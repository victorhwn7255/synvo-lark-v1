import type { Pool } from "pg";

export class PostgresInbox {
  readonly #pool: Pool;
  readonly #activeClaims = new Map<string, number | null>();

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async claim(
    eventId: string,
    eventType: string,
    now = new Date(),
    leaseMs = 30_000,
  ): Promise<boolean> {
    if (!Number.isInteger(leaseMs) || leaseMs <= 0) {
      throw new Error("Inbox lease must be a positive integer");
    }
    if (this.#activeClaims.has(eventId)) {
      return false;
    }

    this.#activeClaims.set(eventId, null);
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    try {
      const result = await this.#pool.query<{ attempt_count: number }>(
        `INSERT INTO inbox_events (
            event_id,
            event_type,
            status,
            attempt_count,
            lease_expires_at
         ) VALUES ($1, $2, 'PROCESSING', 1, $4)
         ON CONFLICT (event_id) DO UPDATE SET
            status = 'PROCESSING',
            attempt_count = inbox_events.attempt_count + 1,
            lease_expires_at = EXCLUDED.lease_expires_at,
            last_error_code = NULL
         WHERE inbox_events.status = 'PROCESSING'
           AND inbox_events.event_type = EXCLUDED.event_type
           AND inbox_events.lease_expires_at <= $3
         RETURNING attempt_count`,
        [eventId, eventType, now, leaseExpiresAt],
      );
      const attemptCount = result.rows[0]?.attempt_count;
      if (attemptCount === undefined) {
        this.#activeClaims.delete(eventId);
        return false;
      }
      this.#activeClaims.set(eventId, attemptCount);
      return true;
    } catch (error) {
      this.#activeClaims.delete(eventId);
      throw error;
    }
  }

  async complete(eventId: string): Promise<boolean> {
    const attemptCount = this.#activeClaims.get(eventId);
    if (attemptCount === undefined) {
      return false;
    }

    const result = await this.#pool.query(
      `UPDATE inbox_events
          SET status = 'COMPLETED',
              lease_expires_at = NULL,
              completed_at = now(),
              last_error_code = NULL
        WHERE event_id = $1
          AND status = 'PROCESSING'
          AND attempt_count = $2`,
      [eventId, attemptCount],
    );
    this.#activeClaims.delete(eventId);
    return (result.rowCount ?? 0) === 1;
  }

  async release(
    eventId: string,
    errorCode: string,
    now = new Date(),
  ): Promise<boolean> {
    const attemptCount = this.#activeClaims.get(eventId);
    if (attemptCount === undefined) {
      return false;
    }

    try {
      const result = await this.#pool.query(
        `UPDATE inbox_events
            SET lease_expires_at = $3,
                last_error_code = $4
          WHERE event_id = $1
            AND status = 'PROCESSING'
            AND attempt_count = $2`,
        [eventId, attemptCount, now, errorCode],
      );
      return (result.rowCount ?? 0) === 1;
    } finally {
      this.#activeClaims.delete(eventId);
    }
  }
}
