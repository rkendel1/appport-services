// The reference implementations: the only code allowed to produce expected
// results. Each returns, per case, the full observable result as JSON bytes.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const servicesRoot = new URL('../../../../', import.meta.url); // worktree root (appport-services)

export async function reference(contract) {
  if (contract === 'appport-ui-1' || contract === 'capability-name-1') {
    // Resolved exactly as @appport/services resolves it (the worktree's node_modules).
    // APPPORT_PROTOCOL_DIST points at another build of the reference (a release
    // candidate, or the protocol repo's source) to see what a re-bless would change.
    const alt = process.env.APPPORT_PROTOCOL_DIST;
    const protocol = await import(alt ? new URL('index.js', `file://${alt.replace(/\/?$/, '/')}`).href : '@appport/protocol');
    const pkg = alt ? { version: process.env.APPPORT_PROTOCOL_VERSION ?? `dist:${alt}` }
      : require(new URL('node_modules/@appport/protocol/package.json', servicesRoot).pathname);
    const id = { package: '@appport/protocol', version: pkg.version };
    if (contract === 'appport-ui-1') {
      return { id, run: (c) => {
        try {
          const v = protocol.validateUiContribution(JSON.parse(c.input.json));
          return { ok: true, value: c.op === 'filter' ? protocol.filterUiContribution(v, c.available ?? []) : v };
        } catch (e) {
          if (protocol.AppPortError.is(e)) return { ok: false, error: e.toErrorObject() };
          return { ok: false, internal: e?.name ?? typeof e };
        }
      } };
    }
    return { id, run: (c) => c.op === 'ref'
      ? { ok: true, value: protocol.parseCapabilityRef(c.input.text) }
      : { ok: true, value: protocol.validateName(c.input.text) } };
  }
  if (contract === 'webhook-signature-1') {
    const secrets = await import(new URL('dist/src/webhooks/secrets.js', servicesRoot));
    const pkg = require(new URL('package.json', servicesRoot).pathname);
    return { id: { package: '@appport/services', version: pkg.version, module: 'src/webhooks/secrets.ts' }, run: (c) => {
      const message = c.scheme === 'inbound' ? `${c.input.timestamp}.${c.input.body}` : c.input.body;
      return { ok: true, value: { signature: secrets.signWebhookPayload(c.input.secret, message) } };
    } };
  }
  throw new Error(`no reference for ${contract}`);
}

/** The coarser views a consumer may be compared at. */
export function views(result) {
  const verdict = result.ok ? 'accept' : (result.error ? 'reject' : 'internal');
  return { verdict, code: result.error?.code ?? null, field: result.error?.details?.field ?? null };
}
