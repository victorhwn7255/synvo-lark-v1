import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createPkce, digestOpaqueValue, randomOpaqueValue } from "./pkce.js";

test("creates an RFC 7636 S256 verifier and challenge", () => {
  const { verifier, challenge } = createPkce();

  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    challenge,
    createHash("sha256").update(verifier).digest("base64url"),
  );
});

test("hashes opaque values before persistence", () => {
  const value = randomOpaqueValue();
  const digest = digestOpaqueValue(value);

  assert.equal(digest.length, 64);
  assert.equal(digest.includes(value), false);
});
