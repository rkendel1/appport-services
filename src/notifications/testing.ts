import type { EmailMessage, EmailTransport } from './email.js';
import type { PushMessage, PushTransport } from './push.js';

/**
 * An e-mail transport that records messages instead of sending them (tests,
 * local development). `failNext(n)` makes the next `n` sends throw (a retryable
 * failure).
 */
export class RecordingEmailTransport implements EmailTransport {
  readonly sent: EmailMessage[] = [];
  private failures = 0;

  failNext(count = 1): void { this.failures += count; }

  async send(message: EmailMessage): Promise<{ readonly message_id: string }> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('test transport failure');
    }
    this.sent.push(message);
    return { message_id: `test-email-${this.sent.length}` };
  }
}

/**
 * A push transport that records messages. `reject(device)` makes sends to
 * that device fail permanently (an unregistered device); `failNext(n)` makes
 * the next `n` sends fail with a retryable error.
 */
export class RecordingPushTransport implements PushTransport {
  readonly sent: PushMessage[] = [];
  private failures = 0;
  private readonly rejected = new Set<string>();

  failNext(count = 1): void { this.failures += count; }
  reject(device: string): void { this.rejected.add(device); }

  async send(message: PushMessage): Promise<{ readonly ok: boolean; readonly id?: string; readonly retryable?: boolean; readonly reason?: string }> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('test transport failure');
    }
    if (this.rejected.has(message.device)) return { ok: false, retryable: false, reason: 'device_unregistered' };
    this.sent.push(message);
    return { ok: true, id: `test-push-${this.sent.length}` };
  }
}
