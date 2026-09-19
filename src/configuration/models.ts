export const CONFIGURATION_ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export type ConfigurationEnvironment = (typeof CONFIGURATION_ENVIRONMENTS)[number];
export type ConfigurationKind = 'variable' | 'secret';

export interface ConfigurationScope {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly environment: ConfigurationEnvironment;
}

export interface ConfigurationVariable {
  readonly id: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly environment: ConfigurationEnvironment;
  readonly name: string;
  readonly value: string;
  readonly required: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: string;
  readonly __version: number;
}

export interface ConfigurationVariableView extends Omit<ConfigurationVariable, 'value' | '__version'> {
  readonly kind: 'variable';
  readonly value: string;
}

export interface ConfigurationSecret {
  readonly id: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly environment: ConfigurationEnvironment;
  readonly name: string;
  readonly value: string;
  readonly required: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdBy: string;
  readonly __version: number;
}

export interface ConfigurationSecretView extends Omit<ConfigurationSecret, 'value' | '__version'> {
  readonly kind: 'secret';
  readonly configured: true;
}

export interface ConfigurationDeclaration {
  readonly name: string;
  readonly kind: ConfigurationKind;
  readonly required: boolean;
}

export interface ConfigurationAuditEvent {
  readonly id: string;
  readonly type: 'configuration.created' | 'configuration.updated' | 'configuration.deleted' | 'secret.created' | 'secret.rotated' | 'secret.deleted';
  readonly tenantId: string;
  readonly applicationId: string;
  readonly environment: ConfigurationEnvironment;
  readonly name: string;
  readonly kind: ConfigurationKind;
  readonly actor: string;
  readonly timestamp: string;
  readonly operation: string;
  readonly status: 'configured' | 'deleted';
}

export interface ConfigurationList {
  readonly variables: readonly ConfigurationVariableView[];
  readonly secrets: readonly ConfigurationSecretView[];
  readonly declarations: readonly ConfigurationDeclaration[];
}
