import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const ref = await import(pathToFileURL("/home/user/services-closeout/conformance/contracts/tools/reference.mjs"));
const root = pathToFileURL(process.argv[2].replace(/\/?$/, "/"));
const imp = (p) => import(new URL(p, root).href).catch(() => null);
const modules = { secrets: await imp("src/webhooks/secrets.js"), restrictions: await imp("src/api-keys/restrictions.js"), manifest: await imp("src/authority/manifest.js") };
console.log("modules present:", Object.entries(modules).filter(([,m]) => m).map(([k]) => k).join(","));
for (const corpus of ref.CORPORA) {
  const dir = `/home/user/services-closeout/conformance/contracts/${corpus}`;
  const cases = JSON.parse(readFileSync(`${dir}/cases.json`, "utf8"));
  const expected = JSON.parse(readFileSync(`${dir}/expected.json`, "utf8"));
  const list = Array.isArray(cases) ? cases : cases.cases;
  let same = 0, diff = [];
  for (const c of list) {
    let exact;
    try { exact = ref.run(corpus, modules, c).exact; } catch (e) { exact = "threw " + e; }
    if (exact === expected.results[c.id].exact) same++; else diff.push([c.id, exact.slice(0,160), expected.results[c.id].exact.slice(0,160)]);
  }
  console.log(JSON.stringify({ corpus, cases: list.length, identical: same, differing: diff }));
}
