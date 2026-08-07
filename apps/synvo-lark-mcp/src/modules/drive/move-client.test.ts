import assert from "node:assert/strict";
import test from "node:test";

import { DriveMoveError, LarkDriveMover } from "./move-client.js";

test("uses the exact one-file Drive move endpoint and bounded body", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const mover = new LarkDriveMover({
    fetcher: (async (input: string | URL, init?: RequestInit) => {
      capturedUrl = input.toString();
      capturedInit = init;
      return new Response(JSON.stringify({ code: 0, data: { task_id: "task" } }), {
        status: 200,
        headers: { "content-type": "application/json", "x-tt-logid": "request" },
      });
    }) as typeof fetch,
  });

  const result = await mover.moveFile({
    accessToken: "access-secret",
    fileToken: "file-token",
    destinationFolderToken: "destination-token",
  });

  assert.equal(
    capturedUrl,
    "https://open.larksuite.com/open-apis/drive/v1/files/file-token/move",
  );
  assert.equal(capturedInit?.method, "POST");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    type: "file",
    folder_token: "destination-token",
  });
  assert.deepEqual(result, { taskId: "task", requestId: "request" });
});

test("normalizes permission, rate limit, server, timeout, and malformed failures", async (t) => {
  const cases: Array<{
    name: string;
    fetcher: typeof fetch;
    code: DriveMoveError["code"];
    ambiguous: boolean;
  }> = [
    {
      name: "permission revoked",
      fetcher: (async () => new Response(JSON.stringify({ code: 1 }), { status: 403 })) as typeof fetch,
      code: "FORBIDDEN",
      ambiguous: false,
    },
    {
      name: "429",
      fetcher: (async () => new Response(JSON.stringify({ code: 1 }), { status: 429 })) as typeof fetch,
      code: "RATE_LIMITED",
      ambiguous: false,
    },
    {
      name: "5xx",
      fetcher: (async () => new Response(JSON.stringify({ code: 1 }), { status: 503 })) as typeof fetch,
      code: "TEMPORARY",
      ambiguous: true,
    },
    {
      name: "timeout",
      fetcher: (async () => {
        throw Object.assign(new Error("secret detail"), { name: "TimeoutError" });
      }) as typeof fetch,
      code: "TIMEOUT",
      ambiguous: true,
    },
    {
      name: "malformed success",
      fetcher: (async () => new Response("not-json", { status: 200 })) as typeof fetch,
      code: "MALFORMED",
      ambiguous: true,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, async () => {
      const mover = new LarkDriveMover({ fetcher: item.fetcher });
      await assert.rejects(
        mover.moveFile({
          accessToken: "access-secret",
          fileToken: "file-token",
          destinationFolderToken: "destination-token",
        }),
        (error: unknown) =>
          error instanceof DriveMoveError &&
          error.code === item.code &&
          error.ambiguous === item.ambiguous &&
          !error.message.includes("secret"),
      );
    });
  }
});
