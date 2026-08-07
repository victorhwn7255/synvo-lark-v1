import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";

import { driveScanResultAssociatedData } from "@synvo/contracts";
import { PHASE_2_USER_SCOPES, TokenCipher } from "@synvo/lark-auth";
import { digestFolderToken } from "@synvo/synvo-lark-mcp/drive";

import type { AppConfig } from "../config.js";
import {
  phase2IdentityPinExitCode,
  pinPhase2IdentityEnvFile,
  planPhase2IdentityEnvUpdate,
  runPhase2IdentityPin,
  serializePhase2IdentityPinReport,
} from "./phase2-identity-pin.js";
import { verifyPhase2LiveForIdentityPin } from "./phase2-live.js";

const runId = "cb501391-e7bb-44c7-a341-e555ad43018c";
const grantId = "86f732d0-9c00-4513-b460-9995175e47c7";
const scanId = "348b3a29-e5bd-448f-9d93-0ed81275e768";
const rootToken = "fldcnRootIdentityPin123";
const openId = "ou_sensitive_victor_identity";
const tenantKey = "tenant_sensitive_synvo_identity";
const otherOpenId = "ou_sensitive_other_identity";
const otherTenantKey = "tenant_sensitive_other_identity";
const encryptionKey = Buffer.alloc(32, 31).toString("base64url");
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
    organizeFolderRootToken: rootToken,
    organizeFolderWriteEnabled: false,
    ...overrides,
  };
}

function inventory() {
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
  };
}

function encryptedResult(): string {
  return TokenCipher.fromEncodedKey(encryptionKey).encrypt(
    JSON.stringify({ ok: true, inventory: inventory() }),
    driveScanResultAssociatedData(runId),
  );
}

function completedRow(overrides: Record<string, unknown> = {}) {
  return {
    run_id: runId,
    run_state: "COMPLETED",
    run_error_code: null,
    root_token_digest: digestFolderToken(rootToken),
    requester_open_id: openId,
    run_tenant_key: tenantKey,
    oauth_grant_id: grantId,
    scan_result_ciphertext: encryptedResult(),
    grant_id: grantId,
    grant_open_id: openId,
    grant_tenant_key: tenantKey,
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
  return { loadLatestRun: async () => candidate };
}

async function withTemporaryDirectory(
  operation: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "synvo-identity-pin-"));
  try {
    await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("plans a canonical append while preserving all unrelated environment text", () => {
  const original = "FIRST=value\n# retained comment\nLAST=value";
  const plan = planPhase2IdentityEnvUpdate(original, { openId, tenantKey });

  assert.equal(plan.action, "update");
  if (plan.action === "update") {
    assert.equal(
      plan.contents,
      `${original}\nLARK_AUTHORIZED_OPEN_ID=${openId}\n` +
        `LARK_AUTHORIZED_TENANT_KEY=${tenantKey}\n`,
    );
  }
});

test("accepts a matching canonical pair as a no-op", () => {
  const plan = planPhase2IdentityEnvUpdate(
    `A=1\nLARK_AUTHORIZED_OPEN_ID=${openId}\n` +
      `LARK_AUTHORIZED_TENANT_KEY=${tenantKey}\nB=2\n`,
    { openId, tenantKey },
  );

  assert.deepEqual(plan, { action: "noop" });
});

test("rejects duplicate, partial, malformed, mismatched, and unsafe identity values", async (t) => {
  const cases = [
    {
      name: "duplicate key",
      contents:
        `LARK_AUTHORIZED_OPEN_ID=${openId}\n` +
        `LARK_AUTHORIZED_OPEN_ID=${openId}\n` +
        `LARK_AUTHORIZED_TENANT_KEY=${tenantKey}\n`,
      identity: { openId, tenantKey },
      code: "ENV_FILE_INVALID",
    },
    {
      name: "partial pair",
      contents: `LARK_AUTHORIZED_OPEN_ID=${openId}\n`,
      identity: { openId, tenantKey },
      code: "ENV_FILE_INVALID",
    },
    {
      name: "noncanonical existing value",
      contents:
        `LARK_AUTHORIZED_OPEN_ID="${openId}"\n` +
        `LARK_AUTHORIZED_TENANT_KEY=${tenantKey}\n`,
      identity: { openId, tenantKey },
      code: "ENV_FILE_INVALID",
    },
    {
      name: "mismatched existing pair",
      contents:
        `LARK_AUTHORIZED_OPEN_ID=${otherOpenId}\n` +
        `LARK_AUTHORIZED_TENANT_KEY=${otherTenantKey}\n`,
      identity: { openId, tenantKey },
      code: "IDENTITY_MISMATCH",
    },
    {
      name: "unsafe candidate newline",
      contents: "A=1\n",
      identity: { openId: `${openId}\nINJECTED=true`, tenantKey },
      code: "ENV_FILE_INVALID",
    },
  ] as const;

  for (const entry of cases) {
    await t.test(entry.name, () => {
      assert.throws(
        () => planPhase2IdentityEnvUpdate(entry.contents, entry.identity),
        { message: entry.code },
      );
    });
  }
});

test("atomically pins the pair, preserves unrelated lines, and forces mode 0600", async () => {
  await withTemporaryDirectory(async (directory) => {
    const envFile = join(directory, ".env");
    const original = "APP_SECRET=sensitive-existing-secret\nFLAG=false\n";
    await writeFile(envFile, original, { mode: 0o644 });

    const result = await pinPhase2IdentityEnvFile(envFile, {
      openId,
      tenantKey,
    });

    assert.equal(result, "PINNED");
    assert.equal(
      await readFile(envFile, "utf8"),
      `${original}LARK_AUTHORIZED_OPEN_ID=${openId}\n` +
        `LARK_AUTHORIZED_TENANT_KEY=${tenantKey}\n`,
    );
    assert.equal((await stat(envFile)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), [".env"]);
  });
});

test("matching preexisting values are a no-op apart from enforcing mode 0600", async () => {
  await withTemporaryDirectory(async (directory) => {
    const envFile = join(directory, ".env");
    const original =
      `A=1\nLARK_AUTHORIZED_OPEN_ID=${openId}\n` +
      `LARK_AUTHORIZED_TENANT_KEY=${tenantKey}\n`;
    await writeFile(envFile, original, { mode: 0o644 });

    const result = await pinPhase2IdentityEnvFile(envFile, {
      openId,
      tenantKey,
    });

    assert.equal(result, "ALREADY_PINNED");
    assert.equal(await readFile(envFile, "utf8"), original);
    assert.equal((await stat(envFile)).mode & 0o777, 0o600);
  });
});

test("rejects symlink and nonregular targets without changing them", async (t) => {
  await t.test("symlink", async () => {
    await withTemporaryDirectory(async (directory) => {
      const target = join(directory, "target");
      const envFile = join(directory, ".env");
      await writeFile(target, "UNCHANGED=true\n");
      await symlink(target, envFile);

      await assert.rejects(
        pinPhase2IdentityEnvFile(envFile, { openId, tenantKey }),
        { message: "ENV_FILE_UNSAFE" },
      );
      assert.equal(await readFile(target, "utf8"), "UNCHANGED=true\n");
      assert.equal((await lstat(envFile)).isSymbolicLink(), true);
    });
  });

  await t.test("directory", async () => {
    await withTemporaryDirectory(async (directory) => {
      const envFile = join(directory, ".env");
      await mkdir(envFile);
      await assert.rejects(
        pinPhase2IdentityEnvFile(envFile, { openId, tenantKey }),
        { message: "ENV_FILE_UNSAFE" },
      );
    });
  });
});

test("bootstrap verifier exposes the identity only after the complete gate passes", async () => {
  const passing = await verifyPhase2LiveForIdentityPin({
    config: config(),
    reader: reader(completedRow()),
    now,
  });
  assert.equal(passing.report.status, "pass");
  assert.deepEqual(passing.identity, { openId, tenantKey });

  const failing = await verifyPhase2LiveForIdentityPin({
    config: config(),
    reader: reader(completedRow({ delivery_state: "PENDING" })),
    now,
  });
  assert.equal(failing.report.status, "fail");
  assert.equal("identity" in failing, false);
});

test("service pins only a fully verified matching identity", async () => {
  let receivedPath: string | undefined;
  let receivedIdentity: { openId: string; tenantKey: string } | undefined;
  const result = await runPhase2IdentityPin({
    config: config(),
    reader: reader(completedRow()),
    envFilePath: "/sensitive/path/.env",
    now,
    writeIdentity: async (path, identity) => {
      receivedPath = path;
      receivedIdentity = identity;
      return "PINNED";
    },
  });

  assert.deepEqual(result, {
    status: "pass",
    pin_code: "PINNED",
    live_verification_code: "NONE",
    live_gate_passed: true,
    env_updated: true,
    identity_pinned: true,
  });
  assert.equal(receivedPath, "/sensitive/path/.env");
  assert.deepEqual(receivedIdentity, { openId, tenantKey });
  assert.equal(phase2IdentityPinExitCode(result), 0);
});

test("service returns pending without touching the environment when no run exists", async () => {
  let writes = 0;
  const result = await runPhase2IdentityPin({
    config: config(),
    reader: reader(null),
    envFilePath: "/sensitive/path/.env",
    now,
    writeIdentity: async () => {
      writes += 1;
      return "PINNED";
    },
  });

  assert.equal(result.status, "pending");
  assert.equal(result.pin_code, "NO_VERIFIED_RUN");
  assert.equal(result.live_verification_code, "NO_LIVE_RUN");
  assert.equal(result.identity_pinned, false);
  assert.equal(writes, 0);
  assert.equal(phase2IdentityPinExitCode(result), 2);
});

test("service fails without touching the environment for every gate or identity mismatch", async (t) => {
  const cases = [
    {
      name: "requester and grant mismatch",
      selectedConfig: config(),
      row: completedRow({ grant_open_id: otherOpenId }),
      pinCode: "LIVE_GATE_FAILED",
    },
    {
      name: "expired refresh grant",
      selectedConfig: config(),
      row: completedRow({ refresh_expires_at: new Date(now) }),
      pinCode: "LIVE_GATE_FAILED",
    },
    {
      name: "existing configured pair mismatch",
      selectedConfig: config({
        authorizedOpenId: otherOpenId,
        authorizedTenantKey: otherTenantKey,
      }),
      row: completedRow(),
      pinCode: "IDENTITY_MISMATCH",
    },
  ] as const;

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      let writes = 0;
      const result = await runPhase2IdentityPin({
        config: entry.selectedConfig,
        reader: reader(entry.row),
        envFilePath: "/sensitive/path/.env",
        now,
        writeIdentity: async () => {
          writes += 1;
          return "PINNED";
        },
      });
      assert.equal(result.status, "fail");
      assert.equal(result.pin_code, entry.pinCode);
      assert.equal(writes, 0);
      assert.equal(phase2IdentityPinExitCode(result), 1);
    });
  }
});

test("service maps environment failures to safe codes", async () => {
  const result = await runPhase2IdentityPin({
    config: config(),
    reader: reader(completedRow()),
    envFilePath: "/sensitive/path/.env",
    now,
    writeIdentity: async () => {
      throw new Error("sensitive filesystem provider detail");
    },
  });

  assert.equal(result.status, "fail");
  assert.equal(result.pin_code, "ENV_UPDATE_FAILED");
  assert.equal(result.live_gate_passed, true);
  assert.equal(result.identity_pinned, false);
});

test("CLI serializer emits only safe enums and booleans", async () => {
  const ciphertext = completedRow().scan_result_ciphertext as string;
  const result = await runPhase2IdentityPin({
    config: config(),
    reader: reader(completedRow()),
    envFilePath: "/sensitive/path/.env",
    now,
    writeIdentity: async () => "ALREADY_PINNED",
  });
  const output = serializePhase2IdentityPinReport(result);
  const parsed = JSON.parse(output) as Record<string, unknown>;

  assert.deepEqual(Object.keys(parsed).sort(), [
    "env_updated",
    "identity_pinned",
    "live_gate_passed",
    "live_verification_code",
    "pin_code",
    "status",
  ]);
  for (const value of Object.values(parsed)) {
    assert.equal(
      typeof value === "boolean" || typeof value === "string",
      true,
    );
  }
  for (const forbidden of [
    runId,
    grantId,
    scanId,
    rootToken,
    openId,
    tenantKey,
    config().appSecret,
    config().databaseUrl,
    config().oauthTokenEncryptionKey,
    ciphertext,
    "SENSITIVE_ROOT_TITLE",
    "SENSITIVE_PRODUCT_TITLE",
    "SENSITIVE_RESEARCH_TITLE",
    "SENSITIVE_FILE_TITLE",
    "/sensitive/path/.env",
  ]) {
    assert.equal(output.includes(forbidden), false);
  }
});

test("CLI emits a safe config failure without inheriting secret environment values", async () => {
  const scriptPath = fileURLToPath(
    new URL("./phase2-identity-pin.ts", import.meta.url),
  );
  const result = await new Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", scriptPath],
      {
        cwd: process.cwd(),
        env: {},
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    status: "fail",
    pin_code: "CONFIG_INVALID",
    live_verification_code: "CONFIG_INVALID",
    live_gate_passed: false,
    env_updated: false,
    identity_pinned: false,
  });
});
