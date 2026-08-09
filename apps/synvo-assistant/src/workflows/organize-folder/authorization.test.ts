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
} from "../../lark/auth/index.js";
import {
  LarkAuthError,
  LarkOAuthHttpClient,
  ORGANIZE_FOLDER_USER_SCOPES,
  TokenCipher,
} from "../../lark/auth/index.js";

import type {
  OAuthSession,
  OrganizeFolderRun,
  OrganizeFolderRepository,
} from "./repository.js";
import { LarkOAuthService } from "./authorization.js";

class MemoryGrantStore implements OAuthGrantStore {
  grant: StoredOAuthGrant | null = null;

  async findBySubject(): Promise<StoredOAuthGrant | null> {
    return this.grant;
  }

  async save(input: SaveOAuthGrantInput): Promise<StoredOAuthGrant> {
    this.grant = input;
    return input;
  }

  async withLockedGrant<T>(
    _openId: string,
    _tenantKey: string,
    operation: (grant: StoredOAuthGrant) => Promise<LockedGrantResult<T>>,
  ): Promise<T> {
    if (!this.grant) {
      throw new Error("No grant");
    }
    return (await operation(this.grant)).result;
  }
}

class MemoryOrganizeFolderRepository implements OrganizeFolderRepository {
  session: (OAuthSession & {
    requestTokenDigest: string;
    stateDigest?: string;
    consumed?: boolean;
  }) | null = null;
  failedCode: string | null = null;
  boundGrantId: string | null = null;

  async findRunByMessageId(): Promise<OrganizeFolderRun | null> {
    return null;
  }

  async findInventoryRunById() { return null; }

  async createReadyRun(): Promise<boolean> {
    return true;
  }

  async createAwaitingOAuthRun(input: {
    runId: string;
    sessionId: string;
    chatId: string;
    requesterOpenId: string;
    tenantKey: string;
    requestTokenDigest: string;
    redirectUri: string;
    requestedScopes: string[];
    expiresAt: Date;
  }): Promise<boolean> {
    this.session = {
      id: input.sessionId,
      runId: input.runId,
      requestTokenDigest: input.requestTokenDigest,
      requesterOpenId: input.requesterOpenId,
      tenantKey: input.tenantKey,
      chatId: input.chatId,
      redirectUri: input.redirectUri,
      requestedScopes: input.requestedScopes,
      codeVerifierCiphertext: "",
      expiresAt: input.expiresAt,
    };
    return true;
  }

  async startOAuthSession(input: {
    requestTokenDigest: string;
    stateDigest: string;
    codeVerifierCiphertext: string;
    now: Date;
  }): Promise<OAuthSession | null> {
    if (
      !this.session ||
      this.session.requestTokenDigest !== input.requestTokenDigest ||
      this.session.stateDigest ||
      this.session.expiresAt <= input.now
    ) {
      return null;
    }
    this.session.stateDigest = input.stateDigest;
    this.session.codeVerifierCiphertext = input.codeVerifierCiphertext;
    return structuredClone(this.session);
  }

  async consumeOAuthSession(
    stateDigest: string,
    now: Date,
  ): Promise<OAuthSession | null> {
    if (
      !this.session ||
      this.session.stateDigest !== stateDigest ||
      this.session.consumed ||
      this.session.expiresAt <= now
    ) {
      return null;
    }
    this.session.consumed = true;
    return structuredClone(this.session);
  }

  async bindGrantToRun(_runId: string, grantId: string): Promise<void> {
    this.boundGrantId = grantId;
  }

  async markRunFailed(_runId: string, errorCode: string): Promise<void> {
    this.failedCode = errorCode;
  }

  async storeInventoryResult(): Promise<boolean> { return true; }
  async recordProposalDecision() { return { kind: "not_found" } as const; }
  async markProposalStale(): Promise<boolean> { return false; }
  async startExecution(): Promise<boolean> { return false; }
  async storeExecution(): Promise<boolean> { return false; }
  async requestUndo() { return { kind: "not_found" } as const; }
  async startUndo(): Promise<boolean> { return false; }
  async storeUndo(): Promise<boolean> { return false; }
}

class FakeOAuthClient implements LarkOAuthClient {
  identity: LarkUserIdentity = {
    openId: "ou_victor",
    tenantKey: "tenant_synvo",
  };
  token: LarkTokenResponse = {
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresIn: 7_200,
    refreshTokenExpiresIn: 86_400,
    tokenType: "Bearer",
    scopes: [...ORGANIZE_FOLDER_USER_SCOPES],
  };
  exchangedVerifier = "";
  readonly #urlBuilder = new LarkOAuthHttpClient();

  buildAuthorizationUrl(input: AuthorizationUrlInput): URL {
    return this.#urlBuilder.buildAuthorizationUrl(input);
  }

  async exchangeCode(input: ExchangeCodeInput): Promise<LarkTokenResponse> {
    this.exchangedVerifier = input.codeVerifier;
    return this.token;
  }

  async refresh(_input: RefreshTokenInput): Promise<LarkTokenResponse> {
    return this.token;
  }

  async getUserIdentity(): Promise<LarkUserIdentity> {
    return this.identity;
  }
}

function createFixture(options: {
  authorizedOpenId?: string;
  authorizedTenantKey?: string;
} = {}) {
  const repository = new MemoryOrganizeFolderRepository();
  const grantStore = new MemoryGrantStore();
  const oauthClient = new FakeOAuthClient();
  const service = new LarkOAuthService({
    appId: "cli_0123456789abcdef",
    appSecret: "app-secret",
    redirectUri: "http://localhost:3000/oauth/lark/callback",
    cipher: new TokenCipher(Buffer.alloc(32, 9)),
    oauthClient,
    grantStore,
    repository,
    authorizedOpenId: options.authorizedOpenId ?? "ou_victor",
    authorizedTenantKey: options.authorizedTenantKey ?? "tenant_synvo",
    now: () => new Date("2026-08-07T00:00:00.000Z"),
  });
  return { repository, grantStore, oauthClient, service };
}

async function startAuthorization(fixture: ReturnType<typeof createFixture>) {
  const pending = await fixture.service.createPendingAuthorization({
    messageId: "om_message",
    chatId: "oc_chat",
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
    rootTokenDigest: "root-digest",
  });
  assert.ok(pending);
  const requestToken = pending.startUrl.searchParams.get("request");
  assert.ok(requestToken);
  const authorizationUrl = await fixture.service.beginAuthorization(requestToken);
  const state = authorizationUrl.searchParams.get("state");
  assert.ok(state);
  return { pending, authorizationUrl, state };
}

test("binds a single-use PKCE OAuth grant to the initiating actor and tenant", async () => {
  const fixture = createFixture();
  const { pending, authorizationUrl, state } = await startAuthorization(fixture);

  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  const completed = await fixture.service.completeAuthorization({
    state,
    code: "one-time-code",
  });

  assert.equal(completed.runId, pending.runId);
  assert.equal(completed.requesterOpenId, "ou_victor");
  assert.ok(fixture.oauthClient.exchangedVerifier.length >= 43);
  assert.equal(fixture.repository.boundGrantId, fixture.grantStore.grant?.id);
  const serializedGrant = JSON.stringify(fixture.grantStore.grant);
  assert.equal(serializedGrant.includes("access-secret"), false);
  assert.equal(serializedGrant.includes("refresh-secret"), false);
});

test("rejects state mismatch and callback replay", async () => {
  const fixture = createFixture();
  const { state } = await startAuthorization(fixture);

  await assert.rejects(
    fixture.service.completeAuthorization({ state: "x".repeat(43), code: "code" }),
    (error: unknown) =>
      error instanceof LarkAuthError && error.code === "OAUTH_REJECTED",
  );
  await fixture.service.completeAuthorization({ state, code: "code" });
  await assert.rejects(
    fixture.service.completeAuthorization({ state, code: "code" }),
    (error: unknown) =>
      error instanceof LarkAuthError && error.code === "OAUTH_REJECTED",
  );
});

test("rejects expired OAuth start and callback sessions", async () => {
  const expiredStart = createFixture();
  const pending = await expiredStart.service.createPendingAuthorization({
    messageId: "om_expired_start",
    chatId: "oc_chat",
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
    rootTokenDigest: "root-digest",
  });
  assert.ok(pending);
  assert.ok(expiredStart.repository.session);
  expiredStart.repository.session.expiresAt = new Date(
    "2026-08-07T00:00:00.000Z",
  );
  const requestToken = pending.startUrl.searchParams.get("request");
  assert.ok(requestToken);
  await assert.rejects(
    expiredStart.service.beginAuthorization(requestToken),
    (error: unknown) =>
      error instanceof LarkAuthError && error.code === "OAUTH_REJECTED",
  );

  const expiredCallback = createFixture();
  const { state } = await startAuthorization(expiredCallback);
  assert.ok(expiredCallback.repository.session);
  expiredCallback.repository.session.expiresAt = new Date(
    "2026-08-07T00:00:00.000Z",
  );
  await assert.rejects(
    expiredCallback.service.completeAuthorization({ state, code: "code" }),
    (error: unknown) =>
      error instanceof LarkAuthError && error.code === "OAUTH_REJECTED",
  );
});

test("rejects a persisted redirect mismatch before building authorization", async () => {
  const fixture = createFixture();
  const pending = await fixture.service.createPendingAuthorization({
    messageId: "om_message",
    chatId: "oc_chat",
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
    rootTokenDigest: "root-digest",
  });
  assert.ok(pending);
  assert.ok(fixture.repository.session);
  fixture.repository.session.redirectUri = "https://attacker.example/callback";
  const requestToken = pending.startUrl.searchParams.get("request");
  assert.ok(requestToken);

  await assert.rejects(
    fixture.service.beginAuthorization(requestToken),
    (error: unknown) =>
      error instanceof LarkAuthError && error.code === "OAUTH_REJECTED",
  );
});

test("rejects a persisted scope mismatch before exchanging the code", async () => {
  const fixture = createFixture();
  const { state } = await startAuthorization(fixture);
  assert.ok(fixture.repository.session);
  fixture.repository.session.requestedScopes.push("drive:drive:readonly");

  await assert.rejects(
    fixture.service.completeAuthorization({ state, code: "code" }),
    (error: unknown) =>
      error instanceof LarkAuthError && error.code === "OAUTH_REJECTED",
  );
  assert.equal(fixture.oauthClient.exchangedVerifier, "");
  assert.equal(fixture.repository.failedCode, "OAUTH_REJECTED");
});

test("rejects a different user completing OAuth", async () => {
  const fixture = createFixture();
  const { state } = await startAuthorization(fixture);
  fixture.oauthClient.identity = {
    openId: "ou_someone_else",
    tenantKey: "tenant_synvo",
  };

  await assert.rejects(
    fixture.service.completeAuthorization({ state, code: "code" }),
    (error: unknown) =>
      error instanceof LarkAuthError && error.code === "WRONG_USER",
  );
  assert.equal(fixture.repository.failedCode, "WRONG_USER");
});

test("rejects a different tenant completing OAuth", async () => {
  const fixture = createFixture();
  const { state } = await startAuthorization(fixture);
  fixture.oauthClient.identity = {
    openId: "ou_victor",
    tenantKey: "tenant_other",
  };

  await assert.rejects(
    fixture.service.completeAuthorization({ state, code: "code" }),
    (error: unknown) =>
      error instanceof LarkAuthError && error.code === "WRONG_TENANT",
  );
});

test("rejects an actor outside the static pilot allowlist after requester binding", async () => {
  const fixture = createFixture({ authorizedOpenId: "ou_other_pilot" });
  const { state } = await startAuthorization(fixture);

  await assert.rejects(
    fixture.service.completeAuthorization({ state, code: "code" }),
    (error: unknown) =>
      error instanceof LarkAuthError && error.code === "WRONG_USER",
  );
  assert.equal(fixture.grantStore.grant, null);
  assert.equal(fixture.repository.failedCode, "WRONG_USER");
});

test("rejects a tenant outside the static pilot allowlist after requester binding", async () => {
  const fixture = createFixture({ authorizedTenantKey: "tenant_other_pilot" });
  const { state } = await startAuthorization(fixture);

  await assert.rejects(
    fixture.service.completeAuthorization({ state, code: "code" }),
    (error: unknown) =>
      error instanceof LarkAuthError && error.code === "WRONG_TENANT",
  );
  assert.equal(fixture.grantStore.grant, null);
  assert.equal(fixture.repository.failedCode, "WRONG_TENANT");
});

test("rejects PKCE session ciphertext tampering", async () => {
  const fixture = createFixture();
  const { state } = await startAuthorization(fixture);
  assert.ok(fixture.repository.session);
  fixture.repository.session.codeVerifierCiphertext += "tampered";

  await assert.rejects(
    fixture.service.completeAuthorization({ state, code: "code" }),
    (error: unknown) =>
      error instanceof LarkAuthError && error.code === "OAUTH_REJECTED",
  );
  assert.equal(fixture.repository.failedCode, "OAUTH_REJECTED");
});

test("rejects moving PKCE ciphertext to another session identity", async () => {
  const fixture = createFixture();
  const { state } = await startAuthorization(fixture);
  assert.ok(fixture.repository.session);
  fixture.repository.session.requestTokenDigest = "another-request-digest";

  await assert.rejects(
    fixture.service.completeAuthorization({ state, code: "code" }),
    (error: unknown) =>
      error instanceof LarkAuthError && error.code === "OAUTH_REJECTED",
  );
  assert.equal(fixture.oauthClient.exchangedVerifier, "");
});

test("rejects a grant missing offline access", async () => {
  const fixture = createFixture();
  const { state } = await startAuthorization(fixture);
  fixture.oauthClient.token = {
    ...fixture.oauthClient.token,
    scopes: [
      "drive:drive.metadata:readonly",
      "space:document:retrieve",
    ],
  };

  await assert.rejects(
    fixture.service.completeAuthorization({ state, code: "code" }),
    (error: unknown) =>
      error instanceof LarkAuthError && error.code === "WRONG_SCOPE",
  );
});

test("rejects callback tokens with any scope outside the Phase 5 policy", async (t) => {
  for (const extraScope of [
    "drive:drive",
    "docx:document",
    "drive:file:download",
  ]) {
    await t.test(extraScope, async () => {
      const fixture = createFixture();
      const { state } = await startAuthorization(fixture);
      fixture.oauthClient.token = {
        ...fixture.oauthClient.token,
        scopes: [...ORGANIZE_FOLDER_USER_SCOPES, extraScope],
      };

      await assert.rejects(
        fixture.service.completeAuthorization({ state, code: "code" }),
        (error: unknown) =>
          error instanceof LarkAuthError && error.code === "WRONG_SCOPE",
      );
      assert.equal(fixture.grantStore.grant, null);
      assert.equal(fixture.repository.failedCode, "WRONG_SCOPE");
    });
  }
});
