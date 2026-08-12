import assert from "node:assert/strict";
import test from "node:test";

import { decryptDeliveryMessage } from "../../delivery/crypto.js";
import type {
  DeliveryJob,
  DeliveryQueue,
  InsertDeliveryJobInput,
} from "../../delivery/repository.js";
import { LarkAuthError, TokenCipher } from "../../lark/auth/index.js";
import type {
  DriveFileDownloader,
  DriveReader,
  NativeDriveItem,
} from "../../lark/drive/index.js";
import { driveToolError } from "../../lark/drive/index.js";
import { AuthorizedDrivePdfReader } from "./authorized-reader.js";
import { AnalyzeDriveFileWorkflow } from "./workflow.js";
import {
  KNOWLEDGE_MAX_DESCENDANT_DEPTH,
  KNOWLEDGE_MAX_DISCOVERED_PDFS,
  KNOWLEDGE_MAX_VISITED_FOLDERS,
} from "../knowledge/policy.js";

const cipher = new TokenCipher(Buffer.alloc(32, 8));
const fileLink = "https://synvo-ai.larksuite.com/file/boxcnPdf123";
const folderLink =
  "https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123";

class FakeQueue implements DeliveryQueue {
  inserted: InsertDeliveryJobInput | null = null;
  accept = true;
  async enqueue(input: InsertDeliveryJobInput): Promise<boolean> {
    this.inserted = input;
    return this.accept;
  }
  async claimNext(): Promise<DeliveryJob | null> { return null; }
  async extendLease(): Promise<boolean> { return true; }
  async storePayload(): Promise<boolean> { return true; }
  async complete(): Promise<boolean> { return true; }
  async retry(): Promise<boolean> { return true; }
  async fail(): Promise<boolean> { return true; }
  async requestCancellation() { return "terminal" as const; }
  async isCancellationRequested() { return false; }
}

function fixture(options: {
  ownerId?: string;
  type?: string;
  name?: string;
  token?: string;
  parentToken?: string;
  items?: NativeDriveItem[];
  itemResponses?: NativeDriveItem[][];
  folderItems?: Record<string, NativeDriveItem[]>;
  downloadError?: unknown;
  tokenError?: unknown;
  listError?: unknown;
  listErrors?: unknown[];
  deleteError?: unknown;
} = {}) {
  const queue = new FakeQueue();
  const updates: string[] = [];
  let downloads = 0;
  let recoveries = 0;
  let rejections = 0;
  let deletions = 0;
  let lists = 0;
  const requestedFolders: string[] = [];
  const requestedAccessTokens: string[] = [];
  const driveReader: DriveReader = {
    async listFolderPage(input) {
      lists += 1;
      requestedFolders.push(input.folderToken);
      requestedAccessTokens.push(input.accessToken);
      const listError = options.listErrors?.[lists - 1] ?? options.listError;
      if (listError) {
        throw listError;
      }
      return {
        items: options.folderItems
          ? options.folderItems[input.folderToken] ?? []
          : options.itemResponses?.[lists - 1] ?? options.items ?? [{
            token: options.token ?? "boxcnPdf123",
            name: options.name ?? "pilot.pdf",
            type: options.type ?? "file",
            parentToken: options.parentToken ?? "fldcnRoot123",
            ownerId: options.ownerId ?? "ou_victor",
            modifiedTime: "1723334400",
          }],
        hasMore: false,
      };
    },
    async getMetadata() { throw new Error("not used"); },
  };
  const downloader: DriveFileDownloader = {
    async download() {
      downloads += 1;
      if (options.downloadError) {
        throw options.downloadError;
      }
      return Buffer.from("%PDF-test");
    },
  };
  const deleter = {
    async deleteFile() {
      deletions += 1;
      if (options.deleteError) {
        throw options.deleteError;
      }
    },
  };
  const tokenBroker = {
    async getAccessToken() {
      if (options.tokenError) {
        throw options.tokenError;
      }
      return "access-one";
    },
    async recoverAccessToken() { recoveries += 1; return "access-two"; },
    async markAccessTokenRejected() { rejections += 1; },
  };
  const pdfReader = new AuthorizedDrivePdfReader({
    tokenBroker,
    driveReader,
    downloader,
    deleter,
    rootToken: "fldcnRoot123",
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
  });
  const workflow = new AnalyzeDriveFileWorkflow({
    queue,
    cipher,
    pdfReader,
    analyzer: {
      async analyze() { return { text: "Grounded result", truncated: false }; },
    },
    messenger: {
      async create() { return "om_progress"; },
      async update(_id, text) { updates.push(text); },
    },
    rootToken: "fldcnRoot123",
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
    extractPdf: async () => ({
      text: "Extracted",
      pageCount: 2,
      truncated: false,
      pages: [{ pageNumber: 1, text: "Extracted" }],
    }),
  });
  return {
    workflow,
    pdfReader,
    queue,
    updates,
    downloads: () => downloads,
    lists: () => lists,
    recoveries: () => recoveries,
    rejections: () => rejections,
    deletions: () => deletions,
    requestedFolders,
    requestedAccessTokens,
  };
}

const startInput = {
  messageId: "om_command",
  chatId: "oc_chat",
  requesterOpenId: "ou_victor",
  tenantKey: "tenant_synvo",
  fileLink,
};
const analyzeInput = {
  requesterOpenId: "ou_victor",
  tenantKey: "tenant_synvo",
  folderLink,
  relativePath: "pilot.pdf",
};

function folder(token: string, name: string, parentToken: string): NativeDriveItem {
  return { token, name, type: "folder", parentToken, ownerId: "ou_victor" };
}

function pdf(token: string, name: string, parentToken: string): NativeDriveItem {
  return {
    token,
    name,
    type: "file",
    parentToken,
    ownerId: "ou_victor",
    modifiedTime: "1723334400",
  };
}

test("queues one encrypted Drive analysis context without exposing the file token", async () => {
  const testFixture = fixture();
  assert.deepEqual(await testFixture.workflow.start(startInput), { kind: "queued" });
  const inserted = testFixture.queue.inserted;
  assert.ok(inserted?.payloadCiphertext);
  assert.equal(inserted.kind, "ANALYZE_DRIVE_FILE");
  assert.equal(inserted.dedupeKey, "analyze-drive-file:om_command");
  assert.equal(inserted.payloadCiphertext.includes("boxcnPdf123"), false);
  const plaintext = decryptDeliveryMessage(cipher, inserted.id, inserted.payloadCiphertext);
  assert.equal(JSON.parse(plaintext).fileToken, "boxcnPdf123");
});

test("rejects the wrong actor or tenant, malformed link, unusable grant, and duplicate command", async (t) => {
  const wrongActor = fixture();
  assert.equal(
    (await wrongActor.workflow.start({ ...startInput, requesterOpenId: "ou_other" })).kind,
    "rejected",
  );
  assert.equal(
    (await fixture().workflow.start({ ...startInput, tenantKey: "tenant_other" })).kind,
    "rejected",
  );
  assert.equal(
    (await fixture().workflow.start({ ...startInput, fileLink: "https://example.com/file/x" })).kind,
    "rejected",
  );
  for (const code of ["OAUTH_REQUIRED", "WRONG_SCOPE", "OAUTH_REVOKED"] as const) {
    await t.test(code, async () => {
      assert.equal(
        (await fixture({ tokenError: new LarkAuthError(code, "private") }).workflow.start(startInput)).kind,
        "rejected",
      );
    });
  }
  const duplicate = fixture();
  duplicate.queue.accept = false;
  assert.equal((await duplicate.workflow.start(startInput)).kind, "duplicate");
});

test("verifies, downloads, analyzes, and updates one existing progress message", async () => {
  const testFixture = fixture();
  await testFixture.workflow.process(
    {
      id: "job-id",
      dedupeKey: "analyze-drive-file:om_command",
      runId: null,
      kind: "ANALYZE_DRIVE_FILE",
      chatId: "oc_chat",
      payloadCiphertext: null,
      attemptCount: 1,
      expiresAt: null,
    },
    JSON.stringify({ fileToken: "boxcnPdf123", progressMessageId: null }),
    async () => true,
  );
  assert.equal(testFixture.downloads(), 1);
  assert.deepEqual(testFixture.updates, [
    "Verifying the PDF in Lark Drive…",
    "Analyzing the extracted text…",
    "Analysis complete: pilot.pdf\nPages: 2\n\nGrounded result",
  ]);
});

test("returns the same bounded analysis to a direct read-only consumer", async () => {
  const testFixture = fixture();
  assert.deepEqual(
    await testFixture.workflow.analyzeListedFile(analyzeInput),
    {
      ok: true,
      analysis: {
        filename: "pilot.pdf",
        page_count: 2,
        text: "Grounded result",
        input_truncated: false,
        output_truncated: false,
      },
    },
  );
  assert.equal(testFixture.downloads(), 1);
  assert.deepEqual(testFixture.updates, []);
});

test("preserves flat-root PDF discovery and filters unsupported files", async () => {
  const eligible: NativeDriveItem = {
    token: "boxcnEligible",
    name: "Eligible.pdf",
    type: "file",
    parentToken: "fldcnRoot123",
    ownerId: "ou_victor",
    modifiedTime: "1723334400",
  };
  const testFixture = fixture({
    items: [
      eligible,
      { ...eligible, token: "boxcnDocx", name: "Guide.docx", type: "docx" },
      { ...eligible, token: "boxcnOther", ownerId: "ou_other" },
      { ...eligible, token: "boxcnNoVersion", modifiedTime: undefined },
    ],
  });

  assert.deepEqual(
    await testFixture.pdfReader.listKnowledgeFiles({
      requesterOpenId: "ou_victor",
      tenantKey: "tenant_synvo",
    }),
    [{ token: "boxcnEligible", name: "Eligible.pdf", version: "1723334400" }],
  );
});

test("discovers root and nested PDFs through the maximum depth with safe relative paths", async () => {
  const root = "fldcnRoot123";
  const folderItems: Record<string, NativeDriveItem[]> = {
    [root]: [pdf("pdf-root", "Root.pdf", root), folder("folder-1", "Product", root)],
    "folder-1": [pdf("pdf-one", "Guide.pdf", "folder-1"), folder("folder-2", "Research", "folder-1")],
    "folder-2": [folder("folder-3", "Agentic AI", "folder-2")],
    "folder-3": [folder("folder-4", "Deep", "folder-3")],
    "folder-4": [pdf("pdf-four", "Context.pdf", "folder-4")],
  };
  const testFixture = fixture({ folderItems });

  assert.deepEqual(
    await testFixture.pdfReader.listKnowledgeFiles({
      requesterOpenId: "ou_victor",
      tenantKey: "tenant_synvo",
    }),
    [
      {
        token: "pdf-one",
        name: "Product / Guide.pdf",
        version: "1723334400",
      },
      {
        token: "pdf-four",
        name: "Product / Research / Agentic AI / Deep / Context.pdf",
        version: "1723334400",
      },
      { token: "pdf-root", name: "Root.pdf", version: "1723334400" },
    ],
  );
  assert.deepEqual(testFixture.requestedFolders, [
    root,
    "folder-1",
    "folder-2",
    "folder-3",
    "folder-4",
  ]);
});

test("accepts exactly 99 organizer PDFs and rejects the 100th without a partial inventory", async () => {
  const root = "fldcnRoot123";
  const identity = {
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
  };
  const files = Array.from(
    { length: 100 },
    (_, index) => pdf(`pdf-${index}`, `Document ${String(index).padStart(3, "0")}.pdf`, root),
  );

  const accepted = await fixture({
    folderItems: { [root]: files.slice(0, 99) },
  }).pdfReader.inspectWorkspace(identity, { maxPdfs: 99 });
  assert.equal(accepted.files.length, 99);
  assert.equal(accepted.files.at(0)?.fileName, "Document 000.pdf");
  assert.equal(accepted.files.at(-1)?.fileName, "Document 098.pdf");

  await assert.rejects(
    fixture({ folderItems: { [root]: files } }).pdfReader.inspectWorkspace(
      identity,
      { maxPdfs: 99 },
    ),
    /too many PDFs/u,
  );
});

test("restarts one recursive scan with a recovered access token", async () => {
  const root = "fldcnRoot123";
  const testFixture = fixture({
    listErrors: [
      driveToolError(
        "UNAUTHORIZED",
        "private provider detail",
        false,
        { authFailure: "ACCESS_TOKEN_REJECTED" },
      ),
    ],
    folderItems: {
      [root]: [folder("nested", "Research", root)],
      nested: [pdf("nested-pdf", "Guide.pdf", "nested")],
    },
  });

  assert.deepEqual(
    await testFixture.pdfReader.listKnowledgeFiles({
      requesterOpenId: "ou_victor",
      tenantKey: "tenant_synvo",
    }),
    [{
      token: "nested-pdf",
      name: "Research / Guide.pdf",
      version: "1723334400",
    }],
  );
  assert.equal(testFixture.recoveries(), 1);
  assert.equal(testFixture.rejections(), 0);
  assert.deepEqual(testFixture.requestedFolders, [root, root, "nested"]);
  assert.deepEqual(testFixture.requestedAccessTokens, [
    "access-one",
    "access-two",
    "access-two",
  ]);
});

test("fails closed on excessive depth, folder count, PDF count, and path length", async (t) => {
  await t.test("depth", async () => {
    const folderItems: Record<string, NativeDriveItem[]> = {};
    let parent = "fldcnRoot123";
    for (let depth = 1; depth <= KNOWLEDGE_MAX_DESCENDANT_DEPTH + 1; depth += 1) {
      const token = `depth-${depth}`;
      folderItems[parent] = [folder(token, `Depth ${depth}`, parent)];
      parent = token;
    }
    await assert.rejects(
      fixture({ folderItems }).pdfReader.listKnowledgeFiles({
        requesterOpenId: "ou_victor",
        tenantKey: "tenant_synvo",
      }),
      /depth/u,
    );
  });

  await t.test("folders", async () => {
    const root = "fldcnRoot123";
    const children = Array.from(
      { length: KNOWLEDGE_MAX_VISITED_FOLDERS },
      (_, index) => folder(`folder-${index}`, `Folder ${index}`, root),
    );
    await assert.rejects(
      fixture({ folderItems: { [root]: children } }).pdfReader.listKnowledgeFiles({
        requesterOpenId: "ou_victor",
        tenantKey: "tenant_synvo",
      }),
      /too many folders/u,
    );
  });

  await t.test("PDFs", async () => {
    const root = "fldcnRoot123";
    const files = Array.from(
      { length: KNOWLEDGE_MAX_DISCOVERED_PDFS + 1 },
      (_, index) => pdf(`pdf-${index}`, `Document ${index}.pdf`, root),
    );
    await assert.rejects(
      fixture({ folderItems: { [root]: files } }).pdfReader.listKnowledgeFiles({
        requesterOpenId: "ou_victor",
        tenantKey: "tenant_synvo",
      }),
      /too many PDFs|inventory limit/u,
    );
  });

  await t.test("path", async () => {
    const root = "fldcnRoot123";
    const longName = "x".repeat(160);
    const folderItems: Record<string, NativeDriveItem[]> = {
      [root]: [folder("long-1", longName, root)],
      "long-1": [folder("long-2", longName, "long-1")],
      "long-2": [folder("long-3", longName, "long-2")],
      "long-3": [folder("long-4", longName, "long-3")],
    };
    await assert.rejects(
      fixture({ folderItems }).pdfReader.listKnowledgeFiles({
        requesterOpenId: "ou_victor",
        tenantKey: "tenant_synvo",
      }),
      /display limit/u,
    );
  });
});

test("rejects repeated tokens, cycles, and inconsistent parents without leaving the root", async (t) => {
  const identity = {
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
  };
  await t.test("repeated file", async () => {
    const root = "fldcnRoot123";
    await assert.rejects(
      fixture({
        folderItems: {
          [root]: [folder("child", "Child", root), pdf("same", "One.pdf", root)],
          child: [pdf("same", "Two.pdf", "child")],
        },
      }).pdfReader.listKnowledgeFiles(identity),
      /repeated Drive item/u,
    );
  });
  await t.test("cycle", async () => {
    const root = "fldcnRoot123";
    await assert.rejects(
      fixture({
        folderItems: {
          [root]: [folder("child", "Child", root)],
          child: [folder(root, "Back to root", "child")],
        },
      }).pdfReader.listKnowledgeFiles(identity),
      /repeated folder/u,
    );
  });
  await t.test("parent", async () => {
    await assert.rejects(
      fixture({
        folderItems: {
          fldcnRoot123: [pdf("outside", "Outside.pdf", "fldcnSibling")],
        },
      }).pdfReader.listKnowledgeFiles(identity),
      /outside the folder/u,
    );
  });
});

test("ignores shortcuts and unsupported objects and never requests sibling roots", async () => {
  const root = "fldcnRoot123";
  const testFixture = fixture({
    folderItems: {
      [root]: [
        { ...folder("shortcut", "Shared alias", root), type: "shortcut" },
        { ...pdf("docx", "Guide.docx", root), type: "docx" },
        folder("nested", "Nested", root),
      ],
      nested: [pdf("nested-pdf", "Nested.pdf", "nested")],
      shortcut: [pdf("forbidden", "Forbidden.pdf", "shortcut")],
      fldcnSibling: [pdf("sibling", "Sibling.pdf", "fldcnSibling")],
    },
  });
  assert.deepEqual(
    await testFixture.pdfReader.listKnowledgeFiles({
      requesterOpenId: "ou_victor",
      tenantKey: "tenant_synvo",
    }),
    [{
      token: "nested-pdf",
      name: "Nested / Nested.pdf",
      version: "1723334400",
    }],
  );
  assert.deepEqual(testFixture.requestedFolders, [root, "nested"]);
});

test("revalidates a Drive PDF before and after the bounded download", async () => {
  const file: NativeDriveItem = {
    token: "boxcnPdf123",
    name: "pilot.pdf",
    type: "file",
    parentToken: "fldcnRoot123",
    ownerId: "ou_victor",
    modifiedTime: "1723334400",
  };
  const stable = fixture({ items: [file] });
  const result = await stable.pdfReader.readKnowledgeFile({
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
    fileToken: file.token,
    expectedVersion: file.modifiedTime!,
    expectedName: file.name,
  });
  assert.equal(result.name, "pilot.pdf");
  assert.equal(result.version, "1723334400");
  assert.equal(result.bytes.toString(), "%PDF-test");
  assert.equal(stable.lists(), 2);
  assert.equal(stable.downloads(), 1);

  const changed = fixture({
    itemResponses: [[file], [{ ...file, modifiedTime: "1723334401" }]],
  });
  await assert.rejects(
    changed.pdfReader.readKnowledgeFile({
      requesterOpenId: "ou_victor",
      tenantKey: "tenant_synvo",
      fileToken: file.token,
      expectedVersion: file.modifiedTime!,
      expectedName: file.name,
    }),
    /changed|available|no longer matches/u,
  );
  assert.equal(changed.downloads(), 1);

  const renamed = fixture({
    itemResponses: [[file], [{ ...file, name: "renamed.pdf" }]],
  });
  await assert.rejects(
    renamed.pdfReader.readKnowledgeFile({
      requesterOpenId: "ou_victor",
      tenantKey: "tenant_synvo",
      fileToken: file.token,
      expectedVersion: file.modifiedTime!,
      expectedName: file.name,
    }),
    /no longer matches/u,
  );
  assert.equal(renamed.downloads(), 1);
});

test("deletes only an unchanged approved PDF and verifies its absence", async () => {
  const file = pdf("boxcnPdf123", "pilot.pdf", "fldcnRoot123");
  const deleted = fixture({ itemResponses: [[file], []] });
  await deleted.pdfReader.deleteKnowledgeFile({
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
    fileToken: file.token,
    expectedVersion: file.modifiedTime!,
    expectedName: file.name,
  });
  assert.equal(deleted.deletions(), 1);
  assert.equal(deleted.lists(), 2);

  const changed = fixture({ itemResponses: [[{ ...file, modifiedTime: "changed" }]] });
  await assert.rejects(
    changed.pdfReader.deleteKnowledgeFile({
      requesterOpenId: "ou_victor",
      tenantKey: "tenant_synvo",
      fileToken: file.token,
      expectedVersion: file.modifiedTime!,
      expectedName: file.name,
    }),
    /approved deletion snapshot/u,
  );
  assert.equal(changed.deletions(), 0);
});

test("does not report deletion when the approved PDF was moved before execution", async () => {
  const testFixture = fixture({ items: [] });
  await assert.rejects(
    testFixture.pdfReader.deleteKnowledgeFile({
      requesterOpenId: "ou_victor",
      tenantKey: "tenant_synvo",
      fileToken: "boxcnPdf123",
      expectedVersion: "1723334400",
      expectedName: "pilot.pdf",
    }),
    /no longer present/u,
  );
  assert.equal(testFixture.deletions(), 0);
});

test("rejects an unauthorized direct analysis consumer before Drive access", async () => {
  for (const identity of [
    { requesterOpenId: "ou_other", tenantKey: "tenant_synvo" },
    { requesterOpenId: "ou_victor", tenantKey: "tenant_other" },
  ]) {
    const testFixture = fixture();
    const result = await testFixture.workflow.analyzeListedFile({
      ...analyzeInput,
      ...identity,
    });
    assert.equal(result.ok, false);
    assert.equal(testFixture.lists(), 0);
    assert.equal(testFixture.downloads(), 0);
  }
});

test("returns a safe result for an unusable OAuth grant", async () => {
  for (const code of ["OAUTH_REQUIRED", "WRONG_SCOPE", "OAUTH_REVOKED"] as const) {
    const testFixture = fixture({
      tokenError: new LarkAuthError(code, "private provider detail"),
    });
    const result = await testFixture.workflow.analyzeListedFile(analyzeInput);
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error.message, /Drive connection/i);
    assert.equal(testFixture.lists(), 0);
    assert.equal(testFixture.downloads(), 0);
  }
});

test("preserves retryability for a temporary direct-analysis failure", async () => {
  const testFixture = fixture({
    listError: driveToolError(
      "LARK_RETRYABLE",
      "private provider detail",
      true,
    ),
  });

  assert.deepEqual(
    await testFixture.workflow.analyzeListedFile(analyzeInput),
    {
      ok: false,
      error: {
        message: "Lark Drive is temporarily unavailable. Please try again in a moment.",
        retryable: true,
      },
    },
  );
});

test("rejects malformed and unallowlisted folder links before Drive access", async () => {
  for (const unapprovedFolderLink of [
    "not a URL",
    "https://example.com/drive/folder/fldcnRoot123",
    "https://synvo-ai.larksuite.com/drive/folder/fldcnSibling",
    "https://synvo-ai.larksuite.com/drive/folder/fldcnNested",
  ]) {
    const testFixture = fixture();
    const result = await testFixture.workflow.analyzeListedFile({
      ...analyzeInput,
      folderLink: unapprovedFolderLink,
    });
    assert.equal(result.ok, false);
    assert.equal(testFixture.lists(), 0);
    assert.equal(testFixture.downloads(), 0);
  }
});

test("requires one exact, unambiguous, owned workspace PDF path", async () => {
  const missing = fixture();
  assert.equal(
    (await missing.workflow.analyzeListedFile({
      ...analyzeInput,
      relativePath: "missing.pdf",
    })).ok,
    false,
  );
  assert.equal(missing.downloads(), 0);

  const duplicate = fixture({
    items: [
      {
        token: "boxcnOne",
        name: "pilot.pdf",
        type: "file",
        parentToken: "fldcnRoot123",
        ownerId: "ou_victor",
      },
      {
        token: "boxcnTwo",
        name: "pilot.pdf",
        type: "file",
        parentToken: "fldcnRoot123",
        ownerId: "ou_victor",
      },
    ],
  });
  assert.equal(
    (await duplicate.workflow.analyzeListedFile(analyzeInput)).ok,
    false,
  );
  assert.equal(duplicate.downloads(), 0);

  for (const { testFixture, relativePath } of [
    { testFixture: fixture({ type: "docx" }), relativePath: "pilot.pdf" },
    { testFixture: fixture({ name: "pilot.txt" }), relativePath: "pilot.txt" },
    { testFixture: fixture({ ownerId: "ou_other" }), relativePath: "pilot.pdf" },
  ]) {
    const result = await testFixture.workflow.analyzeListedFile({
      ...analyzeInput,
      relativePath,
    });
    assert.equal(result.ok, false);
    assert.equal(testFixture.downloads(), 0);
  }
});

test("rejects files outside the root, with a wrong owner, or with a non-PDF type", async () => {
  for (const testFixture of [
    fixture({ token: "another-token" }),
    fixture({ ownerId: "ou_other" }),
    fixture({ type: "docx" }),
    fixture({ name: "pilot.txt" }),
  ]) {
    await testFixture.workflow.process(
      {
        id: "job-id",
        dedupeKey: "analyze-drive-file:om_command",
        runId: null,
        kind: "ANALYZE_DRIVE_FILE",
        chatId: "oc_chat",
        payloadCiphertext: null,
        attemptCount: 1,
        expiresAt: null,
      },
      JSON.stringify({ fileToken: "boxcnPdf123", progressMessageId: "om_progress" }),
      async () => true,
    );
    assert.equal(testFixture.downloads(), 0);
    assert.match(
      testFixture.updates.at(-1) ?? "",
      /directly inside the approved folder|ordinary PDF/,
    );
  }
});

test("recovers one rejected access token and revokes after a second rejection", async () => {
  let calls = 0;
  const rejected = fixture({
    downloadError: driveToolError(
      "UNAUTHORIZED",
      "private",
      false,
      { authFailure: "ACCESS_TOKEN_REJECTED" },
    ),
  });
  await rejected.workflow.process(
    {
      id: "job-id",
      dedupeKey: "analyze-drive-file:om_command",
      runId: null,
      kind: "ANALYZE_DRIVE_FILE",
      chatId: "oc_chat",
      payloadCiphertext: null,
      attemptCount: 1,
      expiresAt: null,
    },
    JSON.stringify({ fileToken: "boxcnPdf123", progressMessageId: "om_progress" }),
    async () => { calls += 1; return true; },
  );
  assert.equal(rejected.recoveries(), 1);
  assert.equal(rejected.rejections(), 1);
  assert.equal(rejected.downloads(), 2);
  assert.equal(calls, 0);
  assert.match(rejected.updates.at(-1) ?? "", /can’t access Lark Drive/u);
});
