import assert from "node:assert/strict";
import test from "node:test";

import {
  driveScanResultAssociatedData,
  driveScanFolderInputSchema,
  driveScanFolderResultSchema,
} from "./organize-folder.js";

test("keeps the encrypted scan-result associated-data contract stable", () => {
  assert.equal(
    driveScanResultAssociatedData("4d872758-1f71-4ed8-b141-a2d193ceea91"),
    "organize-folder-run:4d872758-1f71-4ed8-b141-a2d193ceea91:scan-result:v1",
  );
});

test("drive scan accepts only a server-owned UUID run id", () => {
  assert.deepEqual(
    driveScanFolderInputSchema.parse({
      run_id: "4d872758-1f71-4ed8-b141-a2d193ceea91",
    }),
    { run_id: "4d872758-1f71-4ed8-b141-a2d193ceea91" },
  );

  assert.throws(() =>
    driveScanFolderInputSchema.parse({
      run_id: "4d872758-1f71-4ed8-b141-a2d193ceea91",
      access_token: "must-never-be-an-argument",
    }),
  );
});

test("drive scan result never requires native Drive tokens", () => {
  const result = driveScanFolderResultSchema.parse({
    ok: false,
    error: {
      code: "OAUTH_REQUIRED",
      message: "Lark authorization is required.",
      retryable: false,
    },
  });

  assert.equal(result.ok, false);
  assert.equal("access_token" in result, false);
  assert.equal("folder_token" in result, false);
});

test("drive scan result rejects native tokens and ambiguous envelopes", () => {
  assert.throws(() =>
    driveScanFolderResultSchema.parse({
      ok: false,
      access_token: "must-never-cross-the-boundary",
      error: {
        code: "OAUTH_REQUIRED",
        message: "Lark authorization is required.",
        retryable: false,
      },
    }),
  );
  assert.throws(() => driveScanFolderResultSchema.parse({ ok: true }));
  assert.throws(() =>
    driveScanFolderResultSchema.parse({
      ok: false,
      error: {
        code: "OAUTH_REQUIRED",
        message: "Lark authorization is required.",
        retryable: false,
      },
      inventory: {
        run_id: "4d872758-1f71-4ed8-b141-a2d193ceea91",
      },
    }),
  );
});
