import assert from "node:assert/strict";
import test from "node:test";

import { driveScanResultAssociatedData } from "@synvo/contracts";
import { PHASE_2_USER_SCOPES, TokenCipher } from "@synvo/lark-auth";
import { digestFolderToken } from "@synvo/synvo-lark-mcp/drive";

import type { AppConfig } from "../config.js";
import {
  phase2LiveExitCode,
  PostgresPhase2LiveReader,
  serializePhase2LiveReport,
  verifyPhase2Live,
} from "./phase2-live.js";

const runId = "cb501391-e7bb-44c7-a341-e555ad43018c";
const grantId = "86f732d0-9c00-4513-b460-9995175e47c7";
const scanId = "348b3a29-e5bd-448f-9d93-0ed81275e768";
const rootToken = "fldcnRootVerifier123";
const authorizedOpenId = "ou_sensitive_victor_identity";
const authorizedTenantKey = "tenant_sensitive_synvo_identity";
const encryptionKey = Buffer.alloc(32, 17).toString("base64url");
const now = new Date("2026-08-07T01:00:00.000Z");

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    appId: "cli_0123456789abcdef",
    appSecret: "sensitive-app-secret",
    databaseUrl: "postgresql://sensitive-database-url",
    httpHost: "127.0.0.1",
    httpPort: 3000,
    larkOAuthRedirectUri: "http://localhost:3000/oauth/lark/callback",
    oauthTokenEncryptionKey: encryptionKey,
    authorizedOpenId,
    authorizedTenantKey,
    organizeFolderRootToken: rootToken,
    organizeFolderWriteEnabled: false,
    ...overrides,
  };
}

function inventory(overrides: Record<string, unknown> = {}) {
  return {
    run_id: runId,
    scan_id: scanId,
    complete: true,
    baseline_matches: true,
    root: {
      ref: "root",
      name: "SENSITIVE_ROOT_TITLE",
      parent_ref: null,
      owner_verification: "matched",
      child_count: 6,
    },
    destinations: [
      {
        ref: "d001",
        name: "SENSITIVE_PRODUCT_TITLE",
        parent_ref: "root",
        owner_verification: "matched",
        child_count: 0,
      },
      {
        ref: "d002",
        name: "SENSITIVE_RESEARCH_TITLE",
        parent_ref: "root",
        owner_verification: "matched",
        child_count: 0,
      },
    ],
    files: [1, 2, 3, 4].map((number) => ({
      ref: `f00${number}`,
      name: `SENSITIVE_FILE_TITLE_${number}.pdf`,
      type: "file",
      parent_ref: "root",
      owner_verification: "matched",
    })),
    skipped: [],
    issues: [],
    summary: {
      root_folder_count: 2,
      root_file_count: 4,
      root_skipped_count: 0,
      destination_child_count: 0,
    },
    ...overrides,
  };
}

function encryptedResult(value: unknown, associatedRunId = runId): string {
  return TokenCipher.fromEncodedKey(encryptionKey).encrypt(
    JSON.stringify(value),
    driveScanResultAssociatedData(associatedRunId),
  );
}

function completedRow(overrides: Record<string, unknown> = {}) {
  return {
    run_id: runId,
    run_state: "COMPLETED",
    run_error_code: null,
    root_token_digest: digestFolderToken(rootToken),
    requester_open_id: authorizedOpenId,
    run_tenant_key: authorizedTenantKey,
    oauth_grant_id: grantId,
    scan_result_ciphertext: encryptedResult({
      ok: true,
      inventory: inventory(),
    }),
    grant_id: grantId,
    grant_open_id: authorizedOpenId,
    grant_tenant_key: authorizedTenantKey,
    granted_scopes: [...PHASE_2_USER_SCOPES],
    refresh_expires_at: new Date("2026-09-07T01:00:00.000Z"),
    refresh_version: 1,
    revoked_at: null,
    delivery_state: "COMPLETED",
    delivery_error_code: null,
    delivered_at: new Date("2026-08-07T01:01:00.000Z"),
    ...overrides,
  };
}

function reader(candidate: unknown | null) {
  return {
    loadLatestRun: async () => candidate,
  };
}

test("passes only the exact live Phase 2 gate and emits no sensitive values", async () => {
  const row = completedRow();
  const report = await verifyPhase2Live({
    config: config(),
    reader: reader(row),
    now,
  });

  assert.equal(report.status, "pass");
  assert.equal(report.verification_code, "NONE");
  assert.equal(report.run_state, "COMPLETED");
  assert.equal(report.run_error_code, "NONE");
  assert.equal(report.delivery_state, "COMPLETED");
  assert.equal(report.delivery_error_code, "NONE");
  assert.equal(report.latest_run_found, true);
  assert.equal(report.grant_found, true);
  assert.equal(Object.values(report.checks).every(Boolean), true);
  assert.deepEqual(report.counts, {
    root_folder_count: 2,
    root_file_count: 4,
    root_skipped_count: 0,
    destination_child_count: 0,
    destination_count: 2,
    empty_destination_count: 2,
    issue_count: 0,
  });
  assert.equal(phase2LiveExitCode(report), 0);

  const output = serializePhase2LiveReport(report);
  for (const forbidden of [
    runId,
    grantId,
    scanId,
    rootToken,
    authorizedOpenId,
    authorizedTenantKey,
    config().appSecret,
    config().databaseUrl,
    config().oauthTokenEncryptionKey,
    row.scan_result_ciphertext,
    "SENSITIVE_ROOT_TITLE",
    "SENSITIVE_PRODUCT_TITLE",
    "SENSITIVE_RESEARCH_TITLE",
    "SENSITIVE_FILE_TITLE",
  ]) {
    assert.equal(output.includes(forbidden), false);
  }
});

test("returns a safe pending report and nonzero exit when no live run exists", async () => {
  const report = await verifyPhase2Live({
    config: config(),
    reader: reader(null),
    now,
  });

  assert.equal(report.status, "pending");
  assert.equal(report.verification_code, "NO_LIVE_RUN");
  assert.equal(report.run_state, "NO_RUN");
  assert.equal(report.latest_run_found, false);
  assert.equal(report.checks.write_disabled, true);
  assert.equal(report.checks.static_identity_configured, true);
  assert.equal("counts" in report, false);
  assert.equal(phase2LiveExitCode(report), 2);
});

test("reports nonterminal live runs as pending without inventing inventory counts", async () => {
  const report = await verifyPhase2Live({
    config: config(),
    reader: reader(
      completedRow({
        run_state: "READY_TO_SCAN",
        scan_result_ciphertext: null,
        delivery_state: "PENDING",
        delivered_at: null,
      }),
    ),
    now,
  });

  assert.equal(report.status, "pending");
  assert.equal(report.verification_code, "LIVE_RUN_PENDING");
  assert.equal(report.run_state, "READY_TO_SCAN");
  assert.equal(report.checks.cached_result_valid, false);
  assert.equal("counts" in report, false);
  assert.equal(phase2LiveExitCode(report), 2);
});

test("fails closed for every OAuth, identity, root, and run-state mismatch", async (t) => {
  const cases: Array<{
    name: string;
    config?: AppConfig;
    row: ReturnType<typeof completedRow>;
    failedCheck: keyof Awaited<ReturnType<typeof verifyPhase2Live>>["checks"];
  }> = [
    {
      name: "configured root digest",
      row: completedRow({ root_token_digest: "0".repeat(64) }),
      failedCheck: "root_digest_matches",
    },
    {
      name: "static identity configuration",
      config: config({
        authorizedOpenId: undefined,
        authorizedTenantKey: undefined,
      }),
      row: completedRow(),
      failedCheck: "static_identity_configured",
    },
    {
      name: "static requester identity",
      row: completedRow({ requester_open_id: "ou_different" }),
      failedCheck: "static_identity_matches_requester",
    },
    {
      name: "static grant identity",
      row: completedRow({ grant_open_id: "ou_different" }),
      failedCheck: "static_identity_matches_grant",
    },
    {
      name: "requester and grant binding",
      row: completedRow({ grant_tenant_key: "tenant_different" }),
      failedCheck: "requester_grant_bound",
    },
    {
      name: "exact scopes",
      row: completedRow({
        granted_scopes: [...PHASE_2_USER_SCOPES, "drive:drive"],
      }),
      failedCheck: "exact_scopes",
    },
    {
      name: "future refresh expiry",
      row: completedRow({ refresh_expires_at: new Date(now) }),
      failedCheck: "refresh_expiry_future",
    },
    {
      name: "revocation",
      row: completedRow({ revoked_at: new Date(now) }),
      failedCheck: "not_revoked",
    },
    {
      name: "positive refresh version",
      row: completedRow({ refresh_version: 0 }),
      failedCheck: "positive_refresh_version",
    },
    {
      name: "terminal error",
      row: completedRow({ run_error_code: "OAUTH_REVOKED" }),
      failedCheck: "run_has_no_error",
    },
    {
      name: "completed delivery",
      row: completedRow({
        delivery_state: "PENDING",
        delivered_at: null,
      }),
      failedCheck: "delivery_completed",
    },
    {
      name: "delivery error",
      row: completedRow({
        delivery_error_code: "DELIVERY_RETRYABLE",
      }),
      failedCheck: "delivery_has_no_error",
    },
    {
      name: "recorded delivery timestamp",
      row: completedRow({ delivered_at: null }),
      failedCheck: "delivery_recorded",
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const report = await verifyPhase2Live({
        config: entry.config ?? config(),
        reader: reader(entry.row),
        now,
      });
      assert.equal(report.status, "fail");
      assert.equal(report.verification_code, "GATE_MISMATCH");
      assert.equal(report.checks[entry.failedCheck], false);
      assert.equal(phase2LiveExitCode(report), 1);
    });
  }
});

test("fails every exact inventory invariant independently of the baseline flag", async () => {
  const malformedBaseline = inventory({
    complete: false,
    baseline_matches: false,
    root: {
      ref: "root",
      name: "SENSITIVE_ROOT_TITLE",
      parent_ref: "outside",
      owner_verification: "mismatched",
      child_count: 8,
    },
    destinations: [
      {
        ref: "d001",
        name: "SENSITIVE_PRODUCT_TITLE",
        parent_ref: "root",
        owner_verification: "matched",
        child_count: 1,
      },
      {
        ref: "d002",
        name: "SENSITIVE_RESEARCH_TITLE",
        parent_ref: "root",
        owner_verification: "matched",
        child_count: 0,
      },
      {
        ref: "d003",
        name: "SENSITIVE_EXTRA_TITLE",
        parent_ref: "root",
        owner_verification: "matched",
        child_count: 0,
      },
    ],
    files: [
      {
        ref: "f001",
        name: "SENSITIVE_FILE.txt",
        type: "file",
        parent_ref: "root",
        owner_verification: "matched",
      },
    ],
    skipped: [
      {
        ref: "s001",
        name: "SENSITIVE_SKIPPED",
        type: "docx",
        parent_ref: "root",
        owner_verification: "matched",
      },
    ],
    issues: ["SENSITIVE_ISSUE"],
    summary: {
      root_folder_count: 3,
      root_file_count: 1,
      root_skipped_count: 1,
      destination_child_count: 1,
    },
  });
  const report = await verifyPhase2Live({
    config: config(),
    reader: reader(
      completedRow({
        scan_result_ciphertext: encryptedResult({
          ok: true,
          inventory: malformedBaseline,
        }),
      }),
    ),
    now,
  });

  assert.equal(report.status, "fail");
  assert.equal(report.verification_code, "GATE_MISMATCH");
  for (const check of [
    "inventory_complete",
    "baseline_matches",
    "root_is_root",
    "root_folder_count_exact",
    "root_file_count_exact",
    "root_child_count_exact",
    "root_files_are_pdfs",
    "no_skipped_items",
    "no_destination_children",
    "two_empty_destinations",
    "no_issues",
    "owners_matched",
  ] as const) {
    assert.equal(report.checks[check], false);
  }
  const output = serializePhase2LiveReport(report);
  assert.equal(output.includes("SENSITIVE_"), false);
});

test("fails safely when the cached result cannot be authenticated or parsed", async (t) => {
  await t.test("wrong associated run", async () => {
    const report = await verifyPhase2Live({
      config: config(),
      reader: reader(
        completedRow({
          scan_result_ciphertext: encryptedResult(
            { ok: true, inventory: inventory() },
            "9bf7d873-b066-46a4-af0b-d930acb6b876",
          ),
        }),
      ),
      now,
    });
    assert.equal(report.status, "fail");
    assert.equal(report.verification_code, "CACHED_RESULT_INVALID");
    assert.equal(report.checks.cached_result_valid, false);
  });

  await t.test("strict schema violation", async () => {
    const report = await verifyPhase2Live({
      config: config(),
      reader: reader(
        completedRow({
          scan_result_ciphertext: encryptedResult({
            ok: true,
            inventory: inventory(),
            access_token: "SENSITIVE_ACCESS_TOKEN",
          }),
        }),
      ),
      now,
    });
    assert.equal(report.status, "fail");
    assert.equal(report.verification_code, "CACHED_RESULT_INVALID");
    assert.equal(
      serializePhase2LiveReport(report).includes("SENSITIVE_ACCESS_TOKEN"),
      false,
    );
  });
});

test("sanitizes unknown terminal errors and invalid database rows", async () => {
  const providerDetail = "SENSITIVE_PROVIDER_ERROR_DETAIL";
  const failed = await verifyPhase2Live({
    config: config(),
    reader: reader(
      completedRow({
        run_state: "FAILED_NO_CHANGE",
        run_error_code: providerDetail,
        delivery_error_code: providerDetail,
        scan_result_ciphertext: null,
      }),
    ),
    now,
  });
  assert.equal(failed.status, "fail");
  assert.equal(failed.verification_code, "RUN_FAILED");
  assert.equal(failed.run_error_code, "INVALID");
  assert.equal(failed.delivery_error_code, "INVALID");
  assert.equal(serializePhase2LiveReport(failed).includes(providerDetail), false);

  const invalid = await verifyPhase2Live({
    config: config(),
    reader: reader({ provider_detail: providerDetail }),
    now,
  });
  assert.equal(invalid.status, "fail");
  assert.equal(invalid.verification_code, "DATABASE_ROW_INVALID");
  assert.equal(invalid.latest_run_found, true);
  assert.equal(serializePhase2LiveReport(invalid).includes(providerDetail), false);
});

test("the PostgreSQL reader never selects OAuth token ciphertext", async () => {
  let sql = "";
  const database = {
    query: async (text: string) => {
      sql = text;
      return { rows: [] };
    },
  };
  const reader = new PostgresPhase2LiveReader(database);

  assert.equal(await reader.loadLatestRun(), null);
  assert.match(sql, /scan_result_ciphertext/);
  assert.doesNotMatch(sql, /access_token_ciphertext/);
  assert.doesNotMatch(sql, /refresh_token_ciphertext/);
  assert.doesNotMatch(sql, /payload_ciphertext/);
  assert.doesNotMatch(sql, /dedupe_key/);
  assert.doesNotMatch(sql, /message_id/);
  assert.doesNotMatch(sql, /chat_id/);
});
