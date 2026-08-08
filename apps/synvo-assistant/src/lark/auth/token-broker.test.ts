import assert from "node:assert/strict";
import test from "node:test";

import type {
  AuthorizationUrlInput,
  ExchangeCodeInput,
  LarkOAuthClient,
  LarkTokenResponse,
  LarkUserIdentity,
  LockedGrantResult,
  OAuthGrantStore,
  RefreshTokenInput,
  SaveOAuthGrantInput,
  StoredOAuthGrant,
} from "./index.js";
import {
  createEncryptedOAuthGrant,
  grantTokenAssociatedData,
  LarkAuthError,
  LarkOAuthHttpClient,
  LarkTokenBroker,
  DRIVE_INVENTORY_USER_SCOPES,
  TokenCipher,
} from "./index.js";

class MemoryGrantStore implements OAuthGrantStore {
  grant: StoredOAuthGrant | null;
  #lock: Promise<void> = Promise.resolve();

  constructor(grant: StoredOAuthGrant | null) {
    this.grant = grant;
  }

  async findBySubject(): Promise<StoredOAuthGrant | null> {
    return this.grant ? structuredClone(this.grant) : null;
  }

  async save(input: SaveOAuthGrantInput): Promise<StoredOAuthGrant> {
    this.grant = structuredClone(input);
    return structuredClone(input);
  }

  async withLockedGrant<T>(
    _openId: string,
    _tenantKey: string,
    operation: (grant: StoredOAuthGrant) => Promise<LockedGrantResult<T>>,
  ): Promise<T> {
    const previous = this.#lock;
    let release: () => void = () => undefined;
    this.#lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      if (!this.grant) {
        throw new Error("OAUTH_GRANT_NOT_FOUND");
      }
      const outcome = await operation(structuredClone(this.grant));
      if (outcome.replacement) {
        this.grant = { ...this.grant, ...structuredClone(outcome.replacement) };
      }
      return outcome.result;
    } finally {
      release();
    }
  }
}

class FakeOAuthClient implements LarkOAuthClient {
  refreshCalls = 0;
  refreshResponse: LarkTokenResponse;
  refreshError: Error | null = null;

  constructor(refreshResponse: LarkTokenResponse) {
    this.refreshResponse = refreshResponse;
  }

  buildAuthorizationUrl(_input: AuthorizationUrlInput): URL {
    return new URL("https://accounts.larksuite.com/");
  }

  async exchangeCode(_input: ExchangeCodeInput): Promise<LarkTokenResponse> {
    return this.refreshResponse;
  }

  async refresh(_input: RefreshTokenInput): Promise<LarkTokenResponse> {
    this.refreshCalls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (this.refreshError) {
      throw this.refreshError;
    }
    return this.refreshResponse;
  }

  async getUserIdentity(_accessToken: string): Promise<LarkUserIdentity> {
    return { openId: "open-victor", tenantKey: "tenant-synvo" };
  }
}

const cipher = new TokenCipher(Buffer.alloc(32, 3));
const scopes = [...DRIVE_INVENTORY_USER_SCOPES];
const originalToken: LarkTokenResponse = {
  accessToken: "access-original",
  refreshToken: "refresh-original",
  expiresIn: 60,
  refreshTokenExpiresIn: 3_600,
  tokenType: "Bearer",
  scopes,
};
const rotatedToken: LarkTokenResponse = {
  accessToken: "access-rotated",
  refreshToken: "refresh-rotated",
  expiresIn: 7_200,
  refreshTokenExpiresIn: 86_400,
  tokenType: "Bearer",
  scopes,
};

function createBroker(
  store: MemoryGrantStore,
  client: LarkOAuthClient,
  now: Date,
): LarkTokenBroker {
  return new LarkTokenBroker({
    clientId: "cli_0123456789abcdef",
    clientSecret: "app-secret",
    cipher,
    grantStore: store,
    oauthClient: client,
    now: () => now,
  });
}

test("returns a still-valid encrypted access token without refreshing", async () => {
  const now = new Date("2026-08-07T00:00:00.000Z");
  const grant = createEncryptedOAuthGrant(cipher, {
    openId: "open-victor",
    tenantKey: "tenant-synvo",
    token: { ...originalToken, expiresIn: 7_200 },
    now,
  });
  const store = new MemoryGrantStore(grant);
  const client = new FakeOAuthClient(rotatedToken);

  assert.equal(
    await createBroker(store, client, now).getAccessToken(
      "open-victor",
      "tenant-synvo",
    ),
    "access-original",
  );
  assert.equal(client.refreshCalls, 0);
});

test("serializes concurrent refresh and atomically stores rotating tokens", async () => {
  const issuedAt = new Date("2026-08-07T00:00:00.000Z");
  const now = new Date("2026-08-07T00:10:00.000Z");
  const grant = createEncryptedOAuthGrant(cipher, {
    openId: "open-victor",
    tenantKey: "tenant-synvo",
    token: originalToken,
    now: issuedAt,
  });
  const store = new MemoryGrantStore(grant);
  const client = new FakeOAuthClient(rotatedToken);
  const broker = createBroker(store, client, now);

  const results = await Promise.all([
    broker.getAccessToken("open-victor", "tenant-synvo"),
    broker.getAccessToken("open-victor", "tenant-synvo"),
  ]);

  assert.deepEqual(results, ["access-rotated", "access-rotated"]);
  assert.equal(client.refreshCalls, 1);
  const storedGrant = store.grant;
  assert.ok(storedGrant);
  assert.equal(storedGrant.refreshVersion, 2);
  assert.equal(
    cipher.decrypt(
      storedGrant.refreshTokenCiphertext,
      grantTokenAssociatedData(
        storedGrant.tenantKey,
        storedGrant.openId,
        "refresh",
        storedGrant.refreshVersion,
      ),
    ),
    "refresh-rotated",
  );
  assert.equal(
    storedGrant.accessExpiresAt.getTime(),
    now.getTime() + rotatedToken.expiresIn * 1_000,
  );
  assert.equal(
    storedGrant.refreshExpiresAt.getTime(),
    now.getTime() + rotatedToken.refreshTokenExpiresIn * 1_000,
  );
});

test("requires reauthorization after refresh-token expiry", async () => {
  const issuedAt = new Date("2026-08-07T00:00:00.000Z");
  const now = new Date("2026-08-07T02:00:00.000Z");
  const store = new MemoryGrantStore(
    createEncryptedOAuthGrant(cipher, {
      openId: "open-victor",
      tenantKey: "tenant-synvo",
      token: originalToken,
      now: issuedAt,
    }),
  );
  const client = new FakeOAuthClient(rotatedToken);

  await assert.rejects(
    createBroker(store, client, now).getAccessToken(
      "open-victor",
      "tenant-synvo",
    ),
    (error: unknown) =>
      error instanceof LarkAuthError && error.code === "OAUTH_REVOKED",
  );
  assert.ok(store.grant?.revokedAt);
  assert.equal(client.refreshCalls, 0);
});

test("marks a provider-revoked refresh grant unusable", async () => {
  const issuedAt = new Date("2026-08-07T00:00:00.000Z");
  const now = new Date("2026-08-07T00:10:00.000Z");
  const store = new MemoryGrantStore(
    createEncryptedOAuthGrant(cipher, {
      openId: "open-victor",
      tenantKey: "tenant-synvo",
      token: originalToken,
      now: issuedAt,
    }),
  );
  const client = new FakeOAuthClient(rotatedToken);
  client.refreshError = new LarkAuthError(
    "OAUTH_REVOKED",
    "The Lark authorization is no longer usable.",
  );

  await assert.rejects(
    createBroker(store, client, now).getAccessToken(
      "open-victor",
      "tenant-synvo",
    ),
    (error: unknown) =>
      error instanceof LarkAuthError && error.code === "OAUTH_REVOKED",
  );
  assert.equal(client.refreshCalls, 1);
  assert.ok(store.grant?.revokedAt);
});

test("persists revocation from a standard OAuth invalid_grant response", async () => {
  const issuedAt = new Date("2026-08-07T00:00:00.000Z");
  const now = new Date("2026-08-07T00:10:00.000Z");
  const store = new MemoryGrantStore(
    createEncryptedOAuthGrant(cipher, {
      openId: "open-victor",
      tenantKey: "tenant-synvo",
      token: originalToken,
      now: issuedAt,
    }),
  );
  const client = new LarkOAuthHttpClient({
    fetch: async () =>
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "sensitive provider detail",
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ),
  });

  await assert.rejects(
    createBroker(store, client, now).getAccessToken(
      "open-victor",
      "tenant-synvo",
    ),
    (error: unknown) =>
      error instanceof LarkAuthError && error.code === "OAUTH_REVOKED",
  );
  assert.ok(store.grant?.revokedAt);
});

test("forces one locked refresh after a valid-looking access token is rejected", async () => {
  const now = new Date("2026-08-07T00:00:00.000Z");
  const store = new MemoryGrantStore(
    createEncryptedOAuthGrant(cipher, {
      openId: "open-victor",
      tenantKey: "tenant-synvo",
      token: { ...originalToken, expiresIn: 7_200 },
      now,
    }),
  );
  const client = new FakeOAuthClient(rotatedToken);
  const broker = createBroker(store, client, now);

  const recovered = await Promise.all([
    broker.recoverAccessToken(
      "open-victor",
      "tenant-synvo",
      "access-original",
    ),
    broker.recoverAccessToken(
      "open-victor",
      "tenant-synvo",
      "access-original",
    ),
  ]);

  assert.deepEqual(recovered, ["access-rotated", "access-rotated"]);
  assert.equal(client.refreshCalls, 1);
  assert.equal(store.grant?.refreshVersion, 2);
});

test("marks the grant revoked when a recovered access token is rejected", async () => {
  const now = new Date("2026-08-07T00:00:00.000Z");
  const store = new MemoryGrantStore(
    createEncryptedOAuthGrant(cipher, {
      openId: "open-victor",
      tenantKey: "tenant-synvo",
      token: { ...originalToken, expiresIn: 7_200 },
      now,
    }),
  );
  const broker = createBroker(store, new FakeOAuthClient(rotatedToken), now);

  await broker.markAccessTokenRejected(
    "open-victor",
    "tenant-synvo",
    "access-original",
  );

  assert.ok(store.grant?.revokedAt);
  await assert.rejects(
    broker.getAccessToken("open-victor", "tenant-synvo"),
    (error: unknown) =>
      error instanceof LarkAuthError && error.code === "OAUTH_REVOKED",
  );
});

test("rejects a grant that is missing offline access", async () => {
  const now = new Date("2026-08-07T00:00:00.000Z");
  const store = new MemoryGrantStore(
    createEncryptedOAuthGrant(cipher, {
      openId: "open-victor",
      tenantKey: "tenant-synvo",
      token: {
        ...originalToken,
        scopes: [
          "drive:drive.metadata:readonly",
          "space:document:retrieve",
        ],
        expiresIn: 7_200,
      },
      now,
    }),
  );

  await assert.rejects(
    createBroker(store, new FakeOAuthClient(rotatedToken), now).getAccessToken(
      "open-victor",
      "tenant-synvo",
    ),
    (error: unknown) =>
      error instanceof LarkAuthError && error.code === "WRONG_SCOPE",
  );
});

test("rejects stored grants with any scope outside the read-only inventory policy", async (t) => {
  const now = new Date("2026-08-07T00:00:00.000Z");
  for (const extraScope of [
    "drive:drive",
    "space:document:move",
    "drive:file:download",
  ]) {
    await t.test(extraScope, async () => {
      const grant = createEncryptedOAuthGrant(cipher, {
        openId: "open-victor",
        tenantKey: "tenant-synvo",
        token: { ...originalToken, expiresIn: 7_200 },
        now,
      });
      grant.grantedScopes = [...grant.grantedScopes, extraScope];
      const client = new FakeOAuthClient(rotatedToken);

      await assert.rejects(
        createBroker(
          new MemoryGrantStore(grant),
          client,
          now,
        ).getAccessToken("open-victor", "tenant-synvo"),
        (error: unknown) =>
          error instanceof LarkAuthError && error.code === "WRONG_SCOPE",
      );
      assert.equal(client.refreshCalls, 0);
    });
  }
});

test("rejects a refresh response with any scope outside the read-only inventory policy", async (t) => {
  const issuedAt = new Date("2026-08-07T00:00:00.000Z");
  const now = new Date("2026-08-07T00:10:00.000Z");
  for (const extraScope of [
    "drive:drive",
    "space:document:move",
    "drive:file:download",
  ]) {
    await t.test(extraScope, async () => {
      const grant = createEncryptedOAuthGrant(cipher, {
        openId: "open-victor",
        tenantKey: "tenant-synvo",
        token: originalToken,
        now: issuedAt,
      });
      const store = new MemoryGrantStore(grant);
      const client = new FakeOAuthClient({
        ...rotatedToken,
        scopes: [...DRIVE_INVENTORY_USER_SCOPES, extraScope],
      });

      await assert.rejects(
        createBroker(store, client, now).getAccessToken(
          "open-victor",
          "tenant-synvo",
        ),
        (error: unknown) =>
          error instanceof LarkAuthError && error.code === "WRONG_SCOPE",
      );
      assert.equal(client.refreshCalls, 1);
      assert.equal(store.grant?.refreshVersion, 1);
      assert.deepEqual(store.grant?.grantedScopes, scopes);
    });
  }
});
