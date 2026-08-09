import { randomUUID } from "node:crypto";

import { LarkAuthError } from "./errors.js";
import type {
  OAuthGrantStore,
  ReplaceOAuthGrantInput,
  StoredOAuthGrant,
} from "./grant-store.js";
import {
  hasExactScopes,
  type LarkOAuthClient,
  type LarkTokenResponse,
  ORGANIZE_FOLDER_USER_SCOPES,
} from "./oauth-client.js";
import {
  grantTokenAssociatedData,
  type TokenCipher,
} from "./token-crypto.js";

type NewOAuthGrantInput = {
  openId: string;
  tenantKey: string;
  token: LarkTokenResponse;
  now?: Date;
};

type TokenBrokerOptions = {
  clientId: string;
  clientSecret: string;
  cipher: TokenCipher;
  grantStore: OAuthGrantStore;
  oauthClient: LarkOAuthClient;
  refreshSkewMs?: number;
  now?: () => Date;
};

function tokenExpiry(now: Date, expiresInSeconds: number): Date {
  return new Date(now.getTime() + expiresInSeconds * 1_000);
}

function assertExactScopes(
  grantedScopes: readonly string[],
  expectedScopes: readonly string[],
): void {
  if (!hasExactScopes(grantedScopes, expectedScopes)) {
    throw new LarkAuthError(
      "WRONG_SCOPE",
      "The Lark authorization scope set does not match the read-only policy.",
    );
  }
}

export function createEncryptedOAuthGrant(
  cipher: TokenCipher,
  input: NewOAuthGrantInput,
): StoredOAuthGrant {
  const now = input.now ?? new Date();
  const refreshVersion = 1;
  return {
    id: randomUUID(),
    openId: input.openId,
    tenantKey: input.tenantKey,
    accessTokenCiphertext: cipher.encrypt(
      input.token.accessToken,
      grantTokenAssociatedData(
        input.tenantKey,
        input.openId,
        "access",
        refreshVersion,
      ),
    ),
    refreshTokenCiphertext: cipher.encrypt(
      input.token.refreshToken,
      grantTokenAssociatedData(
        input.tenantKey,
        input.openId,
        "refresh",
        refreshVersion,
      ),
    ),
    grantedScopes: [...input.token.scopes].sort(),
    accessExpiresAt: tokenExpiry(now, input.token.expiresIn),
    refreshExpiresAt: tokenExpiry(now, input.token.refreshTokenExpiresIn),
    refreshVersion,
    revokedAt: null,
  };
}

function decryptAccessToken(cipher: TokenCipher, grant: StoredOAuthGrant): string {
  return cipher.decrypt(
    grant.accessTokenCiphertext,
    grantTokenAssociatedData(
      grant.tenantKey,
      grant.openId,
      "access",
      grant.refreshVersion,
    ),
  );
}

function decryptRefreshToken(cipher: TokenCipher, grant: StoredOAuthGrant): string {
  return cipher.decrypt(
    grant.refreshTokenCiphertext,
    grantTokenAssociatedData(
      grant.tenantKey,
      grant.openId,
      "refresh",
      grant.refreshVersion,
    ),
  );
}

type LockedTokenResult =
  | { kind: "token"; accessToken: string }
  | { kind: "revoked"; error: LarkAuthError };

export class LarkTokenBroker {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #cipher: TokenCipher;
  readonly #grantStore: OAuthGrantStore;
  readonly #oauthClient: LarkOAuthClient;
  readonly #refreshSkewMs: number;
  readonly #requiredScopes: readonly string[];
  readonly #now: () => Date;

  constructor(options: TokenBrokerOptions) {
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#cipher = options.cipher;
    this.#grantStore = options.grantStore;
    this.#oauthClient = options.oauthClient;
    this.#refreshSkewMs = options.refreshSkewMs ?? 120_000;
    this.#requiredScopes = [...ORGANIZE_FOLDER_USER_SCOPES].sort();
    this.#now = options.now ?? (() => new Date());
  }

  async getAccessToken(openId: string, tenantKey: string): Promise<string> {
    const current = await this.#grantStore.findBySubject(openId, tenantKey);
    this.#assertUsable(current);
    const now = this.#now();

    if (current.accessExpiresAt.getTime() > now.getTime() + this.#refreshSkewMs) {
      return decryptAccessToken(this.#cipher, current);
    }

    const outcome = await this.#grantStore.withLockedGrant(
      openId,
      tenantKey,
      async (lockedGrant) => this.#refreshLockedGrant(lockedGrant),
    );

    if (outcome.kind === "revoked") {
      throw outcome.error;
    }
    return outcome.accessToken;
  }

  async recoverAccessToken(
    openId: string,
    tenantKey: string,
    rejectedAccessToken: string,
  ): Promise<string> {
    const outcome = await this.#grantStore.withLockedGrant(
      openId,
      tenantKey,
      async (lockedGrant) =>
        this.#refreshLockedGrant(lockedGrant, rejectedAccessToken),
    );

    if (outcome.kind === "revoked") {
      throw outcome.error;
    }
    return outcome.accessToken;
  }

  async markAccessTokenRejected(
    openId: string,
    tenantKey: string,
    rejectedAccessToken: string,
  ): Promise<void> {
    await this.#grantStore.withLockedGrant(
      openId,
      tenantKey,
      async (lockedGrant) => {
        if (lockedGrant.revokedAt) {
          return { result: undefined };
        }
        this.#assertUsable(lockedGrant);
        const currentAccessToken = decryptAccessToken(this.#cipher, lockedGrant);
        return {
          result: undefined,
          replacement:
            currentAccessToken === rejectedAccessToken
              ? this.#revokedReplacement(lockedGrant, this.#now())
              : undefined,
        };
      },
    );
  }

  #assertUsable(
    grant: StoredOAuthGrant | null,
  ): asserts grant is StoredOAuthGrant {
    if (!grant) {
      throw new LarkAuthError(
        "OAUTH_REQUIRED",
        "Lark authorization is required.",
      );
    }
    if (grant.revokedAt) {
      throw new LarkAuthError(
        "OAUTH_REVOKED",
        "The Lark authorization is no longer usable.",
      );
    }
    assertExactScopes(grant.grantedScopes, this.#requiredScopes);
  }

  async #refreshLockedGrant(
    grant: StoredOAuthGrant,
    rejectedAccessToken?: string,
  ): Promise<{
    result: LockedTokenResult;
    replacement?: ReplaceOAuthGrantInput;
  }> {
    this.#assertUsable(grant);
    const now = this.#now();
    const currentAccessToken = decryptAccessToken(this.#cipher, grant);
    if (
      rejectedAccessToken !== undefined &&
      currentAccessToken !== rejectedAccessToken
    ) {
      return {
        result: { kind: "token", accessToken: currentAccessToken },
      };
    }
    if (
      rejectedAccessToken === undefined &&
      grant.accessExpiresAt.getTime() > now.getTime() + this.#refreshSkewMs
    ) {
      return {
        result: {
          kind: "token",
          accessToken: currentAccessToken,
        },
      };
    }

    if (grant.refreshExpiresAt.getTime() <= now.getTime()) {
      const error = new LarkAuthError(
        "OAUTH_REVOKED",
        "The Lark authorization has expired.",
      );
      return {
        result: { kind: "revoked", error },
        replacement: this.#revokedReplacement(grant, now),
      };
    }

    let refreshed: LarkTokenResponse;
    try {
      refreshed = await this.#oauthClient.refresh({
        clientId: this.#clientId,
        clientSecret: this.#clientSecret,
        scopes: this.#requiredScopes,
        refreshToken: decryptRefreshToken(this.#cipher, grant),
      });
      assertExactScopes(refreshed.scopes, this.#requiredScopes);
    } catch (error) {
      if (error instanceof LarkAuthError && error.code === "OAUTH_REVOKED") {
        return {
          result: { kind: "revoked", error },
          replacement: this.#revokedReplacement(grant, now),
        };
      }
      throw error;
    }

    const nextVersion = grant.refreshVersion + 1;
    const replacement: ReplaceOAuthGrantInput = {
      accessTokenCiphertext: this.#cipher.encrypt(
        refreshed.accessToken,
        grantTokenAssociatedData(
          grant.tenantKey,
          grant.openId,
          "access",
          nextVersion,
        ),
      ),
      refreshTokenCiphertext: this.#cipher.encrypt(
        refreshed.refreshToken,
        grantTokenAssociatedData(
          grant.tenantKey,
          grant.openId,
          "refresh",
          nextVersion,
        ),
      ),
      grantedScopes: [...refreshed.scopes].sort(),
      accessExpiresAt: tokenExpiry(now, refreshed.expiresIn),
      refreshExpiresAt: tokenExpiry(now, refreshed.refreshTokenExpiresIn),
      refreshVersion: nextVersion,
      revokedAt: null,
    };

    return {
      result: { kind: "token", accessToken: refreshed.accessToken },
      replacement,
    };
  }

  #revokedReplacement(
    grant: StoredOAuthGrant,
    revokedAt: Date,
  ): ReplaceOAuthGrantInput {
    return {
      accessTokenCiphertext: grant.accessTokenCiphertext,
      refreshTokenCiphertext: grant.refreshTokenCiphertext,
      grantedScopes: grant.grantedScopes,
      accessExpiresAt: grant.accessExpiresAt,
      refreshExpiresAt: grant.refreshExpiresAt,
      refreshVersion: grant.refreshVersion,
      revokedAt,
    };
  }
}
