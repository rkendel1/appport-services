//! EXPERIMENT. A line-by-line Rust port of `validateUiContribution`,
//! `filterUiContribution` and `isValidName` from the published
//! `@appport/protocol` 1.0.3 (`dist/ui.js`, `dist/names.js`), which is the
//! version `@appport/services` 0.4.12 resolves.
//!
//! The TypeScript package is the oracle. This port exists only to measure
//! whether a shared Rust implementation can reproduce that oracle across a
//! WebAssembly or Node-API boundary. It is not a production implementation.
//!
//! Observable behaviour reproduced deliberately:
//! - check order, so a document with several defects reports the same first one;
//! - error codes, messages and `details`;
//! - string length counted in UTF-16 code units (`String.prototype.length`);
//! - `Number.isInteger` for `order` (so `1.0` and `1e21` are integers);
//! - `String(value)` in the protocol error message, including the `TypeError`
//!   JavaScript raises for an object with its own non-callable `toString`;
//! - output key order and number spelling, so the result serializes to the
//!   same bytes as `JSON.stringify` of the TypeScript result.

use serde_json::{Map, Number, Value};

pub const UI_PROTOCOL_ID: &str = "AppPort/ui/1";
pub const UI_DISCOVERY_PATH: &str = "/v1/ui";

const REQUIREMENTS: [&str; 4] = ["identity", "tenant", "application", "environment"];
const RESERVED_NAME_SEGMENTS: [&str; 12] = [
    "http", "https", "ws", "wss", "websocket", "webtransport", "ipc", "electron", "tauri", "rest",
    "grpc", "inprocess",
];

/// What the TypeScript function throws, as far as a caller can observe it.
#[derive(Debug, Clone, PartialEq)]
pub enum Failure {
    /// An `AppPortError` (`toErrorObject()` shape).
    Protocol { code: &'static str, message: String, details: Option<Value> },
    /// A non-AppPort exception (JavaScript `TypeError`). AppPort servers
    /// sanitize these into `INTERNAL_ERROR`.
    Internal(&'static str),
}

impl Failure {
    fn invalid_request(message: impl Into<String>, field: Option<&str>) -> Self {
        Failure::Protocol {
            code: "INVALID_REQUEST",
            message: message.into(),
            details: field.map(|field| {
                let mut details = Map::new();
                details.insert("field".into(), Value::String(field.into()));
                Value::Object(details)
            }),
        }
    }

    pub fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert("ok".into(), Value::Bool(false));
        match self {
            Failure::Protocol { code, message, details } => {
                let mut error = Map::new();
                error.insert("code".into(), Value::String((*code).into()));
                error.insert("message".into(), Value::String(message.clone()));
                if let Some(details) = details {
                    error.insert("details".into(), details.clone());
                }
                out.insert("error".into(), Value::Object(error));
            }
            Failure::Internal(name) => {
                out.insert("internal".into(), Value::String((*name).into()));
            }
        }
        Value::Object(out)
    }
}

type Outcome<T> = Result<T, Failure>;

/// `String.prototype.length`.
fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

fn record(value: Option<&Value>) -> Option<&Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn number_f64(number: &Number) -> f64 {
    // With arbitrary_precision, as_f64 refuses values that overflow; JavaScript
    // reads them as ±Infinity.
    number
        .as_f64()
        .unwrap_or_else(|| number.to_string().parse::<f64>().unwrap_or(f64::NAN))
}

/// ECMAScript `String(value)` for JSON values; `None` is `undefined`.
fn js_string(value: Option<&Value>) -> Outcome<String> {
    Ok(match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => ryu_js::Buffer::new().format(number_f64(number)).to_string(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => {
            let mut parts = Vec::with_capacity(items.len());
            for item in items {
                parts.push(match item {
                    Value::Null => String::new(),
                    other => js_string(Some(other))?,
                });
            }
            parts.join(",")
        }
        Some(Value::Object(map)) => {
            // OrdinaryToPrimitive(hint string): an own `toString` shadows the
            // callable one and JSON cannot supply a function, and the
            // inherited `valueOf` returns the object itself.
            if map.contains_key("toString") {
                return Err(Failure::Internal("TypeError"));
            }
            "[object Object]".into()
        }
    })
}

fn non_empty<'a>(value: Option<&'a Value>, field: &str) -> Outcome<&'a str> {
    match value {
        Some(Value::String(text)) if !text.is_empty() && js_length(text) <= 512 => Ok(text),
        _ => Err(Failure::invalid_request(
            format!("Field \"{field}\" must be a non-empty string"),
            Some(field),
        )),
    }
}

fn unique<'a>(values: impl Iterator<Item = &'a str>, field: &str) -> Outcome<()> {
    let mut seen = std::collections::HashSet::new();
    for value in values {
        if !seen.insert(value) {
            return Err(Failure::invalid_request(format!("Duplicate {field}: {value}"), Some(field)));
        }
    }
    Ok(())
}

/// `isValidName` (`names.ts`): `^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$`, at most
/// 128 UTF-16 units, no reserved transport segment.
pub fn is_valid_name(value: &Value) -> bool {
    let Value::String(name) = value else { return false };
    if name.is_empty() || js_length(name) > 128 {
        return false;
    }
    let segments: Vec<&str> = name.split('.').collect();
    segments.len() >= 2
        && segments.iter().all(|segment| {
            let mut chars = segment.chars();
            chars.next().is_some_and(|first| first.is_ascii_lowercase())
                && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        })
        && !segments.iter().any(|segment| RESERVED_NAME_SEGMENTS.contains(segment))
}

fn is_integer(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Number(number)) => {
            let float = number_f64(number);
            float.is_finite() && float.trunc() == float
        }
        _ => false,
    }
}

/// `validateUiContribution(value)`.
pub fn validate_ui_contribution(value: &Value) -> Outcome<Value> {
    let Some(document) = value.as_object() else {
        return Err(Failure::invalid_request("UI contribution must be an object", None));
    };
    if document.get("protocol").and_then(Value::as_str) != Some(UI_PROTOCOL_ID) {
        let shown = js_string(document.get("protocol"))?;
        let mut details = Map::new();
        details.insert("supported".into(), Value::Array(vec![Value::String(UI_PROTOCOL_ID.into())]));
        return Err(Failure::Protocol {
            code: "INVALID_PROTOCOL",
            message: format!("Unsupported UI contribution protocol: {shown}"),
            details: Some(Value::Object(details)),
        });
    }
    let Some(product) = record(document.get("product")) else {
        return Err(Failure::invalid_request("Field \"product\" must be an object", Some("product")));
    };
    let product_id = non_empty(product.get("id"), "product.id")?;
    let product_version = non_empty(product.get("version"), "product.version")?;
    let (Some(surfaces_in), Some(navigation_in)) = (
        document.get("surfaces").and_then(Value::as_array),
        document.get("navigation").and_then(Value::as_array),
    ) else {
        return Err(Failure::invalid_request("UI contribution surfaces and navigation must be arrays", None));
    };

    let mut surfaces = Vec::with_capacity(surfaces_in.len());
    let mut surface_ids = Vec::with_capacity(surfaces_in.len());
    for (index, surface) in surfaces_in.iter().enumerate() {
        let Some(surface) = surface.as_object() else {
            return Err(Failure::invalid_request(format!("Surface {index} must be an object"), None));
        };
        let id = non_empty(surface.get("id"), &format!("surfaces[{index}].id"))?;
        let title = non_empty(surface.get("title"), &format!("surfaces[{index}].title"))?;
        let route = non_empty(surface.get("route"), &format!("surfaces[{index}].route"))?;
        if !route.starts_with('/') || route.starts_with("//") || route.contains("://") {
            return Err(Failure::invalid_request(
                format!("Surface {id} has a malformed route"),
                Some(&format!("surfaces[{index}].route")),
            ));
        }
        let capabilities = match surface.get("capabilities") {
            Some(Value::Array(names)) if names.iter().all(is_valid_name) => names.clone(),
            _ => {
                return Err(Failure::invalid_request(
                    format!("Surface {id} has invalid capability references"),
                    Some(&format!("surfaces[{index}].capabilities")),
                ))
            }
        };
        let mut out = Map::new();
        out.insert("id".into(), Value::String(id.into()));
        out.insert("title".into(), Value::String(title.into()));
        out.insert("route".into(), Value::String(route.into()));
        out.insert("capabilities".into(), Value::Array(capabilities));
        if let Some(Value::Array(entities)) = surface.get("entities") {
            out.insert("entities".into(), Value::Array(entities.clone()));
        }
        if let Some(Value::Array(actions)) = surface.get("actions") {
            out.insert("actions".into(), Value::Array(actions.clone()));
        }
        surface_ids.push(id);
        surfaces.push(Value::Object(out));
    }
    unique(surface_ids.iter().copied(), "surface id")?;

    let mut navigation = Vec::with_capacity(navigation_in.len());
    let mut navigation_ids = Vec::with_capacity(navigation_in.len());
    let mut navigation_surfaces = Vec::with_capacity(navigation_in.len());
    for (index, item) in navigation_in.iter().enumerate() {
        let Some(item) = item.as_object() else {
            return Err(Failure::invalid_request(format!("Navigation {index} must be an object"), None));
        };
        let id = non_empty(item.get("id"), &format!("navigation[{index}].id"))?;
        let surface = non_empty(item.get("surface"), &format!("navigation[{index}].surface"))?;
        if !is_integer(item.get("order")) {
            return Err(Failure::invalid_request(format!("Navigation {id} order must be an integer"), None));
        }
        let label = non_empty(item.get("label"), &format!("navigation[{index}].label"))?;
        let group = non_empty(item.get("group"), &format!("navigation[{index}].group"))?;
        let mut out = Map::new();
        out.insert("id".into(), Value::String(id.into()));
        out.insert("label".into(), Value::String(label.into()));
        out.insert("group".into(), Value::String(group.into()));
        out.insert("order".into(), item["order"].clone());
        out.insert("surface".into(), Value::String(surface.into()));
        navigation_ids.push(id);
        navigation_surfaces.push(surface);
        navigation.push(Value::Object(out));
    }
    unique(navigation_ids.iter().copied(), "navigation id")?;
    let known: std::collections::HashSet<&str> = surface_ids.iter().copied().collect();
    if navigation_surfaces.iter().any(|surface| !known.contains(surface)) {
        return Err(Failure::invalid_request("Navigation references an unknown surface", None));
    }

    let requires = match record(document.get("composition")).and_then(|c| c.get("requires")) {
        Some(Value::Array(requires))
            if requires.iter().all(|r| r.as_str().is_some_and(|r| REQUIREMENTS.contains(&r))) =>
        {
            requires.clone()
        }
        _ => {
            return Err(Failure::invalid_request(
                "Unsupported composition requirements",
                Some("composition.requires"),
            ))
        }
    };

    let mut product_out = Map::new();
    product_out.insert("id".into(), Value::String(product_id.into()));
    product_out.insert("version".into(), Value::String(product_version.into()));
    let mut composition = Map::new();
    composition.insert("requires".into(), Value::Array(requires));
    let mut out = Map::new();
    out.insert("protocol".into(), Value::String(UI_PROTOCOL_ID.into()));
    out.insert("product".into(), Value::Object(product_out));
    out.insert("surfaces".into(), Value::Array(surfaces));
    out.insert("navigation".into(), Value::Array(navigation));
    out.insert("composition".into(), Value::Object(composition));
    Ok(Value::Object(out))
}

/// `filterUiContribution(contribution, availableCapabilities)` on a
/// contribution `validate_ui_contribution` returned.
pub fn filter_ui_contribution(contribution: &Value, available: &[&str]) -> Value {
    let available: std::collections::HashSet<&str> = available.iter().copied().collect();
    let mut out = contribution.as_object().cloned().unwrap_or_default();
    let surfaces: Vec<Value> = out
        .get("surfaces")
        .and_then(Value::as_array)
        .map(|surfaces| {
            surfaces
                .iter()
                .filter(|surface| {
                    surface["capabilities"]
                        .as_array()
                        .is_some_and(|names| names.iter().all(|n| n.as_str().is_some_and(|n| available.contains(n))))
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let ids: std::collections::HashSet<&str> = surfaces.iter().filter_map(|s| s["id"].as_str()).collect();
    let navigation: Vec<Value> = out
        .get("navigation")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| item["surface"].as_str().is_some_and(|s| ids.contains(&s)))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    // [...new Set(...)].sort(): default sort compares UTF-16 code units.
    let mut seen = std::collections::HashSet::new();
    let mut capabilities: Vec<String> = Vec::new();
    for surface in &surfaces {
        for name in surface["capabilities"].as_array().into_iter().flatten() {
            if let Some(name) = name.as_str() {
                if seen.insert(name) {
                    capabilities.push(name.to_string());
                }
            }
        }
    }
    capabilities.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    out.insert("surfaces".into(), Value::Array(surfaces));
    out.insert("navigation".into(), Value::Array(navigation));
    out.insert("capabilities".into(), Value::Array(capabilities.into_iter().map(Value::String).collect()));
    Value::Object(out)
}

/// Respell every number as `JSON.stringify` would after `JSON.parse`: the
/// nearest double, ECMAScript `Number::toString`, `null` when not finite.
/// Without this `20.0`, `-0` and `9007199254740993` would come back as written.
fn js_numbers(value: &mut Value) {
    match value {
        Value::Number(number) => {
            let float = number_f64(number);
            *value = if float.is_finite() {
                let text = ryu_js::Buffer::new().format_finite(float).to_string();
                Value::Number(serde_json::from_str(&text).expect("ECMAScript number text is JSON"))
            } else {
                Value::Null
            };
        }
        Value::Array(items) => items.iter_mut().for_each(js_numbers),
        Value::Object(map) => map.values_mut().for_each(js_numbers),
        _ => {}
    }
}

/// The language-neutral boundary both bindings expose: one JSON request,
/// one JSON envelope back. `{"op":"validate","value":…}` or
/// `{"op":"filter","value":…,"available":[…]}` (filter validates first, as
/// `createUiDiscoveryDocument` does).
pub fn handle_json(request: &[u8]) -> String {
    let parsed: Value = match serde_json::from_slice(request) {
        Ok(value) => value,
        Err(_) => return r#"{"ok":false,"internal":"SyntaxError"}"#.to_string(),
    };
    let op = parsed.get("op").and_then(Value::as_str).unwrap_or("validate");
    let value = parsed.get("value").cloned().unwrap_or(Value::Null);
    let result = validate_ui_contribution(&value).map(|validated| {
        if op == "filter" {
            let available: Vec<&str> = parsed
                .get("available")
                .and_then(Value::as_array)
                .map(|names| names.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            filter_ui_contribution(&validated, &available)
        } else {
            validated
        }
    });
    let envelope = match result {
        Ok(mut value) => {
            js_numbers(&mut value);
            let mut out = Map::new();
            out.insert("ok".into(), Value::Bool(true));
            out.insert("value".into(), value);
            Value::Object(out)
        }
        Err(failure) => failure.to_value(),
    };
    serde_json::to_string(&envelope).expect("JSON values serialize")
}
