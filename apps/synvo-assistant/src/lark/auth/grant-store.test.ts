import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import {
  ORGANIZE_FOLDER_SCOPE_PROFILE,
  ORGANIZE_FOLDER_USER_SCOPES,
  PostgresOAuthGrantStore,
  type StoredOAuthGrant,
} from "./index.js";

const grant: StoredOAuthGrant = {
  id: "4e41b888-b1b9-46cf-aac8-3e0f35e0d266",
  openId: "open-id",
  tenantKey: "tenant-key",
  accessTokenCiphertext: "access-ciphertext",
  refreshTokenCiphertext: "refresh-ciphertext",
  grantedScopes: [...ORGANIZE_FOLDER_USER_SCOPES],
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

test("uses one fixed Phase 5 OAuth grant profile", async () => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const pool = {
    async query(text: string, values: unknown[]) {
      calls.push({ text, values });
      return { rows: [row()], rowCount: 1 };
    },
  } as unknown as Pool;
  const store = new PostgresOAuthGrantStore(pool);

  await store.findBySubject(grant.openId, grant.tenantKey);
  await store.save(grant);

  assert.equal(calls[0]!.values[2], ORGANIZE_FOLDER_SCOPE_PROFILE);
  assert.match(calls[1]!.text, /ON CONFLICT \(tenant_key, open_id, scope_profile\)/);
  assert.equal(calls[1]!.values[3], ORGANIZE_FOLDER_SCOPE_PROFILE);
});
