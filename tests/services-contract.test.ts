import assert from 'node:assert/strict';
import test from 'node:test';

import * as api from '../src/index.js';
import { SERVICE_COLLECTIONS, SERVICE_INDEXES, SERVICE_NAMES, SERVICE_REQUIREMENTS, servicesContract, type ServiceName, type ServicesContractField } from '../src/contract/services-contract.js';
import { exercise, type JsonType } from './support/contract-exerciser.js';
import { recordTypes } from './support/record-types.js';

/** FeltDB's own value check (feltdb::state_contract::valid_type) for the types declared here. */
function accepts(field: ServicesContractField, type: JsonType): boolean {
  if (type === 'null') return field.nullable;
  switch (field.type) {
    case 'text': return type === 'string';
    case 'integer': return type === 'integer';
    case 'number': return type === 'integer' || type === 'number';
    case 'boolean': return type === 'boolean';
    case 'json': return true;
  }
}

for (const service of SERVICE_NAMES) {
  test(`${service}: every record its write paths commit is declared, with values of the declared types`, async () => {
    const observed = await exercise(service);
    const declared = new Map(servicesContract([service]).collections.map((c) => [c.name, c]));
    const problems: string[] = [];
    for (const [collection, fields] of observed) {
      const declaration = declared.get(collection);
      if (!declaration) {
        problems.push(`${collection}: written by ${service}, not in servicesContract(['${service}'])`);
        continue;
      }
      for (const [name, types] of fields) {
        if (name === 'id') continue;
        const field = declaration.fields.find((f) => f.name === name);
        if (!field) problems.push(`${collection}.${name}: written, not declared`);
        else for (const type of types) if (!accepts(field, type)) problems.push(`${collection}.${name}: a ${type} value, declared ${field.type}${field.nullable ? ' (nullable)' : ''}`);
      }
    }
    // No stale declarations: everything this service declares it stores, it does store.
    for (const name of ['service_effect_evidence', ...SERVICE_REQUIREMENTS[service].collections]) {
      if (!observed.has(name)) problems.push(`${name}: declared for ${service}, never written by its write paths`);
    }
    assert.deepEqual(problems, []);
  });
}

test('each declaration is exactly the record its store writes (TypeScript types of the stored records)', () => {
  const types = recordTypes();
  assert.deepEqual([...types.keys()].sort(), Object.keys(SERVICE_COLLECTIONS).sort(), 'a collection per stored record type');
  const problems: string[] = [];
  for (const [name, fields] of types) {
    const declared = SERVICE_COLLECTIONS[name]!.fields;
    const recordFields = fields.filter((f) => f.name !== '__version');
    for (const field of recordFields) {
      const declaration = declared.find((d) => d.name === field.name);
      if (!declaration) {
        problems.push(`${name}.${field.name}: in the record type, not declared`);
        continue;
      }
      const ok = field.kind === 'numeric' ? declaration.type === 'integer' || declaration.type === 'number' : declaration.type === field.kind;
      if (!ok) problems.push(`${name}.${field.name}: record type is ${field.kind}, declared ${declaration.type}`);
      if (field.optional && !declaration.nullable && declaration.name !== 'id') problems.push(`${name}.${field.name}: optional in the record, declared non-nullable`);
    }
    for (const declaration of declared) {
      if (!recordFields.some((f) => f.name === declaration.name)) problems.push(`${name}.${declaration.name}: declared, not in the record type`);
    }
  }
  assert.deepEqual(problems, []);
});

test('declarations follow FeltDB conventions: id is required text, everything else nullable and optional, no __version', () => {
  for (const c of Object.values(SERVICE_COLLECTIONS)) {
    assert.deepEqual(c.fields.find((f) => f.name === 'id'), { name: 'id', type: 'text', required: true, nullable: false }, c.name);
    for (const f of c.fields) if (f.name !== 'id') assert.deepEqual([f.required, f.nullable], [false, true], `${c.name}.${f.name}`);
    assert.ok(!c.fields.some((f) => f.name === '__version'), c.name);
    assert.equal(new Set(c.fields.map((f) => f.name)).size, c.fields.length, `${c.name}: no field twice`);
  }
});

test('every tenant-scoped read is index-backed, as an application-scoped FeltDB authority requires', () => {
  // feltdb::state_contract: a query filtered on one of these fields is answered only through a
  // schema-declared equality index (else INDEX_UNAVAILABLE). Every store reads within a tenant.
  const scopeFields = ['tenant_id', 'tenantId', 'organization_id', 'organizationId', 'scope_prefix'];
  const fragment = servicesContract('all');
  for (const c of fragment.collections) {
    const scoped = c.fields.filter((f) => scopeFields.includes(f.name)).map((f) => f.name);
    assert.ok(scoped.length, `${c.name}: its stores read by tenant, so it declares tenantId`);
    const indexes = fragment.indexes.filter((i) => i.collection === c.name);
    for (const field of scoped) assert.ok(indexes.some((i) => i.fields.includes(field)), `${c.name}: an equality index on ${field}`);
  }
  for (const index of fragment.indexes) {
    const declared = SERVICE_COLLECTIONS[index.collection];
    assert.ok(declared, `${index.name}: on a declared collection`);
    for (const field of index.fields) assert.ok(declared.fields.some((f) => f.name === field), `${index.name}: ${field} is a declared field`);
  }
  assert.equal(new Set(fragment.indexes.map((i) => i.name)).size, fragment.indexes.length, 'index names are unique');
  assert.deepEqual(Object.keys(SERVICE_INDEXES).sort(), Object.keys(SERVICE_COLLECTIONS).sort());
});

test('composition is deterministic: same services, same fragment, whatever the order; each collection once; dependencies included', () => {
  const a = servicesContract(['schedules', 'files', 'intelligence', 'configuration']);
  const b = servicesContract(['configuration', 'intelligence', 'files', 'schedules', 'files']);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const names = a.collections.map((c) => c.name);
  assert.deepEqual(names, [...names].sort(), 'name order');
  assert.equal(new Set(names).size, names.length, 'no collection twice');
  assert.ok(names.includes('jobs'), 'schedules brings jobs');
  assert.ok(names.includes('service_effect_evidence'), 'evidence for every effect');
  assert.deepEqual(a.indexes.map((i) => i.collection), names, 'an index per collection, in the same order');
  assert.deepEqual(servicesContract([]), { collections: [], indexes: [] });
  assert.deepEqual(servicesContract('all').collections.map((c) => c.name), Object.keys(SERVICE_COLLECTIONS).sort());
  assert.throws(() => servicesContract(['files', 'nope' as ServiceName]), /Unknown AppPort service "nope"/);
  // The fragment is frozen: a host composes it, it does not edit it.
  assert.throws(() => (a.collections as unknown as unknown[]).push({}));
});

test('the contract is part of the public API', () => {
  assert.equal(api.servicesContract, servicesContract);
  assert.equal(api.SERVICE_COLLECTIONS, SERVICE_COLLECTIONS);
  assert.equal(typeof api.SERVICES_CONTRACT_VERSION, 'number');
});
