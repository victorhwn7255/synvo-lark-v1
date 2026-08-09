import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { Pool } from "pg";

import {
  createEncryptedOAuthGrant,
  ORGANIZE_FOLDER_USER_SCOPES,
  LarkTokenBroker,
  PostgresOAuthGrantStore,
  TokenCipher,
  type LarkOAuthClient,
  type LarkTokenResponse,
} from "../../../apps/synvo-assistant/src/lark/auth/index.js";
import {
  isDatabaseSchemaReady,
  runMigrations,
} from "../../../apps/synvo-assistant/src/db/migrate.js";
import { PostgresDeliveryQueue } from "../../../apps/synvo-assistant/src/delivery/repository.js";
import { PostgresOrganizeFolderRepository } from "../../../apps/synvo-assistant/src/workflows/organize-folder/repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

async function cleanRun(pool: Pool, runId: string): Promise<void> {
  await pool.query("DELETE FROM lark_delivery_jobs WHERE run_id = $1", [runId]);
  await pool.query("DELETE FROM lark_oauth_sessions WHERE run_id = $1", [runId]);
  await pool.query("DELETE FROM organize_folder_runs WHERE id = $1", [runId]);
}

test(
  "Postgres preserves one-time OAuth state and serializes token refresh",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(databaseUrl);
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const suffix = randomUUID();
    const openId = `ou_${suffix}`;
    const tenantKey = `tenant_${suffix}`;
    const runId = randomUUID();
    const repository = new PostgresOrganizeFolderRepository(pool);
    const grantStore = new PostgresOAuthGrantStore(pool);
    const cipher = new TokenCipher(Buffer.alloc(32, 11));
    const original: LarkTokenResponse = {
      accessToken: "access-original",
      refreshToken: "refresh-original",
      expiresIn: 60,
      refreshTokenExpiresIn: 86_400,
      tokenType: "Bearer",
      scopes: [...ORGANIZE_FOLDER_USER_SCOPES],
    };
    const rotated = {
      ...original,
      accessToken: "access-rotated",
      refreshToken: "refresh-rotated",
      expiresIn: 7_200,
    };
    let refreshCalls = 0;
    const oauthClient: LarkOAuthClient = {
      buildAuthorizationUrl() { throw new Error("unused"); },
      async exchangeCode() { throw new Error("unused"); },
      async refresh() {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return rotated;
      },
      async getUserIdentity() { throw new Error("unused"); },
    };

    try {
      await runMigrations(pool);
      assert.equal(await isDatabaseSchemaReady(pool), true);
      await grantStore.save(
        createEncryptedOAuthGrant(cipher, {
          openId,
          tenantKey,
          token: original,
          now: new Date("2026-08-07T00:00:00.000Z"),
        }),
      );
      const broker = new LarkTokenBroker({
        clientId: "cli_0123456789abcdef",
        clientSecret: "secret",
        cipher,
        grantStore,
        oauthClient,
        now: () => new Date("2026-08-07T00:10:00.000Z"),
      });
      assert.deepEqual(
        await Promise.all([
          broker.getAccessToken(openId, tenantKey),
          broker.getAccessToken(openId, tenantKey),
        ]),
        ["access-rotated", "access-rotated"],
      );
      assert.equal(refreshCalls, 1);

      assert.equal(
        await repository.createAwaitingOAuthRun({
          runId,
          sessionId: randomUUID(),
          messageId: `om_${suffix}`,
          chatId: `oc_${suffix}`,
          requesterOpenId: openId,
          tenantKey,
          rootTokenDigest: "a".repeat(64),
          requestTokenDigest: "b".repeat(64),
          redirectUri: "http://localhost:3000/oauth/lark/callback",
          requestedScopes: [...ORGANIZE_FOLDER_USER_SCOPES],
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
          deliveryJobId: randomUUID(),
          authorizationMessageCiphertext: "encrypted",
        }),
        true,
      );
      const started = await repository.startOAuthSession({
        requestTokenDigest: "b".repeat(64),
        stateDigest: "c".repeat(64),
        codeVerifierCiphertext: "verifier",
        now: new Date(),
      });
      assert.ok(started);
      assert.equal(
        await repository.startOAuthSession({
          requestTokenDigest: "b".repeat(64),
          stateDigest: "d".repeat(64),
          codeVerifierCiphertext: "other",
          now: new Date(),
        }),
        null,
      );
    } finally {
      await cleanRun(pool, runId);
      await pool.query(
        "DELETE FROM lark_oauth_grants WHERE open_id = $1 AND tenant_key = $2",
        [openId, tenantKey],
      );
      await pool.end();
    }
  },
);

test(
  "Postgres deduplicates a workflow and leases one durable delivery job",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(databaseUrl);
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const suffix = randomUUID();
    const openId = `ou_${suffix}`;
    const tenantKey = `tenant_${suffix}`;
    const runId = randomUUID();
    const rejectedRunId = randomUUID();
    const grantId = randomUUID();
    const messageId = `om_${suffix}`;
    const repository = new PostgresOrganizeFolderRepository(pool);
    const queue = new PostgresDeliveryQueue(pool);
    const grantStore = new PostgresOAuthGrantStore(pool);
    const cipher = new TokenCipher(Buffer.alloc(32, 12));

    try {
      await runMigrations(pool);
      await grantStore.save(
        createEncryptedOAuthGrant(cipher, {
          openId,
          tenantKey,
          token: {
            accessToken: "access",
            refreshToken: "refresh",
            expiresIn: 7_200,
            refreshTokenExpiresIn: 86_400,
            tokenType: "Bearer",
            scopes: [...ORGANIZE_FOLDER_USER_SCOPES],
          },
        }),
      );
      const storedGrant = await grantStore.findBySubject(openId, tenantKey);
      assert.ok(storedGrant);
      assert.equal(
        await repository.createReadyRun({
          id: runId,
          messageId,
          chatId: `oc_${suffix}`,
          requesterOpenId: openId,
          tenantKey,
          rootTokenDigest: "a".repeat(64),
          oauthGrantId: storedGrant.id,
          deliveryJobId: grantId,
        }),
        true,
      );
      assert.equal(
        await repository.createReadyRun({
          id: randomUUID(),
          messageId,
          chatId: `oc_${suffix}`,
          requesterOpenId: openId,
          tenantKey,
          rootTokenDigest: "a".repeat(64),
          oauthGrantId: storedGrant.id,
          deliveryJobId: randomUUID(),
        }),
        false,
      );
      const [first, second] = await Promise.all([
        queue.claimNext(new Date(), 60_000),
        queue.claimNext(new Date(), 60_000),
      ]);
      assert.equal([first, second].filter(Boolean).length, 1);
      const job = first ?? second;
      assert.ok(job);
      assert.equal(await queue.complete(job), true);
      assert.equal(
        await repository.storeInventoryResult({
          runId,
          resultCiphertext: "encrypted-result",
          state: "COMPLETED",
          errorCode: null,
          proposalCiphertext: "encrypted-proposal",
          proposalStatus: "PROPOSED",
        }),
        true,
      );
      assert.deepEqual(
        await repository.recordProposalDecision({
          proposalId: runId,
          requesterOpenId: openId,
          tenantKey,
          decision: "APPROVED",
          decidedAt: new Date("2026-08-08T00:00:00.000Z"),
          executionJobId: randomUUID(),
        }),
        {
          kind: "recorded",
          status: "APPROVED",
          executionQueued: true,
        },
      );
      const executionJob = await queue.claimNext(new Date(), 60_000);
      assert.ok(executionJob);
      assert.equal(executionJob.kind, "ORGANIZE_FOLDER_EXECUTE");
      assert.equal(executionJob.runId, runId);
      assert.equal(await repository.startExecution(runId), true);
      assert.equal(
        await repository.storeExecution({
          proposalId: runId,
          status: "COMPLETED",
          ciphertext: "encrypted-execution",
        }),
        true,
      );
      assert.equal(await queue.complete(executionJob), true);

      assert.deepEqual(
        await repository.requestUndo({
          proposalId: runId,
          requesterOpenId: openId,
          tenantKey,
          deliveryJobId: randomUUID(),
          executionCiphertext: "encrypted-execution-with-undo-request",
        }),
        { kind: "recorded" },
      );
      const undoJob = await queue.claimNext(new Date(), 60_000);
      assert.ok(undoJob);
      assert.equal(undoJob.kind, "ORGANIZE_FOLDER_UNDO");
      assert.equal(undoJob.runId, runId);
      assert.equal(await repository.startUndo(runId), true);
      assert.equal(
        await repository.storeUndo({
          proposalId: runId,
          status: "COMPLETED",
          ciphertext: "encrypted-completed-undo",
        }),
        true,
      );
      assert.equal(await queue.complete(undoJob), true);
      assert.deepEqual(
        await repository.recordProposalDecision({
          proposalId: runId,
          requesterOpenId: openId,
          tenantKey,
          decision: "APPROVED",
          decidedAt: new Date("2026-08-08T00:01:00.000Z"),
        }),
        {
          kind: "existing",
          status: "APPROVED",
        },
      );
      assert.deepEqual(
        await repository.recordProposalDecision({
          proposalId: runId,
          requesterOpenId: openId,
          tenantKey,
          decision: "REJECTED",
          decidedAt: new Date("2026-08-08T00:02:00.000Z"),
        }),
        {
          kind: "existing",
          status: "APPROVED",
        },
      );
      assert.deepEqual(
        await repository.recordProposalDecision({
          proposalId: runId,
          requesterOpenId: `other_${openId}`,
          tenantKey,
          decision: "APPROVED",
          decidedAt: new Date("2026-08-08T00:03:00.000Z"),
        }),
        { kind: "not_found" },
      );

      assert.equal(
        await repository.createReadyRun({
          id: rejectedRunId,
          messageId: `om_reject_${suffix}`,
          chatId: `oc_${suffix}`,
          requesterOpenId: openId,
          tenantKey,
          rootTokenDigest: "a".repeat(64),
          oauthGrantId: storedGrant.id,
          deliveryJobId: randomUUID(),
        }),
        true,
      );
      assert.equal(
        await repository.storeInventoryResult({
          runId: rejectedRunId,
          resultCiphertext: "encrypted-result",
          state: "COMPLETED",
          errorCode: null,
          proposalCiphertext: "encrypted-proposal",
          proposalStatus: "PROPOSED",
        }),
        true,
      );
      assert.deepEqual(
        await repository.recordProposalDecision({
          proposalId: rejectedRunId,
          requesterOpenId: openId,
          tenantKey,
          decision: "REJECTED",
          decidedAt: new Date("2026-08-08T00:04:00.000Z"),
        }),
        {
          kind: "recorded",
          status: "REJECTED",
          executionQueued: false,
        },
      );

      const storedRun = await repository.findInventoryRunById(runId);
      const rejectedRun = await repository.findInventoryRunById(rejectedRunId);
      const decisionAudit = await pool.query<{
        proposal_decided_by_open_id: string;
        proposal_decided_at: Date;
      }>(
        `SELECT proposal_decided_by_open_id, proposal_decided_at
           FROM organize_folder_runs
          WHERE id = $1`,
        [runId],
      );
      const ownedJobs = await pool.query<{ state: string }>(
        `SELECT state
           FROM lark_delivery_jobs
          WHERE run_id = $1
          ORDER BY created_at`,
        [runId],
      );
      assert.equal(storedRun?.state, "COMPLETED");
      assert.equal(storedRun?.proposalStatus, "APPROVED");
      assert.equal(storedRun?.executionStatus, "COMPLETED");
      assert.equal(storedRun?.undoStatus, "COMPLETED");
      assert.equal(rejectedRun?.proposalStatus, "REJECTED");
      assert.equal(
        decisionAudit.rows[0]?.proposal_decided_by_open_id,
        openId,
      );
      assert.equal(
        decisionAudit.rows[0]?.proposal_decided_at.toISOString(),
        "2026-08-08T00:00:00.000Z",
      );
      assert.deepEqual(
        ownedJobs.rows.map(({ state }) => state),
        ["COMPLETED", "COMPLETED", "COMPLETED"],
      );
    } finally {
      await cleanRun(pool, runId);
      await cleanRun(pool, rejectedRunId);
      await pool.query(
        "DELETE FROM lark_oauth_grants WHERE open_id = $1 AND tenant_key = $2",
        [openId, tenantKey],
      );
      await pool.end();
    }
  },
);
