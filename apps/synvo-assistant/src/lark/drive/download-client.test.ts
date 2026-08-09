import assert from "node:assert/strict";
import test from "node:test";

import { DriveToolError } from "./errors.js";
import { LarkDriveFileDownloader } from "./download-client.js";

const input = {
  accessToken: "user-access-token",
  fileToken: "boxcnPdf123",
  maxBytes: 16,
};

test("downloads one bounded Drive file with the user access token", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = new LarkDriveFileDownloader({
    fetchImplementation: (async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response("%PDF-test", { status: 200 });
    }) as typeof fetch,
  });

  assert.equal((await client.download(input)).toString(), "%PDF-test");
  assert.equal(
    calls[0]?.url,
    "https://open.larksuite.com/open-apis/drive/v1/files/boxcnPdf123/download",
  );
  assert.equal(
    (calls[0]?.init.headers as Record<string, string>).Authorization,
    "Bearer user-access-token",
  );
});

test("rejects declared and streamed files above the configured limit", async () => {
  for (const response of [
    new Response("small", {
      status: 200,
      headers: { "content-length": "17" },
    }),
    new Response("x".repeat(17), { status: 200 }),
  ]) {
    const client = new LarkDriveFileDownloader({
      fetchImplementation: (async () => response.clone()) as typeof fetch,
    });
    await assert.rejects(
      client.download(input),
      (error: unknown) =>
        error instanceof DriveToolError &&
        error.safeError.code === "LIMIT_EXCEEDED",
    );
  }
});

for (const [status, code] of [
  [401, "UNAUTHORIZED"],
  [403, "UNAUTHORIZED"],
  [404, "LARK_PERMANENT"],
  [429, "LARK_RETRYABLE"],
  [503, "LARK_RETRYABLE"],
] as const) {
  test(`normalizes Drive download HTTP ${status}`, async () => {
    const client = new LarkDriveFileDownloader({
      fetchImplementation: (async () =>
        new Response("private provider body", { status })) as typeof fetch,
    });
    await assert.rejects(
      client.download(input),
      (error: unknown) =>
        error instanceof DriveToolError && error.safeError.code === code,
    );
  });
}

test("normalizes download timeouts without leaking transport detail", async () => {
  const client = new LarkDriveFileDownloader({
    fetchImplementation: (async () => {
      throw new DOMException("private timeout detail", "TimeoutError");
    }) as typeof fetch,
  });
  await assert.rejects(
    client.download(input),
    (error: unknown) =>
      error instanceof DriveToolError &&
      error.safeError.code === "LARK_RETRYABLE" &&
      !error.message.includes("private"),
  );
});

test("normalizes download network failures without leaking transport detail", async () => {
  const client = new LarkDriveFileDownloader({
    fetchImplementation: (async () => {
      throw Object.assign(new Error("private network detail"), {
        code: "ECONNRESET",
      });
    }) as typeof fetch,
  });
  await assert.rejects(
    client.download(input),
    (error: unknown) =>
      error instanceof DriveToolError &&
      error.safeError.code === "LARK_RETRYABLE" &&
      !error.message.includes("private"),
  );
});
