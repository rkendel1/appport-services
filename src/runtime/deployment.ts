import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { FeltDBOptions } from '@feltdb/core';

import { createFeltDbRuntime } from '../storage/api-keys.js';
import { parseAppPortConfig, type AppPortConfig } from './dsl.js';

/** The deployment the CLI and the standalone management host both resolve from disk. */
export interface ResolvedDeployment {
  /** Options for the FeltDB runtime, already narrowed by the deployment contract. */
  readonly feltdb: FeltDBOptions;
  /** The parsed application contract, when `appport.toml` exists. */
  readonly config?: AppPortConfig;
  /** Application identity: the contract name, else the namespace, else `default`. */
  readonly application: string;
}

export const DEFAULT_APPLICATION = 'default';
export const DEFAULT_STATE_DIRECTORY = '.appport/state';
export const DEFAULT_CONFIG_FILE = 'appport.toml';

/**
 * Resolve the durable deployment for `cwd`.
 *
 * This is the single source of truth for "where does state live". The CLI
 * commands and the standalone management host must agree, otherwise the host
 * would serve a different database than the operator administers.
 *
 * - No `appport.toml`: the FeltDB defaults.
 * - `deployment.storage = "memory"`: ephemeral, and never durable state.
 * - A non-local deployment with `FELTDB_URL`: the remote FeltDB server.
 * - Otherwise: a local FeltDB under `.appport/state`.
 */
export function resolveDeployment(cwd: string, env: NodeJS.ProcessEnv = process.env): ResolvedDeployment {
  const configPath = resolve(cwd, DEFAULT_CONFIG_FILE);
  if (!existsSync(configPath)) {
    return { feltdb: {}, application: DEFAULT_APPLICATION };
  }
  const config = parseAppPortConfig(configPath);
  const namespace = config.state.namespace;
  if (config.deployment.storage === 'memory') {
    return { feltdb: { memory: true, namespace }, config, application: config.application.name };
  }
  if (config.deployment.mode !== 'local' && env.FELTDB_URL) {
    return {
      feltdb: {
        namespace,
        server: {
          url: env.FELTDB_URL,
          token: env.FELTDB_TOKEN,
          applicationId: config.application.name,
          environment: env.FELTDB_ENVIRONMENT,
        },
      },
      config,
      application: config.application.name,
    };
  }
  return { feltdb: { mode: 'local', namespace, path: resolve(cwd, DEFAULT_STATE_DIRECTORY) }, config, application: config.application.name };
}

/** Open the FeltDB runtime the deployment resolves to. */
export function createConfiguredRuntime(cwd: string, env: NodeJS.ProcessEnv = process.env): { runtime: ReturnType<typeof createFeltDbRuntime>; config?: AppPortConfig; application: string } {
  const deployment = resolveDeployment(cwd, env);
  return { runtime: createFeltDbRuntime(deployment.feltdb), config: deployment.config, application: deployment.application };
}
