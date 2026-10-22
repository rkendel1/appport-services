// The reference execution of each @appport/services corpus: the only code
// allowed to produce expected results. `root` is the URL of a build of this
// repository (dist/), so tests and tools/bless.mjs run the same modules.

/** JSON with object keys in code-unit order, so results do not depend on locale. */
export function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function views(result) {
  const verdict = result.ok ? "accept" : result.error ? "reject" : "internal";
  return { exact: stable(result), verdict, code: result.error?.code ?? null, field: null };
}

export const CORPORA = ["webhook-signature-1", "api-key-restrictions-1", "services-manifest-1"];

export async function load(root) {
  const module = (path) => import(new URL(path, root).href);
  const [secrets, restrictions, manifest] = await Promise.all([
    module("src/webhooks/secrets.js"),
    module("src/api-keys/restrictions.js"),
    module("src/authority/manifest.js"),
  ]);
  return { secrets, restrictions, manifest };
}

const failure = (error) => ({ ok: false, error: { code: error?.code ?? "INTERNAL", message: error?.message ?? String(error) } });

const runners = {
  "webhook-signature-1": ({ secrets }, testCase) => {
    const { secret, body, timestamp } = testCase.input;
    const message = testCase.scheme === "inbound" ? `${timestamp}.${body}` : body;
    const signature = secrets.signWebhookPayload(secret, message);
    // The verifier must accept its own signature and refuse any other.
    return {
      ok: true,
      value: {
        signature,
        verifies: secrets.verifyWebhookSignature(secret, message, signature),
        rejectsAlteredBody: !secrets.verifyWebhookSignature(secret, `${message} `, signature),
      },
    };
  },
  "api-key-restrictions-1": ({ restrictions }, testCase) => {
    const { input } = testCase;
    try {
      switch (testCase.op) {
        case "normalize": return { ok: true, value: restrictions.normalizeRestrictions(input.restrictions) };
        case "permit": return { ok: true, value: restrictions.restrictionsPermit(input.restrictions, input.capability, input.resource) };
        case "within": return { ok: true, value: restrictions.restrictionsWithin(input.child, input.parent) };
        default: throw new Error(`unknown op ${testCase.op}`);
      }
    } catch (error) {
      return failure(error);
    }
  },
  "services-manifest-1": ({ manifest }, testCase) => {
    switch (testCase.op) {
      case "digest": return { ok: true, value: manifest.serviceCapabilityManifestDigest() };
      case "manifest": return { ok: true, value: manifest.SERVICE_CAPABILITY_MANIFEST };
      case "legacy-scopes": return { ok: true, value: manifest.LEGACY_SCOPE_MIGRATION };
      default: throw new Error(`unknown op ${testCase.op}`);
    }
  },
};

export function run(corpus, modules, testCase) {
  return views(runners[corpus](modules, testCase));
}

export function lintCases(cases) {
  const problems = [];
  const ids = new Set();
  for (const testCase of cases) {
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(testCase.id ?? "")) problems.push(`invalid id ${JSON.stringify(testCase.id)}`);
    if (ids.has(testCase.id)) problems.push(`duplicate id ${testCase.id}`);
    ids.add(testCase.id);
    if (!["valid", "invalid", "boundary", "security", "versioned"].includes(testCase.class)) problems.push(`${testCase.id}: unknown class`);
    if (testCase.class === "security" && !testCase.security?.rationale) problems.push(`${testCase.id}: security cases need a rationale`);
  }
  return problems;
}
