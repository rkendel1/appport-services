// Decision data for bridge sizing (D-9). Drives the real bridge directly over
// protocol 2, one request at a time (no queueing), and records how stored
// state, per-call latency and child memory grow with the number of writes.
//
//   node growth-probe.mjs growth <node> <bridge> <stateDir> <maxWrites> <step> <checkpointEvery>
//   node growth-probe.mjs instances <node> <bridge> <stateDir> <apps>
//
// growth: one JSON line per step. instances: RSS after touching 1..apps
// applications with MAX_APPLICATIONS=apps, against an existing state.
import { spawn } from "node:child_process";
import { cpSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [mode, node, bridge, stateDir, ...rest] = process.argv.slice(2);

function start(maxApplications) {
  const child = spawn(node, [bridge], {
    env: {
      PATH: process.env.PATH,
      AUTHBOUNDRY_APPPORT_SERVICES_PROTOCOL: "2",
      AUTHBOUNDRY_APPPORT_SERVICES_MAX_APPLICATIONS: String(maxApplications),
      AUTHBOUNDRY_FELTDB_PATH: join(stateDir, "db"),
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const waiting = new Map();
  let ready;
  const readyPromise = new Promise((resolve) => (ready = resolve));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.type === "ready") return ready();
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  let next = 1;
  const call = (operation, app, n) => {
    const id = next++;
    const input = operation === "configuration.create_variable" ? { name: `VAR_${n}`, value: `v${n}`, required: false } : {};
    const request = {
      application_id: app, tenant_id: `tenant-a:${app}`, environment: "production",
      authority: { verified_by: "authboundry", actor: "operator-1" }, actor: "operator-1", input,
    };
    const started = process.hrtime.bigint();
    return new Promise((resolve, reject) => {
      waiting.set(id, (message) => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        message.ok ? resolve(ms) : reject(new Error(`${operation}: ${message.error}`));
      });
      child.stdin.write(`${JSON.stringify({ id, operation, request })}\n`);
    });
  };
  const rss = () => {
    const status = readFileSync(`/proc/${child.pid}/status`, "utf8");
    const kb = (key) => Number(status.match(new RegExp(`${key}:\\s+(\\d+)`))[1]);
    return { rss_mb: Math.round(kb("VmRSS") / 1024), hwm_mb: Math.round(kb("VmHWM") / 1024) };
  };
  return { ready: readyPromise, call, rss, stop: () => child.stdin.end() };
}

function bytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? bytes(path) : statSync(path).size;
  }
  return total;
}
function stateJson(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) { const found = stateJson(path); if (found) return found; }
    else if (entry.name === "state.json") return statSync(path).size;
  }
  return 0;
}
const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
const mb = (n) => Math.round((n / 1048576) * 10) / 10;

if (mode === "growth") {
  const [maxWrites, step, checkpointEvery] = rest.map(Number);
  const bridgeChild = start(1);
  await bridgeChild.ready;
  let n = 0;
  await bridgeChild.call("snapshot", "a", 0);
  // Does a read write durable state?
  let before = bytes(stateDir);
  for (let i = 0; i < 200; i++) await bridgeChild.call("snapshot", "a", 0);
  const perSnapshot = (bytes(stateDir) - before) / 200;
  before = bytes(stateDir);
  for (let i = 0; i < 200; i++) await bridgeChild.call("configuration.create_variable", "a", n++);
  const perWrite = (bytes(stateDir) - before) / 200;
  console.log(JSON.stringify({ probe: "bytes_per_call", snapshot_bytes: Math.round(perSnapshot), write_bytes: Math.round(perWrite) }));
  const started = Date.now();
  while (n < maxWrites) {
    const writeMs = [];
    for (let i = 0; i < step; i++) writeMs.push(await bridgeChild.call("configuration.create_variable", "a", n++));
    const snapshotMs = [];
    for (let i = 0; i < 15; i++) snapshotMs.push(await bridgeChild.call("snapshot", "a", 0));
    // MAX_APPLICATIONS=1: alternating applications makes every call a cache miss.
    const missMs = [];
    for (let i = 0; i < 6; i++) missMs.push(await bridgeChild.call("snapshot", i % 2 ? "a" : "b", 0));
    console.log(JSON.stringify({
      probe: "growth", writes: n, elapsed_s: Math.round((Date.now() - started) / 1000),
      state_json_mb: mb(stateJson(stateDir)), state_dir_mb: mb(bytes(stateDir)),
      write_p50_ms: Math.round(median(writeMs.slice(-15))), snapshot_p50_ms: Math.round(median(snapshotMs)),
      miss_snapshot_p50_ms: Math.round(median(missMs)), ...bridgeChild.rss(),
    }));
    if (Math.floor(n / checkpointEvery) > Math.floor((n - step) / checkpointEvery)) cpSync(stateDir, `${stateDir}-at-${n}`, { recursive: true });
  }
  bridgeChild.stop();
} else if (mode === "instances") {
  const [apps] = rest.map(Number);
  const bridgeChild = start(apps);
  await bridgeChild.ready;
  const rows = [];
  for (let i = 0; i < apps; i++) {
    await bridgeChild.call("snapshot", `app-${i}`, 0);
    rows.push({ cached: i + 1, ...bridgeChild.rss() });
  }
  console.log(JSON.stringify({ probe: "instances", state_json_mb: mb(stateJson(stateDir)), rows }));
  bridgeChild.stop();
}
