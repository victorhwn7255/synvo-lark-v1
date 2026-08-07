import type { Pool, PoolClient } from "pg";

export type DriveMoveSpikeRunContext = {
  runId: string;
  grantId: string;
  requesterOpenId: string;
  tenantKey: string;
  rootTokenDigest: string;
};

export type MutationBatchState =
  | "PREPARED"
  | "EXECUTING"
  | "RESTORED"
  | "FAILED_KNOWN_STATE"
  | "NEEDS_ATTENTION";

export type MoveDirection = "FORWARD" | "RESTORE";

export type MoveAttemptState =
  | "INTENT_RECORDED"
  | "REQUESTING"
  | "RECONCILING"
  | "VERIFIED"
  | "FAILED_KNOWN_STATE"
  | "NEEDS_ATTENTION";

export type StoredMutationBatch = DriveMoveSpikeRunContext & {
  id: string;
  operationKey: string;
  manifestCiphertext: string;
  manifestDigest: string;
  baselineDigest: string;
  state: MutationBatchState;
  confirmationDigest: string | null;
  confirmedAt: Date | null;
  executionAttempt: number;
};

export type StoredMoveAttempt = {
  id: string;
  batchId: string;
  direction: MoveDirection;
  attemptKey: string;
  state: MoveAttemptState;
  requestCount: number;
  intentCiphertext: string;
  responseCiphertext: string | null;
  observationCiphertext: string | null;
  lastErrorCode: string | null;
};

type BatchRow = {
  id: string;
  operation_key: string;
  run_id: string;
  oauth_grant_id: string;
  requester_open_id: string;
  tenant_key: string;
  root_token_digest: string;
  manifest_ciphertext: string;
  manifest_digest: string;
  baseline_digest: string;
  state: MutationBatchState;
  confirmation_digest: string | null;
  confirmed_at: Date | null;
  execution_attempt: number;
};

type AttemptRow = {
  id: string;
  batch_id: string;
  direction: MoveDirection;
  attempt_key: string;
  state: MoveAttemptState;
  request_count: number;
  intent_ciphertext: string;
  response_ciphertext: string | null;
  observation_ciphertext: string | null;
  last_error_code: string | null;
};

const batchColumns = `id,
  operation_key,
  run_id,
  oauth_grant_id,
  requester_open_id,
  tenant_key,
  root_token_digest,
  manifest_ciphertext,
  manifest_digest,
  baseline_digest,
  state,
  confirmation_digest,
  confirmed_at,
  execution_attempt`;

const attemptColumns = `id,
  batch_id,
  direction,
  attempt_key,
  state,
  request_count,
  intent_ciphertext,
  response_ciphertext,
  observation_ciphertext,
  last_error_code`;

function toBatch(row: BatchRow): StoredMutationBatch {
  return {
    id: row.id,
    operationKey: row.operation_key,
    runId: row.run_id,
    grantId: row.oauth_grant_id,
    requesterOpenId: row.requester_open_id,
    tenantKey: row.tenant_key,
    rootTokenDigest: row.root_token_digest,
    manifestCiphertext: row.manifest_ciphertext,
    manifestDigest: row.manifest_digest,
    baselineDigest: row.baseline_digest,
    state: row.state,
    confirmationDigest: row.confirmation_digest,
    confirmedAt: row.confirmed_at,
    executionAttempt: row.execution_attempt,
  };
}

function toAttempt(row: AttemptRow): StoredMoveAttempt {
  return {
    id: row.id,
    batchId: row.batch_id,
    direction: row.direction,
    attemptKey: row.attempt_key,
    state: row.state,
    requestCount: row.request_count,
    intentCiphertext: row.intent_ciphertext,
    responseCiphertext: row.response_ciphertext,
    observationCiphertext: row.observation_ciphertext,
    lastErrorCode: row.last_error_code,
  };
}

export interface DriveMoveSpikeStore {
  loadLatestCompletedRun(): Promise<DriveMoveSpikeRunContext | null>;
  prepare(input: {
    id: string;
    operationKey: string;
    context: DriveMoveSpikeRunContext;
    manifestCiphertext: string;
    manifestDigest: string;
    baselineDigest: string;
  }): Promise<StoredMutationBatch>;
  loadBatch(batchId: string): Promise<StoredMutationBatch | null>;
  claimExecution(batchId: string, confirmationDigest: string): Promise<StoredMutationBatch>;
  ensureAttempt(input: {
    id: string;
    batchId: string;
    direction: MoveDirection;
    attemptKey: string;
    intentCiphertext: string;
  }): Promise<StoredMoveAttempt>;
  beginRequest(attemptId: string): Promise<StoredMoveAttempt>;
  allowReconciledRetry(attemptId: string): Promise<StoredMoveAttempt>;
  recordResponse(attemptId: string, responseCiphertext: string): Promise<void>;
  recordObservation(input: {
    attemptId: string;
    state: MoveAttemptState;
    observationCiphertext: string;
    errorCode?: string;
  }): Promise<void>;
  finishBatch(batchId: string, state: MutationBatchState, errorCode?: string): Promise<void>;
}

async function selectBatch(
  client: Pick<PoolClient, "query">,
  batchId: string,
  lock = false,
): Promise<StoredMutationBatch | null> {
  const result = await client.query<BatchRow>(
    `SELECT ${batchColumns}
       FROM phase3_mutation_batches
      WHERE id = $1
      ${lock ? "FOR UPDATE" : ""}`,
    [batchId],
  );
  return result.rows[0] ? toBatch(result.rows[0]) : null;
}

export class PostgresDriveMoveSpikeStore implements DriveMoveSpikeStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async loadLatestCompletedRun(): Promise<DriveMoveSpikeRunContext | null> {
    const result = await this.#pool.query<{
      run_id: string;
      oauth_grant_id: string;
      requester_open_id: string;
      tenant_key: string;
      root_token_digest: string;
    }>(
      `SELECT run.id AS run_id,
              run.oauth_grant_id,
              run.requester_open_id,
              run.tenant_key,
              run.root_token_digest
         FROM organize_folder_runs AS run
         JOIN lark_oauth_grants AS oauth_grant
           ON oauth_grant.id = run.oauth_grant_id
          AND oauth_grant.open_id = run.requester_open_id
          AND oauth_grant.tenant_key = run.tenant_key
          AND oauth_grant.scope_profile = 'phase3_move_spike'
        WHERE run.workflow_phase = 3
          AND run.state = 'COMPLETED'
          AND run.terminal_error_code IS NULL
        ORDER BY run.created_at DESC, run.id DESC
        LIMIT 1`,
    );
    const row = result.rows[0];
    return row
      ? {
          runId: row.run_id,
          grantId: row.oauth_grant_id,
          requesterOpenId: row.requester_open_id,
          tenantKey: row.tenant_key,
          rootTokenDigest: row.root_token_digest,
        }
      : null;
  }

  async prepare(input: {
    id: string;
    operationKey: string;
    context: DriveMoveSpikeRunContext;
    manifestCiphertext: string;
    manifestDigest: string;
    baselineDigest: string;
  }): Promise<StoredMutationBatch> {
    const result = await this.#pool.query<BatchRow>(
      `INSERT INTO phase3_mutation_batches (
          id,
          operation_key,
          run_id,
          oauth_grant_id,
          requester_open_id,
          tenant_key,
          root_token_digest,
          manifest_ciphertext,
          manifest_digest,
          baseline_digest,
          state
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'PREPARED')
       ON CONFLICT (operation_key) DO UPDATE
         SET operation_key = EXCLUDED.operation_key
       RETURNING ${batchColumns}`,
      [
        input.id,
        input.operationKey,
        input.context.runId,
        input.context.grantId,
        input.context.requesterOpenId,
        input.context.tenantKey,
        input.context.rootTokenDigest,
        input.manifestCiphertext,
        input.manifestDigest,
        input.baselineDigest,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("PHASE3_BATCH_PREPARE_FAILED");
    }
    return toBatch(row);
  }

  loadBatch(batchId: string): Promise<StoredMutationBatch | null> {
    return selectBatch(this.#pool, batchId);
  }

  async claimExecution(
    batchId: string,
    confirmationDigest: string,
  ): Promise<StoredMutationBatch> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const batch = await selectBatch(client, batchId, true);
      if (!batch) {
        throw new Error("PHASE3_BATCH_NOT_FOUND");
      }
      if (batch.state === "RESTORED") {
        await client.query("COMMIT");
        return batch;
      }
      if (batch.confirmationDigest && batch.confirmationDigest !== confirmationDigest) {
        throw new Error("PHASE3_CONFIRMATION_MISMATCH");
      }
      if (!new Set<MutationBatchState>(["PREPARED", "EXECUTING"]).has(batch.state)) {
        throw new Error(`PHASE3_BATCH_NOT_EXECUTABLE:${batch.state}`);
      }
      const result = await client.query<BatchRow>(
        `UPDATE phase3_mutation_batches
            SET state = 'EXECUTING',
                confirmation_digest = COALESCE(confirmation_digest, $2),
                confirmed_at = COALESCE(confirmed_at, now()),
                execution_attempt = execution_attempt + 1,
                lease_expires_at = now() + interval '5 minutes',
                updated_at = now()
          WHERE id = $1
            AND (
              state = 'PREPARED'
              OR (state = 'EXECUTING' AND (lease_expires_at IS NULL OR lease_expires_at <= now()))
            )
        RETURNING ${batchColumns}`,
        [batchId, confirmationDigest],
      );
      const claimed = result.rows[0];
      if (!claimed) {
        throw new Error("PHASE3_BATCH_ALREADY_RUNNING");
      }
      await client.query("COMMIT");
      return toBatch(claimed);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async ensureAttempt(input: {
    id: string;
    batchId: string;
    direction: MoveDirection;
    attemptKey: string;
    intentCiphertext: string;
  }): Promise<StoredMoveAttempt> {
    await this.#pool.query(
      `INSERT INTO phase3_move_attempts (
          id, batch_id, direction, attempt_key, state, intent_ciphertext
       ) VALUES ($1, $2, $3, $4, 'INTENT_RECORDED', $5)
       ON CONFLICT DO NOTHING`,
      [
        input.id,
        input.batchId,
        input.direction,
        input.attemptKey,
        input.intentCiphertext,
      ],
    );
    const result = await this.#pool.query<AttemptRow>(
      `SELECT ${attemptColumns}
         FROM phase3_move_attempts
        WHERE batch_id = $1 AND direction = $2`,
      [input.batchId, input.direction],
    );
    const row = result.rows[0];
    if (!row || row.attempt_key !== input.attemptKey) {
      throw new Error("PHASE3_ATTEMPT_IDENTITY_MISMATCH");
    }
    return toAttempt(row);
  }

  async beginRequest(attemptId: string): Promise<StoredMoveAttempt> {
    const result = await this.#pool.query<AttemptRow>(
      `UPDATE phase3_move_attempts
          SET state = 'REQUESTING',
              request_count = request_count + 1,
              updated_at = now()
        WHERE id = $1
          AND state = 'INTENT_RECORDED'
          AND request_count < 3
      RETURNING ${attemptColumns}`,
      [attemptId],
    );
    const row = result.rows[0];
    if (!row) {
      const existing = await this.#pool.query<AttemptRow>(
        `SELECT ${attemptColumns} FROM phase3_move_attempts WHERE id = $1`,
        [attemptId],
      );
      const current = existing.rows[0];
      if (!current) {
        throw new Error("PHASE3_ATTEMPT_NOT_FOUND");
      }
      return toAttempt(current);
    }
    return toAttempt(row);
  }

  async allowReconciledRetry(attemptId: string): Promise<StoredMoveAttempt> {
    const result = await this.#pool.query<AttemptRow>(
      `UPDATE phase3_move_attempts
          SET state = 'INTENT_RECORDED',
              updated_at = now()
        WHERE id = $1
          AND state IN ('REQUESTING', 'RECONCILING')
          AND request_count < 3
      RETURNING ${attemptColumns}`,
      [attemptId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error("PHASE3_ATTEMPT_NOT_RETRYABLE");
    }
    return toAttempt(row);
  }

  async recordResponse(attemptId: string, responseCiphertext: string): Promise<void> {
    await this.#pool.query(
      `UPDATE phase3_move_attempts
          SET response_ciphertext = $2,
              state = 'RECONCILING',
              updated_at = now()
        WHERE id = $1`,
      [attemptId, responseCiphertext],
    );
  }

  async recordObservation(input: {
    attemptId: string;
    state: MoveAttemptState;
    observationCiphertext: string;
    errorCode?: string;
  }): Promise<void> {
    await this.#pool.query(
      `UPDATE phase3_move_attempts
          SET state = $2,
              observation_ciphertext = $3,
              last_error_code = $4,
              updated_at = now()
        WHERE id = $1`,
      [
        input.attemptId,
        input.state,
        input.observationCiphertext,
        input.errorCode ?? null,
      ],
    );
  }

  async finishBatch(
    batchId: string,
    state: MutationBatchState,
    errorCode?: string,
  ): Promise<void> {
    await this.#pool.query(
      `UPDATE phase3_mutation_batches
          SET state = $2,
              terminal_error_code = $3,
              lease_expires_at = NULL,
              updated_at = now()
        WHERE id = $1`,
      [batchId, state, errorCode ?? null],
    );
  }
}
