//! Usage: bridge-harness <scenario> [args]
//! The bridge script and node binary are chosen exactly as the server chooses
//! them: AUTHBOUNDRY_APPPORT_SERVICES_BRIDGE and AUTHBOUNDRY_NODE.
#[allow(dead_code)]
#[path = "../../../../../../authboundry/crates/server/src/appport_services.rs"]
mod appport_services;

use serde_json::{json, Value};
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};

fn request(op: &str, app: &str, n: usize) -> Value {
    let input = match op {
        "configuration.create_variable" => json!({ "name": format!("VAR_{n}"), "value": format!("v{n}"), "required": false }),
        _ => json!({ "n": n }),
    };
    json!({
        "application_id": app, "tenant_id": "tenant-a", "environment": "production",
        "authority": { "verified_by": "authboundry", "actor": "operator-1" },
        "input": input,
    })
}

/// The bridge child is this process's only child.
fn child_pid() -> Option<u32> {
    let me = std::process::id();
    for task in std::fs::read_dir(format!("/proc/{me}/task")).ok()? {
        let children = std::fs::read_to_string(task.ok()?.path().join("children")).ok()?;
        if let Some(pid) = children.split_whitespace().next() { return pid.parse().ok(); }
    }
    None
}

fn rss_kb(pid: u32) -> u64 {
    std::fs::read_to_string(format!("/proc/{pid}/status")).ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("VmRSS:")).map(|l| l.split_whitespace().nth(1).unwrap().parse().unwrap()))
        .unwrap_or(0)
}

fn pct(sorted: &[f64], p: f64) -> f64 { sorted[((sorted.len() as f64 * p) as usize).min(sorted.len() - 1)] }

/// `threads` callers each issue `per_thread` calls of `op`. Prints one JSON line.
fn load(op: &str, threads: usize, per_thread: usize, distinct_apps: bool) {
    let barrier = Arc::new(Barrier::new(threads));
    let start = Instant::now();
    let handles: Vec<_> = (0..threads).map(|t| {
        let barrier = barrier.clone();
        let op = op.to_string();
        std::thread::spawn(move || {
            barrier.wait();
            let mut lat = Vec::with_capacity(per_thread);
            let mut errors = 0usize;
            for i in 0..per_thread {
                let n = t * per_thread + i;
                let app = if distinct_apps { format!("app-{n}") } else { "app-load".to_string() };
                let s = Instant::now();
                if appport_services::call(&op, request(&op, &app, n)).is_err() { errors += 1; }
                lat.push(s.elapsed().as_secs_f64() * 1e3);
            }
            (lat, errors)
        })
    }).collect();
    let mut all = vec![];
    let mut errors = 0;
    for h in handles { let (l, e) = h.join().unwrap(); all.extend(l); errors += e; }
    let wall = start.elapsed().as_secs_f64();
    all.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pid = child_pid();
    println!("{}", json!({
        "scenario": "load", "op": op, "threads": threads, "calls": all.len(), "errors": errors, "distinct_apps": distinct_apps,
        "throughput_per_s": all.len() as f64 / wall, "p50_ms": pct(&all, 0.5), "p95_ms": pct(&all, 0.95), "p99_ms": pct(&all, 0.99), "max_ms": all.last(),
        "child_rss_kb": pid.map(rss_kb),
    }));
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args[1].as_str() {
        // load <op> <threads> <per_thread> [distinct]
        "load" => {
            // Warm: first call spawns the child and opens state.
            let _ = appport_services::call(&args[2], request(&args[2], "app-load", 999_999));
            let pid = child_pid();
            println!("{}", json!({ "scenario": "warm", "child_pid": pid, "child_rss_kb": pid.map(rss_kb) }));
            load(&args[2], args[3].parse().unwrap(), args[4].parse().unwrap(), args.get(5).is_some_and(|a| a == "distinct"));
        }
        // sweep <op> <calls_total>: concurrency 1,2,4,8,16,32 in one process (one child), as the server would.
        "sweep" => {
            let _ = appport_services::call(&args[2], request(&args[2], "app-load", 999_999));
            let total: usize = args[3].parse().unwrap();
            for threads in [1, 2, 4, 8, 16, 32] { load(&args[2], threads, (total / threads).max(1), false); }
        }
        // memory <op> <rounds> <per_round> [distinct]: child RSS after each round
        "memory" => {
            let _ = appport_services::call(&args[2], request(&args[2], "app-mem", 0));
            let pid = child_pid().unwrap();
            let distinct = args.get(5).is_some_and(|a| a == "distinct");
            let per: usize = args[4].parse().unwrap();
            for round in 0..args[3].parse::<usize>().unwrap() {
                let s = Instant::now();
                let mut errors = 0;
                for i in 0..per {
                    let n = round * per + i;
                    let app = if distinct { format!("app-{n}") } else { "app-mem".to_string() };
                    if appport_services::call(&args[2], request(&args[2], &app, n)).is_err() { errors += 1; }
                }
                println!("{}", json!({ "scenario": "memory", "round": round, "calls_so_far": (round + 1) * per, "distinct_apps": distinct, "errors": errors, "round_ms": s.elapsed().as_millis(), "child_rss_kb": rss_kb(pid) }));
            }
        }
        // kill <op>: call, SIGKILL the child, then keep calling; is it ever restarted?
        "kill" => {
            let op = &args[2];
            let first = appport_services::call(op, request(op, "app-kill", 1)).map(|_| "ok").unwrap_or_else(|e| Box::leak(e.into_boxed_str()));
            let pid = child_pid().unwrap();
            std::process::Command::new("kill").args(["-9", &pid.to_string()]).status().unwrap();
            std::thread::sleep(Duration::from_millis(300));
            let mut after = vec![];
            for i in 0..5 {
                let s = Instant::now();
                let r = appport_services::call(op, request(op, "app-kill", 10 + i));
                after.push(json!({ "attempt": i, "result": r.map(|_| "ok".to_string()).unwrap_or_else(|e| e), "ms": s.elapsed().as_secs_f64() * 1e3, "child_pid_now": child_pid() }));
            }
            println!("{}", json!({ "scenario": "kill", "before": first, "killed_pid": pid, "after": after }));
        }
        // hang: one caller's request never answers; do other callers proceed? (fake bridge)
        "hang" => {
            let hung = std::thread::spawn(|| { let s = Instant::now(); let r = appport_services::call("hang", json!({ "application_id": "a" })); (r.is_ok(), s.elapsed().as_secs_f64()) });
            std::thread::sleep(Duration::from_millis(200));
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || { let s = Instant::now(); let r = appport_services::call("echo", json!({ "application_id": "a", "n": 1 })); tx.send((r.is_ok(), s.elapsed().as_secs_f64())).ok(); });
            let other = rx.recv_timeout(Duration::from_secs(10));
            println!("{}", json!({ "scenario": "hang", "second_caller_completed_within_10s": other.is_ok(), "hung_caller_finished": hung.is_finished() }));
            std::process::exit(0);
        }
        // noise <k>: the child writes one stray stdout line during request k; are later responses misattributed? (fake bridge)
        "noise" => {
            let mut rows = vec![];
            for n in 0..6 {
                let op = if n == 2 { "noise" } else { "echo" };
                let r = appport_services::call(op, json!({ "application_id": "a", "n": n }));
                rows.push(json!({ "sent_n": n, "op": op, "got": r.map(|v| v).unwrap_or_else(|e| json!({ "error": e })) }));
            }
            println!("{}", json!({ "scenario": "noise", "rows": rows }));
        }
        // missing: bridge path absent on first call; then fixed; does the server recover?
        "missing" => {
            let first = appport_services::call("echo", json!({ "application_id": "a" })).err();
            let fixed = std::env::var("FIXED_BRIDGE").unwrap();
            std::env::set_var("AUTHBOUNDRY_APPPORT_SERVICES_BRIDGE", fixed);
            let second = appport_services::call("echo", json!({ "application_id": "a", "n": 1 })).map(|_| "ok".to_string()).unwrap_or_else(|e| e);
            println!("{}", json!({ "scenario": "missing", "first": first, "after_fix": second }));
        }
        // attrib <n>: sequential create_variable calls; does each response name the variable it created?
        "attrib" => {
            let mut rows = vec![];
            for n in 0..args[2].parse::<usize>().unwrap() {
                let r = appport_services::call("configuration.create_variable", request("configuration.create_variable", "app-attrib", n));
                let got = match &r { Ok(v) => v.get("name").cloned().unwrap_or(Value::Null), Err(e) => json!({ "error": e }) };
                rows.push(json!({ "sent": format!("VAR_{n}"), "got": got }));
            }
            println!("{}", json!({ "scenario": "attrib", "debug_cas": std::env::var("DEBUG_CAS").ok(), "rows": rows }));
        }
        // multiapp <phase>: phase "write" interleaves writes from two applications
        // (two createServices instances on the same local state path); phase "read"
        // runs in a fresh process and snapshots both.
        "multiapp" => {
            if args[2] == "write" {
                let mut out = vec![];
                for (app, n) in [("app-a", 1), ("app-b", 2), ("app-a", 3), ("app-b", 4), ("app-a", 5)] {
                    let r = appport_services::call("configuration.create_variable", request("configuration.create_variable", app, n));
                    out.push(json!({ "app": app, "var": format!("VAR_{n}"), "ok": r.is_ok(), "err": r.err() }));
                }
                println!("{}", json!({ "scenario": "multiapp-write", "rows": out }));
            } else {
                let mut out = vec![];
                for app in ["app-a", "app-b"] {
                    let r = appport_services::call("snapshot", request("snapshot", app, 0));
                    let names: Vec<Value> = r.as_ref().ok().and_then(|v| v["configuration"]["variables"].as_array().cloned()).unwrap_or_default()
                        .iter().filter_map(|c| c.get("name").cloned()).collect();
                    out.push(json!({ "app": app, "variables": names, "err": r.err() }));
                }
                println!("{}", json!({ "scenario": "multiapp-read", "rows": out }));
            }
        }
        other => panic!("unknown scenario {other}"),
    }
}
