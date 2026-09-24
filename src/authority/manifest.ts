import { createHash } from 'node:crypto';

export type ServiceEffect = 'consequential' | 'observation';

export interface ServiceCapability {
  readonly name: string;
  readonly version: number;
  readonly service: string;
  readonly operation: string;
  readonly effect: ServiceEffect;
  /** False only for runtime-internal operations that are never reachable through invoke(). */
  readonly invocable: boolean;
  readonly authorization: {
    readonly required: true;
    readonly resource: string;
  };
}

type Entry = readonly [name: string, service: string, operation: string, effect: ServiceEffect, resource: string, invocable?: boolean];

// Every public service operation, audited from the pre-migration service
// methods. Each maps to exactly one capability; there are no *.admin or
// wildcard capabilities. The table is static: services never invent names.
const ENTRIES: readonly Entry[] = [
  ['apikeys.read', 'api-keys', 'listApiKeys', 'observation', 'api_key'],
  ['apikeys.create', 'api-keys', 'createApiKey', 'consequential', 'api_key'],
  ['apikeys.revoke', 'api-keys', 'revokeApiKey', 'consequential', 'api_key'],

  ['webhooks.read', 'webhooks', 'listWebhookEndpoints', 'observation', 'webhook_endpoint'],
  ['webhooks.register', 'webhooks', 'createWebhookEndpoint', 'consequential', 'webhook_endpoint'],
  ['webhooks.remove', 'webhooks', 'disableWebhookEndpoint', 'consequential', 'webhook_endpoint'],
  ['webhooks.emit', 'webhooks', 'emitWebhookEvent', 'consequential', 'webhook_event'],
  ['webhooks.replay', 'webhooks', 'replayWebhookDelivery', 'consequential', 'webhook_delivery'],
  ['webhooks.deliver', 'webhooks', 'deliverWebhook', 'consequential', 'webhook_delivery', false],
  ['webhooks.integrations.register', 'webhooks', 'registerIntegration', 'consequential', 'webhook_integration'],
  ['webhooks.receive', 'webhooks', 'receiveWebhook', 'consequential', 'webhook_integration', false],

  ['jobs.read', 'jobs', 'listJobs', 'observation', 'job'],
  ['jobs.create', 'jobs', 'enqueue', 'consequential', 'job'],
  ['jobs.retry', 'jobs', 'retry', 'consequential', 'job'],
  ['jobs.execute', 'jobs', 'executeJob', 'consequential', 'job', false],

  ['schedules.read', 'schedules', 'list', 'observation', 'schedule'],
  ['schedules.create', 'schedules', 'create', 'consequential', 'schedule'],
  ['schedules.cancel', 'schedules', 'disable', 'consequential', 'schedule'],

  ['notifications.read', 'notifications', 'list', 'observation', 'notification'],
  ['notifications.send', 'notifications', 'create', 'consequential', 'notification'],
  ['notifications.update', 'notifications', 'markRead', 'consequential', 'notification'],
  ['notifications.delete', 'notifications', 'delete', 'consequential', 'notification'],

  ['files.read', 'files', 'list', 'observation', 'file'],
  ['files.write', 'files', 'create', 'consequential', 'file'],
  ['files.delete', 'files', 'delete', 'consequential', 'file'],

  ['configuration.read', 'configuration', 'list', 'observation', 'configuration'],
  ['configuration.write', 'configuration', 'createVariable', 'consequential', 'configuration'],
  ['configuration.delete', 'configuration', 'delete', 'consequential', 'configuration'],
  ['credential.attach', 'configuration', 'createSecret', 'consequential', 'credential'],
  ['credential.rotate', 'configuration', 'rotateSecret', 'consequential', 'credential'],
  ['credential.detach', 'configuration', 'delete', 'consequential', 'credential'],
];

function freezeCapability([name, service, operation, effect, resource, invocable = true]: Entry): ServiceCapability {
  return Object.freeze({
    name,
    version: 1,
    service,
    operation,
    effect,
    invocable,
    authorization: Object.freeze({ required: true as const, resource }),
  });
}

/** Deterministic, sorted, frozen capability manifest for AppPort/AuthBoundry. */
export const SERVICE_CAPABILITY_MANIFEST: readonly ServiceCapability[] = Object.freeze(
  [...ENTRIES].sort((a, b) => a[0].localeCompare(b[0])).map(freezeCapability),
);

const BY_NAME: ReadonlyMap<string, ServiceCapability> = new Map(SERVICE_CAPABILITY_MANIFEST.map((capability) => [capability.name, capability]));

export type ServiceCapabilityName = (typeof ENTRIES)[number][0];

export function getServiceCapability(name: string): ServiceCapability | undefined {
  return BY_NAME.get(name);
}

/** Stable digest so AuthBoundry can pin the manifest it evaluated against. */
export function serviceCapabilityManifestDigest(): string {
  return createHash('sha256').update(JSON.stringify(SERVICE_CAPABILITY_MANIFEST)).digest('hex');
}

/**
 * Pre-migration scope names and what replaced them. Old scopes grant nothing;
 * this table exists only to produce migration errors and documentation.
 */
export const LEGACY_SCOPE_MIGRATION: Readonly<Record<string, string | null>> = Object.freeze({
  'files.admin': null,
  'notifications.admin': null,
  'schedules.admin': null,
  'configuration.admin': null,
  'files.create': 'files.write',
  'files.read:any': 'files.read',
  'files.write:any': 'files.write',
  'files.delete:any': 'files.delete',
  'notifications.create': 'notifications.send',
  'notifications.write': 'notifications.update',
  'notifications.read:any': 'notifications.read',
  'schedules.write': 'schedules.cancel',
  'schedules.read:any': 'schedules.read',
  'schedules.write:any': 'schedules.cancel',
  'secret.rotate': 'credential.rotate',
});
