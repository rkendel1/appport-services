/**
 * The real AppPort SDK feedback provider and consumer (`@appport/sdk` >= 1.7.0) around a given FeedbackStore, in one
 * process over the in-process transport. The SDK decides everything; the store under test only stores.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFeltDB, defineStateContract, field, type StateFirstDB } from '@feltdb/core';
import {
  asserted,
  createApplication,
  createClient,
  createFeedbackClient,
  createFeedbackProvider,
  createInProcessTransport,
  createServer,
  defineCapability,
  permissionAuthorizer,
  s,
  unavailable,
  withheld,
  type FeedbackReportInput,
  type FeedbackStore,
} from '@appport/sdk';

import { feedbackStoreContract } from '../../src/storage/feedback.js';

export const PRODUCT = 'com.example.invoicing';

const session = (id: string, principal: string, permissions: string[]) => ({
  id,
  applicationId: PRODUCT,
  createdAt: new Date().toISOString(),
  principal: { id: principal, type: 'service' as const },
  permissions,
});
export const SESSIONS = {
  reporter: session('ses_reporter', 'svc_procurement', ['feedback.submit']),
  other: session('ses_other', 'svc_other', ['feedback.submit']),
};

export async function feedbackRig(store: FeedbackStore) {
  const provider = createFeedbackProvider({
    product: { id: PRODUCT },
    store,
    actor: { kind: 'agent', id: 'invoicing-maintainer' },
    initialRetry: () => ({ action: 'use_alternative', alternative: { capability: { name: 'invoices.create', version: 1 } } }),
  });
  const application = createApplication({
    application: { id: PRODUCT, name: 'Invoicing', version: '3.2.0' },
    capabilities: [
      defineCapability({ name: 'invoices.create', version: 2, authorization: ['invoices.write'], effect: 'consequential', input: s.object({ dueDate: s.string() }), output: s.object({ id: s.string() }), handler: () => ({ id: 'inv_1' }) }),
      ...provider.capabilities,
    ],
    authorizer: permissionAuthorizer(),
    extensions: [...provider.extensions],
    attributes: { ...provider.attributes },
    mode: 'production',
  });
  const server = createServer({ application, authenticate: () => ({}) });
  const as = (who: keyof typeof SESSIONS) => createFeedbackClient(
    createClient({ transport: createInProcessTransport({ server, identity: { session: SESSIONS[who], principal: SESSIONS[who].principal } }) }),
    { agent: { id: `${who}-agent`, version: '1.0.0' } },
  );
  let n = 0;
  const report = (extra: Partial<FeedbackReportInput> = {}): FeedbackReportInput => {
    n += 1;
    return {
      category: 'unexpected_behavior',
      severity: 'high',
      summary: `invoices.create@2 rejects documented ISO dates (${n})`,
      expected: 'dueDate 2026-12-01 is accepted.',
      observed: 'INVALID_INPUT: dueDate must be a string.',
      capability: 'invoices.create@2',
      reproduction: { steps: ['call invoices.create@2 with dueDate 2026-12-01'], errorCode: 'INVALID_INPUT' },
      evidence: [{ kind: 'response', mediaType: 'application/json', content: '{"ok":false,"error":{"code":"INVALID_INPUT"}}', source: 'observed' }],
      context: {
        correlationId: 'task_month_end_0042',
        runtime: asserted({ name: 'node', version: '22.0.0' }),
        originatingApplication: withheld(),
        parentAgent: unavailable(),
        taskCategory: asserted('invoice.creation'),
        integrationMechanism: asserted('sdk'),
      },
      ...extra,
    };
  };
  return { provider, application, reporter: as('reporter'), other: as('other'), report };
}

/** A FeltDB state contract with exactly the store's declarations (the mapping FeltKit uses). */
export function feedbackStateContract() {
  type Spec = ReturnType<typeof field.string>;
  const fragment = feedbackStoreContract();
  const collections: Record<string, { fields: Record<string, Spec>; indexes?: Array<{ name: string; fields: string[] }> }> = {};
  for (const collection of fragment.collections) {
    const fields: Record<string, Spec> = {};
    for (const f of collection.fields) {
      if (f.name === 'id') continue;
      const options = { required: false, nullable: true } as const;
      fields[f.name] = (f.type === 'text' ? field.string(options) : f.type === 'integer' ? field.integer(options) : field.json(options)) as Spec;
    }
    collections[collection.name] = { fields };
  }
  for (const index of fragment.indexes) (collections[index.collection]!.indexes ??= []).push({ name: index.name, fields: [...index.fields] });
  return defineStateContract({ name: 'feedback-host', version: 1, collections } as never);
}

/** A persisted FeltDB at `path` (new unless given) enforcing exactly the store's contract. Shared access, like several provider processes. */
export async function openFeedbackDb(path?: string): Promise<{ db: StateFirstDB; path: string }> {
  const dir = path ?? (await mkdtemp(join(tmpdir(), 'feedback-store-')));
  const db = createFeltDB({ mode: 'local', namespace: 'feedback', path: dir, access: 'shared' } as never);
  if (!(await db.stateContract.active())) await db.stateContract.evolve(feedbackStateContract() as never);
  return { db, path: dir };
}
