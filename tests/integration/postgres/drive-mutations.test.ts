import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  createEncryptedOAuthGrant,
  DRIVE_INVENTORY_USER_SCOPES,
  DRIVE_MOVE_SPIKE_SCOPE_PROFILE,
  DRIVE_MOVE_SPIKE_USER_SCOPES,
  PostgresOAuthGrantStore,
  TokenCipher,
} from "@synvo/lark-auth";
import { Pool } from "pg";

import { runMigrations } from "../../../apps/assistant-backend/src/db/migrate.js";
import { PostgresOrganizeFolderRepository } from "../../../apps/assistant-backend/src/repositories/organize-folder.js";
import { PostgresDriveMoveSpikeStore } from "../../../apps/synvo-lark-mcp/tools/drive-move-spike/mutation-repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test(
  "Postgres isolates Drive move spike grants and serializes durable mutation intent",
  { skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    assert.ok(databaseUrl);
    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    const suffix = randomUUID();
    const openId = `drive-move-spike-open-${suffix}`;
    const tenantKey = `drive-move-spike-tenant-${suffix}`;
    const cipher = new TokenCipher(Buffer.alloc(32, 21));
    const readOnlyStore = new PostgresOAuthGrantStore(pool);
    const driveMoveSpikeStore = new PostgresOAuthGrantStore(pool, {
      scopeProfile: DRIVE_MOVE_SPIKE_SCOPE_PROFILE,
    });
    const runId = randomUUID();
    const batchId = randomUUID();
    const attemptId = randomUUID();
    const deliveryJobId = randomUUID();
    const rootDigest = "a".repeat(64);
    try {
      await runMigrations(pool);
      const tokenBase = {
        accessToken: "integration-access-secret",
        refreshToken: "integration-refresh-secret",
        expiresIn: 7_200,
        refreshTokenExpiresIn: 86_400,
        tokenType: "Bearer",
      };
      const readOnlyGrant = await readOnlyStore.save(
        createEncryptedOAuthGrant(cipher, {
          openId,
          tenantKey,
          token: { ...tokenBase, scopes: [...DRIVE_INVENTORY_USER_SCOPES] },
        }),
      );
      const driveMoveSpikeGrant = await driveMoveSpikeStore.save(
        createEncryptedOAuthGrant(cipher, {
          openId,
          tenantKey,
          token: { ...tokenBase, scopes: [...DRIVE_MOVE_SPIKE_USER_SCOPES] },
        }),
      );
      assert.notEqual(readOnlyGrant.id, driveMoveSpikeGrant.id);
      assert.equal(
        (await readOnlyStore.findBySubject(openId, tenantKey))?.id,
        readOnlyGrant.id,
      );
      assert.equal((await driveMoveSpikeStore.findBySubject(openId, tenantKey))?.id, driveMoveSpikeGrant.id);

      const runRepository = new PostgresOrganizeFolderRepository(pool, {
        workflowVariant: "drive_move_spike",
      });
      assert.equal(
        await runRepository.createReadyRun({
          id: runId,
          messageId: `drive-move-spike-message-${suffix}`,
          chatId: `drive-move-spike-chat-${suffix}`,
          requesterOpenId: openId,
          tenantKey,
          rootTokenDigest: rootDigest,
          oauthGrantId: driveMoveSpikeGrant.id,
          deliveryJobId,
        }),
        true,
      );
      await pool.query(
        `UPDATE organize_folder_runs
            SET state = 'COMPLETED'
          WHERE id = $1`,
        [runId],
      );

      const mutationStore = new PostgresDriveMoveSpikeStore(pool);
      assert.deepEqual(await mutationStore.loadLatestCompletedRun(), {
        runId,
        grantId: driveMoveSpikeGrant.id,
        requesterOpenId: openId,
        tenantKey,
        rootTokenDigest: rootDigest,
      });
      const prepared = await mutationStore.prepare({
        id: batchId,
        operationKey: `drive-move-spike-integration:${suffix}`,
        context: {
          runId,
          grantId: driveMoveSpikeGrant.id,
          requesterOpenId: openId,
          tenantKey,
          rootTokenDigest: rootDigest,
        },
        manifestCiphertext: "encrypted-manifest",
        manifestDigest: "b".repeat(64),
        baselineDigest: "c".repeat(64),
      });
      assert.equal(prepared.state, "PREPARED");

      const claims = await Promise.allSettled([
        mutationStore.claimExecution(batchId, "d".repeat(64)),
        mutationStore.claimExecution(batchId, "d".repeat(64)),
      ]);
      assert.equal(claims.filter((claim) => claim.status === "fulfilled").length, 1);
      assert.equal(claims.filter((claim) => claim.status === "rejected").length, 1);

      const [firstAttempt, duplicateAttempt] = await Promise.all([
        mutationStore.ensureAttempt({
          id: attemptId,
          batchId,
          direction: "FORWARD",
          attemptKey: "e".repeat(64),
          intentCiphertext: "encrypted-intent",
        }),
        mutationStore.ensureAttempt({
          id: randomUUID(),
          batchId,
          direction: "FORWARD",
          attemptKey: "e".repeat(64),
          intentCiphertext: "different-encrypted-intent",
        }),
      ]);
      assert.equal(firstAttempt.id, duplicateAttempt.id);
      assert.equal(firstAttempt.attemptKey, duplicateAttempt.attemptKey);

      const started = await Promise.all([
        mutationStore.beginRequest(firstAttempt.id),
        mutationStore.beginRequest(firstAttempt.id),
      ]);
      assert.equal(Math.max(...started.map((attempt) => attempt.requestCount)), 1);
      const persisted = await pool.query<{
        request_count: number;
        intent_ciphertext: string;
      }>(
        `SELECT request_count, intent_ciphertext
           FROM phase3_move_attempts
          WHERE id = $1`,
        [firstAttempt.id],
      );
      assert.deepEqual(persisted.rows[0], {
        request_count: 1,
        intent_ciphertext: firstAttempt.intentCiphertext,
      });

      await pool.query(
        `UPDATE phase3_mutation_batches
            SET lease_expires_at = now() - interval '1 second'
          WHERE id = $1`,
        [batchId],
      );
      const recovered = await mutationStore.claimExecution(batchId, "d".repeat(64));
      assert.equal(recovered.executionAttempt, 2);
      await mutationStore.finishBatch(batchId, "RESTORED");
      assert.equal((await mutationStore.loadBatch(batchId))?.state, "RESTORED");
    } finally {
      await pool.query("DELETE FROM phase3_mutation_batches WHERE id = $1", [batchId]);
      await pool.query("DELETE FROM organize_folder_runs WHERE id = $1", [runId]);
      await pool.query(
        "DELETE FROM lark_oauth_grants WHERE open_id = $1 AND tenant_key = $2",
        [openId, tenantKey],
      );
      await pool.end();
    }
  },
);
