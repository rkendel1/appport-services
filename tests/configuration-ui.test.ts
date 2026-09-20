import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import express from 'express';

import { createConfigurationUiRouter } from '../src/_internal.js';

test('configuration UI exposes pages for all services', async () => {
  const app = express();
  app.use(createConfigurationUiRouter());
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;

  try {
    const services = await fetch(`${base}/services`).then((response) => response.text());
    const apiKeys = await fetch(`${base}/api-keys`).then((response) => response.text());
    const jobs = await fetch(`${base}/jobs`).then((response) => response.text());
    const schedules = await fetch(`${base}/schedules`).then((response) => response.text());
    const files = await fetch(`${base}/files`).then((response) => response.text());
    const secrets = await fetch(`${base}/secrets`).then((response) => response.text());
    const webhooks = await fetch(`${base}/webhooks`).then((response) => response.text());
    const notifications = await fetch(`${base}/notifications`).then((response) => response.text());

    for (const label of ['API Keys', 'Jobs', 'Schedules', 'Files', 'Secrets', 'Webhooks', 'Notifications']) {
      assert.match(services, new RegExp(label));
    }
    assert.match(apiKeys, /Create API key/);
    assert.match(apiKeys, /method:'POST'/);
    assert.match(jobs, /Queue durable work/);
    assert.match(jobs, /method:'POST'/);
    assert.match(secrets, /Provider-neutral secret metadata/);
    assert.match(webhooks, /Register durable event endpoints/);
    assert.match(notifications, /Create durable notification records/);
    assert.match(files, /Create durable file metadata records/);
    assert.match(files, /method:'POST'/);
    assert.match(schedules, /plain English/);
    assert.match(schedules, /Every 15 minutes/);
    assert.doesNotMatch(schedules, /cron/i);
    assert.match(webhooks, /Register endpoint/);
    assert.match(notifications, /Create durable notification records/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
