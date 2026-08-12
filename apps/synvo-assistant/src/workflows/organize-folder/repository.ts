import type { Pool, PoolClient } from "pg";

import { insertDeliveryJob } from "../../delivery/repository.js";
import type { ExecutionStatus, UndoStatus } from "./execution.js";
import type { ProposalStatus } from "./proposal.js";

export type InventoryRun = {
  id: string;
  chatId: string;
  requesterOpenId: string;
  tenantKey: string;
  state: string;
  rootTokenDigest: string;
  oauthGrantId: string | null;
  oauthGrantMatchesSubject: boolean;
  resultCiphertext: string | null;
  proposalCiphertext: string | null;
  proposalStatus: ProposalStatus | null;
  executionCiphertext: string | null;
  executionStatus: ExecutionStatus | null;
  undoStatus: UndoStatus | null;
  operationMessageId: string | null;
};

export type ProposalDecisionStoreResult =
  | {
      kind: "recorded";
      status: "APPROVED" | "REJECTED";
      executionQueued: boolean;
    }
  | { kind: "existing"; status: ProposalStatus }
  | { kind: "not_found" };

export type UndoRequestStoreResult =
  | { kind: "recorded" }
  | { kind: "existing"; status: UndoStatus }
  | { kind: "not_ready" }
  | { kind: "not_found" };

export type StoreInventoryResultInput =
  | {
      runId: string;
      resultCiphertext: string;
      state: "COMPLETED";
      errorCode: null;
      proposalCiphertext: string;
      proposalStatus: "PROPOSED";
    }
  | {
      runId: string;
      resultCiphertext: string;
      state: "FAILED_NO_CHANGE";
      errorCode: string | null;
      proposalCiphertext: string | null;
      proposalStatus: null;
    };

export type OAuthSession = {
  runId: string;
  requestTokenDigest: string;
  requesterOpenId: string;
  tenantKey: string;
  redirectUri: string;
  requestedScopes: string[];
  codeVerifierCiphertext: string;
};

export interface OrganizeFolderRepository {
  hasRunForMessage(messageId: string): Promise<boolean>;
  findInventoryRunById(runId: string): Promise<InventoryRun | null>;
  createReadyRun(input: {
    id: string;
    messageId: string;
    chatId: string;
    requesterOpenId: string;
    tenantKey: string;
    rootTokenDigest: string;
    oauthGrantId: string;
    consentSnapshotCiphertext: string;
    deliveryJobId: string;
  }): Promise<boolean>;
  createAwaitingOAuthRun(input: {
    runId: string;
    sessionId: string;
    messageId: string;
    chatId: string;
    requesterOpenId: string;
    tenantKey: string;
    rootTokenDigest: string;
    requestTokenDigest: string;
    redirectUri: string;
    requestedScopes: string[];
    expiresAt: Date;
    deliveryJobId: string | null;
    authorizationMessageCiphertext: string | null;
  }): Promise<boolean>;
  startOAuthSession(input: {
    requestTokenDigest: string;
    stateDigest: string;
    codeVerifierCiphertext: string;
    now: Date;
  }): Promise<OAuthSession | null>;
  consumeOAuthSession(stateDigest: string, now: Date): Promise<OAuthSession | null>;
  bindGrantToRun(
    runId: string,
    grantId: string,
    deliveryJobId: string,
    completionMessageCiphertext: string,
  ): Promise<void>;
  markRunFailed(runId: string, errorCode: string): Promise<void>;
  storeInventoryResult(input: StoreInventoryResultInput): Promise<boolean>;
  recordProposalDecision(input: {
    proposalId: string;
    chatId: string;
    requesterOpenId: string;
    tenantKey: string;
    decision: "APPROVED" | "REJECTED";
    decidedAt: Date;
    proposalNotBefore?: Date;
    executionJobId?: string;
    operationMessageId?: string;
  }): Promise<ProposalDecisionStoreResult>;
  markProposalStale(proposalId: string): Promise<boolean>;
  startExecution(proposalId: string): Promise<boolean>;
  storeExecution(input: {
    proposalId: string;
    status: ExecutionStatus;
    ciphertext: string | null;
  }): Promise<boolean>;
  requestUndo(input: {
    proposalId: string;
    chatId: string;
    requesterOpenId: string;
    tenantKey: string;
    deliveryJobId: string;
    executionCiphertext: string;
    operationMessageId?: string;
  }): Promise<UndoRequestStoreResult>;
  startUndo(proposalId: string): Promise<boolean>;
  storeUndo(input: {
    proposalId: string;
    status: UndoStatus;
    ciphertext: string;
  }): Promise<boolean>;
}

type SessionRow = {
  run_id: string;
  request_token_digest: string;
  requester_open_id: string;
  tenant_key: string;
  redirect_uri: string;
  requested_scopes: string[];
  code_verifier_ciphertext: string;
};

type InventoryRunRow = {
  id: string;
  chat_id: string;
  requester_open_id: string;
  tenant_key: string;
  state: string;
  root_token_digest: string;
  oauth_grant_id: string | null;
  oauth_grant_matches_subject: boolean;
  scan_result_ciphertext: string | null;
  proposal_ciphertext: string | null;
  proposal_status: ProposalStatus | null;
  execution_ciphertext: string | null;
  execution_status: ExecutionStatus | null;
  undo_status: UndoStatus | null;
  operation_message_id: string | null;
};

type ProposalDecisionRow = {
  proposal_status: ProposalStatus;
  chat_id: string;
};

type UndoStatusRow = { undo_status: UndoStatus | null };

function toSession(row: SessionRow): OAuthSession {
  return {
    runId: row.run_id,
    requestTokenDigest: row.request_token_digest,
    requesterOpenId: row.requester_open_id,
    tenantKey: row.tenant_key,
    redirectUri: row.redirect_uri,
    requestedScopes: [...row.requested_scopes].sort(),
    codeVerifierCiphertext: row.code_verifier_ciphertext,
  };
}

async function insertRun(
  client: Pick<PoolClient, "query">,
  input: {
    id: string;
    messageId: string;
    chatId: string;
    requesterOpenId: string;
    tenantKey: string;
    rootTokenDigest: string;
    oauthGrantId: string | null;
    state: "AWAITING_OAUTH" | "READY_TO_SCAN";
  },
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO organize_folder_runs (
        id,
        message_id,
        chat_id,
        requester_open_id,
        tenant_key,
        root_token_digest,
        oauth_grant_id,
        state
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (message_id) DO NOTHING`,
    [
      input.id,
      input.messageId,
      input.chatId,
      input.requesterOpenId,
      input.tenantKey,
      input.rootTokenDigest,
      input.oauthGrantId,
      input.state,
    ],
  );
  return (result.rowCount ?? 0) === 1;
}

export class PostgresOrganizeFolderRepository implements OrganizeFolderRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async hasRunForMessage(messageId: string): Promise<boolean> {
    const result = await this.#pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM organize_folder_runs
          WHERE message_id = $1
       ) AS exists`,
      [messageId],
    );
    return result.rows[0]?.exists ?? false;
  }

  async findInventoryRunById(runId: string): Promise<InventoryRun | null> {
    const result = await this.#pool.query<InventoryRunRow>(
      `SELECT run.id,
              run.chat_id,
              run.requester_open_id,
              run.tenant_key,
              run.state,
              run.root_token_digest,
              run.oauth_grant_id,
              run.scan_result_ciphertext,
              run.proposal_ciphertext,
              run.proposal_status,
              run.execution_ciphertext,
              run.execution_status,
              run.undo_status,
              run.operation_message_id,
              EXISTS (
                SELECT 1
                  FROM lark_oauth_grants AS oauth_grant
                 WHERE oauth_grant.id = run.oauth_grant_id
                   AND oauth_grant.open_id = run.requester_open_id
                   AND oauth_grant.tenant_key = run.tenant_key
              ) AS oauth_grant_matches_subject
         FROM organize_folder_runs AS run
        WHERE run.id = $1`,
      [runId],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          chatId: row.chat_id,
          requesterOpenId: row.requester_open_id,
          tenantKey: row.tenant_key,
          state: row.state,
          rootTokenDigest: row.root_token_digest,
          oauthGrantId: row.oauth_grant_id,
          oauthGrantMatchesSubject: row.oauth_grant_matches_subject,
          resultCiphertext: row.scan_result_ciphertext,
          proposalCiphertext: row.proposal_ciphertext,
          proposalStatus: row.proposal_status,
          executionCiphertext: row.execution_ciphertext,
          executionStatus: row.execution_status,
          undoStatus: row.undo_status,
          operationMessageId: row.operation_message_id,
        }
      : null;
  }

  async createReadyRun(input: {
    id: string;
    messageId: string;
    chatId: string;
    requesterOpenId: string;
    tenantKey: string;
    rootTokenDigest: string;
    oauthGrantId: string;
    consentSnapshotCiphertext: string;
    deliveryJobId: string;
  }): Promise<boolean> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await insertRun(client, {
        ...input,
        state: "READY_TO_SCAN",
      });
      if (!inserted) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `UPDATE organize_folder_runs
            SET scan_result_ciphertext = $2,
                updated_at = now()
          WHERE id = $1`,
        [input.id, input.consentSnapshotCiphertext],
      );
      const queued = await insertDeliveryJob(client, {
        id: input.deliveryJobId,
        dedupeKey: `organize-folder-scan:${input.id}`,
        runId: input.id,
        kind: "ORGANIZE_FOLDER_SCAN",
        chatId: input.chatId,
      });
      if (!queued) {
        throw new Error("Drive scan delivery job could not be created");
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createAwaitingOAuthRun(input: {
    runId: string;
    sessionId: string;
    messageId: string;
    chatId: string;
    requesterOpenId: string;
    tenantKey: string;
    rootTokenDigest: string;
    requestTokenDigest: string;
    redirectUri: string;
    requestedScopes: string[];
    expiresAt: Date;
    deliveryJobId: string | null;
    authorizationMessageCiphertext: string | null;
  }): Promise<boolean> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await insertRun(client, {
        id: input.runId,
        messageId: input.messageId,
        chatId: input.chatId,
        requesterOpenId: input.requesterOpenId,
        tenantKey: input.tenantKey,
        rootTokenDigest: input.rootTokenDigest,
        oauthGrantId: null,
        state: "AWAITING_OAUTH",
      });
      if (!inserted) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `INSERT INTO lark_oauth_sessions (
            id,
            run_id,
            request_token_digest,
            requester_open_id,
            tenant_key,
            redirect_uri,
            requested_scopes,
            expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          input.sessionId,
          input.runId,
          input.requestTokenDigest,
          input.requesterOpenId,
          input.tenantKey,
          input.redirectUri,
          input.requestedScopes,
          input.expiresAt,
        ],
      );
      if (
        (input.deliveryJobId === null) !==
        (input.authorizationMessageCiphertext === null)
      ) {
        throw new Error("Authorization delivery fields must be provided together");
      }
      if (input.deliveryJobId && input.authorizationMessageCiphertext) {
        const queued = await insertDeliveryJob(client, {
          id: input.deliveryJobId,
          dedupeKey: `organize-folder-authorization:${input.runId}`,
          runId: input.runId,
          kind: "TEXT",
          chatId: input.chatId,
          payloadCiphertext: input.authorizationMessageCiphertext,
          expiresAt: input.expiresAt,
        });
        if (!queued) {
          throw new Error("Authorization delivery job could not be created");
        }
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async startOAuthSession(input: {
    requestTokenDigest: string;
    stateDigest: string;
    codeVerifierCiphertext: string;
    now: Date;
  }): Promise<OAuthSession | null> {
    const result = await this.#pool.query<SessionRow>(
      `UPDATE lark_oauth_sessions
          SET state_digest = $2,
              code_verifier_ciphertext = $3,
              started_at = $4
        WHERE request_token_digest = $1
          AND started_at IS NULL
          AND consumed_at IS NULL
          AND expires_at > $4
      RETURNING run_id,
                request_token_digest,
                requester_open_id,
                tenant_key,
                redirect_uri,
                requested_scopes,
                code_verifier_ciphertext`,
      [
        input.requestTokenDigest,
        input.stateDigest,
        input.codeVerifierCiphertext,
        input.now,
      ],
    );
    return result.rows[0] ? toSession(result.rows[0]) : null;
  }

  async consumeOAuthSession(
    stateDigest: string,
    now: Date,
  ): Promise<OAuthSession | null> {
    const result = await this.#pool.query<SessionRow>(
      `UPDATE lark_oauth_sessions
          SET consumed_at = $2
        WHERE state_digest = $1
          AND consumed_at IS NULL
          AND expires_at > $2
      RETURNING run_id,
                request_token_digest,
                requester_open_id,
                tenant_key,
                redirect_uri,
                requested_scopes,
                code_verifier_ciphertext`,
      [stateDigest, now],
    );
    return result.rows[0] ? toSession(result.rows[0]) : null;
  }

  async bindGrantToRun(
    runId: string,
    grantId: string,
    deliveryJobId: string,
    completionMessageCiphertext: string,
  ): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ chat_id: string }>(
        `UPDATE organize_folder_runs
            SET oauth_grant_id = $2,
                state = 'FAILED_NO_CHANGE',
                terminal_error_code = NULL,
                updated_at = now()
          WHERE id = $1 AND state = 'AWAITING_OAUTH'
        RETURNING chat_id`,
        [runId, grantId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error("OAuth run could not be bound to the grant");
      }
      const queued = await insertDeliveryJob(client, {
        id: deliveryJobId,
        dedupeKey: `organize-workspace-authorization-complete:${runId}`,
        runId,
        kind: "TEXT",
        chatId: row.chat_id,
        payloadCiphertext: completionMessageCiphertext,
      });
      if (!queued) {
        throw new Error("Authorization completion delivery job could not be created");
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markRunFailed(runId: string, errorCode: string): Promise<void> {
    await this.#pool.query(
      `UPDATE organize_folder_runs
          SET state = 'FAILED_NO_CHANGE',
              terminal_error_code = $2,
              updated_at = now()
        WHERE id = $1 AND state IN ('AWAITING_OAUTH', 'READY_TO_SCAN')`,
      [runId, errorCode],
    );
  }
  async storeInventoryResult(
    input: StoreInventoryResultInput,
  ): Promise<boolean> {
    const result = await this.#pool.query(
      `UPDATE organize_folder_runs
          SET state = $2,
              terminal_error_code = $3,
              scan_result_ciphertext = $4,
              proposal_ciphertext = $5,
              proposal_status = $6,
              updated_at = now()
        WHERE id = $1
          AND state IN ('READY_TO_SCAN', 'SCANNING')
      RETURNING id`,
      [
        input.runId,
        input.state,
        input.errorCode,
        input.resultCiphertext,
        input.proposalCiphertext,
        input.proposalStatus,
      ],
    );
    return result.rowCount === 1;
  }

  async recordProposalDecision(input: {
    proposalId: string;
    chatId: string;
    requesterOpenId: string;
    tenantKey: string;
    decision: "APPROVED" | "REJECTED";
    decidedAt: Date;
    proposalNotBefore?: Date;
    executionJobId?: string;
    operationMessageId?: string;
  }): Promise<ProposalDecisionStoreResult> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const queueExecution =
        input.decision === "APPROVED" && input.executionJobId !== undefined;
      const updated = await client.query<ProposalDecisionRow>(
        `UPDATE organize_folder_runs
            SET proposal_status = $4,
                proposal_decided_by_open_id = $2,
                proposal_decided_at = $5,
                execution_status = CASE WHEN $6 THEN 'QUEUED' ELSE execution_status END,
                operation_message_id = CASE
                  WHEN $6 THEN COALESCE($9, operation_message_id)
                  ELSE operation_message_id
                END,
                updated_at = now()
          WHERE id = $1
            AND requester_open_id = $2
            AND tenant_key = $3
            AND chat_id = $7
            AND proposal_status = 'PROPOSED'
            AND proposal_ciphertext IS NOT NULL
            AND updated_at >= $8
        RETURNING proposal_status, chat_id`,
        [
          input.proposalId,
          input.requesterOpenId,
          input.tenantKey,
          input.decision,
          input.decidedAt,
          queueExecution,
          input.chatId,
          input.proposalNotBefore ?? new Date(0),
          input.operationMessageId ?? null,
        ],
      );
      const row = updated.rows[0];
      if (row) {
        if (queueExecution) {
          const queued = await insertDeliveryJob(client, {
            id: input.executionJobId!,
            dedupeKey: `organize-folder-execute:${input.proposalId}`,
            runId: input.proposalId,
            kind: "ORGANIZE_FOLDER_EXECUTE",
            chatId: row.chat_id,
          });
          if (!queued) {
            throw new Error("Folder execution delivery job could not be created");
          }
        }
        await client.query("COMMIT");
        return {
          kind: "recorded",
          status: input.decision,
          executionQueued: queueExecution,
        };
      }

      const expired = await client.query<ProposalDecisionRow>(
        `UPDATE organize_folder_runs
            SET proposal_status = 'STALE',
                updated_at = now()
          WHERE id = $1
            AND requester_open_id = $2
            AND tenant_key = $3
            AND chat_id = $4
            AND proposal_status = 'PROPOSED'
            AND proposal_ciphertext IS NOT NULL
            AND updated_at < $5
        RETURNING proposal_status, chat_id`,
        [
          input.proposalId,
          input.requesterOpenId,
          input.tenantKey,
          input.chatId,
          input.proposalNotBefore ?? new Date(0),
        ],
      );
      if (expired.rows[0]) {
        await client.query("COMMIT");
        return { kind: "existing", status: "STALE" };
      }

      const existing = await client.query<Pick<ProposalDecisionRow, "proposal_status">>(
        `SELECT proposal_status
           FROM organize_folder_runs
          WHERE id = $1
            AND requester_open_id = $2
            AND tenant_key = $3
            AND chat_id = $4
            AND proposal_status IS NOT NULL
            AND proposal_ciphertext IS NOT NULL`,
        [input.proposalId, input.requesterOpenId, input.tenantKey, input.chatId],
      );
      await client.query("COMMIT");
      const existingRow = existing.rows[0];
      return existingRow
        ? { kind: "existing", status: existingRow.proposal_status }
        : { kind: "not_found" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markProposalStale(proposalId: string): Promise<boolean> {
    const result = await this.#pool.query(
      `UPDATE organize_folder_runs
          SET proposal_status = 'STALE',
              execution_status = 'STALE',
              updated_at = now()
        WHERE id = $1
          AND proposal_status = 'APPROVED'
          AND execution_status IN ('QUEUED', 'RUNNING')`,
      [proposalId],
    );
    return result.rowCount === 1;
  }

  async startExecution(proposalId: string): Promise<boolean> {
    const result = await this.#pool.query(
      `UPDATE organize_folder_runs
          SET execution_status = 'RUNNING',
              updated_at = now()
        WHERE id = $1
          AND proposal_status = 'APPROVED'
          AND execution_status IN ('QUEUED', 'RUNNING')
      RETURNING id`,
      [proposalId],
    );
    return result.rowCount === 1;
  }

  async storeExecution(input: {
    proposalId: string;
    status: ExecutionStatus;
    ciphertext: string | null;
  }): Promise<boolean> {
    const result = await this.#pool.query(
      `UPDATE organize_folder_runs
          SET execution_status = $2,
              execution_ciphertext = $3,
              updated_at = now()
        WHERE id = $1
          AND proposal_status IN ('APPROVED', 'STALE')
          AND execution_status IS NOT NULL
      RETURNING id`,
      [input.proposalId, input.status, input.ciphertext],
    );
    return result.rowCount === 1;
  }

  async requestUndo(input: {
    proposalId: string;
    chatId: string;
    requesterOpenId: string;
    tenantKey: string;
    deliveryJobId: string;
    executionCiphertext: string;
    operationMessageId?: string;
  }): Promise<UndoRequestStoreResult> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<{ chat_id: string }>(
        `UPDATE organize_folder_runs
            SET undo_status = 'REQUESTED',
                execution_ciphertext = $4,
                operation_message_id = COALESCE($6, operation_message_id),
                updated_at = now()
          WHERE id = $1
            AND requester_open_id = $2
            AND tenant_key = $3
            AND chat_id = $5
            AND execution_ciphertext IS NOT NULL
            AND execution_status IN ('COMPLETED', 'PARTIAL')
            AND undo_status IS NULL
        RETURNING chat_id`,
        [
          input.proposalId,
          input.requesterOpenId,
          input.tenantKey,
          input.executionCiphertext,
          input.chatId,
          input.operationMessageId ?? null,
        ],
      );
      const row = updated.rows[0];
      if (row) {
        const queued = await insertDeliveryJob(client, {
          id: input.deliveryJobId,
          dedupeKey: `organize-folder-undo:${input.proposalId}`,
          runId: input.proposalId,
          kind: "ORGANIZE_FOLDER_UNDO",
          chatId: row.chat_id,
        });
        if (!queued) {
          throw new Error("Folder undo delivery job could not be created");
        }
        await client.query("COMMIT");
        return { kind: "recorded" };
      }

      const existing = await client.query<UndoStatusRow>(
        `SELECT undo_status
           FROM organize_folder_runs
          WHERE id = $1
            AND requester_open_id = $2
            AND tenant_key = $3
            AND chat_id = $4`,
        [input.proposalId, input.requesterOpenId, input.tenantKey, input.chatId],
      );
      await client.query("COMMIT");
      const existingRow = existing.rows[0];
      if (!existingRow) {
        return { kind: "not_found" };
      }
      return existingRow.undo_status
        ? { kind: "existing", status: existingRow.undo_status }
        : { kind: "not_ready" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async startUndo(proposalId: string): Promise<boolean> {
    const result = await this.#pool.query(
      `UPDATE organize_folder_runs
          SET undo_status = 'RUNNING',
              updated_at = now()
        WHERE id = $1
          AND execution_ciphertext IS NOT NULL
          AND execution_status IN ('COMPLETED', 'PARTIAL')
          AND undo_status IN ('REQUESTED', 'RUNNING')
      RETURNING id`,
      [proposalId],
    );
    return result.rowCount === 1;
  }

  async storeUndo(input: {
    proposalId: string;
    status: UndoStatus;
    ciphertext: string;
  }): Promise<boolean> {
    const result = await this.#pool.query(
      `UPDATE organize_folder_runs
          SET undo_status = $2,
              execution_ciphertext = $3,
              updated_at = now()
        WHERE id = $1
          AND undo_status IS NOT NULL
      RETURNING id`,
      [input.proposalId, input.status, input.ciphertext],
    );
    return result.rowCount === 1;
  }
}
