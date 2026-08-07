import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createPhase2HttpHandler } from "./server.js";

async function withServer(
  handler: ReturnType<typeof createPhase2HttpHandler>,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("reports read-only Phase 2 health", async () => {
  const handler = createPhase2HttpHandler({
    oauthService: {
      async beginAuthorization() {
        throw new Error("unused");
      },
      async completeAuthorization() {
        throw new Error("unused");
      },
    },
    healthCheck: async () => true,
  });

  await withServer(handler, async (origin) => {
    const response = await fetch(`${origin}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ok",
      phase: 2,
      drive_mode: "read_only",
    });
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /form-action 'self'/);
    assert.doesNotMatch(csp, /accounts\.larksuite\.com/);
  });
});

test("requires an explicit browser confirmation before starting OAuth", async () => {
  let beginCalls = 0;
  const handler = createPhase2HttpHandler({
    oauthService: {
      async beginAuthorization(requestToken) {
        beginCalls += 1;
        assert.equal(requestToken, "x".repeat(43));
        return new URL(
          "https://accounts.larksuite.com/open-apis/authen/v1/authorize?state=opaque",
        );
      },
      async completeAuthorization() {
        throw new Error("unused");
      },
    },
    healthCheck: async () => true,
  });

  await withServer(handler, async (origin) => {
    const startUrl = `${origin}/oauth/lark/start?request=${"x".repeat(43)}`;
    const confirmation = await fetch(startUrl);
    assert.equal(confirmation.status, 200);
    assert.match(await confirmation.text(), /Continue with Lark/);
    assert.match(
      confirmation.headers.get("content-security-policy") ?? "",
      /form-action 'self' https:\/\/accounts\.larksuite\.com/,
    );
    assert.equal(beginCalls, 0);

    const response = await fetch(startUrl, { redirect: "manual" });
    assert.equal(response.status, 200);
    assert.equal(beginCalls, 0);

    const redirect = await fetch(startUrl, {
      method: "POST",
      redirect: "manual",
    });
    assert.equal(redirect.status, 303);
    assert.equal(beginCalls, 1);
    assert.match(
      redirect.headers.get("location") ?? "",
      /^https:\/\/accounts\.larksuite\.com\//,
    );
    assert.equal(redirect.headers.get("cache-control"), "no-store");
    assert.match(
      redirect.headers.get("content-security-policy") ?? "",
      /form-action 'self' https:\/\/accounts\.larksuite\.com/,
    );
  });
});

test("accepts the exact callback after atomically queueing the scan", async () => {
  let completed = false;
  const authorization = {
    runId: "4d872758-1f71-4ed8-b141-a2d193ceea91",
    chatId: "oc_chat",
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
  };
  const handler = createPhase2HttpHandler({
    oauthService: {
      async beginAuthorization() {
        throw new Error("unused");
      },
      async completeAuthorization(input) {
        assert.deepEqual(input, {
          state: "opaque-state",
          code: "one-time-code",
          providerError: undefined,
        });
        completed = true;
        return authorization;
      },
    },
    healthCheck: async () => true,
  });

  await withServer(handler, async (origin) => {
    const response = await fetch(
      `${origin}/oauth/lark/callback?state=opaque-state&code=one-time-code`,
    );
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Return to Lark/);
    assert.equal(completed, true);
  });
});

test("does not expose callback query values in a failure page", async () => {
  const handler = createPhase2HttpHandler({
    oauthService: {
      async beginAuthorization() {
        throw new Error("unused");
      },
      async completeAuthorization() {
        throw new Error("provider included secret-code");
      },
    },
    healthCheck: async () => true,
  });

  await withServer(handler, async (origin) => {
    const response = await fetch(
      `${origin}/oauth/lark/callback?state=secret-state&code=secret-code`,
    );
    const body = await response.text();
    assert.equal(response.status, 500);
    assert.equal(body.includes("secret-state"), false);
    assert.equal(body.includes("secret-code"), false);
  });
});
