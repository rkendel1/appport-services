// Regenerate a corpus's expected.json from the reference only (this
// repository's build: run `npm run build` first).
//
//   node conformance/contracts/tools/bless.mjs <corpus> --check
//   node conformance/contracts/tools/bless.mjs <corpus> --write --accept=<id,...> --reason="..."
//
// --write refuses unless every changed and removed case id is listed in
// --accept, and records the reason and the reference version in the history.
// Nothing here can bless an implementation under test.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { lintCases, load, run } from "./reference.mjs";

const [corpus, ...flags] = process.argv.slice(2);
const flag = (name) => flags.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3);
const directory = new URL(`../${corpus}/`, import.meta.url);
const root = new URL("../../../dist/", import.meta.url);
const servicesPackage = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
const modules = await load(root);

const casesText = readFileSync(new URL("cases.json", directory), "utf8");
const { cases } = JSON.parse(casesText);
const problems = lintCases(cases);
if (problems.length) throw new Error(problems.join("\n"));
const results = Object.fromEntries(cases.map((testCase) => [testCase.id, run(corpus, modules, testCase)]));
const expectedPath = new URL("expected.json", directory);
const previous = existsSync(expectedPath) ? JSON.parse(readFileSync(expectedPath, "utf8")) : { results: {}, history: [] };
const changed = Object.keys(results).filter((id) => previous.results[id]?.exact !== results[id].exact);
const removed = Object.keys(previous.results).filter((id) => !(id in results));
const casesSha256 = createHash("sha256").update(casesText).digest("hex");

if (flags.includes("--check")) {
  if (changed.length || removed.length || previous.casesSha256 !== casesSha256) {
    console.error(`${corpus}: out of date. changed=${changed.join(",") || "-"} removed=${removed.join(",") || "-"} casesChanged=${previous.casesSha256 !== casesSha256}`);
    process.exit(1);
  }
  console.log(`${corpus}: ${cases.length} cases match the reference`);
  process.exit(0);
}
if (!flags.includes("--write")) throw new Error("pass --check or --write");
const accepted = new Set((flag("accept") ?? "").split(",").filter(Boolean));
const unreviewed = [...changed, ...removed].filter((id) => !accepted.has(id));
if (unreviewed.length) {
  console.error(`refusing: ${unreviewed.length} changed or removed case(s) not in --accept:`);
  for (const id of unreviewed) console.error(`  ${id}\n    was: ${previous.results[id]?.exact ?? "(new)"}\n    now: ${results[id]?.exact ?? "(removed)"}`.slice(0, 800));
  process.exit(2);
}
if (!flag("reason")) throw new Error("--reason is required");
const history = [...(previous.history ?? []), { reference: `${servicesPackage.name}@${servicesPackage.version} (source)`, reason: flag("reason"), changed, removed }];
writeFileSync(expectedPath, `${JSON.stringify({ corpus, reference: servicesPackage.name, casesSha256, results, history }, null, 1)}\n`);
console.log(`${corpus}: wrote ${cases.length} expectations (${changed.length} changed, ${removed.length} removed)`);
