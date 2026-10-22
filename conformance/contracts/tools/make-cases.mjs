// Writes cases.json for api-key-restrictions-1 and services-manifest-1.
// Inputs and intent only; expected results come from tools/bless.mjs.
import { writeFileSync } from "node:fs";

const write = (corpus, contract, operations, cases) => writeFileSync(new URL(`../${corpus}/cases.json`, import.meta.url),
  `${JSON.stringify({ contract, corpus, corpusVersion: "1.0.0", operations, cases }, null, 1)}\n`);

const ESCALATION = "A key restricted this way must never authorize more than its restrictions say (default deny).";
const NARROWING = "A key used to manage keys must not create, widen or rotate a key broader than itself.";
const r = (capabilities, resources) => (resources === undefined ? { capabilities } : { capabilities, resources });
const cases = [];
const add = (id, cls, op, input, extra = {}) => cases.push({ id: `akr1.${op}.${id}`, class: cls, op, input, ...extra });

// normalize: validation and canonical form of caller-supplied restrictions
add("capabilities-only", "valid", "normalize", { restrictions: r(["files.read"]) });
add("deduplicated-and-sorted", "valid", "normalize", { restrictions: r(["jobs.read", "files.read", "jobs.read"]) });
add("empty-capabilities", "boundary", "normalize", { restrictions: r([]) });
add("resource-rule-type-id-attributes", "valid", "normalize", { restrictions: r(["files.read"], [{ type: "file", id: "f1", attributes: { owner: "u1", folder: "a" } }]) });
add("attributes-key-order-is-not-semantic", "boundary", "normalize", { restrictions: r(["files.read"], [{ attributes: { b: "2", B: "1", a: "0", _: "3" } }]) });
add("unknown-capability", "security", "normalize", { restrictions: r(["files.admin"]) }, { security: { rationale: "An unknown name would match nothing and read as narrower than it is; it is refused." } });
add("non-invocable-capability", "security", "normalize", { restrictions: r(["webhooks.deliver"]) }, { security: { rationale: "Runtime-internal operations cannot be granted to a key." } });
add("legacy-admin-scope", "invalid", "normalize", { restrictions: r(["files.read:any"]) });
add("unknown-member", "invalid", "normalize", { restrictions: { capabilities: ["files.read"], scopes: ["x"] } });
add("not-an-object", "invalid", "normalize", { restrictions: ["files.read"] });
add("null", "invalid", "normalize", { restrictions: null });
add("capabilities-missing", "invalid", "normalize", { restrictions: {} });
add("capability-not-a-string", "invalid", "normalize", { restrictions: r([1]) });
add("64-capabilities", "boundary", "normalize", { restrictions: r(Array(64).fill("files.read")) });
add("65-capabilities", "boundary", "normalize", { restrictions: r(Array(65).fill("files.read")) });
add("resources-not-array", "invalid", "normalize", { restrictions: r(["files.read"], {}) });
add("empty-rule", "security", "normalize", { restrictions: r(["files.read"], [{}]) }, { security: { rationale: "An empty rule would match every resource; omitting resources must be explicit." } });
add("unknown-resource-type", "invalid", "normalize", { restrictions: r(["files.read"], [{ type: "everything" }]) });
add("rule-unknown-member", "invalid", "normalize", { restrictions: r(["files.read"], [{ type: "file", owner: "u" }]) });
add("rule-id-256", "boundary", "normalize", { restrictions: r(["files.read"], [{ id: "x".repeat(256) }]) });
add("rule-id-257", "boundary", "normalize", { restrictions: r(["files.read"], [{ id: "x".repeat(257) }]) });
add("rule-id-whitespace", "invalid", "normalize", { restrictions: r(["files.read"], [{ id: "  " }]) });
add("attribute-not-string", "invalid", "normalize", { restrictions: r(["files.read"], [{ attributes: { owner: 1 } }]) });
add("16-attributes", "boundary", "normalize", { restrictions: r(["files.read"], [{ attributes: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, "v"])) }]) });
add("17-attributes", "boundary", "normalize", { restrictions: r(["files.read"], [{ attributes: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"])) }]) });
add("65-rules", "boundary", "normalize", { restrictions: r(["files.read"], Array(65).fill({ type: "file" })) });

// permit: what a restricted key may do
const file = { type: "file", tenantId: "t", id: "f1", attributes: { owner: "u1" } };
const scoped = r(["files.read"], [{ type: "file", attributes: { owner: "u1" } }]);
add("unrestricted", "valid", "permit", { restrictions: undefined, capability: "files.delete", resource: file });
add("listed-capability", "valid", "permit", { restrictions: r(["files.read"]), capability: "files.read", resource: file });
add("unlisted-capability", "security", "permit", { restrictions: r(["files.read"]), capability: "files.delete", resource: file }, { security: { rationale: ESCALATION } });
add("empty-capabilities-deny-all", "security", "permit", { restrictions: r([]), capability: "files.read", resource: file }, { security: { rationale: ESCALATION } });
add("matching-rule", "valid", "permit", { restrictions: scoped, capability: "files.read", resource: file });
add("attribute-mismatch", "security", "permit", { restrictions: scoped, capability: "files.read", resource: { ...file, attributes: { owner: "u2" } } }, { security: { rationale: ESCALATION } });
add("missing-attributes", "security", "permit", { restrictions: scoped, capability: "files.read", resource: { type: "file", tenantId: "t", id: "f1" } }, { security: { rationale: ESCALATION } });
add("type-mismatch", "security", "permit", { restrictions: scoped, capability: "files.read", resource: { ...file, type: "job" } }, { security: { rationale: ESCALATION } });
add("id-rule", "valid", "permit", { restrictions: r(["files.read"], [{ id: "f1" }]), capability: "files.read", resource: file });
add("id-rule-other-id", "security", "permit", { restrictions: r(["files.read"], [{ id: "f1" }]), capability: "files.read", resource: { ...file, id: "f2" } }, { security: { rationale: ESCALATION } });
add("any-of-several-rules", "valid", "permit", { restrictions: r(["files.read"], [{ id: "zz" }, { id: "f1" }]), capability: "files.read", resource: file });

// within: a managing key cannot mint a broader one
const parent = r(["files.read", "files.write"], [{ type: "file", attributes: { owner: "u1" } }]);
add("unrestricted-parent", "valid", "within", { child: r(["files.delete"]), parent: undefined });
add("unrestricted-child-under-restricted-parent", "security", "within", { child: undefined, parent }, { security: { rationale: NARROWING } });
add("subset", "valid", "within", { child: r(["files.read"], [{ type: "file", attributes: { owner: "u1" } }]), parent });
add("extra-capability", "security", "within", { child: r(["files.read", "files.delete"], [{ type: "file", attributes: { owner: "u1" } }]), parent }, { security: { rationale: NARROWING } });
add("child-drops-resources", "security", "within", { child: r(["files.read"]), parent }, { security: { rationale: NARROWING } });
add("child-rule-narrower", "valid", "within", { child: r(["files.read"], [{ type: "file", id: "f1", attributes: { owner: "u1", folder: "a" } }]), parent });
add("child-rule-broader", "security", "within", { child: r(["files.read"], [{ type: "file" }]), parent }, { security: { rationale: NARROWING } });
add("parent-without-resources", "valid", "within", { child: r(["files.read"], [{ id: "x" }]), parent: r(["files.read"]) });
write("api-key-restrictions-1", "@appport/services API-key restrictions", {
  normalize: "normalizeRestrictions(input.restrictions)",
  permit: "restrictionsPermit(input.restrictions, input.capability, input.resource)",
  within: "restrictionsWithin(input.child, input.parent)",
}, cases);

write("services-manifest-1", "@appport/services capability manifest", {
  digest: "serviceCapabilityManifestDigest()", manifest: "SERVICE_CAPABILITY_MANIFEST", "legacy-scopes": "LEGACY_SCOPE_MIGRATION",
}, [
  { id: "svm1.digest", class: "valid", op: "digest", input: {}, requirements: ["sha256-hex-of-JSON.stringify-of-manifest", "manifest-sorted-by-name"] },
  { id: "svm1.manifest", class: "valid", op: "manifest", input: {} },
  { id: "svm1.legacy-scopes", class: "valid", op: "legacy-scopes", input: {} },
]);
console.log(cases.length, "restriction cases");
