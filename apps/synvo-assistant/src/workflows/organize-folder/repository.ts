import type { Pool, PoolClient } from "pg";

import { insertDeliveryJob } from "../../delivery/repository.js";
import type { ProposalStatus } from "./proposal.js";

export type OrganizeFolderRun = {
  id: string;
  messageId: string;
  chatId: string;
  requesterOpenId: string;
  tenantKey: string;
  state: string;
  oauthGrantId: string | null;
};

export type InventoryRun = {
  id: string;
  requesterOpenId: string;
  tenantKey: string;
  state: string;
  rootTokenDigest: string;
  oauthGrantId: string | null;
  oauthGrantMatchesSubject: boolean;
  resultCiphertext: string | null;
  proposalCiphertext: string | null;
  proposalStatus: ProposalStatus | null;
};

export type ProposalDecisionStoreResult =
  | { kind: "recorded"; status: "APPROVED" | "REJECTED" }
  | { kind: "existing"; status: ProposalStatus }
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
      errorCode: string;
      proposalCiphertext: null;
      proposalStatus: null;
    };

export type OAuthSession = {
  id: string;
  runId: string;
  requestTokenDigest: string;
  requesterOpenId: string;
  tenantKey: string;
  chatId: string;
  redirectUri: string;
  requestedScopes: string[];
  codeVerifierCiphertext: string;
  expiresAt: Date;
};

export interface OrganizeFolderRepository {
  findRunByMessageId(messageId: string): Promise<OrganizeFolderRun | null>;
  findInventoryRunById(runId: string): Promise<InventoryRun | null>;
  createReadyRun(input: {
    id: string;
    messageId: string;
    chatId: string;
    requesterOpenId: string;
    tenantKey: string;
    rootTokenDigest: string;
    oauthGrantId: string;
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
    deliveryJobId: string;
    authorizationMessageCiphertext: string;
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
  ): Promise<void>;
  markRunFailed(runId: string, errorCode: string): Promise<void>;
  storeInventoryResult(input: StoreInventoryResultInput): Promise<boolean>;
  recordProposalDecision(input: {
    proposalId: string;
    requesterOpenId: string;
    tenantKey: string;
    decision: "APPROVED" | "REJECTED";
    decidedAt: Date;
  }): Promise<ProposalDecisionStoreResult>;
}

type RunRow = {
  id: string;
  message_id: string;
  chat_id: string;
  requester_open_id: string;
  tenant_key: string;
  state: string;
  oauth_grant_id: string | null;
};

type SessionRow = {
  id: string;
  run_id: string;
  request_token_digest: string;
  requester_open_id: string;
  tenant_key: string;
  chat_id: string;
  redirect_uri: string;
  requested_scopes: string[];
  code_verifier_ciphertext: string;
  expires_at: Date;
};

type InventoryRunRow = {
  id: string;
  requester_open_id: string;
  tenant_key: string;
  state: string;
  root_token_digest: string;
  oauth_grant_id: string | null;
  oauth_grant_matches_subject: boolean;
  scan_result_ciphertext: string | null;
  proposal_ciphertext: string | null;
  proposal_status: ProposalStatus | null;
};

type ProposalDecisionRow = {
  proposal_status: ProposalStatus;
};

function toRun(row: RunRow): OrganizeFolderRun {
  return {
    id: row.id,
    messageId: row.message_id,
    chatId: row.chat_id,
    requesterOpenId: row.requester_open_id,
    tenantKey: row.tenant_key,
    state: row.state,
    oauthGrantId: row.oauth_grant_id,
  };
}

function toSession(row: SessionRow): OAuthSession {
  return {
    id: row.id,
    runId: row.run_id,
    requestTokenDigest: row.request_token_digest,
    requesterOpenId: row.requester_open_id,
    tenantKey: row.tenant_key,
    chatId: row.chat_id,
    redirectUri: row.redirect_uri,
    requestedScopes: [...row.requested_scopes].sort(),
    codeVerifierCiphertext: row.code_verifier_ciphertext,
    expiresAt: row.expires_at,
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
    workflowPhase: 2 | 3;
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
        state,
        workflow_phase
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
      input.workflowPhase,
    ],
  );
  return (result.rowCount ?? 0) === 1;
}

export class PostgresOrganizeFolderRepository implements OrganizeFolderRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async findRunByMessageId(messageId: string): Promise<OrganizeFolderRun | null> {
    const result = await this.#pool.query<RunRow>(
      `SELECT id,
              message_id,
              chat_id,
              requester_open_id,
              tenant_key,
              state,
              oauth_grant_id
         FROM organize_folder_runs
        WHERE message_id = $1`,
      [messageId],
    );
    return result.rows[0] ? toRun(result.rows[0]) : null;
  }

  async findInventoryRunById(runId: string): Promise<InventoryRun | null> {
    const result = await this.#pool.query<InventoryRunRow>(
      `SELECT run.id,
              run.requester_open_id,
              run.tenant_key,
              run.state,
              run.root_token_digest,
              run.oauth_grant_id,
              run.scan_result_ciphertext,
              run.proposal_ciphertext,
              run.proposal_status,
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
          requesterOpenId: row.requester_open_id,
          tenantKey: row.tenant_key,
          state: row.state,
          rootTokenDigest: row.root_token_digest,
          oauthGrantId: row.oauth_grant_id,
          oauthGrantMatchesSubject: row.oauth_grant_matches_subject,
          resultCiphertext: row.scan_result_ciphertext,
          proposalCiphertext: row.proposal_ciphertext,
          proposalStatus: row.proposal_status,
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
    deliveryJobId: string;
  }): Promise<boolean> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await insertRun(client, {
        ...input,
        state: "READY_TO_SCAN",
        workflowPhase: 2,
      });
      if (!inserted) {
        await client.query("ROLLBACK");
        return false;
      }
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
    deliveryJobId: string;
    authorizationMessageCiphertext: string;
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
        workflowPhase: 2,
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
            chat_id,
            redirect_uri,
            requested_scopes,
            expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          input.sessionId,
          input.runId,
          input.requestTokenDigest,
          input.requesterOpenId,
          input.tenantKey,
          input.chatId,
          input.redirectUri,
          input.requestedScopes,
          input.expiresAt,
        ],
      );
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
      RETURNING id,
                run_id,
                request_token_digest,
                requester_open_id,
                tenant_key,
                chat_id,
                redirect_uri,
                requested_scopes,
                code_verifier_ciphertext,
                expires_at`,
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
      RETURNING id,
                run_id,
                request_token_digest,
                requester_open_id,
                tenant_key,
                chat_id,
                redirect_uri,
                requested_scopes,
                code_verifier_ciphertext,
                expires_at`,
      [stateDigest, now],
    );
    return result.rows[0] ? toSession(result.rows[0]) : null;
  }

  async bindGrantToRun(
    runId: string,
    grantId: string,
    deliveryJobId: string,
  ): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ chat_id: string }>(
        `UPDATE organize_folder_runs
            SET oauth_grant_id = $2,
                state = 'READY_TO_SCAN',
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
        dedupeKey: `organize-folder-scan:${runId}`,
        runId,
        kind: "ORGANIZE_FOLDER_SCAN",
        chatId: row.chat_id,
      });
      if (!queued) {
        throw new Error("Drive scan delivery job could not be created");
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
              scan_lease_expires_at = NULL,
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
    requesterOpenId: string;
    tenantKey: string;
    decision: "APPROVED" | "REJECTED";
    decidedAt: Date;
  }): Promise<ProposalDecisionStoreResult> {
    const updated = await this.#pool.query<ProposalDecisionRow>(
      `UPDATE organize_folder_runs
          SET proposal_status = $4,
              proposal_decided_by_open_id = $2,
              proposal_decided_at = $5,
              updated_at = now()
        WHERE id = $1
          AND requester_open_id = $2
          AND tenant_key = $3
          AND proposal_status = 'PROPOSED'
          AND proposal_ciphertext IS NOT NULL
      RETURNING proposal_status`,
      [
        input.proposalId,
        input.requesterOpenId,
        input.tenantKey,
        input.decision,
        input.decidedAt,
      ],
    );
    if (updated.rows[0]) {
      return { kind: "recorded", status: input.decision };
    }

    const existing = await this.#pool.query<ProposalDecisionRow>(
      `SELECT proposal_status
         FROM organize_folder_runs
        WHERE id = $1
          AND requester_open_id = $2
          AND tenant_key = $3
          AND proposal_status IS NOT NULL
          AND proposal_ciphertext IS NOT NULL`,
      [input.proposalId, input.requesterOpenId, input.tenantKey],
    );
    const row = existing.rows[0];
    return row
      ? {
          kind: "existing",
          status: row.proposal_status,
        }
      : { kind: "not_found" };
  }
}
