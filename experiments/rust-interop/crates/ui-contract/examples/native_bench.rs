//! Pure-Rust timing of handle_json (parse + validate + serialize), no JS boundary.
use std::time::Instant;
fn main() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!("../../../fixtures/ui-contract-corpus.json")).unwrap();
    for name in ["compute fixture: anonymous /v1/ui (services 0.4.10)", "services 0.4.12 APPPORT_UI_CONTRIBUTIONS[0]", "64 surfaces (Compute MAX_LINKS)", "1000 surfaces", "capability: uppercase rejected"] {
        let case = corpus["cases"].as_array().unwrap().iter().find(|c| c["name"] == name).unwrap();
        let request = format!("{{\"op\":\"validate\",\"value\":{}}}", case["raw"].as_str().unwrap());
        let n = if name == "1000 surfaces" { 400 } else { 20000 };
        for _ in 0..n / 10 { std::hint::black_box(appport_ui_contract::handle_json(request.as_bytes())); }
        let mut samples = Vec::with_capacity(n);
        for _ in 0..n {
            let s = Instant::now();
            std::hint::black_box(appport_ui_contract::handle_json(std::hint::black_box(request.as_bytes())));
            samples.push(s.elapsed().as_secs_f64() * 1e6);
        }
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!("{name:55} p50 {:9.2} µs  p95 {:9.2} µs  ({} bytes in)", samples[n / 2], samples[n * 95 / 100], request.len());
    }
}
