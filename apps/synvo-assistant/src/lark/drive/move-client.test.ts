import assert from "node:assert/strict";
import test from "node:test";

import {
  DriveMoveError,
  LarkDriveFileDeleter,
  LarkDriveFolderCreator,
  LarkDriveMover,
} from "./move-client.js";

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
      response: jsonResponse({ code: 1 }, 401),
      code: "UNAUTHORIZED",
      ambiguous: false,
    },
    {
      name: "fresh authorization required",
      response: jsonResponse({ code: 99991679 }, 401),
      code: "REAUTHORIZATION_REQUIRED",
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

test("deletes one ordinary file through the documented Drive endpoint", async () => {
  let requestedUrl = "";
  const deleter = new LarkDriveFileDeleter({
    requestTimeoutMs: 100,
    fetcher: async (input, init) => {
      requestedUrl = String(input);
      assert.equal(init?.method, "DELETE");
      assert.equal(init?.redirect, "error");
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer private-access-token",
      );
      return jsonResponse({ code: 0 });
    },
  });

  await deleter.deleteFile({
    accessToken: "private-access-token",
    fileToken: "file/token",
  });

  const url = new URL(requestedUrl);
  assert.equal(url.pathname, "/open-apis/drive/v1/files/file%2Ftoken");
  assert.equal(url.searchParams.get("type"), "file");
  assert.equal(url.searchParams.get("async"), "false");
});

test("creates one ordinary folder beneath the trusted parent", async () => {
  let requestedUrl = "";
  let requestedBody: unknown;
  const creator = new LarkDriveFolderCreator({
    requestTimeoutMs: 100,
    fetcher: async (input, init) => {
      requestedUrl = String(input);
      requestedBody = JSON.parse(String(init?.body));
      assert.equal(init?.method, "POST");
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer private-access-token",
      );
      return jsonResponse({ code: 0, data: { token: "new-folder-token" } });
    },
  });

  assert.deepEqual(await creator.createFolder({
    accessToken: "private-access-token",
    parentFolderToken: "trusted-root-token",
    name: "Engineering",
  }), { folderToken: "new-folder-token" });
  assert.equal(
    new URL(requestedUrl).pathname,
    "/open-apis/drive/v1/files/create_folder",
  );
  assert.deepEqual(requestedBody, {
    name: "Engineering",
    folder_token: "trusted-root-token",
  });
});

test("treats a malformed folder-create success as ambiguous", async () => {
  const creator = new LarkDriveFolderCreator({
    requestTimeoutMs: 100,
    fetcher: async () => jsonResponse({ code: 0, data: {} }),
  });
  await assert.rejects(
    creator.createFolder({
      accessToken: "private-access-token",
      parentFolderToken: "trusted-root-token",
      name: "Engineering",
    }),
    (error: unknown) =>
      error instanceof DriveMoveError &&
      error.code === "MALFORMED" &&
      error.ambiguous,
  );
});
