import assert from "node:assert/strict";
import test from "node:test";

import {
  grantTokenAssociatedData,
  oauthSessionAssociatedData,
  TokenCipher,
} from "./token-crypto.js";

const key = Buffer.alloc(32, 7);

test("encrypts and decrypts a token only with matching associated data", () => {
  const cipher = new TokenCipher(key);
  const associatedData = grantTokenAssociatedData(
    "tenant-a",
    "open-a",
    "access",
    1,
  );
  const ciphertext = cipher.encrypt("secret-access-token", associatedData);

  assert.notEqual(ciphertext.includes("secret-access-token"), true);
  assert.equal(cipher.decrypt(ciphertext, associatedData), "secret-access-token");
  assert.throws(() => cipher.decrypt(ciphertext, `${associatedData}:wrong`));
});

test("requires a 32-byte encryption key", () => {
  assert.throws(
    () => new TokenCipher(Buffer.alloc(31)),
    /exactly 32 bytes/,
  );
});

test("binds a PKCE verifier to its app, session, redirect, and scopes", () => {
  const cipher = new TokenCipher(key);
  const policy = {
    appId: "cli_0123456789abcdef",
    requestTokenDigest: "request-digest",
    redirectUri: "https://assistant.synvo.ai/oauth/lark/callback",
    scopes: [
      "drive:drive.metadata:readonly",
      "offline_access",
      "space:document:retrieve",
    ],
  };
  const associatedData = oauthSessionAssociatedData(policy);
  const ciphertext = cipher.encrypt("pkce-verifier", associatedData);

  assert.equal(cipher.decrypt(ciphertext, associatedData), "pkce-verifier");
  assert.throws(() =>
    cipher.decrypt(
      ciphertext,
      oauthSessionAssociatedData({ ...policy, appId: "cli_other" }),
    ),
  );
  assert.throws(() =>
    cipher.decrypt(
      ciphertext,
      oauthSessionAssociatedData({
        ...policy,
        redirectUri: "https://attacker.example/callback",
      }),
    ),
  );
  assert.throws(() =>
    cipher.decrypt(
      ciphertext,
      oauthSessionAssociatedData({
        ...policy,
        scopes: [...policy.scopes, "drive:drive:readonly"],
      }),
    ),
  );
});
