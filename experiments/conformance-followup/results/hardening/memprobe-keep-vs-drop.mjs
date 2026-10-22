// Is per-application retention reclaimable once the bridge drops its reference?
import { createRequire } from 'node:module';
const require = createRequire('/home/user/authboundry-bridge/package.json');
const { createServices } = await import('/home/user/authboundry-bridge/node_modules/@appport/services/dist/src/index.js');
const dir = process.argv[2];
const mode = process.argv[3]; // keep | drop
const N = Number(process.argv[4] ?? 200);
const authorizer = { async authorize(r) { return { decision_id: 'x', allowed: true, capability: r.capability, tenant_id: r.tenant_id, application_id: r.application_id, subject: r.subject, resource: r.resource, evaluated_at: r.context.timestamp }; } };
const kept = new Map();
const mb = () => { global.gc(); global.gc(); const m = process.memoryUsage(); return { heapMB: +(m.heapUsed / 2 ** 20).toFixed(1), rssMB: +(m.rss / 2 ** 20).toFixed(1), externalMB: +(m.external / 2 ** 20).toFixed(1) }; };
console.log(JSON.stringify({ mode, at: 0, ...mb() }));
for (let i = 1; i <= N; i++) {
  const app = `app-${i}`;
  const services = createServices({ mode: 'local', namespace: 'authboundry-appport', path: `${dir}.appport-services`, applicationId: 'authboundry', application: app, authorityScope: { kind: 'tenant', tenantId: 'authboundry-system' }, authorizer });
  const op = services.identify({ principalId: 'owner', principalType: 'authboundry_session', tenantId: `org:${app}`, applicationId: app });
  await services.configuration.list({ tenantId: `org:${app}`, applicationId: app, environment: 'production' }, op);
  await services.apiKeys.listApiKeys(`org:${app}`);
  if (mode === 'keep') kept.set(app, services);
  if (i % 50 === 0) console.log(JSON.stringify({ mode, at: i, ...mb() }));
}
const handles = process._getActiveHandles().length, requests = process._getActiveRequests().length;
console.log(JSON.stringify({ mode, final: true, activeHandles: handles, activeRequests: requests, ...mb() }));
