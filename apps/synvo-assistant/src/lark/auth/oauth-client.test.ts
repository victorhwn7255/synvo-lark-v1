import assert from "node:assert/strict";
import test from "node:test";

import {
  hasExactScopes,
  LarkAuthError,
  LarkOAuthHttpClient,
  LARK_OAUTH_TOKEN_URL,
  LARK_USER_INFO_URL,
  ORGANIZE_FOLDER_USER_SCOPES,
} from "./index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("builds a PKCE S256 authorization URL with the exact Drive PDF scopes", () => {
  const client = new LarkOAuthHttpClient();
  const url = client.buildAuthorizationUrl({
    clientId: "cli_0123456789abcdef",
    redirectUri: "http://localhost:3000/oauth/lark/callback",
    scopes: ORGANIZE_FOLDER_USER_SCOPES,
    state: "state-value",
    codeChallenge: "challenge-value",
  });

  assert.equal(url.hostname, "accounts.larksuite.com");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("state"), "state-value");
  assert.equal(
    url.searchParams.get("scope"),
    "drive:drive.metadata:readonly drive:file:download offline_access space:document:move space:document:retrieve",
  );
});

test("exchanges a code through Lark's documented browser OAuth endpoint", async () => {
  let observedUrl = "";
  let observedRedirect: RequestRedirect | undefined;
  let observedBody: Record<string, unknown> = {};
  const fakeFetch: typeof fetch = async (input, init) => {
    observedUrl = String(input);
    observedRedirect = init?.redirect;
    observedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({
      code: "0",
      access_token: "access-value",
      refresh_token: "refresh-value",
      expires_in: 7200,
      refresh_token_expires_in: 2_592_000,
      token_type: "Bearer",
      scope:
        "space:document:retrieve space:document:move drive:drive.metadata:readonly drive:file:download offline_access",
    });
  };
  const client = new LarkOAuthHttpClient({ fetch: fakeFetch });

  const token = await client.exchangeCode({
    clientId: "cli_0123456789abcdef",
    clientSecret: "app-secret",
    redirectUri: "http://localhost:3000/oauth/lark/callback",
    scopes: ORGANIZE_FOLDER_USER_SCOPES,
    code: "one-time-code",
    codeVerifier: "v".repeat(43),
  });

  assert.equal(observedUrl, LARK_OAUTH_TOKEN_URL);
  assert.equal(observedRedirect, "error");
  assert.equal(observedBody.grant_type, "authorization_code");
  assert.equal(observedBody.code_verifier, "v".repeat(43));
  assert.equal(observedBody.redirect_uri, "http://localhost:3000/oauth/lark/callback");
  assert.deepEqual(token.scopes, [
    "drive:drive.metadata:readonly",
    "drive:file:download",
    "offline_access",
    "space:document:move",
    "space:document:retrieve",
  ]);
});

test("gets the Lark user identity with a Bearer token", async () => {
  let observedUrl = "";
  let observedInit: RequestInit | undefined;
  const client = new LarkOAuthHttpClient({
    fetch: async (input, init) => {
      observedUrl = String(input);
      observedInit = init;
      return jsonResponse({
        code: 0,
        data: {
          open_id: "open-victor",
          tenant_key: "tenant-synvo",
        },
      });
    },
  });

  assert.deepEqual(await client.getUserIdentity("access-value"), {
    openId: "open-victor",
    tenantKey: "tenant-synvo",
  });
  assert.equal(observedUrl, LARK_USER_INFO_URL);
  assert.equal(observedInit?.method, "GET");
  assert.equal(observedInit?.redirect, "error");
  assert.equal(
    new Headers(observedInit?.headers).get("Authorization"),
    "Bearer access-value",
  );
  assert.equal(new Headers(observedInit?.headers).get("Accept"), "application/json");
});

test("rejects a malformed Lark user identity", async () => {
  const client = new LarkOAuthHttpClient({
    fetch: async () =>
      jsonResponse({
        code: 0,
        data: {
          open_id: "open-victor",
        },
      }),
  });

  await assert.rejects(
    client.getUserIdentity("access-value"),
    (error: unknown) =>
      error instanceof LarkAuthError && error.code === "OAUTH_MALFORMED",
  );
});

test("normalizes a rejected user-info request without exposing provider text", async () => {
  const client = new LarkOAuthHttpClient({
    fetch: async () =>
      jsonResponse(
        {
          code: 99_991_663,
          msg: "sensitive provider detail",
        },
        403,
      ),
  });

  await assert.rejects(
    client.getUserIdentity("access-value"),
    (error: unknown) => {
      assert.equal(error instanceof LarkAuthError, true);
      assert.equal((error as LarkAuthError).code, "OAUTH_REJECTED");
      assert.equal((error as LarkAuthError).providerCode, "99991663");
      assert.equal(
        error instanceof Error && error.message.includes("sensitive"),
        false,
      );
      return true;
    },
  );
});

test("normalizes a revoked refresh token without exposing provider text", async () => {
  const client = new LarkOAuthHttpClient({
    fetch: async () =>
      jsonResponse(
        {
          code: 20064,
          error_description: "sensitive provider detail",
        },
        400,
      ),
  });

  await assert.rejects(
    client.refresh({
      clientId: "cli_0123456789abcdef",
      clientSecret: "app-secret",
      scopes: ORGANIZE_FOLDER_USER_SCOPES,
      refreshToken: "refresh-value",
    }),
    (error: unknown) => {
      assert.equal(error instanceof LarkAuthError, true);
      assert.equal((error as LarkAuthError).code, "OAUTH_REVOKED");
      assert.equal(error instanceof Error && error.message.includes("sensitive"), false);
      return true;
    },
  );
});

test("treats the standard OAuth invalid_grant HTTP response as revoked", async () => {
  const client = new LarkOAuthHttpClient({
    fetch: async () =>
      jsonResponse(
        {
          error: "invalid_grant",
          error_description: "refresh token was revoked",
        },
        400,
      ),
  });

  await assert.rejects(
    client.refresh({
      clientId: "cli_0123456789abcdef",
      clientSecret: "app-secret",
      scopes: ORGANIZE_FOLDER_USER_SCOPES,
      refreshToken: "refresh-value",
    }),
    (error: unknown) =>
      error instanceof LarkAuthError &&
      error.code === "OAUTH_REVOKED" &&
      error.providerCode === "invalid_grant" &&
      !error.message.includes("refresh token"),
  );
});

test("accepts only the exact Drive PDF scope set", () => {
  assert.equal(
    hasExactScopes(ORGANIZE_FOLDER_USER_SCOPES),
    true,
  );
  assert.equal(
    hasExactScopes(["offline_access", "space:document:retrieve"]),
    false,
  );
  for (const extraScope of [
    "drive:drive",
    "docx:document",
    "space:document:delete",
  ]) {
    assert.equal(
      hasExactScopes([...ORGANIZE_FOLDER_USER_SCOPES, extraScope]),
      false,
    );
  }
});

test("rejects non-Bearer token responses for exchange and refresh", async () => {
  const client = new LarkOAuthHttpClient({
    fetch: async () =>
      jsonResponse({
        code: 0,
        access_token: "access-value",
        refresh_token: "refresh-value",
        expires_in: 7_200,
        refresh_token_expires_in: 2_592_000,
        token_type: "MAC",
        scope: ORGANIZE_FOLDER_USER_SCOPES.join(" "),
      }),
  });
  const isMalformedTokenType = (error: unknown) =>
    error instanceof LarkAuthError && error.code === "OAUTH_MALFORMED";

  await assert.rejects(
    client.exchangeCode({
      clientId: "cli_0123456789abcdef",
      clientSecret: "app-secret",
      redirectUri: "http://localhost:3000/oauth/lark/callback",
      scopes: ORGANIZE_FOLDER_USER_SCOPES,
      code: "one-time-code",
      codeVerifier: "v".repeat(64),
    }),
    isMalformedTokenType,
  );
  await assert.rejects(
    client.refresh({
      clientId: "cli_0123456789abcdef",
      clientSecret: "app-secret",
      scopes: ORGANIZE_FOLDER_USER_SCOPES,
      refreshToken: "refresh-value",
    }),
    isMalformedTokenType,
  );
});

test("keeps non-JSON rate limits and server failures retryable", async (t) => {
  for (const status of [429, 503]) {
    await t.test(String(status), async () => {
      const client = new LarkOAuthHttpClient({
        fetch: async () =>
          new Response("sensitive upstream failure", {
            status,
            headers: { "Content-Type": "text/plain" },
          }),
      });

      await assert.rejects(
        client.refresh({
          clientId: "cli_0123456789abcdef",
          clientSecret: "app-secret",
          scopes: ORGANIZE_FOLDER_USER_SCOPES,
          refreshToken: "refresh-value",
        }),
        (error: unknown) => {
          assert.equal(error instanceof LarkAuthError, true);
          assert.equal((error as LarkAuthError).code, "OAUTH_RETRYABLE");
          assert.equal(
            error instanceof Error && error.message.includes("sensitive"),
            false,
          );
          return true;
        },
      );
    });
  }
});
