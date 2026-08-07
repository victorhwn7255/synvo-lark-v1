import { randomUUID } from "node:crypto";

import type { OAuthGrantStore } from "@synvo/lark-auth";
import {
  createEncryptedOAuthGrant,
  hasExactScopes,
  LarkAuthError,
  type LarkOAuthClient,
  oauthSessionAssociatedData,
  PHASE_2_USER_SCOPES,
  type TokenCipher,
} from "@synvo/lark-auth";

import type { Phase2Repository } from "../repositories/phase2.js";
import { encryptDeliveryMessage } from "../delivery/crypto.js";
import { createPkce, digestOpaqueValue, randomOpaqueValue } from "./pkce.js";

const sessionLifetimeMs = 10 * 60 * 1_000;

function canonicalScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes)].sort();
}

function assertExpectedSessionPolicy(
  session: { redirectUri: string; requestedScopes: readonly string[] },
  redirectUri: string,
): void {
  const expectedScopes = canonicalScopes(PHASE_2_USER_SCOPES);
  const actualScopes = canonicalScopes(session.requestedScopes);
  const hasExpectedScopes =
    session.requestedScopes.length === actualScopes.length &&
    actualScopes.length === expectedScopes.length &&
    actualScopes.every((scope, index) => scope === expectedScopes[index]);

  if (session.redirectUri !== redirectUri || !hasExpectedScopes) {
    throw new LarkAuthError(
      "OAUTH_REJECTED",
      "The authorization session does not match the expected OAuth policy.",
    );
  }
}

export type OAuthServiceOptions = {
  appId: string;
  appSecret: string;
  redirectUri: string;
  cipher: TokenCipher;
  oauthClient: LarkOAuthClient;
  grantStore: OAuthGrantStore;
  repository: Phase2Repository;
  authorizedOpenId?: string;
  authorizedTenantKey?: string;
  now?: () => Date;
};

export type PendingAuthorizationInput = {
  messageId: string;
  chatId: string;
  requesterOpenId: string;
  tenantKey: string;
  rootTokenDigest: string;
};

export type PendingAuthorization = {
  runId: string;
  startUrl: URL;
};

export type CompletedAuthorization = {
  runId: string;
  chatId: string;
  requesterOpenId: string;
  tenantKey: string;
};

function authorizationRequiredMessage(startUrl: URL): string {
  return [
    "Read-only Lark Drive authorization is required.",
    "",
    `Authorize this request: ${startUrl.toString()}`,
    "",
    "The link expires in 10 minutes. The assistant requests folder-list access, read-only file and folder metadata, and offline refresh access.",
    "No files will be opened, downloaded, or changed.",
  ].join("\n");
}

export class LarkOAuthService {
  readonly #appId: string;
  readonly #appSecret: string;
  readonly #redirectUri: string;
  readonly #cipher: TokenCipher;
  readonly #oauthClient: LarkOAuthClient;
  readonly #grantStore: OAuthGrantStore;
  readonly #repository: Phase2Repository;
  readonly #authorizedOpenId?: string;
  readonly #authorizedTenantKey?: string;
  readonly #now: () => Date;

  constructor(options: OAuthServiceOptions) {
    this.#appId = options.appId;
    this.#appSecret = options.appSecret;
    this.#redirectUri = options.redirectUri;
    this.#cipher = options.cipher;
    this.#oauthClient = options.oauthClient;
    this.#grantStore = options.grantStore;
    this.#repository = options.repository;
    this.#authorizedOpenId = options.authorizedOpenId;
    this.#authorizedTenantKey = options.authorizedTenantKey;
    this.#now = options.now ?? (() => new Date());
  }

  async createPendingAuthorization(
    input: PendingAuthorizationInput,
  ): Promise<PendingAuthorization | null> {
    const now = this.#now();
    const runId = randomUUID();
    const sessionId = randomUUID();
    const requestToken = randomOpaqueValue();
    const requestTokenDigest = digestOpaqueValue(requestToken);
    const startUrl = new URL("/oauth/lark/start", this.#redirectUri);
    startUrl.searchParams.set("request", requestToken);
    const deliveryJobId = randomUUID();
    const created = await this.#repository.createAwaitingOAuthRun({
      runId,
      sessionId,
      messageId: input.messageId,
      chatId: input.chatId,
      requesterOpenId: input.requesterOpenId,
      tenantKey: input.tenantKey,
      rootTokenDigest: input.rootTokenDigest,
      requestTokenDigest,
      redirectUri: this.#redirectUri,
      requestedScopes: [...PHASE_2_USER_SCOPES],
      expiresAt: new Date(now.getTime() + sessionLifetimeMs),
      deliveryJobId,
      authorizationMessageCiphertext: encryptDeliveryMessage(
        this.#cipher,
        deliveryJobId,
        authorizationRequiredMessage(startUrl),
      ),
    });
    if (!created) {
      return null;
    }
    return { runId, startUrl };
  }

  async beginAuthorization(requestToken: string): Promise<URL> {
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(requestToken)) {
      throw new LarkAuthError(
        "OAUTH_REJECTED",
        "The authorization request is invalid or expired.",
      );
    }
    const requestTokenDigest = digestOpaqueValue(requestToken);
    const state = randomOpaqueValue();
    const stateDigest = digestOpaqueValue(state);
    const { verifier, challenge } = createPkce();
    const codeVerifierCiphertext = this.#cipher.encrypt(
      verifier,
      oauthSessionAssociatedData({
        appId: this.#appId,
        requestTokenDigest,
        redirectUri: this.#redirectUri,
        scopes: PHASE_2_USER_SCOPES,
      }),
    );
    const session = await this.#repository.startOAuthSession({
      requestTokenDigest,
      stateDigest,
      codeVerifierCiphertext,
      now: this.#now(),
    });
    if (!session) {
      throw new LarkAuthError(
        "OAUTH_REJECTED",
        "The authorization request is invalid or expired.",
      );
    }
    assertExpectedSessionPolicy(session, this.#redirectUri);

    return this.#oauthClient.buildAuthorizationUrl({
      clientId: this.#appId,
      redirectUri: this.#redirectUri,
      scopes: PHASE_2_USER_SCOPES,
      state,
      codeChallenge: challenge,
    });
  }

  async completeAuthorization(input: {
    state: string | undefined;
    code: string | undefined;
    providerError?: string;
  }): Promise<CompletedAuthorization> {
    if (!input.state || !/^[A-Za-z0-9_-]{32,256}$/.test(input.state)) {
      throw new LarkAuthError(
        "OAUTH_REJECTED",
        "The authorization state is invalid or expired.",
      );
    }
    const session = await this.#repository.consumeOAuthSession(
      digestOpaqueValue(input.state),
      this.#now(),
    );
    if (!session) {
      throw new LarkAuthError(
        "OAUTH_REJECTED",
        "The authorization state is invalid, expired, or already used.",
      );
    }

    try {
      assertExpectedSessionPolicy(session, this.#redirectUri);
      if (input.providerError || !input.code) {
        throw new LarkAuthError(
          "OAUTH_REJECTED",
          "Lark authorization was not completed.",
        );
      }
      const verifier = this.#cipher.decrypt(
        session.codeVerifierCiphertext,
        oauthSessionAssociatedData({
          appId: this.#appId,
          requestTokenDigest: session.requestTokenDigest,
          redirectUri: this.#redirectUri,
          scopes: PHASE_2_USER_SCOPES,
        }),
      );
      const token = await this.#oauthClient.exchangeCode({
        clientId: this.#appId,
        clientSecret: this.#appSecret,
        redirectUri: this.#redirectUri,
        scopes: PHASE_2_USER_SCOPES,
        code: input.code,
        codeVerifier: verifier,
      });
      if (!hasExactScopes(token.scopes, PHASE_2_USER_SCOPES)) {
        throw new LarkAuthError(
          "WRONG_SCOPE",
          "The Lark authorization scope set does not match the Phase 2 read-only policy.",
        );
      }

      const identity = await this.#oauthClient.getUserIdentity(token.accessToken);
      if (identity.openId !== session.requesterOpenId) {
        throw new LarkAuthError(
          "WRONG_USER",
          "The Lark account does not match the bot requester.",
        );
      }
      if (identity.tenantKey !== session.tenantKey) {
        throw new LarkAuthError(
          "WRONG_TENANT",
          "The Lark account does not belong to the requesting tenant.",
        );
      }
      if (
        this.#authorizedOpenId &&
        identity.openId !== this.#authorizedOpenId
      ) {
        throw new LarkAuthError(
          "WRONG_USER",
          "This Lark account is not authorized for the pilot.",
        );
      }
      if (
        this.#authorizedTenantKey &&
        identity.tenantKey !== this.#authorizedTenantKey
      ) {
        throw new LarkAuthError(
          "WRONG_TENANT",
          "This Lark tenant is not authorized for the pilot.",
        );
      }

      const grant = await this.#grantStore.save(
        createEncryptedOAuthGrant(this.#cipher, {
          openId: identity.openId,
          tenantKey: identity.tenantKey,
          token,
          now: this.#now(),
        }),
      );
      await this.#repository.bindGrantToRun(
        session.runId,
        grant.id,
        randomUUID(),
      );
      return {
        runId: session.runId,
        chatId: session.chatId,
        requesterOpenId: session.requesterOpenId,
        tenantKey: session.tenantKey,
      };
    } catch (error) {
      const errorCode =
        error instanceof LarkAuthError ? error.code : "OAUTH_REJECTED";
      await this.#repository.markRunFailed(session.runId, errorCode);
      if (error instanceof LarkAuthError) {
        throw error;
      }
      throw new LarkAuthError(
        "OAUTH_REJECTED",
        "The Lark authorization session could not be completed.",
      );
    }
  }
}
