import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  type DriveScanFolderResult,
} from "@synvo/contracts";
import {
  createEncryptedOAuthGrant,
  grantTokenAssociatedData,
  type LarkOAuthClient,
  type LarkTokenResponse,
  LarkTokenBroker,
  PHASE_2_USER_SCOPES,
  PostgresOAuthGrantStore,
  TokenCipher,
} from "@synvo/lark-auth";
import { Pool } from "pg";

import {
  isPhase2SchemaReady,
  runMigrations,
} from "../../../apps/assistant-backend/src/db/migrate.js";
import { encryptDeliveryMessage } from "../../../apps/assistant-backend/src/delivery/crypto.js";
import { PostgresDeliveryQueue } from "../../../apps/assistant-backend/src/delivery/repository.js";
import { PostgresInbox } from "../../../apps/assistant-backend/src/repositories/inbox.js";
import { PostgresPhase2Repository } from "../../../apps/assistant-backend/src/repositories/phase2.js";
import { DriveToolError } from "../../../apps/synvo-lark-mcp/src/modules/drive/errors.js";
import { digestFolderToken } from "../../../apps/synvo-lark-mcp/src/modules/drive/folder-link.js";
import { PostgresDriveRunRepository } from "../../../apps/synvo-lark-mcp/src/repositories/run-context.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test(
  "Postgres persists one-time OAuth state and serializes token rotation",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(databaseUrl);
    const pool = new Pool({ connectionString: databaseUrl, max: 6 });
    const suffix = randomUUID();
    const openId = `ou_integration_${suffix}`;
    const tenantKey = `tenant_integration_${suffix}`;
    const messageId = `om_integration_${suffix}`;
    const runId = randomUUID();
    const sessionId = randomUUID();
    const authorizationDeliveryJobId = randomUUID();
    const scanDeliveryJobId = randomUUID();
    const grantStore = new PostgresOAuthGrantStore(pool);
    const repository = new PostgresPhase2Repository(pool);
    const cipher = new TokenCipher(Buffer.alloc(32, 11));
    const issuedAt = new Date("2026-08-07T00:00:00.000Z");
    const now = new Date("2026-08-07T00:10:00.000Z");
    const originalToken: LarkTokenResponse = {
      accessToken: "integration-access-original",
      refreshToken: "integration-refresh-original",
      expiresIn: 60,
      refreshTokenExpiresIn: 86_400,
      tokenType: "Bearer",
      scopes: [...PHASE_2_USER_SCOPES],
    };
    const rotatedToken: LarkTokenResponse = {
      accessToken: "integration-access-rotated",
      refreshToken: "integration-refresh-rotated",
      expiresIn: 7_200,
      refreshTokenExpiresIn: 86_400,
      tokenType: "Bearer",
      scopes: [...PHASE_2_USER_SCOPES],
    };
    let refreshCalls = 0;
    const oauthClient: LarkOAuthClient = {
      buildAuthorizationUrl() {
        throw new Error("unused");
      },
      async exchangeCode() {
        throw new Error("unused");
      },
      async refresh() {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return rotatedToken;
      },
      async getUserIdentity() {
        throw new Error("unused");
      },
    };

    try {
      await runMigrations(pool);
      assert.equal(await isPhase2SchemaReady(pool), true);

      const grant = await grantStore.save(
        createEncryptedOAuthGrant(cipher, {
          openId,
          tenantKey,
          token: originalToken,
          now: issuedAt,
        }),
      );
      assert.equal(
        grant.accessTokenCiphertext.includes(originalToken.accessToken),
        false,
      );

      assert.equal(
        await repository.createAwaitingOAuthRun({
          runId,
          sessionId,
          messageId,
          chatId: `oc_${suffix}`,
          requesterOpenId: openId,
          tenantKey,
          rootTokenDigest: "a".repeat(64),
          requestTokenDigest: "b".repeat(64),
          redirectUri: "http://localhost:3000/oauth/lark/callback",
          requestedScopes: [...PHASE_2_USER_SCOPES],
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
          deliveryJobId: authorizationDeliveryJobId,
          authorizationMessageCiphertext: "encrypted-authorization-message",
        }),
        true,
      );
      assert.ok(
        await repository.startOAuthSession({
          requestTokenDigest: "b".repeat(64),
          stateDigest: "c".repeat(64),
          codeVerifierCiphertext: "encrypted-verifier",
          now,
        }),
      );
      assert.equal(
        await repository.startOAuthSession({
          requestTokenDigest: "b".repeat(64),
          stateDigest: "d".repeat(64),
          codeVerifierCiphertext: "encrypted-verifier-2",
          now,
        }),
        null,
      );
      assert.ok(await repository.consumeOAuthSession("c".repeat(64), now));
      assert.equal(
        await repository.consumeOAuthSession("c".repeat(64), now),
        null,
      );
      await repository.bindGrantToRun(runId, grant.id, scanDeliveryJobId);

      const queuedJobs = await pool.query<{
        id: string;
        kind: string;
        state: string;
      }>(
        `SELECT id, kind, state
           FROM lark_delivery_jobs
          WHERE run_id = $1
          ORDER BY kind`,
        [runId],
      );
      assert.deepEqual(queuedJobs.rows, [
        {
          id: scanDeliveryJobId,
          kind: "ORGANIZE_FOLDER_SCAN",
          state: "PENDING",
        },
        {
          id: authorizationDeliveryJobId,
          kind: "TEXT",
          state: "PENDING",
        },
      ]);

      const broker = new LarkTokenBroker({
        clientId: "cli_0123456789abcdef",
        clientSecret: "integration-app-secret",
        cipher,
        grantStore,
        oauthClient,
        now: () => now,
      });
      assert.deepEqual(
        await Promise.all([
          broker.getAccessToken(openId, tenantKey),
          broker.getAccessToken(openId, tenantKey),
        ]),
        [rotatedToken.accessToken, rotatedToken.accessToken],
      );
      assert.equal(refreshCalls, 1);
      const rotatedGrant = await grantStore.findBySubject(openId, tenantKey);
      assert.ok(rotatedGrant);
      assert.equal(rotatedGrant.refreshVersion, 2);
      assert.equal(
        cipher.decrypt(
          rotatedGrant.refreshTokenCiphertext,
          grantTokenAssociatedData(
            tenantKey,
            openId,
            "refresh",
            rotatedGrant.refreshVersion,
          ),
        ),
        rotatedToken.refreshToken,
      );
      assert.equal(
        rotatedGrant.accessExpiresAt.getTime(),
        now.getTime() + rotatedToken.expiresIn * 1_000,
      );
      assert.equal(
        rotatedGrant.refreshExpiresAt.getTime(),
        now.getTime() + rotatedToken.refreshTokenExpiresIn * 1_000,
      );
    } finally {
      await pool.query(
        "DELETE FROM organize_folder_runs WHERE requester_open_id = $1 AND tenant_key = $2",
        [openId, tenantKey],
      );
      await pool.query(
        "DELETE FROM lark_oauth_grants WHERE open_id = $1 AND tenant_key = $2",
        [openId, tenantKey],
      );
      await pool.end();
    }
  },
);

test(
  "Postgres delivery jobs recover expired leases without stale transitions",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(databaseUrl);
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const queueA = new PostgresDeliveryQueue(pool);
    const queueB = new PostgresDeliveryQueue(pool);
    const suffix = randomUUID();
    const jobId = randomUUID();
    const duplicateJobId = randomUUID();
    const expiredJobId = randomUUID();
    const dedupeKey = `integration-delivery:${suffix}`;
    const expiredDedupeKey = `integration-delivery-expired:${suffix}`;
    const base = new Date(Date.now() + 5_000);
    const cipher = new TokenCipher(Buffer.alloc(32, 13));
    const plaintext = "bounded integration delivery";
    const payloadCiphertext = encryptDeliveryMessage(cipher, jobId, plaintext);

    try {
      await runMigrations(pool);
      assert.equal(
        await queueA.enqueue({
          id: jobId,
          dedupeKey,
          kind: "TEXT",
          chatId: `oc_${suffix}`,
          payloadCiphertext,
        }),
        true,
      );
      assert.equal(
        await queueA.enqueue({
          id: duplicateJobId,
          dedupeKey,
          kind: "TEXT",
          chatId: `oc_other_${suffix}`,
          payloadCiphertext: "different-ciphertext",
        }),
        false,
      );

      const persisted = await pool.query<{ payload_ciphertext: string }>(
        `SELECT payload_ciphertext
           FROM lark_delivery_jobs
          WHERE id = $1`,
        [jobId],
      );
      assert.equal(persisted.rows[0]?.payload_ciphertext, payloadCiphertext);
      assert.equal(payloadCiphertext.includes(plaintext), false);

      const firstClaim = await queueA.claimNext(base, 1_000);
      assert.ok(firstClaim);
      assert.equal(firstClaim.id, jobId);
      assert.equal(firstClaim.attemptCount, 1);
      assert.equal(
        await queueB.claimNext(new Date(base.getTime() + 999), 1_000),
        null,
      );

      const recoveredClaim = await queueB.claimNext(
        new Date(base.getTime() + 1_000),
        1_000,
      );
      assert.ok(recoveredClaim);
      assert.equal(recoveredClaim.id, jobId);
      assert.equal(recoveredClaim.attemptCount, 2);
      assert.equal(await queueA.complete(firstClaim), false);
      assert.equal(
        await queueA.retry(
          firstClaim,
          new Date(base.getTime() + 2_000),
          "STALE_RETRY",
        ),
        false,
      );
      assert.equal(
        await queueB.retry(
          recoveredClaim,
          new Date(base.getTime() + 2_000),
          "DELIVERY_RETRYABLE",
        ),
        true,
      );
      assert.equal(
        await queueA.claimNext(new Date(base.getTime() + 1_999), 1_000),
        null,
      );

      const finalClaim = await queueA.claimNext(
        new Date(base.getTime() + 2_000),
        1_000,
      );
      assert.ok(finalClaim);
      assert.equal(finalClaim.id, jobId);
      assert.equal(finalClaim.attemptCount, 3);
      assert.equal(finalClaim.payloadCiphertext, payloadCiphertext);
      assert.equal(await queueA.complete(finalClaim), true);
      assert.equal(
        await queueB.claimNext(new Date(base.getTime() + 4_000), 1_000),
        null,
      );

      const completed = await pool.query<{
        state: string;
        attempt_count: number;
        payload_ciphertext: string | null;
        delivered_at: Date | null;
      }>(
        `SELECT state, attempt_count, payload_ciphertext, delivered_at
           FROM lark_delivery_jobs
          WHERE id = $1`,
        [jobId],
      );
      assert.deepEqual(completed.rows[0], {
        state: "COMPLETED",
        attempt_count: 3,
        payload_ciphertext: null,
        delivered_at: completed.rows[0]?.delivered_at,
      });
      assert.ok(completed.rows[0]?.delivered_at);

      assert.equal(
        await queueA.enqueue({
          id: expiredJobId,
          dedupeKey: expiredDedupeKey,
          kind: "TEXT",
          chatId: `oc_${suffix}`,
          payloadCiphertext: encryptDeliveryMessage(
            cipher,
            expiredJobId,
            "expired delivery",
          ),
          expiresAt: new Date(base.getTime() - 1),
        }),
        true,
      );
      assert.equal(await queueA.claimNext(base, 1_000), null);
      const expired = await pool.query<{
        state: string;
        payload_ciphertext: string | null;
        last_error_code: string | null;
      }>(
        `SELECT state, payload_ciphertext, last_error_code
           FROM lark_delivery_jobs
          WHERE id = $1`,
        [expiredJobId],
      );
      assert.deepEqual(expired.rows[0], {
        state: "FAILED",
        payload_ciphertext: null,
        last_error_code: "DELIVERY_EXPIRED",
      });
    } finally {
      await pool.query(
        "DELETE FROM lark_delivery_jobs WHERE dedupe_key = ANY($1::text[])",
        [[dedupeKey, expiredDedupeKey]],
      );
      await pool.end();
    }
  },
);

test(
  "Postgres inbox prevents stale owners from completing a recovered event",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(databaseUrl);
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const inboxA = new PostgresInbox(pool);
    const inboxB = new PostgresInbox(pool);
    const inboxC = new PostgresInbox(pool);
    const eventId = `event_integration_${randomUUID()}`;
    const eventType = "im.message.receive_v1";
    const base = new Date(Date.now() + 5_000);

    try {
      await runMigrations(pool);
      assert.equal(await inboxA.claim(eventId, eventType, base, 1_000), true);
      assert.equal(
        await inboxB.claim(
          eventId,
          eventType,
          new Date(base.getTime() + 999),
          1_000,
        ),
        false,
      );
      assert.equal(
        await inboxA.claim(
          eventId,
          eventType,
          new Date(base.getTime() + 1_000),
          1_000,
        ),
        false,
      );
      assert.equal(
        await inboxB.claim(
          eventId,
          eventType,
          new Date(base.getTime() + 1_000),
          1_000,
        ),
        true,
      );

      assert.equal(await inboxA.complete(eventId), false);
      const recovered = await pool.query<{
        status: string;
        attempt_count: number;
      }>(
        `SELECT status, attempt_count
           FROM inbox_events
          WHERE event_id = $1`,
        [eventId],
      );
      assert.deepEqual(recovered.rows[0], {
        status: "PROCESSING",
        attempt_count: 2,
      });

      const releasedAt = new Date(base.getTime() + 1_100);
      assert.equal(
        await inboxB.release(eventId, "EVENT_PROCESSING_RETRYABLE", releasedAt),
        true,
      );
      const released = await pool.query<{
        status: string;
        attempt_count: number;
        last_error_code: string | null;
      }>(
        `SELECT status, attempt_count, last_error_code
           FROM inbox_events
          WHERE event_id = $1`,
        [eventId],
      );
      assert.deepEqual(released.rows[0], {
        status: "PROCESSING",
        attempt_count: 2,
        last_error_code: "EVENT_PROCESSING_RETRYABLE",
      });

      assert.equal(
        await inboxC.claim(eventId, "different.event", releasedAt, 1_000),
        false,
      );
      assert.equal(
        await inboxC.claim(eventId, eventType, releasedAt, 1_000),
        true,
      );
      assert.equal(await inboxB.complete(eventId), false);
      assert.equal(await inboxC.complete(eventId), true);
      assert.equal(
        await new PostgresInbox(pool).claim(
          eventId,
          eventType,
          new Date(base.getTime() + 10_000),
          1_000,
        ),
        false,
      );

      const completed = await pool.query<{
        status: string;
        attempt_count: number;
        lease_expires_at: Date | null;
        completed_at: Date | null;
        last_error_code: string | null;
      }>(
        `SELECT status,
                attempt_count,
                lease_expires_at,
                completed_at,
                last_error_code
           FROM inbox_events
          WHERE event_id = $1`,
        [eventId],
      );
      assert.deepEqual(completed.rows[0], {
        status: "COMPLETED",
        attempt_count: 3,
        lease_expires_at: null,
        completed_at: completed.rows[0]?.completed_at,
        last_error_code: null,
      });
      assert.ok(completed.rows[0]?.completed_at);
    } finally {
      await pool.query("DELETE FROM inbox_events WHERE event_id = $1", [eventId]);
      await pool.end();
    }
  },
);

test(
  "Postgres scan leases recover expired runs without accepting stale results",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(databaseUrl);
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const suffix = randomUUID();
    const openId = `ou_scan_lease_${suffix}`;
    const tenantKey = `tenant_scan_lease_${suffix}`;
    const messageId = `om_scan_lease_${suffix}`;
    const runId = randomUUID();
    const rootToken = `integration-root-${suffix}`;
    const grantStore = new PostgresOAuthGrantStore(pool);
    const phase2Repository = new PostgresPhase2Repository(pool);
    const cipher = new TokenCipher(Buffer.alloc(32, 19));
    const grant = createEncryptedOAuthGrant(cipher, {
      openId,
      tenantKey,
      token: {
        accessToken: "integration-scan-access",
        refreshToken: "integration-scan-refresh",
        expiresIn: 7_200,
        refreshTokenExpiresIn: 86_400,
        tokenType: "Bearer",
        scopes: [...PHASE_2_USER_SCOPES],
      },
      now: new Date(),
    });
    const tokenBroker = {} as LarkTokenBroker;
    const runRepository = new PostgresDriveRunRepository({
      pool,
      tokenBroker,
      cipher,
      rootToken,
    });
    const newerResult: DriveScanFolderResult = {
      ok: true,
      inventory: {
        run_id: runId,
        scan_id: randomUUID(),
        complete: true,
        baseline_matches: true,
        root: {
          ref: "root",
          name: "Newer integration inventory",
          parent_ref: null,
          owner_verification: "matched",
          child_count: 0,
        },
        destinations: [],
        files: [],
        skipped: [],
        issues: [],
        summary: {
          root_folder_count: 0,
          root_file_count: 0,
          root_skipped_count: 0,
          destination_child_count: 0,
        },
      },
    };
    const staleResult: DriveScanFolderResult = {
      ...newerResult,
      inventory: {
        ...newerResult.inventory!,
        scan_id: randomUUID(),
        root: {
          ...newerResult.inventory!.root,
          name: "Stale integration inventory",
        },
      },
    };

    try {
      await runMigrations(pool);
      const savedGrant = await grantStore.save(grant);
      assert.equal(
        await phase2Repository.createReadyRun({
          id: runId,
          messageId,
          chatId: `oc_scan_lease_${suffix}`,
          requesterOpenId: openId,
          tenantKey,
          rootTokenDigest: digestFolderToken(rootToken),
          oauthGrantId: savedGrant.id,
          deliveryJobId: randomUUID(),
        }),
        true,
      );

      const firstClaim = await runRepository.resolve(runId);
      assert.equal(firstClaim.kind, "claimed");
      if (firstClaim.kind !== "claimed") {
        return;
      }
      assert.equal(firstClaim.scanAttempt, 1);

      await pool.query(
        `UPDATE organize_folder_runs
            SET scan_lease_expires_at = now() - interval '1 second'
          WHERE id = $1`,
        [runId],
      );

      const recoveredClaim = await runRepository.resolve(runId);
      assert.equal(recoveredClaim.kind, "claimed");
      if (recoveredClaim.kind !== "claimed") {
        return;
      }
      assert.equal(recoveredClaim.scanAttempt, 2);
      await runRepository.complete(
        runId,
        recoveredClaim.scanAttempt,
        newerResult,
      );

      const persistedBeforeStaleAttempt = await pool.query<{
        state: string;
        scan_attempt: number;
        scan_result_ciphertext: string | null;
      }>(
        `SELECT state, scan_attempt, scan_result_ciphertext
           FROM organize_folder_runs
          WHERE id = $1`,
        [runId],
      );
      assert.equal(persistedBeforeStaleAttempt.rows[0]?.state, "COMPLETED");
      assert.equal(persistedBeforeStaleAttempt.rows[0]?.scan_attempt, 2);
      assert.ok(persistedBeforeStaleAttempt.rows[0]?.scan_result_ciphertext);
      assert.equal(
        persistedBeforeStaleAttempt.rows[0]?.scan_result_ciphertext?.includes(
          newerResult.inventory!.root.name,
        ),
        false,
      );

      await assert.rejects(
        runRepository.complete(runId, firstClaim.scanAttempt, staleResult),
        (error: unknown) =>
          error instanceof DriveToolError &&
          error.safeError.code === "RUN_NOT_READY" &&
          error.safeError.retryable,
      );

      const persistedAfterStaleAttempt = await pool.query<{
        state: string;
        scan_attempt: number;
        scan_result_ciphertext: string | null;
      }>(
        `SELECT state, scan_attempt, scan_result_ciphertext
           FROM organize_folder_runs
          WHERE id = $1`,
        [runId],
      );
      assert.deepEqual(
        persistedAfterStaleAttempt.rows[0],
        persistedBeforeStaleAttempt.rows[0],
      );
      assert.deepEqual(await runRepository.resolve(runId), {
        kind: "cached",
        result: newerResult,
      });
    } finally {
      await pool.query(
        "DELETE FROM organize_folder_runs WHERE requester_open_id = $1 AND tenant_key = $2",
        [openId, tenantKey],
      );
      await pool.query(
        "DELETE FROM lark_oauth_grants WHERE open_id = $1 AND tenant_key = $2",
        [openId, tenantKey],
      );
      await pool.end();
    }
  },
);

test(
  "Postgres createReadyRun atomically queues one scan job and deduplicates a message",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(databaseUrl);
    const pool = new Pool({ connectionString: databaseUrl, max: 4 });
    const suffix = randomUUID();
    const openId = `ou_ready_run_${suffix}`;
    const tenantKey = `tenant_ready_run_${suffix}`;
    const messageId = `om_ready_run_${suffix}`;
    const firstRunId = randomUUID();
    const duplicateRunId = randomUUID();
    const firstDeliveryJobId = randomUUID();
    const duplicateDeliveryJobId = randomUUID();
    const grantStore = new PostgresOAuthGrantStore(pool);
    const repository = new PostgresPhase2Repository(pool);
    const cipher = new TokenCipher(Buffer.alloc(32, 23));

    try {
      await runMigrations(pool);
      const grant = await grantStore.save(
        createEncryptedOAuthGrant(cipher, {
          openId,
          tenantKey,
          token: {
            accessToken: "integration-ready-access",
            refreshToken: "integration-ready-refresh",
            expiresIn: 7_200,
            refreshTokenExpiresIn: 86_400,
            tokenType: "Bearer",
            scopes: [...PHASE_2_USER_SCOPES],
          },
          now: new Date(),
        }),
      );
      const common = {
        messageId,
        chatId: `oc_ready_run_${suffix}`,
        requesterOpenId: openId,
        tenantKey,
        rootTokenDigest: "e".repeat(64),
        oauthGrantId: grant.id,
      };

      const created = await Promise.all([
        repository.createReadyRun({
          ...common,
          id: firstRunId,
          deliveryJobId: firstDeliveryJobId,
        }),
        repository.createReadyRun({
          ...common,
          id: duplicateRunId,
          deliveryJobId: duplicateDeliveryJobId,
        }),
      ]);
      assert.deepEqual([...created].sort(), [false, true]);

      const persisted = await pool.query<{
        run_id: string;
        state: string;
        job_id: string;
        kind: string;
        job_state: string;
      }>(
        `SELECT run.id AS run_id,
                run.state,
                job.id AS job_id,
                job.kind,
                job.state AS job_state
           FROM organize_folder_runs AS run
           JOIN lark_delivery_jobs AS job ON job.run_id = run.id
          WHERE run.message_id = $1
          ORDER BY job.created_at`,
        [messageId],
      );
      assert.equal(persisted.rowCount, 1);
      assert.equal(persisted.rows[0]?.state, "READY_TO_SCAN");
      assert.equal(persisted.rows[0]?.kind, "ORGANIZE_FOLDER_SCAN");
      assert.equal(persisted.rows[0]?.job_state, "PENDING");
      const firstRequestWon = created[0] === true;
      assert.equal(
        persisted.rows[0]?.run_id,
        firstRequestWon ? firstRunId : duplicateRunId,
      );
      assert.equal(
        persisted.rows[0]?.job_id,
        firstRequestWon ? firstDeliveryJobId : duplicateDeliveryJobId,
      );

      const losingRunId = firstRequestWon ? duplicateRunId : firstRunId;
      const losingDeliveryJobId = firstRequestWon
        ? duplicateDeliveryJobId
        : firstDeliveryJobId;
      const absent = await pool.query<{ run_count: number; job_count: number }>(
        `SELECT
           (SELECT count(*)::integer
              FROM organize_folder_runs
             WHERE id = $1) AS run_count,
           (SELECT count(*)::integer
              FROM lark_delivery_jobs
             WHERE id = $2) AS job_count`,
        [losingRunId, losingDeliveryJobId],
      );
      assert.deepEqual(absent.rows[0], { run_count: 0, job_count: 0 });
    } finally {
      await pool.query(
        "DELETE FROM organize_folder_runs WHERE requester_open_id = $1 AND tenant_key = $2",
        [openId, tenantKey],
      );
      await pool.query(
        "DELETE FROM lark_oauth_grants WHERE open_id = $1 AND tenant_key = $2",
        [openId, tenantKey],
      );
      await pool.end();
    }
  },
);
