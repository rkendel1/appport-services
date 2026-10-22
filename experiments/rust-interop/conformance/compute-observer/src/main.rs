#[allow(dead_code)]
#[path = "../../../../../../compute/crates/compute-environment/src/service_ui.rs"]
mod service_ui;

use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::main]
async fn main() {
    let corpus: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(std::env::args().nth(1).unwrap()).unwrap()).unwrap();
    let cases: Arc<Vec<serde_json::Value>> = Arc::new(corpus["cases"].as_array().unwrap().clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let served = cases.clone();
    tokio::spawn(async move {
        loop {
            let (mut stream, _) = listener.accept().await.unwrap();
            let cases = served.clone();
            tokio::spawn(async move {
                let mut buffer = vec![0u8; 8192];
                let read = stream.read(&mut buffer).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]);
                let path = request.split_whitespace().nth(1).unwrap_or("");
                let index: usize = path.trim_start_matches("/c/").trim_end_matches("/v1/ui").parse().unwrap_or(usize::MAX);
                let body = cases.get(index).and_then(|c| c["raw"].as_str()).unwrap_or("").as_bytes().to_vec();
                let head = format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
                let _ = stream.write_all(head.as_bytes()).await;
                let _ = stream.write_all(&body).await;
            });
        }
    });
    for (index, case) in cases.iter().enumerate() {
        if case["op"] != "validate" {
            continue;
        }
        let now = chrono::Utc::now();
        let record = compute_state::ServiceRecord {
            name: "svc".into(),
            capabilities: vec![service_ui::UI_CAPABILITY.into()],
            provider: "local".into(),
            environment: None,
            project: None,
            workload: None,
            endpoint: Some(format!("http://127.0.0.1:{port}/c/{index}")),
            description: None,
            created_at: now,
            updated_at: now,
        };
        let view = service_ui::discover(&record).await;
        println!("{}", serde_json::json!({ "name": case["name"], "status": view.status, "message": view.message, "links": view.links.len() }));
    }
}
