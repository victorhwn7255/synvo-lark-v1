import assert from "node:assert/strict";
import test from "node:test";

import type {
  DriveFetch,
  DriveListPage,
  DriveReader,
  MySpaceRootListPage,
  MySpaceRootReader,
  NativeDriveMetadata,
} from "./read-client.js";
import {
  LarkDriveReader,
  listFolderCompletely,
  listMySpaceRootCompletely,
} from "./read-client.js";
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

  async getMetadata(): Promise<NativeDriveMetadata> {
    throw new Error("Unexpected metadata request");
  }
}

class MySpacePageReader implements MySpaceRootReader {
  readonly pages: MySpaceRootListPage[];
  readonly pageTokens: Array<string | undefined> = [];
  calls = 0;

  constructor(pages: MySpaceRootListPage[]) {
    this.pages = pages;
  }

  async listMySpaceRootPage(input: {
    pageToken?: string;
  }): Promise<MySpaceRootListPage> {
    this.pageTokens.push(input.pageToken);
    const page = this.pages[this.calls];
    this.calls += 1;
    if (!page) {
      throw new Error("Unexpected My Space page request");
    }
    return page;
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

test("lists the bounded My Folders root with the shared pagination policy", async () => {
  const reader = new MySpacePageReader([
    {
      items: [{ token: "one", name: "One", type: "folder" }],
      hasMore: true,
      nextPageToken: "cursor-2",
    },
    {
      items: [{ token: "two", name: "Two", type: "folder" }],
      hasMore: false,
    },
  ]);

  const items = await listMySpaceRootCompletely(reader, {
    accessToken: "access",
  });

  assert.deepEqual(items.map((item) => item.token), ["one", "two"]);
  assert.deepEqual(reader.pageTokens, [undefined, "cursor-2"]);
});

test("rejects repeated cursors and duplicate tokens in My Folders", async (t) => {
  await t.test("repeated cursor", async () => {
    const reader = new MySpacePageReader([
      { items: [], hasMore: true, nextPageToken: "repeat" },
      { items: [], hasMore: true, nextPageToken: "repeat" },
    ]);
    await assert.rejects(
      listMySpaceRootCompletely(reader, { accessToken: "access" }),
      (error: unknown) =>
        error instanceof DriveToolError &&
        error.safeError.code === "INCOMPLETE_SCAN",
    );
  });

  await t.test("duplicate token", async () => {
    const reader = new MySpacePageReader([
      {
        items: [{ token: "duplicate", name: "One", type: "folder" }],
        hasMore: true,
        nextPageToken: "next",
      },
      {
        items: [{ token: "duplicate", name: "Two", type: "folder" }],
        hasMore: false,
      },
    ]);
    await assert.rejects(
      listMySpaceRootCompletely(reader, { accessToken: "access" }),
      (error: unknown) =>
        error instanceof DriveToolError &&
        error.safeError.code === "INCOMPLETE_SCAN",
    );
  });

  await t.test("item limit", async () => {
    const reader = new MySpacePageReader([
      {
        items: [{ token: "one", name: "One", type: "folder" }],
        hasMore: true,
        nextPageToken: "next",
      },
    ]);
    await assert.rejects(
      listMySpaceRootCompletely(reader, {
        accessToken: "access",
        maxItems: 1,
      }),
      (error: unknown) =>
        error instanceof DriveToolError &&
        error.safeError.code === "LIMIT_EXCEEDED",
    );
  });
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

test("lists My Folders without a folder token and accepts a missing parent token", async () => {
  let requestedUrl = "";
  let requestedAuthorization = "";
  const reader = new LarkDriveReader({
    fetcher: async (input, init) => {
      requestedUrl = String(input);
      requestedAuthorization =
        new Headers(init?.headers).get("Authorization") ?? "";
      return jsonResponse({
        code: 0,
        data: {
          files: [
            {
              token: "folder-token",
              name: "Test_Synvo_AI_Assistant",
              type: "folder",
            },
          ],
          has_more: false,
        },
      });
    },
  });

  const page = await reader.listMySpaceRootPage({
    accessToken: "private-access-token",
    pageSize: 50,
  });

  const url = new URL(requestedUrl);
  assert.equal(url.pathname, "/open-apis/drive/v1/files");
  assert.equal(url.searchParams.has("folder_token"), false);
  assert.equal(requestedAuthorization, "Bearer private-access-token");
  assert.deepEqual(page.items, [
    {
      token: "folder-token",
      name: "Test_Synvo_AI_Assistant",
      type: "folder",
    },
  ]);
});

test("normalizes My Folders provider failures without exposing provider data", async (t) => {
  for (const [status, expectedCode] of [
    [401, "UNAUTHORIZED"],
    [403, "UNAUTHORIZED"],
    [404, "LARK_PERMANENT"],
    [429, "LARK_RETRYABLE"],
    [500, "LARK_RETRYABLE"],
  ] as const) {
    await t.test(String(status), async () => {
      const reader = new LarkDriveReader({
        fetcher: async () =>
          jsonResponse(
            { code: 12345, msg: "private-provider-response-body" },
            status,
          ),
      });
      await assert.rejects(
        reader.listMySpaceRootPage({
          accessToken: "private-access-token",
          pageSize: 50,
        }),
        (error: unknown) => {
          if (!(error instanceof DriveToolError)) {
            return false;
          }
          const exposed = JSON.stringify(error.safeError);
          return (
            error.safeError.code === expectedCode &&
            !exposed.includes("private-provider-response-body") &&
            !exposed.includes("private-access-token")
          );
        },
      );
    });
  }
});

test("rejects malformed My Folders responses at the provider boundary", async () => {
  const reader = new LarkDriveReader({
    fetcher: async () =>
      jsonResponse({
        code: 0,
        data: {
          files: [
            {
              token: "folder",
              name: "Folder",
              type: "folder",
              parent_token: "",
            },
          ],
          has_more: false,
        },
      }),
  });

  await assert.rejects(
    reader.listMySpaceRootPage({ accessToken: "access", pageSize: 50 }),
    (error: unknown) =>
      error instanceof DriveToolError &&
      error.safeError.code === "MALFORMED_RESPONSE",
  );
});

test("normalizes a timed-out My Folders request without exposing its token", async () => {
  const reader = new LarkDriveReader({
    fetcher: async () => {
      const error = new Error("private-access-token");
      error.name = "TimeoutError";
      throw error;
    },
  });

  await assert.rejects(
    reader.listMySpaceRootPage({
      accessToken: "private-access-token",
      pageSize: 50,
    }),
    (error: unknown) =>
      error instanceof DriveToolError &&
      error.safeError.code === "LARK_RETRYABLE" &&
      !error.message.includes("private-access-token"),
  );
});

test("rejects malformed provider listings at the Drive boundary", async (t) => {
  const cases = [
    { name: "missing has_more", data: { files: [] } },
    {
      name: "cursor without another page",
      data: { files: [], has_more: false, next_page_token: "unexpected" },
    },
    {
      name: "item outside the requested folder",
      data: {
        files: [{
          token: "outside",
          name: "Outside",
          type: "file",
          parent_token: "another-folder",
        }],
        has_more: false,
      },
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const reader = new LarkDriveReader({
        fetcher: async () => jsonResponse({ code: 0, data: testCase.data }),
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
  }
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

test("requires exact metadata coverage for the requested document", async () => {
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
      document: { token: "two", type: "file" },
    }),
    (error: unknown) =>
      error instanceof DriveToolError &&
      error.safeError.code === "MALFORMED_RESPONSE",
  );
});

test("queries only the requested Drive metadata document", async () => {
  let requestedDocument: { doc_token: string; doc_type: string } | undefined;
  const reader = new LarkDriveReader({
    fetcher: async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        request_docs: Array<{ doc_token: string; doc_type: string }>;
      };
      assert.equal(request.request_docs.length, 1);
      requestedDocument = request.request_docs[0];
      return jsonResponse({
        code: 0,
        data: {
          metas: [{
            doc_token: "root-token",
            doc_type: "folder",
            title: "Test_Synvo_AI_Assistant",
            owner_id: "owner",
            create_time: "1",
            latest_modify_time: "2",
          }],
        },
      });
    },
  });

  const metadata = await reader.getMetadata({
    accessToken: "access",
    document: { token: "root-token", type: "folder" },
  });

  assert.deepEqual(requestedDocument, {
    doc_token: "root-token",
    doc_type: "folder",
  });
  assert.equal(metadata.title, "Test_Synvo_AI_Assistant");
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
