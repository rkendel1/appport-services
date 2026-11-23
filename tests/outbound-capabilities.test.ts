import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import {
  createServices, isServiceAuthorityError, EmailNotificationChannel, PushNotificationChannel, RecordingEmailTransport, RecordingPushTransport,
  type IntelligenceProviderAdapter,
} from '../src/index.js';
import { TestAuthority } from './support/authority.js';
import { MemoryCustody } from './support/custody.js';
import { mockAi } from './support/mock-ai.js';

const SETUP = { tenantId: 'tenant-a', principalId: 'host', purpose: 'test', authorizationRef: 'setup' };

function open(options: { authority?: TestAuthority; custody?: MemoryCustody; extra?: Record<string, unknown> } = {}) {
  const authority = options.authority ?? new TestAuthority({ allowAll: true });
  const services = createServices({
    memory: true, namespace: `outbound-${crypto.randomUUID()}`, application: 'meetings', authorizer: authority,
    ...(options.custody ? { credentials: options.custody } : {}),
    outboundDestinationPolicy: { allowPrivateNetworks: true },
    ...(options.extra ?? {}),
  } as never);
  const host = services.identify({ principalId: 'host-1', principalType: 'user', tenantId: 'tenant-a' })!;
  return { services, host, authority };
}

test('S3: speech to text and embeddings through an OpenAI-compatible provider, metered per tenant with cost', async () => {
  const ai = await mockAi({ apiKey: 'sk-test-provider-key' });
  const custody = new MemoryCustody();
  await custody.store({ reference: { secretId: 'stt', tenantId: 'tenant-a' }, value: 'sk-test-provider-key', context: SETUP });
  try {
    const { services, host } = open({ custody, extra: { intelligencePrices: [
      { provider: 'custom', model: 'whisper-1', modality: 'transcription', unit: 'audio_second', microsPerUnit: 100 },
      { provider: 'custom', modality: 'embeddings', unit: 'token', microsPerUnit: 0.02 },
    ] } });
    await services.intelligence.set({ modality: 'transcription', provider: 'custom', model: 'whisper-1', endpoint: ai.url, credentialRef: 'credential-ref:stt' }, host);
    await services.intelligence.set({ modality: 'embeddings', provider: 'custom', model: 'embed-small', endpoint: ai.url, credentialRef: 'credential-ref:stt' }, host);
    // The chat selection is untouched by the other modalities.
    assert.deepEqual(await services.intelligence.get({}, host), { configured: false, environment: 'production', credentialConfigured: false });
    assert.equal((await services.intelligence.get({ modality: 'transcription' }, host) as { model: string }).model, 'whisper-1');

    const transcript = await services.intelligence.transcribe({ audio: Buffer.from('RIFF fake audio'), contentType: 'audio/wav', filename: 'meeting.wav', language: 'en' }, host);
    assert.equal(transcript.text, 'transcript of ' + ai.requests[0]!.body.length + ' bytes');
    assert.deepEqual([transcript.durationSeconds, transcript.segments?.length, transcript.usage], [12.5, 1, { unit: 'audio_second', units: 12.5, estimated: false, costMicros: 1250, currency: 'USD', priced: true }]);
    assert.equal(ai.requests[0]!.authorization, 'Bearer sk-test-provider-key');

    const embedded = await services.intelligence.embed({ input: ['hello world', 'agenda'] }, host);
    assert.deepEqual(embedded.vectors, [[11, 0, 0.5], [6, 1, 0.5]], 'vectors in input order');
    assert.deepEqual(embedded.usage, { unit: 'token', units: 3, estimated: false, costMicros: 1, currency: 'USD', priced: true });

    const usage = await services.intelligence.usage({}, host);
    assert.equal(usage.complete, true);
    assert.deepEqual(usage.totals.map((total) => [total.modality, total.provider, total.model, total.units, total.costMicros, total.calls]), [
      ['embeddings', 'custom', 'embed-small', 3, 1, 1],
      ['transcription', 'custom', 'whisper-1', 12.5, 1250, 1],
    ]);
    // Another tenant has its own usage.
    const other = services.identify({ principalId: 'host-2', principalType: 'user', tenantId: 'tenant-b' })!;
    assert.deepEqual((await services.intelligence.usage({}, other)).totals, []);

    // Evidence names the provider and the credential by reference; the key is nowhere in FeltDB.
    const evidence = await services.db.collection<{ capability: string; provider?: string; credentialRef?: string }>('service_effect_evidence').list();
    assert.ok(evidence.some((row) => row.capability === 'intelligence.transcribe' && row.provider === 'custom' && row.credentialRef === 'credential-ref:stt'));
    const everything = JSON.stringify(await Promise.all(['service_effect_evidence', 'intelligence_usage', 'ConfigurationSecrets'].map((name) => services.db.collection(name).list())));
    assert.ok(!everything.includes('sk-test-provider-key'));
  } finally {
    await ai.close();
  }
});

test('S3: denial reaches no provider; provider failures and unsupported providers are explicit; usage is estimated when unreported', async () => {
  const ai = await mockAi();
  try {
    const authority = new TestAuthority();
    const { services, host } = open({ authority });
    await authority.grant({ subject: 'host-1', capability: 'intelligence.write' });
    await services.intelligence.set({ modality: 'embeddings', provider: 'custom', model: 'embed', endpoint: ai.url }, host);
    await assert.rejects(services.intelligence.embed({ input: 'x' }, host), /AuthBoundry denied intelligence\.embed/);
    assert.equal(ai.requests.length, 0);
    await authority.grant({ subject: 'host-1', capability: 'intelligence.embed' });
    ai.omitUsage = true;
    const estimated = await services.intelligence.embed({ input: 'twelve chars' }, host);
    assert.deepEqual([estimated.usage.units, estimated.usage.estimated, estimated.usage.priced], [3, true, false]);
    ai.status = 500;
    await assert.rejects(services.intelligence.embed({ input: 'x' }, host), (error: unknown) => isServiceAuthorityError(error) && error.code === 'PROVIDER_ERROR');
    await assert.rejects(services.intelligence.set({ modality: 'transcription', provider: 'anthropic', model: 'claude-haiku-4-5-20251001', credentialRef: 'credential-ref:a' }, host), /does not offer transcription/);
    await assert.rejects(services.intelligence.transcribe({ audio: Buffer.from('x') }, host), /AuthBoundry denied|not configured/);
  } finally {
    await ai.close();
  }
});

test('S3: a host adapter replaces the provider; transcribe reads a stored file', async () => {
  const calls: string[] = [];
  const adapter: IntelligenceProviderAdapter = {
    id: 'custom',
    async transcribe(request, io) { calls.push(`${io.model}:${Buffer.from(request.audio).toString()}:${request.filename}`); return { text: 'from adapter', durationSeconds: 2 }; },
  };
  const { services, host } = open({ extra: { intelligenceProviders: [adapter] } });
  await services.intelligence.set({ modality: 'transcription', provider: 'custom', model: 'local-stt', endpoint: 'http://127.0.0.1:1/v1' }, host);
  const file = await services.files.upload({ name: 'call.ogg', contentType: 'audio/ogg', data: Buffer.from('ogg!') }, host);
  const result = await services.intelligence.transcribe({ fileId: file.id }, host);
  assert.deepEqual([result.text, calls], ['from adapter', ['local-stt:ogg!:call.ogg']]);
});

test('S4: outbound connector: allowlisted hosts, credential by reference, evidence, and refusals', async () => {
  const received: { url: string; authorization?: string; apiKey?: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ url: req.url ?? '', ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}), ...(req.headers['xi-api-key'] ? { apiKey: String(req.headers['xi-api-key']) } : {}), body });
      if (req.url?.startsWith('/redirect')) { res.writeHead(302, { location: 'http://169.254.169.254/' }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'session=abc' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const custody = new MemoryCustody();
  await custody.store({ reference: { secretId: 'turn', tenantId: 'tenant-a' }, value: 'turn-secret-value', context: SETUP });
  await custody.store({ reference: { secretId: 'stt', tenantId: 'tenant-a' }, value: 'stt-secret-value', context: SETUP });
  try {
    const authority = new TestAuthority();
    const { services, host } = open({ authority, custody, extra: { connectors: [
      { id: 'turn', baseUrl: `${base}/api/`, credentialRef: 'credential-ref:turn', allowedMethods: ['POST', 'GET'] },
      { id: 'stt', baseUrl: base, credentialRef: 'credential-ref:stt', auth: { type: 'header', name: 'xi-api-key' } },
    ] } });
    await assert.rejects(services.connectors.request({ connector: 'turn', method: 'POST', path: 'credentials', json: { ttl: 60 } }, host), /AuthBoundry denied connectors\.request/);
    assert.equal(received.length, 0, 'a denied request never leaves');
    await authority.grant({ subject: 'host-1', capability: 'connectors.request', attributes: { connector: 'turn' } });
    await authority.grant({ subject: 'host-1', capability: 'connectors.read' });

    const response = await services.connectors.request({ connector: 'turn', method: 'POST', path: 'credentials', query: { region: 'eu' }, json: { ttl: 60 }, requestId: 'req-42' }, host);
    assert.deepEqual([response.status, response.ok, response.json], [200, true, { ok: true, path: '/api/credentials?region=eu' }]);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.deepEqual(received[0], { url: '/api/credentials?region=eu', authorization: 'Bearer turn-secret-value', body: '{"ttl":60}' });

    // The grant was for the turn connector only.
    await assert.rejects(services.connectors.request({ connector: 'stt', path: '/v1/x' }, host), /AuthBoundry denied/);
    await authority.grant({ subject: 'host-1', capability: 'connectors.request', attributes: { connector: 'stt' } });
    await services.connectors.request({ connector: 'stt', method: 'POST', path: '/v1/x', body: 'audio' }, host);
    assert.equal(received.at(-1)!.apiKey, 'stt-secret-value');

    // Refusals before anything is sent.
    await assert.rejects(services.connectors.request({ connector: 'turn', path: 'http://example.com/x' }, host), (error: unknown) => isServiceAuthorityError(error) && error.details.reason === 'host_not_allowed');
    await assert.rejects(services.connectors.request({ connector: 'turn', path: 'x', headers: { Authorization: 'Bearer raw' } }, host), /carries credentials/);
    await assert.rejects(services.connectors.request({ connector: 'turn', method: 'DELETE', path: 'x' }, host), /does not allow DELETE/);
    await assert.rejects(services.connectors.request({ connector: 'nope', path: 'x' }, host), /not defined/);
    // Redirects are returned, never followed.
    const redirect = await services.connectors.request({ connector: 'turn', path: `${base}/redirect` }, host);
    assert.equal(redirect.status, 302);

    // Evidence: the connector as provider, the credential by reference, the caller's request id.
    const evidence = (await services.evidence.findByRunId('none')).records;
    assert.deepEqual(evidence, []);
    const rows = await services.db.collection<{ capability: string; provider?: string; credentialRef?: string; requestId: string; outcome: string }>('service_effect_evidence').list();
    const turn = rows.find((row) => row.requestId === 'req-42')!;
    assert.deepEqual([turn.capability, turn.provider, turn.credentialRef, turn.outcome], ['connectors.request', 'turn', 'credential-ref:turn', 'succeeded']);
    assert.ok(!JSON.stringify(rows).includes('secret-value'));
    assert.deepEqual((await services.connectors.list({}, host)).map((connector) => [connector.id, connector.credentialConfigured, connector.auth]), [['turn', true, 'bearer'], ['stt', true, 'header']]);
    assert.ok(!JSON.stringify(await services.invoke('connectors.read', {}, { principal: host })).includes('secret'));

    // Without the trusted private-network policy, a loopback connector is refused.
    const strict = createServices({ memory: true, namespace: `strict-${crypto.randomUUID()}`, application: 'meetings', authorizer: new TestAuthority({ allowAll: true }), credentials: custody, connectors: [{ id: 'turn', baseUrl: base, credentialRef: 'credential-ref:turn' }] } as never);
    const strictHost = strict.identify({ principalId: 'host-1', principalType: 'user', tenantId: 'tenant-a' })!;
    await assert.rejects(strict.connectors.request({ connector: 'turn', path: 'x' }, strictHost), /private, loopback/);
    assert.throws(() => createServices({ memory: true, namespace: `bad-${crypto.randomUUID()}`, connectors: [{ id: 'bad', baseUrl: base, credentialRef: 'sk-raw' }] } as never), /never a raw secret/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('S5: e-mail and push reach a non-user contact through pluggable transports', async () => {
  const email = new RecordingEmailTransport();
  const push = new RecordingPushTransport();
  const authority = new TestAuthority();
  const { services, host } = open({ authority, extra: { notificationChannels: [new EmailNotificationChannel({ transport: email, identity: 'invites' }), new PushNotificationChannel({ transport: push })] } });
  const invite = { contact: { email: 'guest@example.com', name: 'Guest' }, type: 'meeting.invite', title: 'You are invited', body: 'Join at 10:00', channels: ['email'] };
  await assert.rejects(services.notifications.notify(invite, host), /AuthBoundry denied notifications\.send/);
  assert.equal(email.sent.length, 0);
  await authority.grant({ subject: 'host-1', capability: 'notifications.send', attributes: { recipientKind: 'contact' } });
  const sent = await services.notifications.notify(invite, host);
  assert.match(sent.notification.recipient, /^contact:[0-9a-f]{32}$/);
  assert.deepEqual(sent.notification.contact, { email: 'guest@example.com', name: 'Guest' });
  assert.equal(sent.deliveries[0]!.status, 'delivered');
  assert.deepEqual([email.sent[0]!.to, email.sent[0]!.subject, email.sent[0]!.identity], ['guest@example.com', 'You are invited', 'invites']);
  // Push to a contact's device; an unregistered device fails for good.
  const reminder = await services.notifications.notify({ contact: { device: 'device-token-1' }, type: 'meeting.reminder', title: 'Starting soon', channels: ['push'] }, host);
  assert.equal(reminder.deliveries[0]!.status, 'delivered');
  assert.deepEqual([push.sent[0]!.device, push.sent[0]!.title, push.sent[0]!.data.type], ['device-token-1', 'Starting soon', 'meeting.reminder']);
  push.reject('device-token-2');
  const gone = await services.notifications.notify({ contact: { device: 'device-token-2' }, type: 'meeting.reminder', title: 'Starting soon', channels: ['push'] }, host);
  assert.deepEqual([gone.deliveries[0]!.status, gone.deliveries[0]!.failureReason], ['failed', 'device_unregistered']);
  // A contact without the channel's address fails without retry; validation refuses bad contacts.
  const noEmail = await services.notifications.notify({ contact: { device: 'd' }, type: 'x', title: 'x', channels: ['email'] }, host);
  assert.deepEqual([noEmail.deliveries[0]!.status, noEmail.deliveries[0]!.failureReason], ['failed', 'no_email_address']);
  await assert.rejects(services.notifications.notify({ contact: { email: 'not-an-address' }, type: 'x', title: 'x', channels: ['email'] }, host), /contact\.email/);
  await assert.rejects(services.notifications.notify({ recipient: 'contact:abc', type: 'x', title: 'x' }, host), /may not start with/);
});
