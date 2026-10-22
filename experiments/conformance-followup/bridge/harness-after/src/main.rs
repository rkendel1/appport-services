//! Usage: bridge-harness-after <scenario> [args]; bridge and node come from the
//! same environment variables the server reads (BridgeConfig::from_env).
use appport_auth_mesh_server::appport_services::{BridgeClient, BridgeConfig};
use serde_json::{json, Value};
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};

fn request(op: &str, app: &str, n: usize) -> Value {
    let input = match op {
        "configuration.create_variable" => json!({ "name": format!("VAR_{n}"), "value": format!("v{n}"), "required": false }),
        _ => json!({ "n": n }),
    };
    json!({
        "application_id": app, "tenant_id": format!("tenant-a:{app}"), "environment": "production",
        "authority": { "verified_by": "authboundry", "actor": "operator-1" }, "actor": "operator-1",
        "input": input,
    })
}

fn rss_kb(pid: u32) -> u64 {
    std::fs::read_to_string(format!("/proc/{pid}/status")).ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("VmRSS:")).map(|l| l.split_whitespace().nth(1).unwrap().parse().unwrap()))
        .unwrap_or(0)
}
fn pct(sorted: &[f64], p: f64) -> f64 { sorted[((sorted.len() as f64 * p) as usize).min(sorted.len() - 1)] }

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let client = Arc::new(BridgeClient::new(BridgeConfig::from_env()));
    match args[1].as_str() {
        // load <op> <threads> <per_thread>
        "load" => {
            let op = args[2].clone();
            let threads: usize = args[3].parse().unwrap();
            let per: usize = args[4].parse().unwrap();
            client.call(&op, request(&op, "app-load", 999_999)).ok();
            let barrier = Arc::new(Barrier::new(threads));
            let start = Instant::now();
            let handles: Vec<_> = (0..threads).map(|t| {
                let (client, barrier, op) = (client.clone(), barrier.clone(), op.clone());
                std::thread::spawn(move || {
                    barrier.wait();
                    let mut lat = vec![]; let mut errors = vec![];
                    for i in 0..per {
                        let s = Instant::now();
                        if let Err(e) = client.call(&op, request(&op, "app-load", t * per + i)) { errors.push(format!("{e:?}")); }
                        lat.push(s.elapsed().as_secs_f64() * 1e3);
                    }
                    (lat, errors)
                })
            }).collect();
            let (mut all, mut errors) = (vec![], vec![]);
            for h in handles { let (l, e) = h.join().unwrap(); all.extend(l); errors.extend(e); }
            let wall = start.elapsed().as_secs_f64();
            all.sort_by(|a, b| a.partial_cmp(b).unwrap());
            errors.sort(); errors.dedup();
            let pid = client.stats().child_pid;
            println!("{}", json!({ "scenario": "load", "op": op, "threads": threads, "calls": all.len(), "errors": errors,
                "throughput_per_s": all.len() as f64 / wall, "p50_ms": pct(&all, 0.5), "p95_ms": pct(&all, 0.95), "p99_ms": pct(&all, 0.99), "max_ms": all.last(),
                "child_rss_kb": pid.map(rss_kb), "stats": format!("{:?}", client.stats()) }));
        }
        // memory <op> <rounds> <per_round> [distinct]
        "memory" => {
            let op = args[2].clone();
            let distinct = args.get(5).is_some_and(|a| a == "distinct");
            let per: usize = args[4].parse().unwrap();
            client.call(&op, request(&op, "app-mem", 0)).ok();
            for round in 0..args[3].parse::<usize>().unwrap() {
                let s = Instant::now();
                let mut errors = 0;
                for i in 0..per {
                    let n = round * per + i;
                    let app = if distinct { format!("app-{n}") } else { "app-mem".to_string() };
                    if client.call(&op, request(&op, &app, n)).is_err() { errors += 1; }
                }
                let pid = client.stats().child_pid.unwrap_or(0);
                println!("{}", json!({ "scenario": "memory", "round": round, "calls_so_far": (round + 1) * per, "distinct_apps": distinct, "errors": errors, "round_ms": s.elapsed().as_millis(), "child_rss_kb": rss_kb(pid) }));
            }
        }
        // faults: the four fault scenarios of the original harness, against the fake bridge
        "faults" => {
            // hang: a second caller completes while the first hangs?
            let c = client.clone();
            let hung = std::thread::spawn(move || { let s = Instant::now(); let r = c.call("hang", json!({"application_id":"a","input":{}})); (format!("{:?}", r.err()), s.elapsed().as_secs_f64()) });
            std::thread::sleep(Duration::from_millis(200));
            let s = Instant::now();
            let second = client.call("echo", json!({"application_id":"a","input":{"n":1}}));
            let (hung_result, hung_secs) = hung.join().unwrap();
            println!("{}", json!({ "scenario": "hang", "second_caller": format!("{:?}", second.map(|v| v["n"].clone())), "second_caller_secs": s.elapsed().as_secs_f64(), "hung_caller": hung_result, "hung_caller_secs": hung_secs }));
            // kill: SIGKILL the child, keep calling
            let pid = client.stats().child_pid.unwrap();
            std::process::Command::new("kill").args(["-9", &pid.to_string()]).status().unwrap();
            std::thread::sleep(Duration::from_millis(300));
            let after: Vec<String> = (0..5).map(|n| format!("{:?}", client.call("echo", json!({"application_id":"a","input":{"n":n}})).map(|v| v["n"].clone()))).collect();
            println!("{}", json!({ "scenario": "kill", "killed_pid": pid, "after": after }));
            // noise: one stray line during request 2
            let rows: Vec<String> = (0..6).map(|n| {
                let op = if n == 2 { "noise" } else { "echo" };
                format!("sent {n} got {:?}", client.call(op, json!({"application_id":"a","input":{"n":n,"lines":1}})).map(|v| v["n"].clone()))
            }).collect();
            println!("{}", json!({ "scenario": "noise", "rows": rows }));
        }
        "missing" => {
            let first = format!("{:?}", client.call("echo", json!({"application_id":"a","input":{"n":0}})).err());
            std::fs::copy(std::env::var("FIXED_BRIDGE").unwrap(), std::env::var("AUTHBOUNDRY_APPPORT_SERVICES_BRIDGE").unwrap()).unwrap();
            let second = format!("{:?}", client.call("echo", json!({"application_id":"a","input":{"n":1}})).map(|v| v["n"].clone()));
            println!("{}", json!({ "scenario": "missing", "first": first, "after_bridge_appears": second }));
        }
        // sustained <threads> <seconds> <apps> <sample_seconds> <state_dir>: mixed load
        // (70% snapshot, 30% create_variable) over more applications than the
        // child caches; one sample line per interval.
        "sustained" => {
            use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
            use std::sync::Mutex;
            let threads: usize = args[2].parse().unwrap();
            let seconds: u64 = args[3].parse().unwrap();
            let apps: usize = args[4].parse().unwrap();
            let sample: u64 = args[5].parse().unwrap();
            let state_dir = std::path::PathBuf::from(&args[6]);
            let stop = Arc::new(AtomicBool::new(false));
            let window: Arc<Mutex<Vec<f64>>> = Arc::new(Mutex::new(vec![]));
            let errors: Arc<Mutex<std::collections::BTreeMap<String, u64>>> = Arc::new(Mutex::new(Default::default()));
            let next = Arc::new(AtomicU64::new(0));
            let workers: Vec<_> = (0..threads).map(|t| {
                let (client, stop, window, errors, next) = (client.clone(), stop.clone(), window.clone(), errors.clone(), next.clone());
                std::thread::spawn(move || {
                    let mut seed = 0x9E3779B97F4A7C15u64 ^ (t as u64 + 1);
                    while !stop.load(Ordering::Relaxed) {
                        seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17;
                        let app = format!("app-{}", seed % apps as u64);
                        let op = if seed % 10 < 7 { "snapshot" } else { "configuration.create_variable" };
                        let n = next.fetch_add(1, Ordering::Relaxed) as usize;
                        let s = Instant::now();
                        let r = client.call(op, request(op, &app, n));
                        let ms = s.elapsed().as_secs_f64() * 1e3;
                        window.lock().unwrap().push(ms);
                        if let Err(e) = r { *errors.lock().unwrap().entry(format!("{e:?}")).or_default() += 1; }
                    }
                })
            }).collect();
            let start = Instant::now();
            let size = |dir: &std::path::Path| -> u64 {
                fn walk(p: &std::path::Path) -> u64 { std::fs::read_dir(p).map(|d| d.flatten().map(|e| { let m = e.metadata().unwrap(); if m.is_dir() { walk(&e.path()) } else { m.len() } }).sum()).unwrap_or(0) }
                walk(dir)
            };
            let mut total = 0usize;
            while start.elapsed().as_secs() < seconds {
                std::thread::sleep(Duration::from_secs(sample));
                let mut w = std::mem::take(&mut *window.lock().unwrap());
                total += w.len();
                w.sort_by(|a, b| a.partial_cmp(b).unwrap());
                let stats = client.stats();
                let q = |p: f64| if w.is_empty() { 0.0 } else { pct(&w, p) };
                println!("{}", json!({ "scenario": "sustained", "t_s": start.elapsed().as_secs(), "calls": total, "window_calls": w.len(),
                    "throughput_per_s": w.len() as f64 / sample as f64, "p50_ms": q(0.5), "p95_ms": q(0.95), "max_ms": w.last(),
                    "child_rss_kb": stats.child_pid.map(rss_kb), "state_bytes": size(&state_dir),
                    "recycles": stats.recycles, "timeouts": stats.timeouts, "overloaded": stats.overloaded, "starts": stats.starts,
                    "errors": errors.lock().unwrap().clone() }));
            }
            stop.store(true, Ordering::Relaxed);
            for w in workers { w.join().unwrap(); }
        }
        other => panic!("unknown scenario {other}"),
    }
}
