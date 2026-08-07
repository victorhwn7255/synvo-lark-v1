import assert from "node:assert/strict";
import test from "node:test";

import {
  driveScanResultAssociatedData,
  type DriveScanFolderResult,
} from "@synvo/contracts";
import {
  TokenCipher,
  type LarkTokenBroker,
} from "@synvo/lark-auth";
import type { Pool } from "pg";

import { DriveToolError } from "../modules/drive/errors.js";
import { digestFolderToken } from "../modules/drive/folder-link.js";
import { PostgresDriveRunRepository } from "./run-context.js";

type QueryCall = {
  text: string;
  values: readonly unknown[];
};

type QueryResponse = {
  rows: unknown[];
  rowCount?: number;
};

class FakePool {
  readonly calls: QueryCall[] = [];
  readonly #responses: QueryResponse[];

  constructor(responses: QueryResponse[]) {
    this.#responses = responses;
  }

  enqueue(response: QueryResponse): void {
    this.#responses.push(response);
  }

  async query<Row>(text: string, values: readonly unknown[] = []): Promise<{
    rows: Row[];
    rowCount: number;
  }> {
    this.calls.push({ text, values });
    const response = this.#responses.shift();
    if (!response) {
      throw new Error("Unexpected database query");
    }
    return {
      rows: response.rows as Row[],
      rowCount: response.rowCount ?? response.rows.length,
    };
  }
}

class FakeTokenBroker {
  readonly calls: Array<{ openId: string; tenantKey: string }> = [];
  readonly recoveryCalls: Array<{
    openId: string;
    tenantKey: string;
    rejectedAccessToken: string;
  }> = [];
  readonly rejectionCalls: Array<{
    openId: string;
    tenantKey: string;
    rejectedAccessToken: string;
  }> = [];

  async getAccessToken(openId: string, tenantKey: string): Promise<string> {
    this.calls.push({ openId, tenantKey });
    return "private-access-token";
  }

  async recoverAccessToken(
    openId: string,
    tenantKey: string,
    rejectedAccessToken: string,
  ): Promise<string> {
    this.recoveryCalls.push({ openId, tenantKey, rejectedAccessToken });
    return "private-recovered-access-token";
  }

  async markAccessTokenRejected(
    openId: string,
    tenantKey: string,
    rejectedAccessToken: string,
  ): Promise<void> {
    this.rejectionCalls.push({ openId, tenantKey, rejectedAccessToken });
  }
}

const runId = "4d872758-1f71-4ed8-b141-a2d193ceea91";
const scanId = "b77e7818-3f09-45da-9860-7bf873ab6d8e";
const rootToken = "allowlisted-root-token";
const cipher = new TokenCipher(Buffer.alloc(32, 17));

const successfulResult: DriveScanFolderResult = {
  ok: true,
  inventory: {
    run_id: runId,
    scan_id: scanId,
    complete: true,
    baseline_matches: true,
    root: {
      ref: "root",
      name: "Sensitive Pilot Root",
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

const failedResult: DriveScanFolderResult = {
  ok: false,
  error: {
    code: "LARK_RETRYABLE",
    message: "Lark Drive is temporarily unavailable.",
    retryable: true,
  },
};

const terminalFailedResult: DriveScanFolderResult = {
  ok: false,
  error: {
    code: "LARK_PERMANENT",
    message: "Lark Drive rejected the read-only inventory request.",
    retryable: false,
  },
};

function claimedRun(scanAttempt = 1) {
  return {
    id: runId,
    requester_open_id: "ou_victor",
    tenant_key: "tenant-synvo",
    oauth_grant_id: "grant-victor",
    scan_attempt: scanAttempt,
  };
}

function diagnosticRow(input: {
  state: string;
  ciphertext?: string | null;
  grantId?: string | null;
  grantMatches?: boolean;
}) {
  return {
    state: input.state,
    root_token_digest: digestFolderToken(rootToken),
    oauth_grant_id: input.grantId === undefined ? "grant-victor" : input.grantId,
    oauth_grant_matches_subject: input.grantMatches ?? true,
    scan_result_ciphertext: input.ciphertext ?? null,
  };
}

function repository(pool: FakePool, broker = new FakeTokenBroker()) {
  return new PostgresDriveRunRepository({
    pool: pool as unknown as Pool,
    tokenBroker: broker as unknown as LarkTokenBroker,
    cipher,
    rootToken,
  });
}

test("atomically claims READY_TO_SCAN or an expired SCANNING lease", async () => {
  const pool = new FakePool([{ rows: [claimedRun(4)] }]);
  const broker = new FakeTokenBroker();

  const resolution = await repository(pool, broker).resolve(runId);

  assert.equal(resolution.kind, "claimed");
  if (resolution.kind !== "claimed") {
    return;
  }
  assert.equal(resolution.scanAttempt, 4);
  const context = await resolution.loadContext();
  assert.equal(context.accessToken, "private-access-token");
  assert.deepEqual(broker.calls, [
    { openId: "ou_victor", tenantKey: "tenant-synvo" },
  ]);
  assert.equal(
    await context.recoverAccessToken("private-access-token"),
    "private-recovered-access-token",
  );
  await context.markAccessTokenRejected("private-recovered-access-token");

  const claimSql = pool.calls[0]?.text ?? "";
  assert.match(claimSql, /scan_attempt = run\.scan_attempt \+ 1/);
  assert.match(claimSql, /run\.state = 'READY_TO_SCAN'/);
  assert.match(claimSql, /run\.state = 'SCANNING'/);
  assert.match(claimSql, /run\.scan_lease_expires_at <= now\(\)/);
  assert.match(claimSql, /run\.oauth_grant_id = oauth_grant\.id/);
  assert.match(claimSql, /run\.requester_open_id = oauth_grant\.open_id/);
  assert.match(claimSql, /run\.tenant_key = oauth_grant\.tenant_key/);
  assert.deepEqual(pool.calls[0]?.values, [
    runId,
    digestFolderToken(rootToken),
    "2 minutes",
  ]);
});

test("rejects an active SCANNING lease as retryable without loading a token", async () => {
  const pool = new FakePool([
    { rows: [] },
    { rows: [diagnosticRow({ state: "SCANNING" })] },
  ]);
  const broker = new FakeTokenBroker();

  await assert.rejects(
    repository(pool, broker).resolve(runId),
    (error: unknown) =>
      error instanceof DriveToolError &&
      error.safeError.code === "RUN_NOT_READY" &&
      error.safeError.retryable,
  );
  assert.equal(broker.calls.length, 0);
});

test("rejects a ready run whose stored grant belongs to another subject", async () => {
  const pool = new FakePool([
    { rows: [] },
    {
      rows: [
        diagnosticRow({
          state: "READY_TO_SCAN",
          grantId: "grant-someone-else",
          grantMatches: false,
        }),
      ],
    },
  ]);
  const broker = new FakeTokenBroker();

  await assert.rejects(
    repository(pool, broker).resolve(runId),
    (error: unknown) =>
      error instanceof DriveToolError && error.safeError.code === "UNAUTHORIZED",
  );
  assert.equal(broker.calls.length, 0);
});

test("persists and returns an encrypted cached success result", async () => {
  const pool = new FakePool([{ rows: [{ id: runId }], rowCount: 1 }]);
  const runRepository = repository(pool);

  await runRepository.complete(runId, 3, successfulResult);

  const writeCall = pool.calls[0];
  assert.ok(writeCall);
  assert.deepEqual(writeCall.values.slice(0, 4), [
    runId,
    3,
    "COMPLETED",
    null,
  ]);
  const ciphertext = String(writeCall.values[4]);
  assert.equal(ciphertext.includes("Sensitive Pilot Root"), false);
  assert.deepEqual(
    JSON.parse(
      cipher.decrypt(ciphertext, driveScanResultAssociatedData(runId)),
    ),
    successfulResult,
  );

  pool.enqueue({ rows: [] });
  pool.enqueue({
    rows: [diagnosticRow({ state: "COMPLETED", ciphertext })],
  });
  assert.deepEqual(await runRepository.resolve(runId), {
    kind: "cached",
    result: successfulResult,
  });
});

test("releases a retryable safe error for a future scan attempt without caching it", async () => {
  const pool = new FakePool([{ rows: [{ id: runId }], rowCount: 1 }]);
  const runRepository = repository(pool);

  await runRepository.fail(runId, 5, failedResult);

  const writeCall = pool.calls[0];
  assert.ok(writeCall);
  assert.deepEqual(writeCall.values, [runId, 5]);
  assert.match(writeCall.text, /SET state = 'READY_TO_SCAN'/);
  assert.match(writeCall.text, /terminal_error_code = NULL/);
  assert.match(writeCall.text, /scan_result_ciphertext = NULL/);
  assert.match(writeCall.text, /scan_lease_expires_at = NULL/);
  assert.match(writeCall.text, /AND state = 'SCANNING'/);
  assert.match(writeCall.text, /AND scan_attempt = \$2/);

  pool.enqueue({ rows: [claimedRun(6)] });
  const retried = await runRepository.resolve(runId);
  assert.equal(retried.kind, "claimed");
  if (retried.kind === "claimed") {
    assert.equal(retried.scanAttempt, 6);
  }
});

test("persists and returns an encrypted cached nonretryable safe error", async () => {
  const pool = new FakePool([{ rows: [{ id: runId }], rowCount: 1 }]);
  const runRepository = repository(pool);

  await runRepository.fail(runId, 5, terminalFailedResult);

  const writeCall = pool.calls[0];
  assert.ok(writeCall);
  assert.deepEqual(writeCall.values.slice(0, 4), [
    runId,
    5,
    "FAILED_NO_CHANGE",
    "LARK_PERMANENT",
  ]);
  const ciphertext = String(writeCall.values[4]);
  assert.equal(ciphertext.includes("rejected"), false);
  assert.deepEqual(
    JSON.parse(
      cipher.decrypt(ciphertext, driveScanResultAssociatedData(runId)),
    ),
    terminalFailedResult,
  );

  pool.enqueue({ rows: [] });
  pool.enqueue({
    rows: [diagnosticRow({ state: "FAILED_NO_CHANGE", ciphertext })],
  });
  assert.deepEqual(await runRepository.resolve(runId), {
    kind: "cached",
    result: terminalFailedResult,
  });
});

test("prevents a stale scan attempt from overwriting a newer result", async () => {
  const pool = new FakePool([{ rows: [], rowCount: 0 }]);

  await assert.rejects(
    repository(pool).complete(runId, 2, successfulResult),
    (error: unknown) =>
      error instanceof DriveToolError &&
      error.safeError.code === "RUN_NOT_READY" &&
      error.safeError.retryable,
  );

  const updateSql = pool.calls[0]?.text ?? "";
  assert.match(updateSql, /AND state = 'SCANNING'/);
  assert.match(updateSql, /AND scan_attempt = \$2/);
});
