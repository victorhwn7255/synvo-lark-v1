import { pathToFileURL } from "node:url";

import {
  driveScanResultAssociatedData,
  driveScanFolderResultSchema,
  phase2ErrorCodeSchema,
  type DriveInventory,
} from "@synvo/contracts";
import {
  hasExactScopes,
  PHASE_2_USER_SCOPES,
  TokenCipher,
} from "@synvo/lark-auth";
import { digestFolderToken } from "@synvo/synvo-lark-mcp/drive";
import { Pool } from "pg";
import { z } from "zod";

import { loadConfig, type AppConfig } from "../config.js";

const runStateSchema = z.enum([
  "AWAITING_OAUTH",
  "READY_TO_SCAN",
  "SCANNING",
  "COMPLETED",
  "FAILED_NO_CHANGE",
]);

const deliveryStateSchema = z.enum([
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
]);

const knownDeliveryErrorCodeSchema = z.enum([
  "DELIVERY_EXPIRED",
  "DELIVERY_PAYLOAD_INVALID",
  "DELIVERY_ATTEMPTS_EXHAUSTED",
  "DELIVERY_RETRYABLE",
]);

const knownRunErrorCodeSchema = z.union([
  phase2ErrorCodeSchema,
  z.enum([
    "WRONG_SCOPE",
    "WRONG_USER",
    "OAUTH_REJECTED",
    "OAUTH_RETRYABLE",
    "OAUTH_MALFORMED",
    "SCAN_ATTEMPTS_EXHAUSTED",
  ]),
]);

const latestRunRowSchema = z.object({
  run_id: z.uuid(),
  run_state: runStateSchema,
  run_error_code: z.string().nullable(),
  root_token_digest: z.string().regex(/^[0-9a-f]{64}$/),
  requester_open_id: z.string().min(1),
  run_tenant_key: z.string().min(1),
  oauth_grant_id: z.uuid().nullable(),
  scan_result_ciphertext: z.string().nullable(),
  grant_id: z.uuid().nullable(),
  grant_open_id: z.string().nullable(),
  grant_tenant_key: z.string().nullable(),
  granted_scopes: z.array(z.string()).nullable(),
  refresh_expires_at: z.date().nullable(),
  refresh_version: z.number().int().nullable(),
  revoked_at: z.date().nullable(),
  delivery_state: deliveryStateSchema.nullable(),
  delivery_error_code: z.string().nullable(),
  delivered_at: z.date().nullable(),
}).strict();

type LatestRunRow = z.infer<typeof latestRunRowSchema>;

export type VerifiedPhase2Identity = Readonly<{
  openId: string;
  tenantKey: string;
}>;

export type Phase2LiveVerificationCode =
  | "NONE"
  | "NO_LIVE_RUN"
  | "LIVE_RUN_PENDING"
  | "WRITE_ENABLED"
  | "CONFIG_INVALID"
  | "DATABASE_UNAVAILABLE"
  | "DATABASE_ROW_INVALID"
  | "CACHED_RESULT_INVALID"
  | "RUN_FAILED"
  | "GATE_MISMATCH";

export type Phase2LiveRunState =
  | z.infer<typeof runStateSchema>
  | "NO_RUN"
  | "UNKNOWN";

export type Phase2LiveRunErrorCode =
  | z.infer<typeof knownRunErrorCodeSchema>
  | "NONE"
  | "INVALID";

export type Phase2LiveDeliveryState =
  | z.infer<typeof deliveryStateSchema>
  | "NO_DELIVERY"
  | "UNKNOWN";

export type Phase2LiveDeliveryErrorCode =
  | z.infer<typeof knownDeliveryErrorCodeSchema>
  | "NONE"
  | "INVALID";

export type Phase2LiveChecks = {
  write_disabled: boolean;
  root_digest_matches: boolean;
  static_identity_configured: boolean;
  static_identity_matches_requester: boolean;
  static_identity_matches_grant: boolean;
  requester_grant_bound: boolean;
  exact_scopes: boolean;
  refresh_expiry_future: boolean;
  not_revoked: boolean;
  positive_refresh_version: boolean;
  run_completed: boolean;
  run_has_no_error: boolean;
  delivery_completed: boolean;
  delivery_has_no_error: boolean;
  delivery_recorded: boolean;
  cached_result_valid: boolean;
  cached_result_bound_to_run: boolean;
  scan_successful: boolean;
  inventory_complete: boolean;
  baseline_matches: boolean;
  root_is_root: boolean;
  root_folder_count_exact: boolean;
  root_file_count_exact: boolean;
  root_child_count_exact: boolean;
  root_files_are_pdfs: boolean;
  no_skipped_items: boolean;
  no_destination_children: boolean;
  two_empty_destinations: boolean;
  no_issues: boolean;
  owners_matched: boolean;
};

export type Phase2LiveCounts = {
  root_folder_count: number;
  root_file_count: number;
  root_skipped_count: number;
  destination_child_count: number;
  destination_count: number;
  empty_destination_count: number;
  issue_count: number;
};

export type Phase2LiveReport = {
  status: "pass" | "pending" | "fail";
  verification_code: Phase2LiveVerificationCode;
  run_state: Phase2LiveRunState;
  run_error_code: Phase2LiveRunErrorCode;
  delivery_state: Phase2LiveDeliveryState;
  delivery_error_code: Phase2LiveDeliveryErrorCode;
  latest_run_found: boolean;
  grant_found: boolean;
  checks: Phase2LiveChecks;
  counts?: Phase2LiveCounts;
};

export interface Phase2LiveQueryable {
  query(text: string): Promise<{ rows: unknown[] }>;
}

export class PostgresPhase2LiveReader {
  readonly #database: Phase2LiveQueryable;

  constructor(database: Phase2LiveQueryable) {
    this.#database = database;
  }

  async loadLatestRun(): Promise<unknown | null> {
    const result = await this.#database.query(
      `SELECT run.id AS run_id,
              run.state AS run_state,
              run.terminal_error_code AS run_error_code,
              run.root_token_digest,
              run.requester_open_id,
              run.tenant_key AS run_tenant_key,
              run.oauth_grant_id,
              run.scan_result_ciphertext,
              oauth_grant.id AS grant_id,
              oauth_grant.open_id AS grant_open_id,
              oauth_grant.tenant_key AS grant_tenant_key,
              oauth_grant.granted_scopes,
              oauth_grant.refresh_expires_at,
              oauth_grant.refresh_version,
              oauth_grant.revoked_at,
              delivery.state AS delivery_state,
              delivery.last_error_code AS delivery_error_code,
              delivery.delivered_at
         FROM organize_folder_runs AS run
         LEFT JOIN lark_oauth_grants AS oauth_grant
           ON oauth_grant.id = run.oauth_grant_id
         LEFT JOIN lark_delivery_jobs AS delivery
           ON delivery.run_id = run.id
          AND delivery.kind = 'ORGANIZE_FOLDER_SCAN'
        ORDER BY run.created_at DESC, run.id DESC
        LIMIT 1`,
    );
    return result.rows[0] ?? null;
  }
}

function emptyChecks(writeDisabled: boolean): Phase2LiveChecks {
  return {
    write_disabled: writeDisabled,
    root_digest_matches: false,
    static_identity_configured: false,
    static_identity_matches_requester: false,
    static_identity_matches_grant: false,
    requester_grant_bound: false,
    exact_scopes: false,
    refresh_expiry_future: false,
    not_revoked: false,
    positive_refresh_version: false,
    run_completed: false,
    run_has_no_error: false,
    delivery_completed: false,
    delivery_has_no_error: false,
    delivery_recorded: false,
    cached_result_valid: false,
    cached_result_bound_to_run: false,
    scan_successful: false,
    inventory_complete: false,
    baseline_matches: false,
    root_is_root: false,
    root_folder_count_exact: false,
    root_file_count_exact: false,
    root_child_count_exact: false,
    root_files_are_pdfs: false,
    no_skipped_items: false,
    no_destination_children: false,
    two_empty_destinations: false,
    no_issues: false,
    owners_matched: false,
  };
}

function sanitizeRunErrorCode(value: string | null): Phase2LiveRunErrorCode {
  if (value === null) {
    return "NONE";
  }
  const parsed = knownRunErrorCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : "INVALID";
}

function sanitizeDeliveryErrorCode(
  value: string | null,
): Phase2LiveDeliveryErrorCode {
  if (value === null) {
    return "NONE";
  }
  const parsed = knownDeliveryErrorCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : "INVALID";
}

function inventoryCounts(inventory: DriveInventory): Phase2LiveCounts {
  return {
    root_folder_count: inventory.summary.root_folder_count,
    root_file_count: inventory.summary.root_file_count,
    root_skipped_count: inventory.summary.root_skipped_count,
    destination_child_count: inventory.summary.destination_child_count,
    destination_count: inventory.destinations.length,
    empty_destination_count: inventory.destinations.filter(
      (destination) => destination.child_count === 0,
    ).length,
    issue_count: inventory.issues.length,
  };
}

function allOwnerSignalsMatch(inventory: DriveInventory): boolean {
  return [
    inventory.root.owner_verification,
    ...inventory.destinations.map((item) => item.owner_verification),
    ...inventory.files.map((item) => item.owner_verification),
    ...inventory.skipped.map((item) => item.owner_verification),
  ].every((value) => value === "matched");
}

function operationalFailure(
  verificationCode:
    | "CONFIG_INVALID"
    | "DATABASE_UNAVAILABLE"
    | "DATABASE_ROW_INVALID",
  options: {
    writeDisabled?: boolean;
    staticIdentityConfigured?: boolean;
  } = {},
): Phase2LiveReport {
  const checks = emptyChecks(options.writeDisabled ?? false);
  checks.static_identity_configured =
    options.staticIdentityConfigured ?? false;
  return {
    status: "fail",
    verification_code: verificationCode,
    run_state: "UNKNOWN",
    run_error_code: "NONE",
    delivery_state: "UNKNOWN",
    delivery_error_code: "NONE",
    latest_run_found: false,
    grant_found: false,
    checks,
  };
}

export function configInvalidReport(): Phase2LiveReport {
  return operationalFailure("CONFIG_INVALID");
}

export function databaseUnavailableReport(
  config?: AppConfig,
): Phase2LiveReport {
  return operationalFailure("DATABASE_UNAVAILABLE", {
    writeDisabled: config?.organizeFolderWriteEnabled === false,
    staticIdentityConfigured: Boolean(
      config?.authorizedOpenId && config.authorizedTenantKey,
    ),
  });
}

export async function verifyPhase2Live(options: {
  config: AppConfig;
  reader: Pick<PostgresPhase2LiveReader, "loadLatestRun">;
  now?: Date;
}): Promise<Phase2LiveReport> {
  const { config, reader } = options;
  const now = options.now ?? new Date();
  const writeDisabled = config.organizeFolderWriteEnabled === false;

  if (!writeDisabled) {
    return {
      status: "fail",
      verification_code: "WRITE_ENABLED",
      run_state: "UNKNOWN",
      run_error_code: "NONE",
      delivery_state: "UNKNOWN",
      delivery_error_code: "NONE",
      latest_run_found: false,
      grant_found: false,
      checks: emptyChecks(false),
    };
  }

  const candidate = await reader.loadLatestRun();
  if (candidate === null) {
    const checks = emptyChecks(true);
    checks.static_identity_configured = Boolean(
      config.authorizedOpenId && config.authorizedTenantKey,
    );
    return {
      status: "pending",
      verification_code: "NO_LIVE_RUN",
      run_state: "NO_RUN",
      run_error_code: "NONE",
      delivery_state: "NO_DELIVERY",
      delivery_error_code: "NONE",
      latest_run_found: false,
      grant_found: false,
      checks,
    };
  }

  const parsedRow = latestRunRowSchema.safeParse(candidate);
  if (!parsedRow.success) {
    return {
      ...operationalFailure("DATABASE_ROW_INVALID", {
        writeDisabled: true,
        staticIdentityConfigured: Boolean(
          config.authorizedOpenId && config.authorizedTenantKey,
        ),
      }),
      latest_run_found: true,
    };
  }
  const row: LatestRunRow = parsedRow.data;
  const staticIdentityConfigured = Boolean(
    config.authorizedOpenId && config.authorizedTenantKey,
  );
  const grantFound = row.grant_id !== null;
  const checks = emptyChecks(true);
  checks.root_digest_matches =
    row.root_token_digest === digestFolderToken(config.organizeFolderRootToken);
  checks.static_identity_configured = staticIdentityConfigured;
  checks.static_identity_matches_requester = Boolean(
    staticIdentityConfigured &&
      config.authorizedOpenId === row.requester_open_id &&
      config.authorizedTenantKey === row.run_tenant_key,
  );
  checks.static_identity_matches_grant = Boolean(
    staticIdentityConfigured &&
      config.authorizedOpenId === row.grant_open_id &&
      config.authorizedTenantKey === row.grant_tenant_key,
  );
  checks.requester_grant_bound = Boolean(
    row.oauth_grant_id &&
      row.oauth_grant_id === row.grant_id &&
      row.requester_open_id === row.grant_open_id &&
      row.run_tenant_key === row.grant_tenant_key,
  );
  checks.exact_scopes = hasExactScopes(
    row.granted_scopes ?? [],
    PHASE_2_USER_SCOPES,
  );
  checks.refresh_expiry_future = Boolean(
    row.refresh_expires_at && row.refresh_expires_at.getTime() > now.getTime(),
  );
  checks.not_revoked = grantFound && row.revoked_at === null;
  checks.positive_refresh_version = Boolean(
    row.refresh_version && row.refresh_version > 0,
  );
  checks.run_completed = row.run_state === "COMPLETED";
  checks.run_has_no_error = row.run_error_code === null;
  checks.delivery_completed = row.delivery_state === "COMPLETED";
  checks.delivery_has_no_error = row.delivery_error_code === null;
  checks.delivery_recorded = row.delivered_at !== null;

  let inventory: DriveInventory | undefined;
  if (row.scan_result_ciphertext) {
    try {
      const cipher = TokenCipher.fromEncodedKey(
        config.oauthTokenEncryptionKey,
      );
      const plaintext = cipher.decrypt(
        row.scan_result_ciphertext,
        driveScanResultAssociatedData(row.run_id),
      );
      const parsedResult = driveScanFolderResultSchema.parse(
        JSON.parse(plaintext) as unknown,
      );
      checks.cached_result_valid = true;
      checks.scan_successful = parsedResult.ok && Boolean(parsedResult.inventory);
      inventory = parsedResult.inventory;
    } catch {
      checks.cached_result_valid = false;
    }
  }

  let counts: Phase2LiveCounts | undefined;
  if (inventory) {
    counts = inventoryCounts(inventory);
    checks.cached_result_bound_to_run = inventory.run_id === row.run_id;
    checks.inventory_complete = inventory.complete;
    checks.baseline_matches = inventory.baseline_matches;
    checks.root_is_root = inventory.root.parent_ref === null;
    checks.root_folder_count_exact =
      counts.root_folder_count === 2 && inventory.destinations.length === 2;
    checks.root_file_count_exact =
      counts.root_file_count === 4 && inventory.files.length === 4;
    checks.root_child_count_exact = inventory.root.child_count === 6;
    checks.root_files_are_pdfs = inventory.files.every(
      (file) => file.type === "file" && file.name.toLowerCase().endsWith(".pdf"),
    );
    checks.no_skipped_items =
      counts.root_skipped_count === 0 && inventory.skipped.length === 0;
    checks.no_destination_children = counts.destination_child_count === 0;
    checks.two_empty_destinations =
      counts.destination_count === 2 && counts.empty_destination_count === 2;
    checks.no_issues = counts.issue_count === 0;
    checks.owners_matched = allOwnerSignalsMatch(inventory);
  }

  const reportBase = {
    run_state: row.run_state,
    run_error_code: sanitizeRunErrorCode(row.run_error_code),
    delivery_state: row.delivery_state ?? "NO_DELIVERY",
    delivery_error_code: sanitizeDeliveryErrorCode(row.delivery_error_code),
    latest_run_found: true,
    grant_found: grantFound,
    checks,
    ...(counts ? { counts } : {}),
  } as const;

  if (
    row.run_state === "AWAITING_OAUTH" ||
    row.run_state === "READY_TO_SCAN" ||
    row.run_state === "SCANNING"
  ) {
    return {
      status: "pending",
      verification_code: "LIVE_RUN_PENDING",
      ...reportBase,
    };
  }

  if (row.run_state === "FAILED_NO_CHANGE") {
    return {
      status: "fail",
      verification_code: "RUN_FAILED",
      ...reportBase,
    };
  }

  if (!checks.cached_result_valid) {
    return {
      status: "fail",
      verification_code: "CACHED_RESULT_INVALID",
      ...reportBase,
    };
  }

  if (Object.values(checks).every(Boolean)) {
    return {
      status: "pass",
      verification_code: "NONE",
      ...reportBase,
    };
  }

  return {
    status: "fail",
    verification_code: "GATE_MISMATCH",
    ...reportBase,
  };
}

export async function verifyPhase2LiveForIdentityPin(options: {
  config: AppConfig;
  reader: Pick<PostgresPhase2LiveReader, "loadLatestRun">;
  now?: Date;
}): Promise<{
  report: Phase2LiveReport;
  identity?: VerifiedPhase2Identity;
}> {
  const candidate = await options.reader.loadLatestRun();
  const parsedRow = latestRunRowSchema.safeParse(candidate);

  if (!parsedRow.success) {
    return {
      report: await verifyPhase2Live({
        config: options.config,
        reader: { loadLatestRun: async () => candidate },
        now: options.now,
      }),
    };
  }

  const identity: VerifiedPhase2Identity = {
    openId: parsedRow.data.requester_open_id,
    tenantKey: parsedRow.data.run_tenant_key,
  };
  const report = await verifyPhase2Live({
    config: {
      ...options.config,
      authorizedOpenId: identity.openId,
      authorizedTenantKey: identity.tenantKey,
    },
    reader: { loadLatestRun: async () => candidate },
    now: options.now,
  });

  return report.status === "pass" ? { report, identity } : { report };
}

export function serializePhase2LiveReport(report: Phase2LiveReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function phase2LiveExitCode(report: Phase2LiveReport): number {
  if (report.status === "pass") {
    return 0;
  }
  return report.status === "pending" ? 2 : 1;
}

async function main(): Promise<void> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch {
    const report = configInvalidReport();
    process.stdout.write(serializePhase2LiveReport(report));
    process.exitCode = phase2LiveExitCode(report);
    return;
  }

  if (config.organizeFolderWriteEnabled) {
    const report = await verifyPhase2Live({
      config,
      reader: { loadLatestRun: async () => null },
    });
    process.stdout.write(serializePhase2LiveReport(report));
    process.exitCode = phase2LiveExitCode(report);
    return;
  }

  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on("error", () => undefined);

  let report: Phase2LiveReport;
  try {
    report = await verifyPhase2Live({
      config,
      reader: new PostgresPhase2LiveReader(pool),
    });
  } catch {
    report = databaseUnavailableReport(config);
  } finally {
    await pool.end().catch(() => undefined);
  }

  process.stdout.write(serializePhase2LiveReport(report));
  process.exitCode = phase2LiveExitCode(report);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main();
}
