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
import { AnalyzeDriveFileWorkflow } from "./workflow.js";

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
  async storePayload(): Promise<boolean> { return true; }
  async complete(): Promise<boolean> { return true; }
  async retry(): Promise<boolean> { return true; }
  async fail(): Promise<boolean> { return true; }
}

function fixture(options: {
  ownerId?: string;
  type?: string;
  name?: string;
  token?: string;
  parentToken?: string;
  items?: NativeDriveItem[];
  downloadError?: unknown;
  tokenError?: unknown;
} = {}) {
  const queue = new FakeQueue();
  const updates: string[] = [];
  let downloads = 0;
  let recoveries = 0;
  let rejections = 0;
  let lists = 0;
  const driveReader: DriveReader = {
    async listFolderPage() {
      lists += 1;
      return {
        items: options.items ?? [{
            token: options.token ?? "boxcnPdf123",
            name: options.name ?? "pilot.pdf",
            type: options.type ?? "file",
            parentToken: options.parentToken ?? "fldcnRoot123",
            ownerId: options.ownerId ?? "ou_victor",
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
  const workflow = new AnalyzeDriveFileWorkflow({
    queue,
    cipher,
    tokenBroker: {
      async getAccessToken() {
        if (options.tokenError) {
          throw options.tokenError;
        }
        return "access-one";
      },
      async recoverAccessToken() { recoveries += 1; return "access-two"; },
      async markAccessTokenRejected() { rejections += 1; },
    },
    driveReader,
    downloader,
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
    extractPdf: async () => ({ text: "Extracted", pageCount: 2, truncated: false }),
  });
  return {
    workflow,
    queue,
    updates,
    downloads: () => downloads,
    lists: () => lists,
    recoveries: () => recoveries,
    rejections: () => rejections,
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
  fileName: "pilot.pdf",
};

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
    assert.match(result.ok ? "" : result.error.message, /authorization/i);
    assert.equal(testFixture.lists(), 0);
    assert.equal(testFixture.downloads(), 0);
  }
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

test("requires one exact, unambiguous, owned root PDF filename", async () => {
  const missing = fixture();
  assert.equal(
    (await missing.workflow.analyzeListedFile({
      ...analyzeInput,
      fileName: "missing.pdf",
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

  for (const { testFixture, fileName } of [
    { testFixture: fixture({ type: "docx" }), fileName: "pilot.pdf" },
    { testFixture: fixture({ name: "pilot.txt" }), fileName: "pilot.txt" },
    { testFixture: fixture({ ownerId: "ou_other" }), fileName: "pilot.pdf" },
    { testFixture: fixture({ parentToken: "fldcnNested" }), fileName: "pilot.pdf" },
  ]) {
    const result = await testFixture.workflow.analyzeListedFile({
      ...analyzeInput,
      fileName,
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
    assert.match(testFixture.updates.at(-1) ?? "", /outside|ordinary PDF/);
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
  assert.match(rejected.updates.at(-1) ?? "", /authorization is unavailable/);
});
