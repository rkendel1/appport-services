import type { StateFirstDB } from '@feltdb/core';

/**
 * A FeltDB transaction operation.
 * Represents a single read, write, or update operation to be batched in a transaction.
 */
export interface TransactionOperation {
  collection: string;
  id: string;
  value?: unknown;
  requireAbsent?: boolean;
  requirePresent?: boolean;
  expectedVersion?: number;
}

/**
 * Collects operations to be executed in a single FeltDB transaction.
 *
 * Services add operations to this builder instead of executing immediately.
 * After all operations are collected, they are committed atomically.
 */
export class TransactionBuilder {
  private readonly operations: TransactionOperation[] = [];

  /**
   * Add an operation to this transaction.
   */
  addOperation(op: TransactionOperation): void {
    this.operations.push(op);
  }

  /**
   * Get all collected operations.
   */
  getOperations(): readonly TransactionOperation[] {
    return this.operations;
  }

  /**
   * Execute all collected operations in a single FeltDB transaction.
   */
  async commit(db: StateFirstDB): Promise<void> {
    if (this.operations.length === 0) {
      return;
    }
    // Cast to any to match FeltDB's expected operation format
    await db.transaction({ operations: this.operations as any });
  }
}

/**
 * Context passed to transaction callback.
 * Allows application and service code to participate in one atomic transaction.
 */
export interface AppPortTransactionContext {
  /**
   * Add a custom operation to the transaction.
   * Used for application-owned state or custom collection operations.
   */
  addOperation(op: TransactionOperation): void;

  /**
   * Get access to a FeltDB collection within the transaction.
   * Operations added to this collection are part of the same transaction.
   */
  collection<T extends Record<string, unknown>>(name: string): AppPortTransactionCollection<T>;
}

/**
 * A collection view for use within a transaction.
 * Methods return operation results without executing immediately;
 * operations are queued for later atomic execution.
 */
export interface AppPortTransactionCollection<T extends Record<string, unknown>> {
  /**
   * Insert a new document (requires document to not exist).
   */
  insert(value: T, id: string): Promise<void>;

  /**
   * Update a document conditionally based on its current version.
   * Returns the updated document if successful, null if version mismatch.
   */
  updateIfVersion(
    id: string,
    expectedVersion: number,
    updates: Partial<T>,
  ): Promise<T | null>;
}

/**
 * Internal implementation of transaction collection that queues operations.
 */
export class TransactionCollectionImpl<T extends Record<string, unknown>>
  implements AppPortTransactionCollection<T>
{
  constructor(private readonly builder: TransactionBuilder, private readonly name: string) {}

  async insert(value: T, id: string): Promise<void> {
    this.builder.addOperation({
      collection: this.name,
      id,
      requireAbsent: true,
      value,
    });
  }

  async updateIfVersion(id: string, expectedVersion: number, updates: Partial<T>): Promise<T | null> {
    // In a transaction context, we can't know if the update will succeed until commit.
    // For now, we queue the operation optimistically.
    // TODO: This is a limitation of the current approach - we're assuming the version match
    // will succeed at commit time, or FeltDB will reject the whole transaction.
    this.builder.addOperation({
      collection: this.name,
      id,
      expectedVersion,
      value: updates,
    });
    return null; // Can't return result until transaction commits
  }
}
