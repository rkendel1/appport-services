import { randomBytes, createHmac, createCipheriv, createDecipheriv, scryptSync } from 'node:crypto';

export interface WebhookSecret {
  readonly id: string;
  readonly endpointId: string;
  readonly encryptedSecret: string;
  readonly createdAt: string;
  readonly __version: number;
}

export interface WebhookSecretStore {
  create(endpointId: string): Promise<{ secret: string; encrypted: WebhookSecret }>;
  getEncrypted(endpointId: string): Promise<WebhookSecret | null>;
  decrypt(encrypted: WebhookSecret): Promise<string>;
}

export class InMemoryWebhookSecretStore implements WebhookSecretStore {
  private readonly secrets = new Map<string, { secret: string; created: string }>();

  async create(endpointId: string): Promise<{ secret: string; encrypted: WebhookSecret }> {
    const secret = randomBytes(32).toString('base64url');
    const createdAt = new Date().toISOString();
    this.secrets.set(endpointId, { secret, created: createdAt });

    return {
      secret,
      encrypted: {
        id: endpointId,
        endpointId,
        encryptedSecret: secret,
        createdAt,
        __version: 1,
      },
    };
  }

  async getEncrypted(endpointId: string): Promise<WebhookSecret | null> {
    const stored = this.secrets.get(endpointId);
    if (!stored) return null;

    return {
      id: endpointId,
      endpointId,
      encryptedSecret: stored.secret,
      createdAt: stored.created,
      __version: 1,
    };
  }

  async decrypt(encrypted: WebhookSecret): Promise<string> {
    const stored = this.secrets.get(encrypted.endpointId);
    if (!stored) {
      throw new Error(`Secret not found for endpoint ${encrypted.endpointId}`);
    }
    return stored.secret;
  }
}

export class EncryptedWebhookSecretStore implements WebhookSecretStore {
  private readonly algorithm = 'aes-256-gcm';
  private readonly encryptionKey: Buffer;
  private readonly secrets = new Map<string, string>();

  constructor(encryptionKey?: Buffer) {
    if (encryptionKey && encryptionKey.length === 32) {
      this.encryptionKey = encryptionKey;
    } else {
      this.encryptionKey = scryptSync('default-webhook-key', 'webhook-salt', 32);
    }
  }

  async create(endpointId: string): Promise<{ secret: string; encrypted: WebhookSecret }> {
    const secret = randomBytes(32).toString('base64url');
    const iv = randomBytes(16);
    const cipher = createCipheriv(this.algorithm, this.encryptionKey, iv);

    let encrypted = cipher.update(secret, 'utf8', 'base64url');
    encrypted += cipher.final('base64url');
    const authTag = cipher.getAuthTag();

    const encryptedValue = `${iv.toString('base64url')}.${authTag.toString('base64url')}.${encrypted}`;
    this.secrets.set(endpointId, encryptedValue);

    const createdAt = new Date().toISOString();
    return {
      secret,
      encrypted: {
        id: endpointId,
        endpointId,
        encryptedSecret: encryptedValue,
        createdAt,
        __version: 1,
      },
    };
  }

  async getEncrypted(endpointId: string): Promise<WebhookSecret | null> {
    const encryptedValue = this.secrets.get(endpointId);
    if (!encryptedValue) return null;

    return {
      id: endpointId,
      endpointId,
      encryptedSecret: encryptedValue,
      createdAt: new Date().toISOString(),
      __version: 1,
    };
  }

  async decrypt(encrypted: WebhookSecret): Promise<string> {
    const parts = encrypted.encryptedSecret.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted secret format');
    }

    const [ivStr, authTagStr, encryptedStr] = parts;
    const iv = Buffer.from(ivStr, 'base64url');
    const authTag = Buffer.from(authTagStr, 'base64url');
    const decipher = createDecipheriv(this.algorithm, this.encryptionKey, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedStr, 'base64url', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }
}

export function signWebhookPayload(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function verifyWebhookSignature(secret: string, payload: string, signature: string): boolean {
  const expectedSignature = signWebhookPayload(secret, payload);
  return expectedSignature === signature;
}
