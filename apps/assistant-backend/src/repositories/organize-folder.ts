import type { Pool, PoolClient } from "pg";

import { insertDeliveryJob } from "../delivery/repository.js";

export type OrganizeFolderRun = {
  id: string;
  messageId: string;
  chatId: string;
  requesterOpenId: string;
  tenantKey: string;
  state: string;
  oauthGrantId: string | null;
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
  readonly #workflowRevision: 2 | 3;

  constructor(
    pool: Pool,
    options: {
      workflowVariant?: "read_only_inventory" | "drive_move_spike";
    } = {},
  ) {
    this.#pool = pool;
    this.#workflowRevision =
      options.workflowVariant === "drive_move_spike" ? 3 : 2;
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
        workflowPhase: this.#workflowRevision,
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
        workflowPhase: this.#workflowRevision,
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
}
