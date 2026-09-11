import { readFileSync } from 'node:fs';
import { parse } from '@iarna/toml';

/**
 * Parsed AppPort Services DSL configuration.
 * Declares which capabilities are used and their configuration.
 */
export interface AppPortConfig {
  capabilities: {
    api: boolean;
    webhooks: boolean;
    jobs: boolean;
  };
  webhooks?: {
    events?: string[];
  };
  jobs?: {
    max_attempts?: number;
  };
}

/**
 * Parse appport.toml and validate configuration.
 */
export function parseAppPortConfig(filePath: string): AppPortConfig {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (error) {
    throw new Error(`Cannot read appport.toml at ${filePath}: ${String(error)}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parse(content);
  } catch (error) {
    throw new Error(`Invalid TOML syntax in appport.toml: ${String(error)}`);
  }

  return validateConfig(parsed);
}

/**
 * Validate parsed TOML configuration structure.
 */
function validateConfig(parsed: Record<string, unknown>): AppPortConfig {
  const capabilities = {
    api: false,
    webhooks: false,
    jobs: false,
  };

  // Check for unknown top-level keys (only allow: capability booleans and section headers)
  const allowedKeys = new Set(['api', 'webhooks', 'jobs']);
  for (const key of Object.keys(parsed)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown configuration: "${key}". Supported capabilities: api, webhooks, jobs`);
    }
  }

  // Parse capability flags (check each capability for truthiness or as a section)
  if (parsed.api === true) {
    capabilities.api = true;
  } else if (parsed.api !== undefined && parsed.api !== false) {
    throw new Error('Invalid api configuration: must be true or omitted');
  }

  // webhooks can be true (flag) or an object (configuration section)
  if (parsed.webhooks === true) {
    capabilities.webhooks = true;
  } else if (typeof parsed.webhooks === 'object' && parsed.webhooks !== null) {
    capabilities.webhooks = true;
  } else if (parsed.webhooks !== undefined && parsed.webhooks !== false) {
    throw new Error('Invalid webhooks configuration: must be true, a [webhooks] section, or omitted');
  }

  // jobs can be true (flag) or an object (configuration section)
  if (parsed.jobs === true) {
    capabilities.jobs = true;
  } else if (typeof parsed.jobs === 'object' && parsed.jobs !== null) {
    capabilities.jobs = true;
  } else if (parsed.jobs !== undefined && parsed.jobs !== false) {
    throw new Error('Invalid jobs configuration: must be true, a [jobs] section, or omitted');
  }

  const config: AppPortConfig = { capabilities };

  // Validate [webhooks] section
  if (typeof parsed.webhooks === 'object' && parsed.webhooks !== null) {
    const webhooksSection = parsed.webhooks as Record<string, unknown>;
    const webhooksConfig: AppPortConfig['webhooks'] = {};

    if (webhooksSection.events !== undefined) {
      if (!Array.isArray(webhooksSection.events)) {
        throw new Error('webhooks.events must be an array of strings');
      }
      if (!webhooksSection.events.every((e) => typeof e === 'string')) {
        throw new Error('webhooks.events must be an array of strings');
      }
      webhooksConfig.events = webhooksSection.events;
    }

    // Check for unknown keys in webhooks section
    const validWebhookKeys = new Set(['events']);
    for (const key of Object.keys(webhooksSection)) {
      if (!validWebhookKeys.has(key)) {
        throw new Error(`Unknown webhooks configuration: "${key}". Supported: events`);
      }
    }

    config.webhooks = webhooksConfig;
  }

  // Validate [jobs] section
  if (typeof parsed.jobs === 'object' && parsed.jobs !== null) {
    const jobsSection = parsed.jobs as Record<string, unknown>;
    const jobsConfig: AppPortConfig['jobs'] = {};

    if (jobsSection.max_attempts !== undefined) {
      if (typeof jobsSection.max_attempts !== 'number') {
        throw new Error('jobs.max_attempts must be a number');
      }
      if (jobsSection.max_attempts < 1 || !Number.isInteger(jobsSection.max_attempts)) {
        throw new Error('jobs.max_attempts must be a positive integer');
      }
      jobsConfig.max_attempts = jobsSection.max_attempts;
    }

    // Check for unknown keys in jobs section
    const validJobsKeys = new Set(['max_attempts']);
    for (const key of Object.keys(jobsSection)) {
      if (!validJobsKeys.has(key)) {
        throw new Error(`Unknown jobs configuration: "${key}". Supported: max_attempts`);
      }
    }

    config.jobs = jobsConfig;
  }

  return config;
}
