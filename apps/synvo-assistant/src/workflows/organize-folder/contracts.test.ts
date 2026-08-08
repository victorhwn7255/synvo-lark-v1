import assert from "node:assert/strict";
import test from "node:test";

import {
  driveFolderInventoryResultAssociatedData,
  driveFolderInventoryResultSchema,
} from "./contracts.js";

test("keeps the encrypted scan-result associated-data contract stable", () => {
  assert.equal(
    driveFolderInventoryResultAssociatedData("4d872758-1f71-4ed8-b141-a2d193ceea91"),
    "organize-folder-run:4d872758-1f71-4ed8-b141-a2d193ceea91:scan-result:v1",
  );
});

test("drive scan result never requires native Drive tokens", () => {
  const result = driveFolderInventoryResultSchema.parse({
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
    driveFolderInventoryResultSchema.parse({
      ok: false,
      access_token: "must-never-cross-the-boundary",
      error: {
        code: "OAUTH_REQUIRED",
        message: "Lark authorization is required.",
        retryable: false,
      },
    }),
  );
  assert.throws(() => driveFolderInventoryResultSchema.parse({ ok: true }));
  assert.throws(() =>
    driveFolderInventoryResultSchema.parse({
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
