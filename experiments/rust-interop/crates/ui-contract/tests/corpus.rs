//! Native Rust port vs the TypeScript oracle recorded in the corpus.
//! Byte equality is reported separately from semantic (parsed-JSON) equality.

use serde_json::Value;

/// Cases where the JSON-text boundary cannot reproduce the oracle. Each is a
/// documented limitation, asserted so that any *new* divergence fails.
const KNOWN: [&str; 1] = [
    // JavaScript strings may hold a lone UTF-16 surrogate; JSON.stringify
    // escapes it (\ud800) and JSON.parse accepts it, but a Rust `String`
    // (UTF-8) cannot hold it, so serde_json refuses the document.
    "lone surrogate in title",
];

#[test]
fn native_port_matches_the_typescript_oracle() {
    let corpus: Value = serde_json::from_str(include_str!("../../../fixtures/ui-contract-corpus.json")).unwrap();
    let (mut bytes_equal, mut semantic_only, mut failures) = (0, vec![], vec![]);
    for case in corpus["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let mut request = format!("{{\"op\":{},\"value\":{}", case["op"], case["raw"].as_str().unwrap());
        if let Some(available) = case.get("available") {
            request.push_str(&format!(",\"available\":{available}"));
        }
        request.push('}');
        let actual = appport_ui_contract::handle_json(request.as_bytes());
        let expected = case["expectedJson"].as_str().unwrap();
        if actual == expected {
            bytes_equal += 1;
        } else if KNOWN.contains(&name) {
            semantic_only.push(name.to_string());
        } else {
            failures.push(format!("{name}\n    ts:   {}\n    rust: {}", &expected[..expected.len().min(200)], &actual[..actual.len().min(200)]));
        }
    }
    println!("byte-equal: {bytes_equal}; known divergences: {semantic_only:?}");
    assert_eq!(semantic_only, KNOWN, "a known divergence disappeared: update KNOWN");
    assert!(failures.is_empty(), "{} divergences:\n{}", failures.len(), failures.join("\n"));
}
