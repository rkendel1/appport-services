import { readFileSync } from 'node:fs';

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
  api?: {
    keys?: boolean;
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
 * Expects format with use declarations and optional [section] configuration.
 */
export function parseAppPortConfig(filePath: string): AppPortConfig {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (error) {
    throw new Error(`Cannot read appport.toml at ${filePath}: ${String(error)}`);
  }

  return validateConfig(content);
}

/**
 * Validate appport.toml configuration.
 * Parses "use" declarations and optional [section] configuration.
 */
function validateConfig(content: string): AppPortConfig {
  const capabilities = {
    api: false,
    webhooks: false,
    jobs: false,
  };

  const config: AppPortConfig = { capabilities };

  // Split into lines for manual parsing
  const lines = content.split('\n').map((line) => line.trim());

  // Extract use declarations and configuration sections
  const webhooksConfig: Record<string, unknown> = {};
  const jobsConfig: Record<string, unknown> = {};
  const apiConfig: Record<string, unknown> = {};
  let currentSection: string | null = null;

  for (const line of lines) {
    // Skip empty lines and comments
    if (!line || line.startsWith('#')) {
      continue;
    }

    if (line === '}') {
      currentSection = null;
      continue;
    }

    // Parse use declarations
    if (line.startsWith('use ')) {
      const block = line.endsWith('{');
      const capability = line.substring(4, block ? line.length - 1 : undefined).trim();
      if (capability === 'api') {
        capabilities.api = true;
      } else if (capability === 'webhooks') {
        capabilities.webhooks = true;
      } else if (capability === 'jobs') {
        capabilities.jobs = true;
      } else {
        throw new Error(
          `Unknown capability: "use ${capability}". Supported: use api, use webhooks, use jobs`,
        );
      }
      currentSection = block ? capability : null;
      continue;
    }

    // Parse section headers
    if (line.startsWith('[') && line.endsWith(']')) {
      const section = line.substring(1, line.length - 1).trim();
      if (section === 'api') {
        currentSection = 'api';
        capabilities.api = true;
      } else if (section === 'webhooks') {
        currentSection = 'webhooks';
        capabilities.webhooks = true;
      } else if (section === 'jobs') {
        currentSection = 'jobs';
        capabilities.jobs = true;
      } else {
        throw new Error(
          `Unknown section: [${section}]. Supported sections: [api], [webhooks], [jobs]`,
        );
      }
      continue;
    }

    // Parse key = value within sections
    if (line.includes('=')) {
      if (!currentSection) {
        throw new Error(
          `Configuration key=value must be within a capability block or section: "${line}"`,
        );
      }

      const [key, ...valueParts] = line.split('=');
      const trimmedKey = key.trim();
      const trimmedValue = valueParts.join('=').trim();

      if (currentSection === 'api') {
        if (trimmedKey !== 'keys' || !['true', 'false'].includes(trimmedValue)) {
          throw new Error('api.keys must be true or false');
        }
        apiConfig.keys = trimmedValue === 'true';
      } else if (currentSection === 'webhooks') {
        if (trimmedKey === 'events') {
          // Parse array value: events = ["event1", "event2"]
          if (!trimmedValue.startsWith('[') || !trimmedValue.endsWith(']')) {
            throw new Error('webhooks.events must be an array');
          }
          const arrayContent = trimmedValue.substring(1, trimmedValue.length - 1);
          const events = arrayContent
            .split(',')
            .map((e) => e.trim())
            .filter((e) => e.length > 0)
            .map((e) => {
              // Remove quotes
              if ((e.startsWith('"') && e.endsWith('"')) || (e.startsWith("'") && e.endsWith("'"))) {
                return e.substring(1, e.length - 1);
              }
              throw new Error('webhooks.events must be an array of strings');
            });
          webhooksConfig.events = events;
        } else {
          throw new Error(`Unknown webhooks configuration: "${trimmedKey}". Supported: events`);
        }
      } else if (currentSection === 'jobs') {
        if (trimmedKey === 'max_attempts') {
          const value = parseInt(trimmedValue, 10);
          if (isNaN(value) || value < 1) {
            throw new Error('jobs.max_attempts must be a positive integer');
          }
          jobsConfig.max_attempts = value;
        } else {
          throw new Error(`Unknown jobs configuration: "${trimmedKey}". Supported: max_attempts`);
        }
      }
    }
  }

  // Add configuration sections if they have values
  if (Object.keys(apiConfig).length > 0) {
    config.api = apiConfig as AppPortConfig['api'];
  }
  if (Object.keys(webhooksConfig).length > 0) {
    config.webhooks = webhooksConfig as AppPortConfig['webhooks'];
  }
  if (Object.keys(jobsConfig).length > 0) {
    config.jobs = jobsConfig as AppPortConfig['jobs'];
  }

  return config;
}
