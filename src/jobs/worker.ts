import type { JobService } from './service.js';
import type { JobStore } from './store.js';

interface JobWorkerOptions {
  readonly workerId: string;
  readonly concurrency?: number;
  readonly pollIntervalMs?: number;
  readonly tenantId: string;
}

const DEFAULT_CONCURRENCY = 10;
const DEFAULT_POLL_INTERVAL_MS = 5000;

export class JobWorker {
  private readonly workerId: string;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly tenantId: string;
  private readonly jobService: JobService;
  private readonly jobStore: JobStore;
  private running = false;
  private activeJobs = 0;
  private pollTimer?: NodeJS.Timeout;
  private readonly now: () => Date;

  constructor(
    jobService: JobService,
    jobStore: JobStore,
    options: JobWorkerOptions,
    now?: () => Date,
  ) {
    this.jobService = jobService;
    this.jobStore = jobStore;
    this.workerId = options.workerId;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.tenantId = options.tenantId;
    this.now = now ?? (() => new Date());
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private poll(): void {
    if (!this.running) {
      return;
    }

    this.work().then(
      () => {
        this.scheduleNextPoll();
      },
      () => {
        this.scheduleNextPoll();
      },
    );
  }

  private scheduleNextPoll(): void {
    if (!this.running) {
      return;
    }
    this.pollTimer = setTimeout(() => this.poll(), this.pollIntervalMs);
  }

  private async work(): Promise<void> {
    while (this.running && this.activeJobs < this.concurrency) {
      const now = this.now().toISOString();
      const dueJobs = await this.jobStore.listDue(this.tenantId, now);

      if (dueJobs.length === 0) {
        break;
      }

      const job = dueJobs[0];

      this.activeJobs++;
      this.jobService
        .executeJob(this.tenantId, job.id, this.workerId)
        .then(
          () => {
            this.activeJobs--;
          },
          () => {
            this.activeJobs--;
          },
        );
    }
  }
}
