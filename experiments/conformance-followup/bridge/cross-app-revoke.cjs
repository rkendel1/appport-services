// EXPERIMENT: can api_keys.revoke issued for application B revoke a key that
// application A created, through the unmodified bridge (shared namespace
// "authboundry-appport")? Requests are shaped exactly as AuthBoundry builds them
// (tenant_id = "<authority tenant>:<application id>", control_routes.rs:850-853).
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const bridge = process.argv[2];
const child = spawn(process.execPath, [bridge], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, FELTDB_URL: '', FELTDB_ENDPOINT: '' } });
const it = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
const call = async (operation, app, tenant, input) => {
  child.stdin.write(JSON.stringify({ operation, request: { application_id: app, tenant_id: tenant, authority: { verified_by: 'authboundry', actor: 'owner' }, input } }) + '\n');
  return JSON.parse((await it.next()).value);
};
const keysOf = async (app, tenant) => (await call('snapshot', app, tenant, {})).value?.api_keys?.map((k) => ({ id: k.id, revoked: Boolean(k.revokedAt) }));
(async () => {
  const out = {};
  for (const [label, appB, tenantB] of [['different app, AuthBoundry-shaped tenant', 'app-b', 'org:app-b'], ['different app, same tenant string', 'app-b', 'org:app-a']]) {
    const created = await call('api_keys.create', 'app-a', 'org:app-a', { name: `k-${label}` });
    const id = created.value?.key?.id ?? created.value?.id;
    const revoke = await call('api_keys.revoke', appB, tenantB, { id });
    out[label] = { created: created.ok, revokeFromB: revoke.ok ? { ok: true, value: revoke.value } : revoke.error, keyAfterInA: (await keysOf('app-a', 'org:app-a')).find((k) => k.id === id) };
  }
  console.log(JSON.stringify({ bridge, out }));
  child.stdin.end();
})();
