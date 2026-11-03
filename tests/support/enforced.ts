/**
 * AppPort Services on a persisted FeltDB that enforces the services' own declared contract
 * (`servicesContract`), as a host composes it (FeltKit, AppBoundry, Managed FeltDB): every
 * record a transaction writes must be declared, or FeltDB refuses the whole transaction.
 *
 * The host's own collections here are `invoices` (application state) and `outbox` (the record a host marks done when the effect it
 * describes is created), so a test can put an effect and its completion in one transaction.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineStateContract, field, type StateFirstDB } from '@feltdb/core';

import { createServices, type AppPortServices } from '../../src/index.js';
import { servicesContract, type ServicesContractFragment } from '../../src/contract/services-contract.js';
import { TestAuthority } from './authority.js';

/** The host's outbox record. */
export const OUTBOX = 'outbox';

type Spec = ReturnType<typeof field.string>;

/** A FeltDB state contract from a services fragment (the mapping FeltKit uses), plus the host's outbox. */
export function stateContractFor(fragment: ServicesContractFragment, name = 'services-host') {
  const collections: Record<string, { fields: Record<string, Spec>; indexes?: Array<{ name: string; fields: string[] }> }> = {};
  for (const collection of fragment.collections) {
    const fields: Record<string, Spec> = {};
    for (const f of collection.fields) {
      if (f.name === 'id') continue;
      const options = { required: f.required && !f.nullable, nullable: f.nullable } as const;
      fields[f.name] = (f.type === 'text' ? field.string(options) : f.type === 'integer' ? field.integer(options) : f.type === 'number' ? field.number(options) : f.type === 'boolean' ? field.boolean(options) : field.json(options)) as Spec;
    }
    collections[collection.name] = { fields };
  }
  for (const index of fragment.indexes) (collections[index.collection]!.indexes ??= []).push({ name: index.name, fields: [...index.fields] });
  collections[OUTBOX] = { fields: { state: field.string({ required: true }), effect: field.string({ required: true }), result: field.json() as Spec } };
  // An application record a transaction may write beside its effects.
  collections.invoices = { fields: { total: field.integer({ required: true }) as Spec } };
  return defineStateContract({ name, version: 1, collections } as never);
}

export interface Enforced {
  readonly services: AppPortServices;
  readonly db: StateFirstDB;
  readonly path: string;
  readonly principal: NonNullable<ReturnType<AppPortServices['identify']>>;
  readonly tenantId: string;
  close(): Promise<void>;
}

/**
 * Services on `path` (a new directory unless given), with `fragment`'s contract installed (the
 * current declarations unless given) unless the store already has one: a reopen keeps the
 * installed contract, as a restarted host does.
 */
export async function openEnforced(options: { path?: string; fragment?: ServicesContractFragment } = {}): Promise<Enforced> {
  const path = options.path ?? (await mkdtemp(join(tmpdir(), 'services-enforced-')));
  const services = createServices({ mode: 'local', namespace: 'services-enforced', path, authorizer: new TestAuthority({ allowAll: true }), application: 'host-app', webhookDestinationPolicy: { lookup: async () => [{ address: '93.184.216.34', family: 4 as const }] } } as never);
  const db = services.db as StateFirstDB;
  if (!(await db.stateContract.active())) await db.stateContract.evolve(stateContractFor(options.fragment ?? servicesContract('all')) as never);
  const tenantId = 'tenant-a';
  const principal = services.identify({ principalId: 'alice', principalType: 'user', tenantId })!;
  return { services, db, path, principal, tenantId, close: () => (services as { close?: () => Promise<void> }).close?.() ?? db.close() };
}

/** Every record of `collection` (FeltDB's own read: the id is the storage key). */
export async function all(db: StateFirstDB, collection: string): Promise<Array<Record<string, unknown> & { id: string }>> {
  return (await db.collection<Record<string, unknown> & { id: string }>(collection).find({} as never)) as Array<Record<string, unknown> & { id: string }>;
}
