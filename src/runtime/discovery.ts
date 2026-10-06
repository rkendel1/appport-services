export type CapabilityCatalogId =
  | 'apikeys'
  | 'webhooks'
  | 'jobs'
  | 'schedules'
  | 'notifications'
  | 'files'
  | 'configuration'
  | 'credentials'
  | 'intelligence'
  | 'secrets'
  | 'runtime-events';

export interface RuntimeCapabilityDescriptor {
  readonly id: CapabilityCatalogId;
  readonly name: string;
  readonly contractVersion: number;
  readonly operations: readonly string[];
  readonly durable: boolean;
  readonly async: boolean;
  readonly dependencies: readonly string[];
  readonly runtimeMounted: boolean;
}

type Descriptor = Omit<RuntimeCapabilityDescriptor, 'runtimeMounted'>;

const DESCRIPTORS: Readonly<Record<CapabilityCatalogId, Descriptor>> = Object.freeze({
  apikeys: Object.freeze({
    id: 'apikeys',
    name: 'API Keys',
    contractVersion: 1,
    operations: Object.freeze(['create', 'read', 'revoke', 'authenticate']),
    durable: true,
    async: false,
    dependencies: Object.freeze(['ServiceGateway', 'FeltDB']),
  }),
  webhooks: Object.freeze({
    id: 'webhooks',
    name: 'Webhooks',
    contractVersion: 1,
    operations: Object.freeze(['register', 'read', 'disable', 'deliver', 'retry', 'replay', 'receive', 'registerIntegration']),
    durable: true,
    async: true,
    dependencies: Object.freeze(['ServiceGateway', 'FeltDB', 'ScopedSecretsResolver']),
  }),
  jobs: Object.freeze({
    id: 'jobs',
    name: 'Jobs',
    contractVersion: 1,
    operations: Object.freeze(['create', 'read', 'execute', 'retry']),
    durable: true,
    async: true,
    dependencies: Object.freeze(['ServiceGateway', 'FeltDB']),
  }),
  schedules: Object.freeze({
    id: 'schedules',
    name: 'Schedules',
    contractVersion: 1,
    operations: Object.freeze(['create', 'read', 'cancel', 'materialize']),
    durable: true,
    async: true,
    dependencies: Object.freeze(['jobs', 'ServiceGateway', 'FeltDB']),
  }),
  notifications: Object.freeze({
    id: 'notifications',
    name: 'Notifications',
    contractVersion: 1,
    operations: Object.freeze(['create', 'read', 'deliver', 'retry', 'acknowledge', 'dismiss', 'delete']),
    durable: true,
    async: true,
    dependencies: Object.freeze(['ServiceGateway', 'FeltDB', 'jobs']),
  }),
  files: Object.freeze({
    id: 'files',
    name: 'Files',
    contractVersion: 1,
    operations: Object.freeze(['create', 'read', 'update', 'delete']),
    durable: true,
    async: false,
    dependencies: Object.freeze(['ServiceGateway', 'FeltDB']),
  }),
  configuration: Object.freeze({
    id: 'configuration',
    name: 'Configuration',
    contractVersion: 1,
    operations: Object.freeze(['read', 'write', 'delete']),
    durable: true,
    async: false,
    dependencies: Object.freeze(['ServiceGateway', 'FeltDB']),
  }),
  credentials: Object.freeze({
    id: 'credentials',
    name: 'Credentials',
    contractVersion: 1,
    operations: Object.freeze(['attach', 'rotate', 'detach']),
    durable: true,
    async: false,
    dependencies: Object.freeze(['configuration', 'ServiceGateway', 'FeltDB']),
  }),
  intelligence: Object.freeze({
    id: 'intelligence',
    name: 'Intelligence',
    contractVersion: 1,
    operations: Object.freeze(['catalog', 'read', 'write', 'credential.set', 'credential.remove', 'resolve']),
    durable: true,
    async: false,
    dependencies: Object.freeze(['configuration', 'ServiceGateway', 'FeltDB']),
  }),
  secrets: Object.freeze({
    id: 'secrets',
    name: 'Secrets',
    contractVersion: 1,
    operations: Object.freeze(['register', 'describe', 'list', 'rotate', 'revoke', 'retire', 'resolve']),
    durable: true,
    async: false,
    dependencies: Object.freeze(['AuthBoundry', 'AppBoundry', 'FeltDB']),
  }),
  'runtime-events': Object.freeze({
    id: 'runtime-events',
    name: 'Runtime Events',
    contractVersion: 1,
    operations: Object.freeze(['publish', 'subscribe', 'stream']),
    durable: false,
    async: true,
    dependencies: Object.freeze(['AppPortEvents']),
  }),
});

export const CAPABILITY_CATALOG: readonly Omit<RuntimeCapabilityDescriptor, 'runtimeMounted'>[] = Object.freeze(
  Object.values(DESCRIPTORS),
);

export function describeCapabilities(mounted: Partial<Record<CapabilityCatalogId, boolean>> = {}): readonly RuntimeCapabilityDescriptor[] {
  return Object.freeze(
    CAPABILITY_CATALOG.map((descriptor) => Object.freeze({
      ...descriptor,
      runtimeMounted: mounted[descriptor.id] ?? false,
    })),
  );
}
