import assert from "node:assert/strict";
import test from "node:test";

import type {
  DriveFetch,
  DriveListPage,
  DriveReader,
  NativeDriveMetadata,
} from "./client.js";
import {
  LarkDriveReader,
  larkBatchMetadataDocumentLimit,
  listFolderCompletely,
} from "./client.js";
import { DriveToolError } from "./errors.js";

class PageReader implements DriveReader {
  readonly pages: DriveListPage[];
  readonly pageTokens: Array<string | undefined> = [];
  calls = 0;

  constructor(pages: DriveListPage[]) {
    this.pages = pages;
  }

  async listFolderPage(input: {
    pageToken?: string;
  }): Promise<DriveListPage> {
    this.pageTokens.push(input.pageToken);
    const page = this.pages[this.calls];
    this.calls += 1;
    if (!page) {
      throw new Error("Unexpected page request");
    }
    return page;
  }

  async getMetadata(): Promise<NativeDriveMetadata[]> {
    return [];
  }
}

test("lists every Drive page without truncation", async () => {
  const reader = new PageReader([
    {
      items: [{ token: "a", name: "A", type: "file", parentToken: "root" }],
      hasMore: true,
      nextPageToken: "cursor-2",
    },
    {
      items: [{ token: "b", name: "B", type: "file", parentToken: "root" }],
      hasMore: false,
    },
  ]);

  const result = await listFolderCompletely(reader, {
    accessToken: "access",
    folderToken: "root",
  });

  assert.deepEqual(
    result.map((item) => item.token),
    ["a", "b"],
  );
  assert.equal(reader.calls, 2);
  assert.deepEqual(reader.pageTokens, [undefined, "cursor-2"]);
});

test("rejects a repeated Drive pagination cursor", async () => {
  const reader = new PageReader([
    { items: [], hasMore: true, nextPageToken: "repeat" },
    { items: [], hasMore: true, nextPageToken: "repeat" },
  ]);

  await assert.rejects(
    listFolderCompletely(reader, {
      accessToken: "access",
      folderToken: "root",
    }),
    (error: unknown) =>
      error instanceof DriveToolError &&
      error.safeError.code === "INCOMPLETE_SCAN",
  );
});

test("stops when the bounded item budget is exceeded", async () => {
  const reader = new PageReader([
    {
      items: [{ token: "a", name: "A", type: "file", parentToken: "root" }],
      hasMore: true,
      nextPageToken: "cursor-2",
    },
  ]);

  await assert.rejects(
    listFolderCompletely(reader, {
      accessToken: "access",
      folderToken: "root",
      maxItems: 1,
    }),
    (error: unknown) =>
      error instanceof DriveToolError &&
      error.safeError.code === "LIMIT_EXCEEDED",
  );
});

test("stops when the bounded page budget is exhausted", async () => {
  const reader = new PageReader([
    { items: [], hasMore: true, nextPageToken: "cursor-2" },
  ]);

  await assert.rejects(
    listFolderCompletely(reader, {
      accessToken: "access",
      folderToken: "root",
      maxPages: 1,
    }),
    (error: unknown) =>
      error instanceof DriveToolError &&
      error.safeError.code === "LIMIT_EXCEEDED",
  );
  assert.deepEqual(reader.pageTokens, [undefined]);
});

test("rejects duplicate native item tokens across Drive pages", async () => {
  const reader = new PageReader([
    {
      items: [
        { token: "duplicate", name: "A", type: "file", parentToken: "root" },
      ],
      hasMore: true,
      nextPageToken: "cursor-2",
    },
    {
      items: [
        { token: "duplicate", name: "B", type: "file", parentToken: "root" },
      ],
      hasMore: false,
    },
  ]);

  await assert.rejects(
    listFolderCompletely(reader, {
      accessToken: "access",
      folderToken: "root",
    }),
    (error: unknown) =>
      error instanceof DriveToolError &&
      error.safeError.code === "INCOMPLETE_SCAN",
  );
});

test("rejects items whose direct parent differs from the requested folder", async () => {
  const reader = new PageReader([
    {
      items: [
        {
          token: "outside",
          name: "Outside",
          type: "file",
          parentToken: "another-folder",
        },
      ],
      hasMore: false,
    },
  ]);

  await assert.rejects(
    listFolderCompletely(reader, {
      accessToken: "access",
      folderToken: "root",
    }),
    (error: unknown) =>
      error instanceof DriveToolError &&
      error.safeError.code === "MALFORMED_RESPONSE",
  );
});

test("requires explicit and internally consistent pagination fields", async () => {
  const reader = new PageReader([
    {
      items: [],
      hasMore: false,
      nextPageToken: "unexpected-cursor",
    },
  ]);

  await assert.rejects(
    listFolderCompletely(reader, {
      accessToken: "access",
      folderToken: "root",
    }),
    (error: unknown) =>
      error instanceof DriveToolError &&
      error.safeError.code === "INCOMPLETE_SCAN",
  );
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("uses the documented read-only Drive endpoint and validates its shape", async () => {
  let requestedUrl = "";
  let requestedAuthorization = "";
  const fetcher: DriveFetch = async (input, init) => {
    requestedUrl = String(input);
    requestedAuthorization = new Headers(init?.headers).get("Authorization") ?? "";
    assert.ok(init?.signal);
    assert.equal(init?.redirect, "error");
    return jsonResponse({
      code: 0,
      data: {
        files: [
          {
            token: "file-token",
            name: "Pilot.pdf",
            type: "file",
            parent_token: "root-token",
          },
        ],
        has_more: false,
      },
    });
  };
  const reader = new LarkDriveReader({ fetcher, requestTimeoutMs: 100 });

  const page = await reader.listFolderPage({
    accessToken: "private-access-token",
    folderToken: "root-token",
    pageSize: 50,
  });

  const url = new URL(requestedUrl);
  assert.equal(url.pathname, "/open-apis/drive/v1/files");
  assert.equal(url.searchParams.get("folder_token"), "root-token");
  assert.equal(requestedAuthorization, "Bearer private-access-token");
  assert.equal(page.items[0]?.parentToken, "root-token");
});

test("rejects a listing when has_more is omitted", async () => {
  const reader = new LarkDriveReader({
    fetcher: async () =>
      jsonResponse({
        code: 0,
        data: { files: [] },
      }),
  });

  await assert.rejects(
    reader.listFolderPage({
      accessToken: "access",
      folderToken: "root",
      pageSize: 50,
    }),
    (error: unknown) =>
      error instanceof DriveToolError &&
      error.safeError.code === "MALFORMED_RESPONSE",
  );
});

test("uses a provider permission code from a non-success response safely", async () => {
  const reader = new LarkDriveReader({
    fetcher: async () => jsonResponse({ code: 99991679 }, 400),
  });

  await assert.rejects(
    reader.listFolderPage({
      accessToken: "private-access-token",
      folderToken: "private-folder-token",
      pageSize: 50,
    }),
    (error: unknown) =>
      error instanceof DriveToolError &&
      error.safeError.code === "UNAUTHORIZED" &&
      error.metadata.authFailure === "ACCESS_TOKEN_REJECTED" &&
      !error.message.includes("private-access-token") &&
      !error.message.includes("private-folder-token"),
  );
});

async function assertSafeHttpFailure(
  status: number,
  expectedCode: "UNAUTHORIZED" | "LARK_PERMANENT",
): Promise<void> {
  const providerBodyMarker = "private-provider-response-body";
  const reader = new LarkDriveReader({
    fetcher: async () =>
      jsonResponse({ code: 12345, msg: providerBodyMarker }, status),
  });

  await assert.rejects(
    reader.listFolderPage({
      accessToken: "private-access-token",
      folderToken: "private-folder-token",
      pageSize: 50,
    }),
    (error: unknown) => {
      if (!(error instanceof DriveToolError)) {
        return false;
      }
      const exposed = JSON.stringify({
        message: error.message,
        safeError: error.safeError,
      });
      return (
        error.safeError.code === expectedCode &&
        !exposed.includes(providerBodyMarker) &&
        !exposed.includes("private-access-token") &&
        !exposed.includes("private-folder-token")
      );
    },
  );
}

test("normalizes a direct Drive 401 without exposing its provider body", async () => {
  await assertSafeHttpFailure(401, "UNAUTHORIZED");
});

test("normalizes a direct Drive 404 without exposing its provider body", async () => {
  await assertSafeHttpFailure(404, "LARK_PERMANENT");
});

test("requires exact, unique metadata coverage", async () => {
  const reader = new LarkDriveReader({
    fetcher: async () =>
      jsonResponse({
        code: 0,
        data: {
          metas: [
            {
              doc_token: "one",
              doc_type: "file",
              title: "One",
              owner_id: "owner",
              create_time: "1",
              latest_modify_time: "2",
            },
          ],
        },
      }),
  });

  await assert.rejects(
    reader.getMetadata({
      accessToken: "access",
      documents: [
        { token: "one", type: "file" },
        { token: "two", type: "file" },
      ],
    }),
    (error: unknown) =>
      error instanceof DriveToolError &&
      error.safeError.code === "MALFORMED_RESPONSE",
  );
});

test("accepts exactly 200 documents in a Lark metadata batch", async () => {
  let requestDocumentCount = 0;
  const documents = Array.from(
    { length: larkBatchMetadataDocumentLimit },
    (_, index) => ({ token: `file-${index}`, type: "file" }),
  );
  const reader = new LarkDriveReader({
    fetcher: async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        request_docs: Array<{ doc_token: string; doc_type: string }>;
      };
      requestDocumentCount = request.request_docs.length;
      return jsonResponse({
        code: 0,
        data: {
          metas: request.request_docs.map((document) => ({
            doc_token: document.doc_token,
            doc_type: document.doc_type,
            title: document.doc_token,
            owner_id: "owner",
            create_time: "1",
            latest_modify_time: "2",
          })),
        },
      });
    },
  });

  const metadata = await reader.getMetadata({
    accessToken: "access",
    documents,
  });

  assert.equal(requestDocumentCount, larkBatchMetadataDocumentLimit);
  assert.equal(metadata.length, larkBatchMetadataDocumentLimit);
});

test("rejects a 201-document metadata batch before calling Lark", async () => {
  let fetchCalls = 0;
  const reader = new LarkDriveReader({
    fetcher: async () => {
      fetchCalls += 1;
      throw new Error("The oversized metadata request reached Lark");
    },
  });

  await assert.rejects(
    reader.getMetadata({
      accessToken: "access",
      documents: Array.from(
        { length: larkBatchMetadataDocumentLimit + 1 },
        (_, index) => ({ token: `file-${index}`, type: "file" }),
      ),
    }),
    (error: unknown) =>
      error instanceof DriveToolError &&
      error.safeError.code === "LIMIT_EXCEEDED",
  );
  assert.equal(fetchCalls, 0);
});

test("sanitizes timed-out requests without exposing Drive or access tokens", async () => {
  const fetcher: DriveFetch = async () => {
    const error = new Error("root-token private-access-token");
    error.name = "TimeoutError";
    throw error;
  };
  const reader = new LarkDriveReader({ fetcher, requestTimeoutMs: 100 });

  await assert.rejects(
    reader.listFolderPage({
      accessToken: "private-access-token",
      folderToken: "root-token",
      pageSize: 50,
    }),
    (error: unknown) =>
      error instanceof DriveToolError &&
      error.safeError.code === "LARK_RETRYABLE" &&
      error.safeError.retryable &&
      !error.message.includes("root-token") &&
      !error.message.includes("private-access-token"),
  );
});

test("retries a nested fetch network failure without exposing tokens", async () => {
  const fetcher: DriveFetch = async () => {
    throw new TypeError("fetch failed with private values", {
      cause: Object.assign(new Error("root-token private-access-token"), {
        code: "ECONNRESET",
      }),
    });
  };
  const reader = new LarkDriveReader({ fetcher, requestTimeoutMs: 100 });

  await assert.rejects(
    reader.listFolderPage({
      accessToken: "private-access-token",
      folderToken: "root-token",
      pageSize: 50,
    }),
    (error: unknown) =>
      error instanceof DriveToolError &&
      error.safeError.code === "LARK_RETRYABLE" &&
      error.safeError.retryable &&
      !error.message.includes("root-token") &&
      !error.message.includes("private-access-token"),
  );
});
