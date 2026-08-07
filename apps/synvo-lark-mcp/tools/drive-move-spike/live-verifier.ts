import { pathToFileURL } from "node:url";

import {
  LarkOAuthHttpClient,
  LarkTokenBroker,
  DRIVE_MOVE_SPIKE_SCOPE_PROFILE,
  DRIVE_MOVE_SPIKE_USER_SCOPES,
  PostgresOAuthGrantStore,
  TokenCipher,
  hasExactScopes,
} from "@synvo/lark-auth";
import { Pool } from "pg";
import { z } from "zod";

import { LarkDriveReader } from "../../src/modules/drive/read-client.js";
import { buildAllowlistedFolderInventory } from "../../src/modules/drive/folder-inventory.js";
import { driveMoveSpikeOperationKeyPrefix } from "./round-trip.js";
import { PostgresDriveMoveSpikeStore } from "./mutation-repository.js";

const rowSchema = z.object({
  batch_state: z.enum([
    "PREPARED",
    "EXECUTING",
    "RESTORED",
    "FAILED_KNOWN_STATE",
    "NEEDS_ATTENTION",
  ]),
  confirmed: z.boolean(),
  execution_attempt: z.number().int().nonnegative(),
  workflow_phase: z.number().int(),
  run_state: z.string(),
  run_error_code: z.string().nullable(),
  grant_profile: z.string(),
  granted_scopes: z.array(z.string()),
  grant_usable: z.boolean(),
  actor_bound: z.boolean(),
  forward_count: z.string(),
  restore_count: z.string(),
  verified_count: z.string(),
  total_attempts: z.string(),
});

export type DriveMoveSpikeLiveReport = {
  status: "pass" | "pending" | "fail";
  verification_code: string;
  checks: {
    write_disabled: boolean;
    exact_move_spike_grant: boolean;
    move_spike_run_completed: boolean;
    batch_restored: boolean;
    explicit_confirmation_recorded: boolean;
    exactly_two_verified_directions: boolean;
    current_baseline_matches: boolean;
    two_approved_folders: boolean;
    four_root_files: boolean;
    both_destinations_empty: boolean;
    no_unsupported_items: boolean;
    owners_matched: boolean;
  };
};

function emptyChecks(writeDisabled: boolean): DriveMoveSpikeLiveReport["checks"] {
  return {
    write_disabled: writeDisabled,
    exact_move_spike_grant: false,
    move_spike_run_completed: false,
    batch_restored: false,
    explicit_confirmation_recorded: false,
    exactly_two_verified_directions: false,
    current_baseline_matches: false,
    two_approved_folders: false,
    four_root_files: false,
    both_destinations_empty: false,
    no_unsupported_items: false,
    owners_matched: false,
  };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || /replace|example/i.test(value)) throw new Error(`${name}_REQUIRED`);
  return value;
}

export async function verifyDriveMoveSpikeLive(): Promise<DriveMoveSpikeLiveReport> {
  const writeDisabled =
    (process.env.ORGANIZE_FOLDER_WRITE_ENABLED?.trim().toLowerCase() || "false") ===
    "false";
  const checks = emptyChecks(writeDisabled);
  if (!writeDisabled) {
    return { status: "fail", verification_code: "WRITE_ENABLED", checks };
  }
  const pool = new Pool({ connectionString: required("DATABASE_URL"), max: 3 });
  try {
    const result = await pool.query(
      `WITH latest_batch AS (
         SELECT id
           FROM phase3_mutation_batches
          WHERE operation_key LIKE $1
          ORDER BY created_at DESC, id DESC
          LIMIT 1
       )
       SELECT batch.state AS batch_state,
              (batch.confirmation_digest IS NOT NULL AND batch.confirmed_at IS NOT NULL) AS confirmed,
              batch.execution_attempt,
              run.workflow_phase,
              run.state AS run_state,
              run.terminal_error_code AS run_error_code,
              oauth_grant.scope_profile AS grant_profile,
              oauth_grant.granted_scopes,
              (
                oauth_grant.revoked_at IS NULL
                AND oauth_grant.refresh_expires_at > now()
                AND oauth_grant.refresh_version > 0
              ) AS grant_usable,
              (
                run.oauth_grant_id = batch.oauth_grant_id
                AND run.requester_open_id = batch.requester_open_id
                AND run.tenant_key = batch.tenant_key
                AND oauth_grant.open_id = batch.requester_open_id
                AND oauth_grant.tenant_key = batch.tenant_key
              ) AS actor_bound,
              count(*) FILTER (WHERE attempt.direction = 'FORWARD')::text AS forward_count,
              count(*) FILTER (WHERE attempt.direction = 'RESTORE')::text AS restore_count,
              count(*) FILTER (WHERE attempt.state = 'VERIFIED')::text AS verified_count,
              count(attempt.id)::text AS total_attempts
         FROM phase3_mutation_batches AS batch
         JOIN latest_batch ON latest_batch.id = batch.id
         JOIN organize_folder_runs AS run ON run.id = batch.run_id
         JOIN lark_oauth_grants AS oauth_grant ON oauth_grant.id = batch.oauth_grant_id
         LEFT JOIN phase3_move_attempts AS attempt ON attempt.batch_id = batch.id
        GROUP BY batch.id, run.id, oauth_grant.id`,
      [`${driveMoveSpikeOperationKeyPrefix}%`],
    );
    if (!result.rows[0]) {
      return { status: "pending", verification_code: "NO_LIVE_BATCH", checks };
    }
    const row = rowSchema.safeParse(result.rows[0]);
    if (!row.success) {
      return { status: "fail", verification_code: "DATABASE_ROW_INVALID", checks };
    }
    checks.exact_move_spike_grant =
      row.data.grant_profile === DRIVE_MOVE_SPIKE_SCOPE_PROFILE &&
      hasExactScopes(row.data.granted_scopes, DRIVE_MOVE_SPIKE_USER_SCOPES) &&
      row.data.grant_usable &&
      row.data.actor_bound;
    checks.move_spike_run_completed =
      row.data.workflow_phase === 3 &&
      row.data.run_state === "COMPLETED" &&
      row.data.run_error_code === null;
    checks.batch_restored =
      row.data.batch_state === "RESTORED" && row.data.execution_attempt >= 1;
    checks.explicit_confirmation_recorded = row.data.confirmed;
    checks.exactly_two_verified_directions =
      row.data.forward_count === "1" &&
      row.data.restore_count === "1" &&
      row.data.verified_count === "2" &&
      row.data.total_attempts === "2";

    const cipher = TokenCipher.fromEncodedKey(required("OAUTH_TOKEN_ENCRYPTION_KEY"));
    const grantStore = new PostgresOAuthGrantStore(pool, {
      scopeProfile: DRIVE_MOVE_SPIKE_SCOPE_PROFILE,
    });
    const tokenBroker = new LarkTokenBroker({
      clientId: required("LARK_APP_ID"),
      clientSecret: required("LARK_APP_SECRET"),
      cipher,
      grantStore,
      oauthClient: new LarkOAuthHttpClient(),
      requiredScopes: DRIVE_MOVE_SPIKE_USER_SCOPES,
    });
    const context = await new PostgresDriveMoveSpikeStore(pool).loadLatestCompletedRun();
    if (!context) {
      return { status: "fail", verification_code: "PHASE3_RUN_MISSING", checks };
    }
    const rootToken = required("ORGANIZE_FOLDER_ROOT_TOKEN");
    let accessToken = await tokenBroker.getAccessToken(
      context.requesterOpenId,
      context.tenantKey,
    );
    const inventory = await buildAllowlistedFolderInventory(new LarkDriveReader(), {
      runId: context.runId,
      requesterOpenId: context.requesterOpenId,
      rootToken,
      accessToken,
      recoverAccessToken: async (rejected) => {
        accessToken = await tokenBroker.recoverAccessToken(
          context.requesterOpenId,
          context.tenantKey,
          rejected,
        );
        return accessToken;
      },
      markAccessTokenRejected: (rejected) =>
        tokenBroker.markAccessTokenRejected(
          context.requesterOpenId,
          context.tenantKey,
          rejected,
        ),
    });
    checks.current_baseline_matches = inventory.baseline_matches;
    checks.two_approved_folders = inventory.destinations.length === 2;
    checks.four_root_files = inventory.files.length === 4;
    checks.both_destinations_empty =
      inventory.destinations.length === 2 &&
      inventory.destinations.every((folder) => folder.child_count === 0);
    checks.no_unsupported_items = inventory.skipped.length === 0;
    checks.owners_matched =
      inventory.root.owner_verification === "matched" &&
      [...inventory.destinations, ...inventory.files].every(
        (item) => item.owner_verification === "matched",
      );
    const passed = Object.values(checks).every(Boolean);
    return {
      status: passed ? "pass" : "fail",
      verification_code: passed ? "NONE" : "GATE_MISMATCH",
      checks,
    };
  } catch {
    return {
      status: "fail",
      verification_code: "VERIFICATION_UNAVAILABLE",
      checks,
    };
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void verifyDriveMoveSpikeLive().then((report) => {
    console.info(JSON.stringify(report, null, 2));
    process.exitCode = report.status === "pass" ? 0 : 1;
  });
}
