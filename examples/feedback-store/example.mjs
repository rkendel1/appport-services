// Durable agent feedback: an AppPort SDK provider backed by FeltDB through AppPort Services.
//
//   npm run build && node examples/feedback-store/example.mjs [state-directory]
//
// A provider accepts a report, "restarts" (closes FeltDB and opens it again), continues the lifecycle, and the reporting
// agent reads the resolution: nothing is lost across the restart. Uses the published packages only.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFeltDB } from '@feltdb/core';
import {
  asserted, createApplication, createClient, createFeedbackClient, createFeedbackProvider,
  createInProcessTransport, createServer, permissionAuthorizer, withheld,
} from '@appport/sdk';
import { FeltDbFeedbackStore } from '@appport/services';

const path = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'feedback-example-'));
const TENANT = 'tenant-a';
const reporter = { id: 'ses_procurement', applicationId: 'com.example.invoicing', createdAt: new Date().toISOString(), principal: { id: 'svc_procurement', type: 'service' }, permissions: ['feedback.submit'] };

/** One provider process: FeltDB (durable local files, shared so several processes may open it), the store, the SDK provider. */
function startProvider() {
  const db = createFeltDB({ mode: 'local', namespace: 'feedback', path, access: 'shared' });
  const store = new FeltDbFeedbackStore(db, { tenantId: TENANT });
  const feedback = createFeedbackProvider({ product: { id: 'com.example.invoicing' }, store, actor: { kind: 'agent', id: 'invoicing-maintainer' } });
  const application = createApplication({
    application: { id: 'com.example.invoicing', name: 'Invoicing', version: '3.2.0' },
    capabilities: [...feedback.capabilities],
    authorizer: permissionAuthorizer(),
    extensions: [...feedback.extensions],
    attributes: { ...feedback.attributes },
    mode: 'production',
  });
  const server = createServer({ application, authenticate: () => ({}) });
  // The reporter's identity comes from authentication (here: bound to the in-process connection), never from the report.
  const client = createClient({ transport: createInProcessTransport({ server, identity: { session: reporter, principal: reporter.principal } }) });
  return { db, store, feedback, consumer: createFeedbackClient(client, { agent: { id: 'procurement-agent', version: '4.1.0' } }) };
}

// 1. The agent reports friction. The receipt is answered only after FeltDB committed the record.
let provider = startProvider();
const { feedbackId, receipt, report } = await provider.consumer.submit({
  category: 'unexpected_behavior',
  severity: 'high',
  summary: 'invoices.create@2 rejects ISO dates the schema documents as valid',
  expected: 'dueDate 2026-12-01 is accepted.',
  observed: 'INVALID_INPUT: dueDate must be a string.',
  reproduction: { steps: ['call invoices.create@2 with dueDate 2026-12-01'], errorCode: 'INVALID_INPUT' },
  evidence: [{ kind: 'response', mediaType: 'application/json', content: '{"ok":false,"error":{"code":"INVALID_INPUT"}}', source: 'observed' }],
  context: { correlationId: 'task_month_end_0042', taskCategory: asserted('invoice.creation'), originatingApplication: withheld() },
});
await provider.feedback.acknowledge(feedbackId);
await provider.feedback.investigate(feedbackId);

// 2. The provider process stops (deploy, crash, scale-in) and a new one starts on the same state.
await provider.db.close();
provider = startProvider();

// 3. The new process finds the record, continues its lifecycle, and the agent's retry replays the original receipt.
await provider.feedback.accept(feedbackId);
await provider.feedback.startWork(feedbackId);
await provider.feedback.markVerified(feedbackId, { method: 'Regression tests for ISO 8601 dueDate values.' });
await provider.feedback.resolve(feedbackId, { summary: 'Fixed in 3.2.1.', retry: { action: 'retry_after_upgrade', upgrade: { api: '3.2.1' } } });
const replay = await provider.consumer.resubmit(report);

// 4. The agent reads the resolution; the provider sees its queue without report content.
const status = await provider.consumer.status(feedbackId);
const queue = await provider.store.list();
await provider.db.close();

console.log(JSON.stringify({
  feedbackId,
  replayedSameReceipt: JSON.stringify(replay.receipt) === JSON.stringify(receipt),
  transitions: status.updates.map((u) => u.to),
  state: status.state,
  next: status.updates.at(-1).resolution.retry,
  queue: queue.map((h) => ({ feedbackId: h.feedbackId, state: h.state, category: h.category })),
}, null, 2));
