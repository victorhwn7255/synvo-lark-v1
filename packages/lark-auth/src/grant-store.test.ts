import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import {
  DRIVE_MOVE_SPIKE_SCOPE_PROFILE,
  DRIVE_MOVE_SPIKE_USER_SCOPES,
  PostgresOAuthGrantStore,
  type StoredOAuthGrant,
} from "./index.js";

const grant: StoredOAuthGrant = {
  id: "4e41b888-b1b9-46cf-aac8-3e0f35e0d266",
  openId: "open-id",
  tenantKey: "tenant-key",
  accessTokenCiphertext: "access-ciphertext",
  refreshTokenCiphertext: "refresh-ciphertext",
  grantedScopes: [...DRIVE_MOVE_SPIKE_USER_SCOPES],
  accessExpiresAt: new Date("2026-08-08T00:00:00Z"),
  refreshExpiresAt: new Date("2026-09-08T00:00:00Z"),
  refreshVersion: 1,
  revokedAt: null,
};

function row() {
  return {
    id: grant.id,
    open_id: grant.openId,
    tenant_key: grant.tenantKey,
    access_token_ciphertext: grant.accessTokenCiphertext,
    refresh_token_ciphertext: grant.refreshTokenCiphertext,
    granted_scopes: grant.grantedScopes,
    access_expires_at: grant.accessExpiresAt,
    refresh_expires_at: grant.refreshExpiresAt,
    refresh_version: grant.refreshVersion,
    revoked_at: grant.revokedAt,
  };
}

test("isolates Drive move spike grants by the explicit scope profile", async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    async query(text: string, values: unknown[]) {
      calls.push({ text, values });
      return { rows: [row()], rowCount: 1 };
    },
  } as unknown as Pool;
  const store = new PostgresOAuthGrantStore(pool, {
    scopeProfile: DRIVE_MOVE_SPIKE_SCOPE_PROFILE,
  });

  await store.findBySubject(grant.openId, grant.tenantKey);
  await store.save(grant);

  assert.match(calls[0]!.text, /scope_profile = \$3/);
  assert.deepEqual(calls[0]!.values, [
    grant.openId,
    grant.tenantKey,
    DRIVE_MOVE_SPIKE_SCOPE_PROFILE,
  ]);
  assert.match(
    calls[1]!.text,
    /ON CONFLICT \(tenant_key, open_id, scope_profile\)/,
  );
  assert.equal(calls[1]!.values[3], DRIVE_MOVE_SPIKE_SCOPE_PROFILE);
});
