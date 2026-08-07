import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createAssistantHttpHandler } from "./server.js";

async function withServer(
  handler: ReturnType<typeof createAssistantHttpHandler>,
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

test("reports read-only inventory health", async () => {
  const handler = createAssistantHttpHandler({
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
      authorization_mode: "read_only_inventory",
      drive_mode: "read_only",
    });
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /form-action 'self'/);
    assert.doesNotMatch(csp, /accounts\.larksuite\.com/);
  });
});

test("reports the Drive move spike as read-only preflight and explains separate move confirmation", async () => {
  const handler = createAssistantHttpHandler({
    authorizationMode: "drive_move_spike",
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
    const health = await fetch(`${origin}/health`);
    assert.deepEqual(await health.json(), {
      status: "ok",
      authorization_mode: "drive_move_spike",
      drive_mode: "read_only_preflight",
    });
    const start = await fetch(
      `${origin}/oauth/lark/start?request=${"x".repeat(43)}`,
    );
    const body = await start.text();
    assert.match(body, /exact four-scope capability grant/i);
    assert.match(body, /separate explicit operator confirmation/i);
  });
});

test("requires an explicit browser confirmation before starting OAuth", async () => {
  let beginCalls = 0;
  const handler = createAssistantHttpHandler({
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
  const handler = createAssistantHttpHandler({
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
  const handler = createAssistantHttpHandler({
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
