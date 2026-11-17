import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import express from 'express';

import { createFeltDbRuntime, FeltDbNotificationAuditSink, FeltDbNotificationDeliveryStore, FeltDbNotificationStore } from '../src/_internal.js';
import { ServiceAuthorityError } from '../src/authority/errors.js';
import type { AuthenticatedPrincipal } from '../src/contract/principals.js';
import { createNotificationRouter, notificationErrorHandler } from '../src/notifications/http.js';
import type { Notification } from '../src/notifications/models.js';
import {
  NOTIFICATION_MARK_ALL_READ_LIMIT, NotificationAuthorizationError, NotificationService, NotificationValidationError,
} from '../src/notifications/service.js';
import { NOTIFICATIONS_BY_RECIPIENT_INDEX, NOTIFICATIONS_BY_RECIPIENT_TYPE_INDEX, type NotificationStore } from '../src/storage/notifications.js';
import { principal as verified, testGateway, TestAuthority } from './support/authority.js';

/**
 * NotificationService.inbox / unreadCount / markAllRead: one recipient's notifications, newest first
 * (createdAt desc, id asc), read in bounded pages from the recipient timeline index on a real
 * local FeltDB. No store mocks.
 */
const who = (id: string) => verified({ principalId: id, principalType: 'user', tenantId: 'tenant-a' });
const isDenied = (error: unknown) => error instanceof ServiceAuthorityError && error.code === 'DENIED';
const invalidCursor = (error: unknown) => error instanceof NotificationValidationError && /Invalid cursor/.test(error.message);
/** The inbox order: newest first, ties by id ascending (FeltDB's tie order in every runtime). */
const order = (a: Notification, b: Notification) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

async function setup() {
  const authority = new TestAuthority();
  for (const subject of ['alice', 'bob']) {
    await authority.grant({ subject, capability: 'notifications.read', tenantId: 'tenant-a', attributes: { recipient: subject } });
    await authority.grant({ subject, capability: 'notifications.update', tenantId: 'tenant-a', attributes: { recipient: subject } });
  }
  // A reader only: may page but not mark.
  await authority.grant({ subject: 'carol', capability: 'notifications.read', tenantId: 'tenant-a', attributes: { recipient: 'carol' } });
  await authority.grant({ subject: 'sender', capability: 'notifications.send', tenantId: 'tenant-a' });
  const runtime = createFeltDbRuntime({ mode: 'local', namespace: `paging-${Math.random()}`, path: await mkdtemp(join(tmpdir(), 'appport-paging-')) });
  const store = new FeltDbNotificationStore(runtime.db);
  const auditSink = new FeltDbNotificationAuditSink(runtime.db);
  const service = new NotificationService({
    store, deliveryStore: new FeltDbNotificationDeliveryStore(runtime.db), auditSink, authority: testGateway(runtime.db, { authorizer: authority }),
  });
  const application = service['gateway']().application;
  /** Records straight to the store, with chosen timestamps: many share one createdAt. */
  const fill = async (count: number, recipient: string, options: { prefix?: string; stamps?: number; types?: readonly string[]; readEvery?: number; tenantId?: string } = {}) => {
    const created: Notification[] = [];
    for (let i = 0; i < count; i++) {
      const second = String(i % (options.stamps ?? 7)).padStart(2, '0');
      const item: Notification = {
        id: `${options.prefix ?? recipient}-${String(i).padStart(4, '0')}`, tenantId: options.tenantId ?? 'tenant-a', applicationId: application, recipient,
        type: options.types ? options.types[i % options.types.length]! : 'post.liked', title: 't', priority: 'normal', channels: ['in-app'], status: 'delivered',
        createdAt: `2026-11-01T10:00:${second}.000Z`, createdBy: 'sender',
        ...(options.readEvery && i % options.readEvery === 0 ? { readAt: '2026-11-02T00:00:00.000Z' } : {}),
        __version: 1,
      } as Notification;
      await store.create(item);
      created.push(item);
    }
    return created;
  };
  return { runtime, store, service, fill, application, close: () => runtime.db.close() };
}

/** Every page of the inbox, following nextCursor. */
async function walk(service: NotificationService, as: AuthenticatedPrincipal, options: { limit: number; unread?: boolean; type?: string }) {
  const pages: Notification[][] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 1_000; guard++) {
    const page = await service.inbox('tenant-a', { ...options, ...(cursor ? { cursor } : {}) }, as);
    assert.ok(page.items.length <= options.limit);
    pages.push([...page.items]);
    if (!page.nextCursor) return pages;
    cursor = page.nextCursor;
  }
  throw new Error('walk did not end');
}

/** Captures what each FeltDB query asked for and how many records it examined. */
function spyQueries(db: unknown) {
  const target = db as { query: (request: { collection: string; limit: number; where?: unknown }) => Promise<{ stats?: { scanned: number; usedIndex: boolean; indexName?: string } }> };
  const calls: Array<{ limit: number; scanned?: number; index?: string }> = [];
  const original = target.query.bind(target);
  target.query = async (request) => {
    const page = await original(request);
    if (request.collection === 'notifications') calls.push({ limit: request.limit, scanned: page.stats?.scanned, index: page.stats?.usedIndex ? page.stats.indexName : undefined });
    return page;
  };
  return { calls, restore: () => { target.query = original; } };
}

test('pages never skip or repeat: 250 notifications over 7 timestamps, newest first, ties by id', async () => {
  const t = await setup();
  try {
    const mine = await t.fill(250, 'alice');
    await t.fill(120, 'bob'); // interleaved in the same tenant and timestamps
    await t.fill(30, 'alice', { prefix: 'other-tenant', tenantId: 'tenant-b' });
    const expected = mine.map((item) => item.id).sort((a, b) => order(mine.find((m) => m.id === a)!, mine.find((m) => m.id === b)!));
    const spy = spyQueries(t.runtime.db);
    let pages: Notification[][];
    try {
      pages = await walk(t.service, who('alice'), { limit: 7 });
    } finally { spy.restore(); }
    const ids = pages.flat().map((item) => item.id);
    assert.equal(ids.length, 250);
    assert.equal(new Set(ids).size, 250, 'no repeats');
    assert.deepEqual(ids, expected, 'createdAt desc, then id asc, across page boundaries inside equal timestamps');
    assert.equal(pages.length, Math.ceil(250 / 7));
    assert.ok(pages.flat().every((item) => item.recipient === 'alice' && item.tenantId === 'tenant-a'));
    // Bounded and index-backed: each page examined at most limit + 1 records, from the recipient index, with one limit.
    assert.ok(spy.calls.length > 0);
    assert.ok(spy.calls.every((call) => call.index === NOTIFICATIONS_BY_RECIPIENT_INDEX), JSON.stringify(spy.calls.slice(0, 3)));
    assert.ok(spy.calls.every((call) => (call.scanned ?? 0) <= 8), `scanned: ${spy.calls.map((call) => call.scanned)}`);
    assert.deepEqual([...new Set(spy.calls.map((call) => call.limit))], [7], 'every page asks for the same limit');
  } finally { await t.close(); }
});

test('a notification inserted between pages neither shifts nor repeats the walk', async () => {
  const t = await setup();
  try {
    await t.fill(20, 'alice', { stamps: 2 });
    const first = await t.service.inbox('tenant-a', { limit: 5 }, who('alice'));
    await t.fill(1, 'alice', { prefix: 'late' }); // same timestamp as half the others, id sorts after them
    const rest: Notification[] = [];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await t.service.inbox('tenant-a', { limit: 5, cursor }, who('alice'));
      rest.push(...page.items);
      cursor = page.nextCursor;
    }
    const seen = [...first.items, ...rest].map((item) => item.id);
    assert.equal(new Set(seen).size, seen.length);
    assert.equal(seen.filter((id) => id.startsWith('alice')).length, 20, 'every original notification exactly once');
  } finally { await t.close(); }
});

test('filters with paging: type (its own index) and unread, alone and together', async () => {
  const t = await setup();
  try {
    const mine = await t.fill(90, 'alice', { types: ['post.liked', 'post.liked', 'user.followed'], readEvery: 4 });
    await t.fill(40, 'bob', { types: ['user.followed'] });
    const expect = (keep: (item: Notification) => boolean) => mine.filter(keep).sort(order).map((item) => item.id);
    const spy = spyQueries(t.runtime.db);
    try {
      const typed = (await walk(t.service, who('alice'), { limit: 4, type: 'user.followed' })).flat().map((item) => item.id);
      assert.deepEqual(typed, expect((item) => item.type === 'user.followed'));
      assert.ok(spy.calls.every((call) => call.index === NOTIFICATIONS_BY_RECIPIENT_TYPE_INDEX), 'the type filter reads its own index');
    } finally { spy.restore(); }
    const unread = (await walk(t.service, who('alice'), { limit: 6, unread: true })).flat().map((item) => item.id);
    assert.deepEqual(unread, expect((item) => !item.readAt));
    const both = (await walk(t.service, who('alice'), { limit: 3, unread: true, type: 'post.liked' })).flat();
    assert.deepEqual(both.map((item) => item.id), expect((item) => !item.readAt && item.type === 'post.liked'));
    assert.ok(both.every((item) => !item.readAt));
    assert.deepEqual((await t.service.inbox('tenant-a', { type: 'nothing.here' }, who('alice'))), { items: [] });
  } finally { await t.close(); }
});

test('a sparse unread filter stops at the examination bound with a cursor, and the walk still completes', async () => {
  const t = await setup();
  try {
    // 60 read, then (older) 3 unread: unread matches are far down the timeline.
    const read = await t.fill(60, 'alice', { prefix: 'b-read', readEvery: 1 });
    const old: Notification[] = [];
    for (let i = 0; i < 3; i++) {
      const item = { ...read[0]!, id: `a-old-${i}`, createdAt: '2026-10-01T00:00:00.000Z', readAt: undefined } as Notification;
      await t.store.create(item);
      old.push(item);
    }
    const first = await t.store.pageByRecipient('tenant-a', 'alice', { limit: 5, unread: true, examine: 10, applicationId: t.application });
    assert.equal(first.records.length, 0, 'nothing unread among the first records examined');
    assert.ok(first.nextCursor, 'stopped at the bound, not at the end');
    const all = (await walk(t.service, who('alice'), { limit: 2, unread: true })).flat().map((item) => item.id);
    assert.deepEqual(all, old.sort(order).map((item) => item.id));
  } finally { await t.close(); }
});

test('cursors: another recipient\'s, another query\'s, a different limit\'s, and tampered cursors are refused', async () => {
  const t = await setup();
  try {
    await t.fill(12, 'alice');
    await t.fill(12, 'bob');
    const bobs = await t.service.inbox('tenant-a', { limit: 5 }, who('bob'));
    assert.ok(bobs.nextCursor);
    await assert.rejects(t.service.inbox('tenant-a', { limit: 5, cursor: bobs.nextCursor }, who('alice')), invalidCursor);
    const alices = await t.service.inbox('tenant-a', { limit: 5 }, who('alice'));
    const cursor = alices.nextCursor!;
    await assert.rejects(t.service.inbox('tenant-a', { limit: 6, cursor }, who('alice')), invalidCursor, 'bound to the limit');
    await assert.rejects(t.service.inbox('tenant-a', { limit: 5, cursor, unread: true }, who('alice')), invalidCursor, 'bound to the filters');
    await assert.rejects(t.service.inbox('tenant-a', { limit: 5, cursor, type: 'post.liked' }, who('alice')), invalidCursor);
    // Tampered: garbage, a flipped character, and a well-formed envelope around a forged store cursor.
    await assert.rejects(t.service.inbox('tenant-a', { limit: 5, cursor: 'not-a-cursor' }, who('alice')), invalidCursor);
    const flipped = cursor.slice(0, 10) + (cursor[10] === 'A' ? 'B' : 'A') + cursor.slice(11);
    await assert.rejects(t.service.inbox('tenant-a', { limit: 5, cursor: flipped }, who('alice')), invalidCursor);
    const envelope = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v: number; b: string; s: string };
    const forgedStore = Buffer.from(JSON.stringify({ c: 'forged-feltdb-cursor' }), 'utf8').toString('base64url');
    const forged = Buffer.from(JSON.stringify({ ...envelope, s: forgedStore }), 'utf8').toString('base64url');
    await assert.rejects(t.service.inbox('tenant-a', { limit: 5, cursor: forged }, who('alice')), invalidCursor);
    // Bob's store cursor inside Alice's envelope: FeltDB's own cursor binding refuses it too.
    const bobStore = (JSON.parse(Buffer.from(bobs.nextCursor!, 'base64url').toString('utf8')) as { s: string }).s;
    const swapped = Buffer.from(JSON.stringify({ ...envelope, s: bobStore }), 'utf8').toString('base64url');
    await assert.rejects(t.service.inbox('tenant-a', { limit: 5, cursor: swapped }, who('alice')), invalidCursor);
    // The genuine cursor still works.
    assert.equal((await t.service.inbox('tenant-a', { limit: 5, cursor }, who('alice'))).items.length, 5);
  } finally { await t.close(); }
});

test('limit bounds: 1–100, integers only; default 50', async () => {
  const t = await setup();
  try {
    await t.fill(120, 'alice');
    for (const limit of [0, -1, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(t.service.inbox('tenant-a', { limit }, who('alice')), /limit must be an integer from 1 to 100/, String(limit));
    }
    assert.equal((await t.service.inbox('tenant-a', { limit: 1 }, who('alice'))).items.length, 1);
    assert.equal((await t.service.inbox('tenant-a', { limit: 100 }, who('alice'))).items.length, 100);
    assert.equal((await t.service.inbox('tenant-a', {}, who('alice'))).items.length, 50);
    await assert.rejects(t.service.unreadCount('tenant-a', { max: 0 }, who('alice')), /max must be/);
    await assert.rejects(t.service.unreadCount('tenant-a', { max: 501 }, who('alice')), /max must be/);
  } finally { await t.close(); }
});

test('authorization: a principal pages, counts and marks only its own notifications', async () => {
  const t = await setup();
  try {
    await t.fill(5, 'alice');
    await t.fill(5, 'bob');
    await assert.rejects(t.service.inbox('tenant-a', { recipient: 'bob' }, who('alice')), isDenied, 'another recipient needs a grant for that recipient');
    await assert.rejects(t.service.unreadCount('tenant-a', { recipient: 'bob' }, who('alice')), isDenied);
    await assert.rejects(t.service.inbox('tenant-b', {}, who('alice')), (error: unknown) => error instanceof ServiceAuthorityError);
    await assert.rejects(t.service.inbox('tenant-a', {}, who('stranger')), isDenied);
    await assert.rejects(t.service.markAllRead('tenant-a', {}, who('carol')), isDenied, 'paging is not marking: notifications.update is required');
    assert.ok((await t.service.inbox('tenant-a', {}, who('alice'))).items.every((item) => item.recipient === 'alice'));
  } finally { await t.close(); }
});

test('markAllRead marks only the caller\'s, optionally by type; unreadCount follows', async () => {
  const t = await setup();
  try {
    await t.fill(30, 'alice', { types: ['post.liked', 'user.followed'], readEvery: 5 });
    await t.fill(10, 'bob');
    assert.deepEqual(await t.service.unreadCount('tenant-a', {}, who('alice')), { count: 24, complete: true });
    assert.deepEqual(await t.service.unreadCount('tenant-a', { max: 10 }, who('alice')), { count: 10, complete: false });
    assert.deepEqual(await t.service.unreadCount('tenant-a', { type: 'user.followed' }, who('alice')), { count: 12, complete: true });

    assert.deepEqual(await t.service.markAllRead('tenant-a', { type: 'user.followed' }, who('alice')), { marked: 12, complete: true });
    assert.deepEqual(await t.service.unreadCount('tenant-a', {}, who('alice')), { count: 12, complete: true });
    assert.deepEqual(await t.service.markAllRead('tenant-a', {}, who('alice')), { marked: 12, complete: true });
    assert.deepEqual(await t.service.markAllRead('tenant-a', {}, who('alice')), { marked: 0, complete: true }, 'idempotent');
    assert.deepEqual(await t.service.unreadCount('tenant-a', {}, who('alice')), { count: 0, complete: true });

    const alice = (await walk(t.service, who('alice'), { limit: 100 })).flat();
    assert.ok(alice.every((item) => item.readAt));
    assert.equal(alice.filter((item) => item.status === 'read').length, 24, 'the 24 marked now read (6 were read before)');
    assert.deepEqual(await t.service.unreadCount('tenant-a', {}, who('bob')), { count: 10, complete: true }, 'bob\'s are untouched');
    const audits = await t.runtime.db.collection<{ type: string; recipient: string; principalId: string }>('notification_audit_events').find({ type: 'notification.read' });
    assert.equal(audits.length, 24, 'one notification.read audit per notification marked');
    assert.ok(audits.every((event) => event.recipient === 'alice' && event.principalId === 'alice'));
  } finally { await t.close(); }
});

test('markAllRead is bounded per call: complete false at the limit, and the next call finishes', async () => {
  const t = await setup();
  try {
    await t.fill(NOTIFICATION_MARK_ALL_READ_LIMIT + 30, 'alice', { stamps: 3 });
    assert.deepEqual(await t.service.markAllRead('tenant-a', {}, who('alice')), { marked: NOTIFICATION_MARK_ALL_READ_LIMIT, complete: false });
    assert.deepEqual(await t.service.markAllRead('tenant-a', {}, who('alice')), { marked: 30, complete: true });
    assert.deepEqual(await t.service.unreadCount('tenant-a', {}, who('alice')), { count: 0, complete: true });
  } finally { await t.close(); }
});

test('backward compatibility: list(filter) is unchanged, and a store without pageByRecipient is refused, never answered', async () => {
  const t = await setup();
  try {
    const mine = await t.fill(30, 'alice', { types: ['post.liked', 'user.followed'], readEvery: 3 });
    const listed = await t.service.list('tenant-a', { recipient: 'alice', unread: true, type: 'post.liked', limit: 100 }, who('alice'));
    // list keeps its own order (createdAt desc, then id desc) and in-memory filtering.
    const listOrder = (x: Notification, y: Notification) => y.createdAt.localeCompare(x.createdAt) || y.id.localeCompare(x.id);
    assert.deepEqual(listed.items.map((item) => item.id), mine.filter((item) => !item.readAt && item.type === 'post.liked').sort(listOrder).map((item) => item.id));
    assert.equal(listed.nextCursor, undefined);

    const s = t.store;
    const legacy: NotificationStore = {
      create: s.create.bind(s), createWithDeliveries: s.createWithDeliveries.bind(s), get: s.get.bind(s), list: s.list.bind(s), update: s.update.bind(s), delete: s.delete.bind(s),
    };
    const old = new NotificationService({ store: legacy, deliveryStore: t.service['options'].deliveryStore, auditSink: t.service['options'].auditSink, authority: t.service['options'].authority });
    const refused = /cannot page notifications by recipient/;
    await assert.rejects(old.inbox('tenant-a', {}, who('alice')), refused);
    await assert.rejects(old.unreadCount('tenant-a', {}, who('alice')), refused);
    await assert.rejects(old.markAllRead('tenant-a', {}, who('alice')), refused);
    assert.equal((await old.list('tenant-a', { recipient: 'alice', limit: 100 }, who('alice'))).items.length, 30, 'list still works on the old store');
  } finally { await t.close(); }
});

test('without an authority: legacy scopes, as list and markRead use them', async () => {
  const runtime = createFeltDbRuntime({ mode: 'local', namespace: `paging-legacy-${Math.random()}`, path: await mkdtemp(join(tmpdir(), 'appport-paging-legacy-')) });
  const service = new NotificationService({
    store: new FeltDbNotificationStore(runtime.db), deliveryStore: new FeltDbNotificationDeliveryStore(runtime.db), auditSink: new FeltDbNotificationAuditSink(runtime.db),
  });
  const legacy = (id: string, scopes: readonly string[]) => ({ principalId: id, principalType: 'api_key', tenantId: 'tenant-a', scopes, credentialId: 'key' }) as unknown as AuthenticatedPrincipal;
  const sender = legacy('sender', ['notifications.create']);
  try {
    for (let i = 0; i < 6; i++) await service.notify({ tenantId: 'tenant-a', recipient: i % 2 ? 'alice' : 'bob', type: 'x', title: `n${i}` }, sender);
    const alice = legacy('alice', ['notifications.read', 'notifications.write']);
    assert.equal((await service.inbox('tenant-a', {}, alice)).items.length, 3);
    await assert.rejects(service.inbox('tenant-a', { recipient: 'bob' }, alice), NotificationAuthorizationError);
    assert.equal((await service.inbox('tenant-a', { recipient: 'bob' }, legacy('operator', ['notifications.read:any']))).items.length, 3);
    await assert.rejects(service.markAllRead('tenant-a', {}, legacy('alice', ['notifications.read'])), NotificationAuthorizationError);
    await assert.rejects(service.inbox('tenant-b', {}, alice), NotificationAuthorizationError);
    assert.deepEqual(await service.markAllRead('tenant-a', {}, alice), { marked: 3, complete: true });
    assert.deepEqual(await service.unreadCount('tenant-a', { recipient: 'bob' }, legacy('operator', ['notifications.read:any'])), { count: 3, complete: true });
  } finally { await runtime.db.close(); }
});

test('HTTP: GET /inbox, GET /unread-count, POST /read-all', async () => {
  const t = await setup();
  await t.fill(8, 'alice');
  await t.fill(3, 'bob');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { const id = req.header('x-test-principal'); if (id) req.auth = who(id); next(); });
  app.use('/notifications', createNotificationRouter(t.service));
  app.use(notificationErrorHandler as express.ErrorRequestHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/notifications`;
  const call = (path: string, as: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-test-principal': as } });
  try {
    const first = await (await call('/inbox?limit=5', 'alice')).json() as { items: Notification[]; nextCursor?: string };
    assert.equal(first.items.length, 5);
    const second = await (await call(`/inbox?limit=5&cursor=${encodeURIComponent(first.nextCursor!)}`, 'alice')).json() as { items: Notification[]; nextCursor?: string };
    assert.deepEqual([second.items.length, second.nextCursor], [3, undefined]);
    assert.equal((await call(`/inbox?limit=5&cursor=${encodeURIComponent(first.nextCursor!)}`, 'bob')).status, 400);
    assert.equal((await call('/inbox?limit=500', 'alice')).status, 400);
    assert.equal((await call('/inbox?recipient=bob', 'alice')).status, 403);
    assert.deepEqual(await (await call('/unread-count', 'alice')).json(), { count: 8, complete: true });
    assert.deepEqual(await (await call('/read-all', 'alice', { method: 'POST', body: '{}' })).json(), { marked: 8, complete: true });
    assert.deepEqual(await (await call('/unread-count', 'alice')).json(), { count: 0, complete: true });
    assert.deepEqual(await (await call('/unread-count', 'bob')).json(), { count: 3, complete: true });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await t.close();
  }
});
