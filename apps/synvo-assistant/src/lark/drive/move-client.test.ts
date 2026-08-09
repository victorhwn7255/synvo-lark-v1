import assert from "node:assert/strict";
import test from "node:test";

import { DriveMoveError, LarkDriveMover } from "./move-client.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("moves one file through the documented Drive endpoint", async () => {
  let requestedUrl = "";
  let requestedBody: unknown;
  let requestedAuthorization = "";
  const mover = new LarkDriveMover({
    requestTimeoutMs: 100,
    fetcher: async (input, init) => {
      requestedUrl = String(input);
      requestedBody = JSON.parse(String(init?.body));
      requestedAuthorization =
        new Headers(init?.headers).get("Authorization") ?? "";
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal);
      return jsonResponse({ code: 0 });
    },
  });

  await mover.moveFile({
    accessToken: "private-access-token",
    fileToken: "file/token",
    destinationFolderToken: "destination-token",
  });

  assert.equal(
    new URL(requestedUrl).pathname,
    "/open-apis/drive/v1/files/file%2Ftoken/move",
  );
  assert.equal(requestedAuthorization, "Bearer private-access-token");
  assert.deepEqual(requestedBody, {
    type: "file",
    folder_token: "destination-token",
  });
});

test("normalizes rejected, ambiguous, and malformed move outcomes", async (t) => {
  const cases = [
    {
      name: "unauthorized",
      response: jsonResponse({ code: 99991679 }, 401),
      code: "UNAUTHORIZED",
      ambiguous: false,
    },
    {
      name: "rate limited",
      response: jsonResponse({ code: 1061045 }, 429),
      code: "RATE_LIMITED",
      ambiguous: false,
    },
    {
      name: "server failure",
      response: jsonResponse({ code: 1 }, 503),
      code: "TEMPORARY",
      ambiguous: true,
    },
    {
      name: "malformed success",
      response: new Response("not-json", { status: 200 }),
      code: "MALFORMED",
      ambiguous: true,
    },
    {
      name: "malformed envelope",
      response: jsonResponse({}, 200),
      code: "MALFORMED",
      ambiguous: true,
    },
  ] as const;

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const mover = new LarkDriveMover({
        requestTimeoutMs: 100,
        fetcher: async () => testCase.response.clone(),
      });
      await assert.rejects(
        mover.moveFile({
          accessToken: "private-access-token",
          fileToken: "file-token",
          destinationFolderToken: "destination-token",
        }),
        (error: unknown) =>
          error instanceof DriveMoveError &&
          error.code === testCase.code &&
          error.ambiguous === testCase.ambiguous &&
          !error.message.includes("private-access-token") &&
          !error.message.includes("file-token"),
      );
    });
  }
});

test("treats a timed-out move as ambiguous", async () => {
  const mover = new LarkDriveMover({
    requestTimeoutMs: 100,
    fetcher: async () => {
      const error = new Error("provider detail");
      error.name = "AbortError";
      throw error;
    },
  });

  await assert.rejects(
    mover.moveFile({
      accessToken: "private-access-token",
      fileToken: "file-token",
      destinationFolderToken: "destination-token",
    }),
    (error: unknown) =>
      error instanceof DriveMoveError &&
      error.code === "TIMEOUT" &&
      error.ambiguous &&
      !error.message.includes("provider detail"),
  );
});
