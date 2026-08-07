import type { Pool, PoolClient } from "pg";

import {
  DRIVE_INVENTORY_SCOPE_PROFILE,
  type OAuthScopeProfile,
} from "./oauth-client.js";

export type StoredOAuthGrant = {
  id: string;
  openId: string;
  tenantKey: string;
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  grantedScopes: string[];
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  refreshVersion: number;
  revokedAt: Date | null;
};

export type SaveOAuthGrantInput = StoredOAuthGrant;

export type ReplaceOAuthGrantInput = {
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  grantedScopes: string[];
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  refreshVersion: number;
  revokedAt: Date | null;
};

export type LockedGrantResult<T> = {
  result: T;
  replacement?: ReplaceOAuthGrantInput;
};

export interface OAuthGrantStore {
  findBySubject(openId: string, tenantKey: string): Promise<StoredOAuthGrant | null>;
  save(input: SaveOAuthGrantInput): Promise<StoredOAuthGrant>;
  withLockedGrant<T>(
    openId: string,
    tenantKey: string,
    operation: (grant: StoredOAuthGrant) => Promise<LockedGrantResult<T>>,
  ): Promise<T>;
}

type GrantRow = {
  id: string;
  open_id: string;
  tenant_key: string;
  access_token_ciphertext: string;
  refresh_token_ciphertext: string;
  granted_scopes: string[];
  access_expires_at: Date;
  refresh_expires_at: Date;
  refresh_version: number;
  revoked_at: Date | null;
};

function toGrant(row: GrantRow): StoredOAuthGrant {
  return {
    id: row.id,
    openId: row.open_id,
    tenantKey: row.tenant_key,
    accessTokenCiphertext: row.access_token_ciphertext,
    refreshTokenCiphertext: row.refresh_token_ciphertext,
    grantedScopes: [...row.granted_scopes].sort(),
    accessExpiresAt: row.access_expires_at,
    refreshExpiresAt: row.refresh_expires_at,
    refreshVersion: row.refresh_version,
    revokedAt: row.revoked_at,
  };
}

async function selectGrant(
  client: Pick<PoolClient, "query">,
  openId: string,
  tenantKey: string,
  scopeProfile: OAuthScopeProfile,
  lock: boolean,
): Promise<StoredOAuthGrant | null> {
  const result = await client.query<GrantRow>(
    `SELECT id,
            open_id,
            tenant_key,
            access_token_ciphertext,
            refresh_token_ciphertext,
            granted_scopes,
            access_expires_at,
            refresh_expires_at,
            refresh_version,
            revoked_at
      FROM lark_oauth_grants
      WHERE open_id = $1
        AND tenant_key = $2
        AND scope_profile = $3
      ${lock ? "FOR UPDATE" : ""}`,
    [openId, tenantKey, scopeProfile],
  );

  return result.rows[0] ? toGrant(result.rows[0]) : null;
}

export class PostgresOAuthGrantStore implements OAuthGrantStore {
  readonly #pool: Pool;
  readonly #scopeProfile: OAuthScopeProfile;

  constructor(
    pool: Pool,
    options: { scopeProfile?: OAuthScopeProfile } = {},
  ) {
    this.#pool = pool;
    this.#scopeProfile = options.scopeProfile ?? DRIVE_INVENTORY_SCOPE_PROFILE;
  }

  async findBySubject(
    openId: string,
    tenantKey: string,
  ): Promise<StoredOAuthGrant | null> {
    return selectGrant(
      this.#pool,
      openId,
      tenantKey,
      this.#scopeProfile,
      false,
    );
  }

  async save(input: SaveOAuthGrantInput): Promise<StoredOAuthGrant> {
    const result = await this.#pool.query<GrantRow>(
      `INSERT INTO lark_oauth_grants (
          id,
          open_id,
          tenant_key,
          scope_profile,
          access_token_ciphertext,
          refresh_token_ciphertext,
          granted_scopes,
          access_expires_at,
          refresh_expires_at,
          refresh_version,
          revoked_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (tenant_key, open_id, scope_profile) DO UPDATE SET
          access_token_ciphertext = EXCLUDED.access_token_ciphertext,
          refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
          granted_scopes = EXCLUDED.granted_scopes,
          access_expires_at = EXCLUDED.access_expires_at,
          refresh_expires_at = EXCLUDED.refresh_expires_at,
          refresh_version = EXCLUDED.refresh_version,
          revoked_at = EXCLUDED.revoked_at,
          updated_at = now()
       RETURNING id,
                 open_id,
                 tenant_key,
                 access_token_ciphertext,
                 refresh_token_ciphertext,
                 granted_scopes,
                 access_expires_at,
                 refresh_expires_at,
                 refresh_version,
                 revoked_at`,
      [
        input.id,
        input.openId,
        input.tenantKey,
        this.#scopeProfile,
        input.accessTokenCiphertext,
        input.refreshTokenCiphertext,
        input.grantedScopes,
        input.accessExpiresAt,
        input.refreshExpiresAt,
        input.refreshVersion,
        input.revokedAt,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error("OAuth grant save returned no row");
    }
    return toGrant(row);
  }

  async withLockedGrant<T>(
    openId: string,
    tenantKey: string,
    operation: (grant: StoredOAuthGrant) => Promise<LockedGrantResult<T>>,
  ): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const grant = await selectGrant(
        client,
        openId,
        tenantKey,
        this.#scopeProfile,
        true,
      );
      if (!grant) {
        throw new Error("OAUTH_GRANT_NOT_FOUND");
      }

      const outcome = await operation(grant);
      if (outcome.replacement) {
        const replacement = outcome.replacement;
        await client.query(
          `UPDATE lark_oauth_grants
              SET access_token_ciphertext = $2,
                  refresh_token_ciphertext = $3,
                  granted_scopes = $4,
                  access_expires_at = $5,
                  refresh_expires_at = $6,
                  refresh_version = $7,
                  revoked_at = $8,
                  updated_at = now()
            WHERE id = $1`,
          [
            grant.id,
            replacement.accessTokenCiphertext,
            replacement.refreshTokenCiphertext,
            replacement.grantedScopes,
            replacement.accessExpiresAt,
            replacement.refreshExpiresAt,
            replacement.refreshVersion,
            replacement.revokedAt,
          ],
        );
      }

      await client.query("COMMIT");
      return outcome.result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
