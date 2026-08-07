import assert from "node:assert/strict";
import test from "node:test";

import type {
  DriveListPage,
  DriveReader,
  NativeDriveItem,
  NativeDriveMetadata,
} from "./client.js";
import { larkBatchMetadataDocumentLimit } from "./client.js";
import { DriveToolError, normalizeDriveError } from "./errors.js";
import {
  scanAllowlistedFolder,
  type DriveScanContext,
} from "./scan-folder.js";

const rootToken = "root-token";
const productToken = "product-token";
const researchToken = "research-token";
const requesterOpenId = "ou_victor";

const rootItems = [
  {
    token: productToken,
    name: "Product",
    type: "folder",
    parentToken: rootToken,
    ownerId: requesterOpenId,
  },
  {
    token: researchToken,
    name: "Research",
    type: "folder",
    parentToken: rootToken,
    ownerId: requesterOpenId,
  },
  {
    token: "file-1",
    name: "[research] - Agentic Context Engineering Research.pdf",
    type: "file",
    parentToken: rootToken,
    ownerId: requesterOpenId,
  },
  {
    token: "file-2",
    name: "[research] - Anthropic Agentic Engineering.pdf",
    type: "file",
    parentToken: rootToken,
    ownerId: requesterOpenId,
  },
  {
    token: "file-3",
    name: "[product] - Local_Cocoa_PDF_Chunking_Technical_Guide.pdf",
    type: "file",
    parentToken: rootToken,
    ownerId: requesterOpenId,
  },
  {
    token: "file-4",
    name: "[product] - Local_Cocoa_Technical_Onboarding_Guide.pdf",
    type: "file",
    parentToken: rootToken,
    ownerId: requesterOpenId,
  },
];

function metadataFor(
  token: string,
  type: string,
  title: string,
  ownerId = requesterOpenId,
): NativeDriveMetadata {
  return {
    token,
    type,
    title,
    ownerId,
    createdTime: "1720000000",
    modifiedTime: "1720000100",
  };
}

class FixtureReader implements DriveReader {
  readonly folders: Map<string, typeof rootItems>;
  readonly metadata: NativeDriveMetadata[];
  readonly finalRootItems?: typeof rootItems;
  rootReads = 0;

  constructor(options: {
    rootItems?: typeof rootItems;
    finalRootItems?: typeof rootItems;
    metadata?: NativeDriveMetadata[];
  } = {}) {
    const initialRootItems = options.rootItems ?? rootItems;
    this.folders = new Map([
      [rootToken, initialRootItems],
      [productToken, []],
      [researchToken, []],
    ]);
    this.finalRootItems = options.finalRootItems;
    this.metadata =
      options.metadata ??
      [
        metadataFor(rootToken, "folder", "Test_Synvo_AI_Assistant"),
        ...initialRootItems.map((item) =>
          metadataFor(item.token, item.type, item.name, item.ownerId),
        ),
      ];
  }

  async listFolderPage(input: { folderToken: string }): Promise<DriveListPage> {
    if (input.folderToken === rootToken) {
      this.rootReads += 1;
      if (this.rootReads > 1 && this.finalRootItems) {
        return { items: this.finalRootItems, hasMore: false };
      }
    }
    const items = this.folders.get(input.folderToken);
    if (!items) {
      throw new Error("Unknown fixture folder");
    }
    return { items, hasMore: false };
  }

  async getMetadata(): Promise<NativeDriveMetadata[]> {
    return this.metadata;
  }
}

function scanContext(
  overrides: Partial<DriveScanContext> = {},
): DriveScanContext {
  return {
    runId: "4d872758-1f71-4ed8-b141-a2d193ceea91",
    requesterOpenId,
    rootToken,
    accessToken: "internal-access-token",
    async recoverAccessToken() {
      throw new Error("Unexpected token recovery");
    },
    async markAccessTokenRejected() {
      throw new Error("Unexpected token rejection");
    },
    ...overrides,
  };
}

test("returns the exact bounded read-only pilot inventory", async () => {
  const inventory = await scanAllowlistedFolder(
    new FixtureReader(),
    scanContext(),
  );

  assert.equal(inventory.complete, true);
  assert.equal(inventory.baseline_matches, true);
  assert.deepEqual(inventory.summary, {
    root_folder_count: 2,
    root_file_count: 4,
    root_skipped_count: 0,
    destination_child_count: 0,
  });
  assert.deepEqual(
    inventory.destinations.map((folder) => [folder.name, folder.child_count]),
    [
      ["Product", 0],
      ["Research", 0],
    ],
  );
  assert.equal(inventory.files.length, 4);
  assert.equal(JSON.stringify(inventory).includes("internal-access-token"), false);
  assert.equal(JSON.stringify(inventory).includes(rootToken), false);
  assert.equal(JSON.stringify(inventory).includes(productToken), false);
});

test("reports an unexpected starting hierarchy without repairing it", async () => {
  const inventory = await scanAllowlistedFolder(
    new FixtureReader({
      rootItems: [
        ...rootItems,
        {
          token: "unexpected-folder",
          name: "Unexpected",
          type: "folder",
          parentToken: rootToken,
          ownerId: requesterOpenId,
        },
      ],
    }),
    scanContext(),
  );

  assert.equal(inventory.baseline_matches, false);
  assert.equal(
    inventory.issues.some((issue) => issue.includes("unexpected root folder")),
    true,
  );
});

test("reports each bounded baseline hierarchy violation", async (t) => {
  const cases: ReadonlyArray<{
    name: string;
    items: typeof rootItems;
    issue: string;
  }> = [
    {
      name: "missing Research destination",
      items: rootItems.filter((item) => item.token !== researchToken),
      issue: "Expected exactly one Research destination folder, found 0",
    },
    {
      name: "duplicate Product destination",
      items: [
        ...rootItems,
        {
          token: "duplicate-product-token",
          name: "Product",
          type: "folder",
          parentToken: rootToken,
          ownerId: requesterOpenId,
        },
      ],
      issue: "Expected exactly one Product destination folder, found 2",
    },
    {
      name: "unsupported root object",
      items: [
        ...rootItems,
        {
          token: "shortcut-token",
          name: "Unexpected shortcut",
          type: "shortcut",
          parentToken: rootToken,
          ownerId: requesterOpenId,
        },
      ],
      issue: "unsupported root item",
    },
    {
      name: "fifth root file",
      items: [
        ...rootItems,
        {
          token: "file-5",
          name: "Unexpected fifth file.pdf",
          type: "file",
          parentToken: rootToken,
          ownerId: requesterOpenId,
        },
      ],
      issue: "Expected four root files, found 5",
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      const inventory = await scanAllowlistedFolder(
        new FixtureReader({ rootItems: testCase.items }),
        scanContext(),
      );

      assert.equal(inventory.baseline_matches, false);
      assert.equal(
        inventory.issues.some((issue) => issue.includes(testCase.issue)),
        true,
      );
    });
  }
});

test("reports a destination that is already nonempty", async () => {
  const reader = new FixtureReader();
  reader.folders.set(productToken, [
    {
      token: "existing-product-file",
      name: "Existing.pdf",
      type: "file",
      parentToken: productToken,
      ownerId: requesterOpenId,
    },
  ]);

  const inventory = await scanAllowlistedFolder(reader, scanContext());

  assert.equal(inventory.baseline_matches, false);
  assert.equal(inventory.summary.destination_child_count, 1);
  assert.equal(
    inventory.issues.some((issue) => issue.includes("not empty")),
    true,
  );
});

test("rejects a four-file baseline when any known fixture name differs", async () => {
  const changedRootItems = rootItems.map((item) =>
    item.token === "file-1" ? { ...item, name: "[research] - Renamed.pdf" } : item,
  );
  const inventory = await scanAllowlistedFolder(
    new FixtureReader({ rootItems: changedRootItems }),
    scanContext(),
  );

  assert.equal(inventory.summary.root_file_count, 4);
  assert.equal(inventory.baseline_matches, false);
  assert.equal(
    inventory.issues.some((issue) => issue.includes("names or types")),
    true,
  );
});

test("reports missing and mismatched owner signals", async () => {
  const metadata = [
    metadataFor(rootToken, "folder", "Test_Synvo_AI_Assistant", "someone-else"),
    ...rootItems.map((item) => metadataFor(item.token, item.type, item.name, "")),
  ];
  const noListOwners = rootItems.map(({ ownerId: _ownerId, ...item }) => item);
  const inventory = await scanAllowlistedFolder(
    new FixtureReader({ rootItems: noListOwners as typeof rootItems, metadata }),
    scanContext(),
  );

  assert.equal(inventory.baseline_matches, false);
  assert.equal(inventory.root.owner_verification, "mismatched");
  assert.equal(
    inventory.issues.some((issue) => issue.includes("omitted")),
    true,
  );
});

test("caps root inventory so root metadata and child metadata fit one Lark batch", async () => {
  const boundaryItems: NativeDriveItem[] = Array.from(
    { length: larkBatchMetadataDocumentLimit - 1 },
    (_, index) => ({
      token: `boundary-file-${index}`,
      name: `Boundary ${index}.pdf`,
      type: "file",
      parentToken: rootToken,
      ownerId: requesterOpenId,
    }),
  );
  let requestedPageSize = 0;
  let metadataDocumentCount = 0;
  const reader: DriveReader = {
    async listFolderPage(input) {
      assert.equal(input.folderToken, rootToken);
      requestedPageSize = input.pageSize;
      return { items: boundaryItems, hasMore: false };
    },
    async getMetadata(input) {
      metadataDocumentCount = input.documents.length;
      return input.documents.map((document) =>
        metadataFor(
          document.token,
          document.type,
          document.token === rootToken
            ? "Test_Synvo_AI_Assistant"
            : document.token,
        ),
      );
    },
  };

  const inventory = await scanAllowlistedFolder(reader, scanContext());

  assert.equal(
    requestedPageSize,
    larkBatchMetadataDocumentLimit - 1,
  );
  assert.equal(metadataDocumentCount, larkBatchMetadataDocumentLimit);
  assert.equal(inventory.root.child_count, larkBatchMetadataDocumentLimit - 1);
});

test("fails the baseline when metadata and folder listing titles race", async () => {
  const metadata = [
    metadataFor(rootToken, "folder", "Test_Synvo_AI_Assistant"),
    ...rootItems.map((item) =>
      metadataFor(
        item.token,
        item.type,
        item.token === "file-1" ? "Renamed during scan.pdf" : item.name,
        item.ownerId,
      ),
    ),
  ];

  const inventory = await scanAllowlistedFolder(
    new FixtureReader({ metadata }),
    scanContext(),
  );

  assert.equal(inventory.baseline_matches, false);
  assert.equal(
    inventory.issues.some((issue) => issue.includes("changed between Lark reads")),
    true,
  );
});

test("fails when an approved destination leaves the root during its scan", async () => {
  const inventory = await scanAllowlistedFolder(
    new FixtureReader({
      finalRootItems: rootItems.filter((item) => item.token !== productToken),
    }),
    scanContext(),
  );

  assert.equal(inventory.baseline_matches, false);
  assert.equal(
    inventory.issues.some((issue) =>
      issue.includes("destination folder(s) moved or changed identity"),
    ),
    true,
  );
});

test("fails when an approved destination gains a child during its scan", async () => {
  const delegate = new FixtureReader();
  let productReads = 0;
  const reader: DriveReader = {
    async listFolderPage(input) {
      if (input.folderToken === productToken) {
        productReads += 1;
        if (productReads === 2) {
          assert.equal(delegate.rootReads, 2);
          return {
            items: [
              {
                token: "racing-file",
                name: "Added during scan.pdf",
                type: "file",
                parentToken: productToken,
                ownerId: requesterOpenId,
              },
            ],
            hasMore: false,
          };
        }
      }
      return delegate.listFolderPage(input);
    },
    getMetadata: () => delegate.getMetadata(),
  };

  const inventory = await scanAllowlistedFolder(reader, scanContext());

  assert.equal(productReads, 2);
  assert.equal(inventory.baseline_matches, false);
  assert.equal(
    inventory.issues.some((issue) =>
      issue.includes("destination folder(s) changed contents"),
    ),
    true,
  );
});

for (const rejection of [
  { name: "HTTP 401", error: { status: 401 } },
  { name: "provider invalid-token code", error: { code: 99991679 } },
]) {
  test(`recovers once and retries one affected read after ${rejection.name}`, async () => {
    const delegate = new FixtureReader();
    const observedTokens: string[] = [];
    let rejected = false;
    let recoverCalls = 0;
    let markCalls = 0;
    const reader: DriveReader = {
      async listFolderPage(input) {
        observedTokens.push(input.accessToken);
        if (!rejected) {
          rejected = true;
          throw normalizeDriveError(rejection.error);
        }
        return delegate.listFolderPage(input);
      },
      getMetadata: () => delegate.getMetadata(),
    };

    const inventory = await scanAllowlistedFolder(
      reader,
      scanContext({
        accessToken: "rejected-token",
        async recoverAccessToken(rejectedAccessToken) {
          recoverCalls += 1;
          assert.equal(rejectedAccessToken, "rejected-token");
          return "recovered-token";
        },
        async markAccessTokenRejected() {
          markCalls += 1;
        },
      }),
    );

    assert.equal(inventory.baseline_matches, true);
    assert.equal(recoverCalls, 1);
    assert.equal(markCalls, 0);
    assert.deepEqual(observedTokens.slice(0, 2), [
      "rejected-token",
      "recovered-token",
    ]);
    assert.equal(observedTokens.slice(2).every((token) => token === "recovered-token"), true);
  });
}

test("revokes after the one recovered token retry is also rejected", async () => {
  let readCalls = 0;
  let recoverCalls = 0;
  let rejectedToken = "";
  const reader: DriveReader = {
    async listFolderPage() {
      readCalls += 1;
      throw normalizeDriveError({ status: 401 });
    },
    async getMetadata() {
      throw new Error("Metadata should not be requested");
    },
  };

  await assert.rejects(
    scanAllowlistedFolder(
      reader,
      scanContext({
        accessToken: "rejected-token",
        async recoverAccessToken() {
          recoverCalls += 1;
          return "recovered-token";
        },
        async markAccessTokenRejected(token) {
          rejectedToken = token;
        },
      }),
    ),
    (error: unknown) =>
      error instanceof DriveToolError && error.safeError.code === "OAUTH_REVOKED",
  );
  assert.equal(readCalls, 2);
  assert.equal(recoverCalls, 1);
  assert.equal(rejectedToken, "recovered-token");
});

test("never recovers an access token after a Drive 403", async () => {
  let recoverCalls = 0;
  const reader: DriveReader = {
    async listFolderPage() {
      throw normalizeDriveError({ status: 403, code: 99991679 });
    },
    async getMetadata() {
      throw new Error("Metadata should not be requested");
    },
  };

  await assert.rejects(
    scanAllowlistedFolder(
      reader,
      scanContext({
        async recoverAccessToken() {
          recoverCalls += 1;
          return "must-not-be-used";
        },
      }),
    ),
    (error: unknown) =>
      error instanceof DriveToolError &&
      error.safeError.code === "UNAUTHORIZED" &&
      error.metadata.authFailure === "FORBIDDEN",
  );
  assert.equal(recoverCalls, 0);
});
