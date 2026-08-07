import type { Pool, PoolClient } from "pg";

export type DeliveryJobKind = "TEXT" | "ORGANIZE_FOLDER_SCAN";

export type DeliveryJob = {
  id: string;
  runId: string | null;
  kind: DeliveryJobKind;
  chatId: string;
  payloadCiphertext: string | null;
  attemptCount: number;
  expiresAt: Date | null;
};

export type InsertDeliveryJobInput = {
  id: string;
  dedupeKey: string;
  runId?: string;
  kind: DeliveryJobKind;
  chatId: string;
  payloadCiphertext?: string;
  expiresAt?: Date;
};

type DeliveryJobRow = {
  id: string;
  run_id: string | null;
  kind: DeliveryJobKind;
  chat_id: string;
  payload_ciphertext: string | null;
  attempt_count: number;
  expires_at: Date | null;
};

function toDeliveryJob(row: DeliveryJobRow): DeliveryJob {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    chatId: row.chat_id,
    payloadCiphertext: row.payload_ciphertext,
    attemptCount: row.attempt_count,
    expiresAt: row.expires_at,
  };
}

export async function insertDeliveryJob(
  client: Pick<PoolClient, "query">,
  input: InsertDeliveryJobInput,
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO lark_delivery_jobs (
        id,
        dedupe_key,
        run_id,
        kind,
        chat_id,
        payload_ciphertext,
        expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      input.id,
      input.dedupeKey,
      input.runId ?? null,
      input.kind,
      input.chatId,
      input.payloadCiphertext ?? null,
      input.expiresAt ?? null,
    ],
  );
  return (result.rowCount ?? 0) === 1;
}

export interface DeliveryQueue {
  enqueue(input: InsertDeliveryJobInput): Promise<boolean>;
  claimNext(now: Date, leaseMs: number): Promise<DeliveryJob | null>;
  storePayload(job: DeliveryJob, payloadCiphertext: string): Promise<boolean>;
  complete(job: DeliveryJob): Promise<boolean>;
  retry(job: DeliveryJob, availableAt: Date, errorCode: string): Promise<boolean>;
  fail(job: DeliveryJob, errorCode: string): Promise<boolean>;
}

export class PostgresDeliveryQueue implements DeliveryQueue {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async enqueue(input: InsertDeliveryJobInput): Promise<boolean> {
    return insertDeliveryJob(this.#pool, input);
  }

  async claimNext(now: Date, leaseMs: number): Promise<DeliveryJob | null> {
    if (!Number.isInteger(leaseMs) || leaseMs <= 0) {
      throw new Error("Delivery lease must be a positive integer");
    }

    await this.#pool.query(
      `UPDATE lark_delivery_jobs
          SET state = 'FAILED',
              payload_ciphertext = NULL,
              lease_expires_at = NULL,
              last_error_code = 'DELIVERY_EXPIRED',
              updated_at = now()
        WHERE state IN ('PENDING', 'PROCESSING')
          AND expires_at IS NOT NULL
          AND expires_at <= $1`,
      [now],
    );

    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const result = await this.#pool.query<DeliveryJobRow>(
      `WITH candidate AS (
          SELECT id
            FROM lark_delivery_jobs
           WHERE (
                   (state = 'PENDING' AND available_at <= $1)
                   OR
                   (
                     state = 'PROCESSING'
                     AND lease_expires_at IS NOT NULL
                     AND lease_expires_at <= $1
                   )
                 )
             AND (expires_at IS NULL OR expires_at > $1)
           ORDER BY available_at, created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
       )
       UPDATE lark_delivery_jobs AS job
          SET state = 'PROCESSING',
              attempt_count = job.attempt_count + 1,
              lease_expires_at = $2,
              last_error_code = NULL,
              updated_at = now()
         FROM candidate
        WHERE job.id = candidate.id
      RETURNING job.id,
                job.run_id,
                job.kind,
                job.chat_id,
                job.payload_ciphertext,
                job.attempt_count,
                job.expires_at`,
      [now, leaseExpiresAt],
    );
    return result.rows[0] ? toDeliveryJob(result.rows[0]) : null;
  }

  async storePayload(
    job: DeliveryJob,
    payloadCiphertext: string,
  ): Promise<boolean> {
    const result = await this.#pool.query(
      `UPDATE lark_delivery_jobs
          SET payload_ciphertext = $3,
              updated_at = now()
        WHERE id = $1
          AND state = 'PROCESSING'
          AND attempt_count = $2`,
      [job.id, job.attemptCount, payloadCiphertext],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async complete(job: DeliveryJob): Promise<boolean> {
    const result = await this.#pool.query(
      `UPDATE lark_delivery_jobs
          SET state = 'COMPLETED',
              payload_ciphertext = NULL,
              lease_expires_at = NULL,
              last_error_code = NULL,
              delivered_at = now(),
              updated_at = now()
        WHERE id = $1
          AND state = 'PROCESSING'
          AND attempt_count = $2`,
      [job.id, job.attemptCount],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async retry(
    job: DeliveryJob,
    availableAt: Date,
    errorCode: string,
  ): Promise<boolean> {
    const result = await this.#pool.query(
      `UPDATE lark_delivery_jobs
          SET state = 'PENDING',
              available_at = $3,
              lease_expires_at = NULL,
              last_error_code = $4,
              updated_at = now()
        WHERE id = $1
          AND state = 'PROCESSING'
          AND attempt_count = $2`,
      [job.id, job.attemptCount, availableAt, errorCode],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async fail(job: DeliveryJob, errorCode: string): Promise<boolean> {
    const result = await this.#pool.query(
      `UPDATE lark_delivery_jobs
          SET state = 'FAILED',
              payload_ciphertext = NULL,
              lease_expires_at = NULL,
              last_error_code = $3,
              updated_at = now()
        WHERE id = $1
          AND state = 'PROCESSING'
          AND attempt_count = $2`,
      [job.id, job.attemptCount, errorCode],
    );
    return (result.rowCount ?? 0) === 1;
  }
}
