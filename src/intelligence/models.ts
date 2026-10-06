import type { CredentialRequirement, IntelligenceProtocol } from './catalog.js';
import type { ConfigurationEnvironment } from '../configuration/models.js';

/** The durable, non-secret part of the configuration (stored as one configuration variable). */
export interface IntelligenceSelection {
  readonly provider: string;
  readonly model: string;
  /** Absent means the provider's default endpoint. */
  readonly endpoint?: string;
}

/** Everything a client may read. It never contains credential material or the credential reference. */
export type IntelligenceConfigurationView =
  | { readonly configured: false; readonly environment: ConfigurationEnvironment; readonly credentialConfigured: false }
  | {
    readonly configured: true;
    readonly environment: ConfigurationEnvironment;
    readonly provider: string;
    readonly model: string;
    readonly endpoint: { readonly kind: 'default' | 'custom'; readonly url: string | null };
    readonly credentialRequirement: CredentialRequirement;
    readonly credentialConfigured: boolean;
    readonly updatedAt: string;
  };

/**
 * The runtime form handed to the execution boundary (FX). It carries the
 * credential reference, never the credential; custody resolves it.
 */
export interface IntelligenceRuntimeConfiguration {
  readonly provider: string;
  readonly protocol: IntelligenceProtocol;
  readonly model: string;
  readonly endpoint: string;
  readonly credentialRef?: string;
}
