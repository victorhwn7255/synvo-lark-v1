import assert from "node:assert/strict";
import test from "node:test";

import { normalizeDriveError } from "./errors.js";

test("normalizes authorization errors without returning provider details", () => {
  const error = normalizeDriveError({
    response: {
      status: 403,
      data: { msg: "private file title and token" },
    },
  });

  assert.equal(error.safeError.code, "UNAUTHORIZED");
  assert.equal(error.message.includes("private file title"), false);
});

test("marks rate limits and service failures retryable", () => {
  assert.equal(
    normalizeDriveError({ response: { status: 429 } }).safeError.retryable,
    true,
  );
  assert.equal(
    normalizeDriveError({ response: { status: 503 } }).safeError.retryable,
    true,
  );
});

test("marks nested fetch transport failures retryable without provider detail", () => {
  const marker = "private token and folder detail";
  const failure = new TypeError(`fetch failed: ${marker}`, {
    cause: Object.assign(new Error(marker), { code: "ECONNRESET" }),
  });
  const normalized = normalizeDriveError(failure);

  assert.equal(normalized.safeError.code, "LARK_RETRYABLE");
  assert.equal(normalized.safeError.retryable, true);
  assert.equal(normalized.message.includes(marker), false);
});
