use appport_auth_mesh_contract::{PrincipalId, TenantId};
use appport_auth_mesh_services::{ServiceError, WebhookAuthority};

#[test]
fn authboundry_rust_vs_appport_services_signatures() {
    let vectors: serde_json::Value =
        serde_json::from_str(include_str!("../../../fixtures/webhook-signature-vectors.json")).unwrap();
    println!("{:>12} {:>34} {:>34}", "secret bytes", "outbound (HMAC over body)", "inbound (HMAC over ts.body)");
    for (index, vector) in vectors["vectors"].as_array().unwrap().iter().enumerate() {
        let secret = vector["secret"].as_str().unwrap();
        let body = vector["body"].as_str().unwrap();
        let signed = format!("{}.{}", vector["timestamp"].as_str().unwrap(), body);
        let authority = WebhookAuthority::default();
        let endpoint = format!("ep{index}");
        authority.register(endpoint.clone(), TenantId::new("t"), PrincipalId::new("p"), secret);
        let outbound = authority.receive(&endpoint, "d1", "evt_1", body, vector["outbound"].as_str().unwrap());
        let inbound = authority.receive(&endpoint, "d2", "evt_1", &signed, vector["inbound"].as_str().unwrap());
        let show = |r: &Result<_, ServiceError>| match r { Ok(_) => "accepted".to_string(), Err(e) => format!("{e:?}") };
        println!("{:>12} {:>34} {:>34}", vector["secretLength"], show(&outbound), show(&inbound));
    }
}
