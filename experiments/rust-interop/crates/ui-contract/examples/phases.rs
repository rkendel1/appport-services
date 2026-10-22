use std::time::Instant;
fn main() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!("../../../fixtures/ui-contract-corpus.json")).unwrap();
    let case = corpus["cases"].as_array().unwrap().iter().find(|c| c["name"] == "1000 surfaces").unwrap();
    let raw = case["raw"].as_str().unwrap();
    for _ in 0..3 {
        let s = Instant::now(); let v: serde_json::Value = serde_json::from_str(raw).unwrap(); let parse = s.elapsed();
        let s = Instant::now(); let out = appport_ui_contract::validate_ui_contribution(&v).unwrap(); let validate = s.elapsed();
        let s = Instant::now(); let text = serde_json::to_string(&out).unwrap(); let ser = s.elapsed();
        let s = Instant::now(); let _: serde_json::Value = serde_json::from_str::<serde_json::Value>(raw).map(|_| serde_json::Value::Null).unwrap(); let parse2 = s.elapsed();
        println!("parse {parse:?} validate {validate:?} serialize {ser:?} parse-again {parse2:?} out {}", text.len());
    }
}
