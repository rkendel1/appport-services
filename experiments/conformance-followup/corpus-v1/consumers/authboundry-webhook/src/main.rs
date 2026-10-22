//! For each case: register the case secret, then present the reference
//! signature for the scheme's signed message. accept = WebhookAuthority::receive
//! returned Ok. (The crate has no timestamp notion, so the inbound message is
//! passed as the payload it would have to verify.)
use appport_auth_mesh_contract::{PrincipalId, TenantId};
use appport_auth_mesh_services::WebhookAuthority;
use serde_json::{json, Value};

fn main() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../webhook-signature-1");
    let cases: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("cases.json")).unwrap()).unwrap();
    let expected: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("expected.json")).unwrap()).unwrap();
    for (i, case) in cases["cases"].as_array().unwrap().iter().enumerate() {
        let id = case["id"].as_str().unwrap();
        let input = &case["input"];
        let exact: Value = serde_json::from_str(expected["results"][id]["exact"].as_str().unwrap()).unwrap();
        let signature = exact["value"]["signature"].as_str().unwrap();
        let message = if case["scheme"] == "inbound" {
            format!("{}.{}", input["timestamp"].as_str().unwrap(), input["body"].as_str().unwrap())
        } else {
            input["body"].as_str().unwrap().to_string()
        };
        let authority = WebhookAuthority::default();
        authority.register(format!("ep{i}"), TenantId::new("t"), PrincipalId::new("p"), input["secret"].as_str().unwrap());
        let r = authority.receive(&format!("ep{i}"), "d1", "e1", &message, signature);
        println!("{}", json!({ "id": id, "verdict": if r.is_ok() { "accept" } else { "reject" }, "detail": format!("{:?}", r.err()) }));
    }
}
