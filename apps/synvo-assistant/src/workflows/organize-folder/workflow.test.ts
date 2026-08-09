import assert from "node:assert/strict";
import test from "node:test";

import {
  ORGANIZE_FOLDER_USER_SCOPES,
  TokenCipher,
  type LockedGrantResult,
  type OAuthGrantStore,
  type SaveOAuthGrantInput,
  type StoredOAuthGrant,
} from "../../lark/auth/index.js";
import {
  digestFolderToken,
  DriveMoveError,
  observeAllowlistedFolder,
  type DriveListPage,
  type DriveMover,
  type DriveReader,
  type NativeDriveItem,
  type NativeDriveMetadata,
} from "../../lark/drive/index.js";
import type { AppConfig } from "../../config.js";
import type {
  InventoryRun,
  OAuthSession,
  OrganizeFolderRepository,
  ProposalDecisionStoreResult,
  StoreInventoryResultInput,
} from "./repository.js";
import {
  driveFolderInventoryResultAssociatedData,
  type DriveFolderInventoryResult,
} from "./contracts.js";
import { OrganizeFolderWorkflow } from "./workflow.js";
import {
  buildOrganizeFolderProposal,
  organizeFolderProposalAssociatedData,
  type OrganizeFolderProposal,
} from "./proposal.js";
import {
  createExecutionRecord,
  executionAssociatedData,
  type ExecutionStatus,
  type UndoStatus,
} from "./execution.js";

const runId = "4d872758-1f71-4ed8-b141-a2d193ceea91";
const fileIdentityDigest = "a".repeat(64);
const productIdentityDigest = "b".repeat(64);
const researchIdentityDigest = "c".repeat(64);
const config: AppConfig = {
  appId: "cli_0123456789abcdef",
  appSecret: "app-secret",
  databaseUrl: "postgresql://local",
  httpHost: "127.0.0.1",
  httpPort: 3000,
  larkOAuthRedirectUri: "http://localhost:3000/oauth/lark/callback",
  oauthTokenEncryptionKey: Buffer.alloc(32, 1).toString("base64url"),
  authorizedOpenId: "ou_victor",
  authorizedTenantKey: "tenant_synvo",
  organizeFolderRootToken: "fldcnRoot123",
  organizeFolderWriteEnabled: false,
  llmApiKey: "nvapi-test-key-that-is-long-enough",
};

class StubGrantStore implements OAuthGrantStore {
  grant: StoredOAuthGrant | null = null;

  async findBySubject(): Promise<StoredOAuthGrant | null> {
    return this.grant;
  }
  async save(input: SaveOAuthGrantInput): Promise<StoredOAuthGrant> {
    return input;
  }
  async withLockedGrant<T>(
    _openId: string,
    _tenantKey: string,
    operation: (grant: StoredOAuthGrant) => Promise<LockedGrantResult<T>>,
  ): Promise<T> {
    if (!this.grant) throw new Error("No grant");
    return (await operation(this.grant)).result;
  }
}

class StubRepository implements OrganizeFolderRepository {
  existingRun = false;
  readyRunId: string | null = null;
  inventoryRun: InventoryRun | null = null;
  storedResult: string | null = null;
  storedInput: StoreInventoryResultInput | null = null;
  decisionResult: ProposalDecisionStoreResult = { kind: "not_found" };
  decisionInput: {
    proposalId: string;
    requesterOpenId: string;
    tenantKey: string;
    decision: "APPROVED" | "REJECTED";
    decidedAt: Date;
    executionJobId?: string;
  } | null = null;
  staleCalls = 0;

  async hasRunForMessage(): Promise<boolean> {
    return this.existingRun;
  }
  async findInventoryRunById(): Promise<InventoryRun | null> {
    return this.inventoryRun;
  }
  async createReadyRun(input: { id: string }): Promise<boolean> {
    this.readyRunId = input.id;
    return true;
  }
  async createAwaitingOAuthRun(): Promise<boolean> { return true; }
  async startOAuthSession(): Promise<OAuthSession | null> { return null; }
  async consumeOAuthSession(): Promise<OAuthSession | null> { return null; }
  async bindGrantToRun(): Promise<void> {}
  async markRunFailed(): Promise<void> {}
  async storeInventoryResult(input: StoreInventoryResultInput): Promise<boolean> {
    this.storedResult = input.resultCiphertext;
    this.storedInput = input;
    return true;
  }
  async recordProposalDecision(input: {
    proposalId: string;
    requesterOpenId: string;
    tenantKey: string;
    decision: "APPROVED" | "REJECTED";
    decidedAt: Date;
    executionJobId?: string;
  }): Promise<ProposalDecisionStoreResult> {
    this.decisionInput = input;
    return this.decisionResult;
  }
  async markProposalStale(): Promise<boolean> {
    if (!this.inventoryRun) return false;
    this.staleCalls += 1;
    this.inventoryRun.proposalStatus = "STALE";
    this.inventoryRun.executionStatus = "STALE";
    return true;
  }
  async startExecution(): Promise<boolean> {
    if (!this.inventoryRun) return false;
    this.inventoryRun.executionStatus = "RUNNING";
    return true;
  }
  async storeExecution(input: {
    status: ExecutionStatus;
    ciphertext: string | null;
  }): Promise<boolean> {
    if (!this.inventoryRun) return false;
    this.inventoryRun.executionStatus = input.status;
    this.inventoryRun.executionCiphertext = input.ciphertext;
    return true;
  }
  async requestUndo(input: { executionCiphertext: string }) {
    if (!this.inventoryRun?.executionCiphertext) {
      return { kind: "not_ready" } as const;
    }
    if (this.inventoryRun.undoStatus) {
      return {
        kind: "existing",
        status: this.inventoryRun.undoStatus,
      } as const;
    }
    this.inventoryRun.executionCiphertext = input.executionCiphertext;
    this.inventoryRun.undoStatus = "REQUESTED";
    return { kind: "recorded" } as const;
  }
  async startUndo(): Promise<boolean> {
    if (!this.inventoryRun) return false;
    this.inventoryRun.undoStatus = "RUNNING";
    return true;
  }
  async storeUndo(input: {
    status: UndoStatus;
    ciphertext: string;
  }): Promise<boolean> {
    if (!this.inventoryRun) return false;
    this.inventoryRun.undoStatus = input.status;
    this.inventoryRun.executionCiphertext = input.ciphertext;
    return true;
  }
}

const noOpReader: DriveReader = {
  async listFolderPage() { throw new Error("unused"); },
  async getMetadata() { throw new Error("unused"); },
};
const noOpMover: DriveMover = {
  async moveFile() { throw new Error("unused"); },
};

class MutablePilotDrive implements DriveReader, DriveMover {
  readonly items: NativeDriveItem[] = [
    {
      token: "folder-product",
      name: "Product",
      type: "folder",
      parentToken: "fldcnRoot123",
      ownerId: "ou_victor",
    },
    {
      token: "folder-research",
      name: "Research",
      type: "folder",
      parentToken: "fldcnRoot123",
      ownerId: "ou_victor",
    },
    {
      token: "file-product-one",
      name: "[product] - Local_Cocoa_PDF_Chunking_Technical_Guide.pdf",
      type: "file",
      parentToken: "fldcnRoot123",
      ownerId: "ou_victor",
      modifiedTime: "2026-08-07T00:00:00.000Z",
    },
    {
      token: "file-product-two",
      name: "[product] - Local_Cocoa_Technical_Onboarding_Guide.pdf",
      type: "file",
      parentToken: "fldcnRoot123",
      ownerId: "ou_victor",
      modifiedTime: "2026-08-07T00:00:00.000Z",
    },
    {
      token: "file-research-one",
      name: "[research] - Agentic Context Engineering Research.pdf",
      type: "file",
      parentToken: "fldcnRoot123",
      ownerId: "ou_victor",
      modifiedTime: "2026-08-07T00:00:00.000Z",
    },
    {
      token: "file-research-two",
      name: "[research] - Anthropic Agentic Engineering.pdf",
      type: "file",
      parentToken: "fldcnRoot123",
      ownerId: "ou_victor",
      modifiedTime: "2026-08-07T00:00:00.000Z",
    },
  ];
  readonly moveCalls: Array<{
    fileToken: string;
    destinationFolderToken: string;
  }> = [];
  failure: {
    call: number;
    error: DriveMoveError;
    moveBeforeThrow?: boolean;
  } | null = null;
  skipMoveOnCall: number | null = null;

  async listFolderPage(input: {
    folderToken: string;
  }): Promise<DriveListPage> {
    return {
      items: this.items
        .filter((item) => item.parentToken === input.folderToken)
        .map((item) => ({ ...item })),
      hasMore: false,
    };
  }

  async getMetadata(): Promise<NativeDriveMetadata> {
    return {
      token: "fldcnRoot123",
      type: "folder",
      title: "Test_Synvo_AI_Assistant",
      ownerId: "ou_victor",
      createdTime: "2026-08-07T00:00:00.000Z",
      modifiedTime: "2026-08-07T00:00:00.000Z",
    };
  }

  async moveFile(input: {
    fileToken: string;
    destinationFolderToken: string;
  }): Promise<void> {
    this.moveCalls.push({
      fileToken: input.fileToken,
      destinationFolderToken: input.destinationFolderToken,
    });
    const failure = this.failure?.call === this.moveCalls.length
      ? this.failure
      : null;
    if (
      (!failure || failure.moveBeforeThrow) &&
      this.skipMoveOnCall !== this.moveCalls.length
    ) {
      this.relocate(input.fileToken, input.destinationFolderToken);
    }
    if (failure) {
      throw failure.error;
    }
  }

  relocate(fileToken: string, destinationFolderToken: string): void {
    const file = this.items.find((item) => item.token === fileToken);
    if (!file) throw new Error("Unknown test file");
    file.parentToken = destinationFolderToken;
  }

  rename(fileToken: string, name: string): void {
    const file = this.items.find((item) => item.token === fileToken);
    if (!file) throw new Error("Unknown test file");
    file.name = name;
  }

  countFiles(folderToken: string): number {
    return this.items.filter(
      (item) => item.type === "file" && item.parentToken === folderToken,
    ).length;
  }
}

async function approvedExecutionFixture(options: {
  writeEnabled?: boolean;
} = {}) {
  const drive = new MutablePilotDrive();
  const repository = new StubRepository();
  const cipher = new TokenCipher(Buffer.alloc(32, 7));
  const observation = await observeAllowlistedFolder(drive, {
    runId,
    requesterOpenId: "ou_victor",
    rootToken: config.organizeFolderRootToken,
    accessToken: "access-token",
    async recoverAccessToken() { return "recovered-token"; },
    async markAccessTokenRejected() {},
  });
  const proposal = buildOrganizeFolderProposal(observation.inventory, runId);
  const result: DriveFolderInventoryResult = {
    ok: true,
    inventory: observation.inventory,
  };
  repository.inventoryRun = {
    id: runId,
    chatId: "oc_chat",
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
    state: "COMPLETED",
    rootTokenDigest: digestFolderToken(config.organizeFolderRootToken),
    oauthGrantId: "grant-id",
    oauthGrantMatchesSubject: true,
    resultCiphertext: cipher.encrypt(
      JSON.stringify(result),
      driveFolderInventoryResultAssociatedData(runId),
    ),
    proposalCiphertext: cipher.encrypt(
      JSON.stringify(proposal),
      organizeFolderProposalAssociatedData(runId),
    ),
    proposalStatus: "APPROVED",
    executionCiphertext: null,
    executionStatus: "QUEUED",
    undoStatus: null,
  };
  const fixture = createWorkflow({
    repository,
    cipher,
    driveReader: drive,
    driveMover: drive,
    configOverride: {
      organizeFolderWriteEnabled: options.writeEnabled ?? true,
    },
  });
  return { ...fixture, drive, observation, proposal };
}

function request(folderLink: string) {
  return {
    messageId: "om_message",
    chatId: "oc_chat",
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
    folderLink,
  };
}

function grant(scopes: readonly string[] = ORGANIZE_FOLDER_USER_SCOPES): StoredOAuthGrant {
  return {
    id: "4e41b888-b1b9-46cf-aac8-3e0f35e0d266",
    openId: "ou_victor",
    tenantKey: "tenant_synvo",
    accessTokenCiphertext: "ciphertext",
    refreshTokenCiphertext: "ciphertext",
    grantedScopes: [...scopes],
    accessExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    refreshExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    refreshVersion: 1,
    revokedAt: null,
  };
}

function createWorkflow(options: {
  grant?: StoredOAuthGrant | null;
  configOverride?: Partial<AppConfig>;
  repository?: StubRepository;
  cipher?: TokenCipher;
  driveReader?: DriveReader;
  driveMover?: DriveMover;
} = {}) {
  const grantStore = new StubGrantStore();
  grantStore.grant = options.grant ?? null;
  const repository = options.repository ?? new StubRepository();
  const cipher = options.cipher ?? new TokenCipher(Buffer.alloc(32, 2));
  const workflow = new OrganizeFolderWorkflow({
    config: { ...config, ...options.configOverride },
    grantStore,
    repository,
    oauthService: {
      async createPendingAuthorization() {
        return true;
      },
    },
    tokenBroker: {
      async getAccessToken() { return "access-token"; },
      async recoverAccessToken() { return "recovered-token"; },
      async markAccessTokenRejected() {},
    },
    cipher,
    driveReader: options.driveReader ?? noOpReader,
    driveMover: options.driveMover ?? noOpMover,
  });
  return { workflow, repository, cipher };
}

test("rejects external and unallowlisted folder links", async () => {
  const { workflow } = createWorkflow();
  for (const link of [
    "https://example.com/drive/folder/fldcnRoot123",
    "https://synvo-ai.larksuite.com/drive/folder/fldcnSibling",
  ]) {
    assert.equal((await workflow.start(request(link))).kind, "rejected");
  }
});

test("applies the same pilot boundaries to direct inventory consumers", async () => {
  const { workflow } = createWorkflow({
    configOverride: {
      authorizedOpenId: "ou_victor",
      authorizedTenantKey: "tenant_synvo",
    },
  });

  const wrongUser = await workflow.readInventory({
    requesterOpenId: "ou_other",
    tenantKey: "tenant_synvo",
    folderLink:
      "https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123",
  });
  assert.equal(wrongUser.ok, false);
  assert.equal(wrongUser.error?.code, "UNAUTHORIZED");

  const wrongRoot = await workflow.readInventory({
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
    folderLink:
      "https://synvo-ai.larksuite.com/drive/folder/fldcnSibling",
  });
  assert.equal(wrongRoot.ok, false);
  assert.equal(wrongRoot.error?.code, "ROOT_NOT_ALLOWLISTED");
});

test("starts authorization when no usable grant exists", async () => {
  const { workflow } = createWorkflow();
  const result = await workflow.start(
    request("https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123"),
  );
  assert.equal(result.kind, "authorization_required");
});

test("creates an inventory run only for the exact Drive PDF grant", async () => {
  const accepted = createWorkflow({ grant: grant() });
  assert.equal(
    (await accepted.workflow.start(
      request("https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123"),
    )).kind,
    "inventory_ready",
  );
  assert.ok(accepted.repository.readyRunId);

  const broader = createWorkflow({
    grant: grant([...ORGANIZE_FOLDER_USER_SCOPES, "space:document:delete"]),
  });
  assert.equal(
    (await broader.workflow.start(
      request("https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123"),
    )).kind,
    "authorization_required",
  );
});

test("does not create another run for a duplicate Lark command", async () => {
  const repository = new StubRepository();
  repository.existingRun = true;
  const { workflow } = createWorkflow({ repository, grant: grant() });

  const result = await workflow.start(
    request("https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123"),
  );
  assert.equal(result.kind, "duplicate");
  assert.equal(repository.readyRunId, null);
});

test("uses a stored terminal result without scanning again", async () => {
  const repository = new StubRepository();
  const cipher = new TokenCipher(Buffer.alloc(32, 3));
  const result: DriveFolderInventoryResult = {
    ok: false,
    error: {
      code: "OAUTH_REVOKED",
      message: "The Lark authorization is no longer usable.",
      retryable: false,
    },
  };
  repository.inventoryRun = {
    id: runId,
    chatId: "oc_chat",
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
    state: "FAILED_NO_CHANGE",
    rootTokenDigest: digestFolderToken(config.organizeFolderRootToken),
    oauthGrantId: null,
    oauthGrantMatchesSubject: false,
    resultCiphertext: cipher.encrypt(
      JSON.stringify(result),
      driveFolderInventoryResultAssociatedData(runId),
    ),
    proposalCiphertext: null,
    proposalStatus: null,
    executionCiphertext: null,
    executionStatus: null,
    undoStatus: null,
  };
  const { workflow } = createWorkflow({ repository, cipher });
  assert.equal(
    await workflow.buildProposalMessage(runId),
    "The Lark authorization is no longer usable.\n\nNo files were changed.",
  );
});

test("reuses the stored proposal on a delivery retry", async () => {
  const repository = new StubRepository();
  const cipher = new TokenCipher(Buffer.alloc(32, 4));
  const proposal: OrganizeFolderProposal = {
    proposal_id: runId,
    moves: [
      {
        file_ref: "f1",
        file_identity_digest: fileIdentityDigest,
        file_name: "[product] - One.pdf",
        destination_ref: "d1",
        destination_identity_digest: productIdentityDigest,
        destination_name: "Product",
      },
      {
        file_ref: "f2",
        file_identity_digest: fileIdentityDigest,
        file_name: "[product] - Two.pdf",
        destination_ref: "d1",
        destination_identity_digest: productIdentityDigest,
        destination_name: "Product",
      },
      {
        file_ref: "f3",
        file_identity_digest: fileIdentityDigest,
        file_name: "[research] - Three.pdf",
        destination_ref: "d2",
        destination_identity_digest: researchIdentityDigest,
        destination_name: "Research",
      },
      {
        file_ref: "f4",
        file_identity_digest: fileIdentityDigest,
        file_name: "[research] - Four.pdf",
        destination_ref: "d2",
        destination_identity_digest: researchIdentityDigest,
        destination_name: "Research",
      },
    ],
  };
  repository.inventoryRun = {
    id: runId,
    chatId: "oc_chat",
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
    state: "COMPLETED",
    rootTokenDigest: digestFolderToken(config.organizeFolderRootToken),
    oauthGrantId: "grant-id",
    oauthGrantMatchesSubject: true,
    resultCiphertext: null,
    proposalCiphertext: cipher.encrypt(
      JSON.stringify(proposal),
      organizeFolderProposalAssociatedData(runId),
    ),
    proposalStatus: "PROPOSED",
    executionCiphertext: null,
    executionStatus: null,
    undoStatus: null,
  };
  const { workflow } = createWorkflow({ repository, cipher });

  const first = await workflow.buildProposalMessage(runId);
  const retry = await workflow.buildProposalMessage(runId);
  assert.equal(first, retry);
  assert.match(first, /Product \(2 files\)/);
  assert.match(first, /Research \(2 files\)/);
  assert.equal(repository.storedInput, null);
});

test("records approval and rejection intent without a Drive mutation", async () => {
  for (const decision of ["APPROVED", "REJECTED"] as const) {
    const repository = new StubRepository();
    repository.decisionResult = {
      kind: "recorded",
      status: decision,
      executionQueued: false,
    };
    const { workflow } = createWorkflow({
      repository,
      configOverride: {
        authorizedOpenId: "ou_victor",
        authorizedTenantKey: "tenant_synvo",
      },
    });

    const reply = await workflow.decideProposal({
      proposalId: runId,
      requesterOpenId: "ou_victor",
      tenantKey: "tenant_synvo",
      decision,
    });
    assert.equal(repository.decisionInput?.decision, decision);
    assert.match(reply, new RegExp(decision.toLowerCase()));
    assert.match(reply, /No files were moved|No execution was queued/);
  }
});

test("allows only the configured pilot actor and tenant to decide", async () => {
  const repository = new StubRepository();
  const { workflow } = createWorkflow({
    repository,
    configOverride: {
      authorizedOpenId: "ou_victor",
      authorizedTenantKey: "tenant_synvo",
    },
  });

  assert.match(
    await workflow.decideProposal({
      proposalId: runId,
      requesterOpenId: "ou_other",
      tenantKey: "tenant_synvo",
      decision: "APPROVED",
    }),
    /not authorized/,
  );
  assert.match(
    await workflow.decideProposal({
      proposalId: runId,
      requesterOpenId: "ou_victor",
      tenantKey: "other_tenant",
      decision: "APPROVED",
    }),
    /tenant is not authorized/,
  );
  assert.equal(repository.decisionInput, null);
});

test("handles duplicate, conflicting, stale, malformed, missing, and unknown decisions safely", async () => {
  const cases: Array<{
    result: ProposalDecisionStoreResult;
    decision?: "APPROVED" | "REJECTED";
    proposalId?: string;
    expected: RegExp;
  }> = [
    {
      result: {
        kind: "existing",
        status: "APPROVED",
      },
      expected: /already approved/,
    },
    {
      result: {
        kind: "existing",
        status: "REJECTED",
      },
      expected: /conflicting decision was not recorded/,
    },
    {
      result: {
        kind: "existing",
        status: "STALE",
      },
      expected: /proposal is stale/,
    },
    {
      result: { kind: "not_found" },
      expected: /proposal is unavailable/,
    },
    {
      result: { kind: "not_found" },
      proposalId: "not-a-uuid",
      expected: /valid proposal ID/,
    },
  ];

  for (const testCase of cases) {
    const repository = new StubRepository();
    repository.decisionResult = testCase.result;
    const { workflow } = createWorkflow({ repository });
    const reply = await workflow.decideProposal({
      proposalId: testCase.proposalId ?? runId,
      requesterOpenId: "ou_victor",
      tenantKey: "tenant_synvo",
      decision: testCase.decision ?? "APPROVED",
    });
    assert.match(reply, testCase.expected);
    assert.match(
      reply,
      /No files were changed|No files were moved|No execution was queued/,
    );
  }
});

test("rejects a stored proposal encrypted for another run", async () => {
  const repository = new StubRepository();
  const cipher = new TokenCipher(Buffer.alloc(32, 5));
  const proposal = {
    proposal_id: runId,
    moves: [],
  } satisfies OrganizeFolderProposal;
  repository.inventoryRun = {
    id: runId,
    chatId: "oc_chat",
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
    state: "COMPLETED",
    rootTokenDigest: digestFolderToken(config.organizeFolderRootToken),
    oauthGrantId: "grant-id",
    oauthGrantMatchesSubject: true,
    resultCiphertext: null,
    proposalCiphertext: cipher.encrypt(
      JSON.stringify(proposal),
      organizeFolderProposalAssociatedData(
        "5f982758-1f71-4ed8-b141-a2d193ceea92",
      ),
    ),
    proposalStatus: "PROPOSED",
    executionCiphertext: null,
    executionStatus: null,
    undoStatus: null,
  };
  const { workflow } = createWorkflow({ repository, cipher });
  await assert.rejects(
    workflow.buildProposalMessage(runId),
    /stored organization proposal is invalid/,
  );
});

test("queues execution only for a newly approved proposal while writes are enabled", async () => {
  const repository = new StubRepository();
  repository.decisionResult = {
    kind: "recorded",
    status: "APPROVED",
    executionQueued: true,
  };
  const { workflow } = createWorkflow({
    repository,
    configOverride: { organizeFolderWriteEnabled: true },
  });

  const reply = await workflow.decideProposal({
    proposalId: runId,
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
    decision: "APPROVED",
  });

  assert.ok(repository.decisionInput?.executionJobId);
  assert.match(reply, /Execution is queued/);
});

test("describes a duplicate approval accurately while writes are enabled", async () => {
  const repository = new StubRepository();
  repository.decisionResult = {
    kind: "existing",
    status: "APPROVED",
  };
  const { workflow } = createWorkflow({
    repository,
    configOverride: { organizeFolderWriteEnabled: true },
  });

  const reply = await workflow.decideProposal({
    proposalId: runId,
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
    decision: "APPROVED",
  });

  assert.match(reply, /approval was already recorded/);
  assert.doesNotMatch(reply, /write switch is disabled/);
});

test("refuses execution without any Drive mutation when the write switch is disabled", async () => {
  const fixture = await approvedExecutionFixture({ writeEnabled: false });

  const reply = await fixture.workflow.buildExecutionMessage(runId);

  assert.match(reply, /write switch is disabled/);
  assert.equal(fixture.drive.moveCalls.length, 0);
  assert.equal(fixture.repository.inventoryRun?.executionStatus, "FAILED");
  assert.equal(fixture.drive.countFiles("fldcnRoot123"), 4);
});

test("rechecks the configured pilot boundary when queued execution runs", async () => {
  for (const configOverride of [
    { authorizedOpenId: "ou_other" },
    { authorizedTenantKey: "tenant_other" },
    { organizeFolderRootToken: "fldcnOtherRoot" },
  ]) {
    const fixture = await approvedExecutionFixture();
    const { workflow } = createWorkflow({
      repository: fixture.repository,
      cipher: fixture.cipher,
      driveReader: fixture.drive,
      driveMover: fixture.drive,
      configOverride: {
        organizeFolderWriteEnabled: true,
        ...configOverride,
      },
    });

    const reply = await workflow.buildExecutionMessage(runId);

    assert.match(reply, /no longer matches the configured pilot boundary/);
    assert.equal(fixture.drive.moveCalls.length, 0);
    assert.equal(fixture.repository.inventoryRun?.executionStatus, "FAILED");
  }
});

test("marks a changed snapshot stale before the first Drive mutation", async () => {
  const fixture = await approvedExecutionFixture();
  fixture.drive.rename("file-product-one", "[product] - Changed.pdf");

  const reply = await fixture.workflow.buildExecutionMessage(runId);

  assert.match(reply, /became stale/);
  assert.equal(fixture.repository.staleCalls, 1);
  assert.equal(fixture.repository.inventoryRun?.proposalStatus, "STALE");
  assert.equal(fixture.drive.moveCalls.length, 0);
  assert.match(
    await fixture.workflow.buildExecutionMessage(runId),
    /became stale before execution/,
  );
});

test("does not execute proposed or rejected runs", async () => {
  for (const status of ["PROPOSED", "REJECTED"] as const) {
    const fixture = await approvedExecutionFixture();
    fixture.repository.inventoryRun!.proposalStatus = status;
    fixture.repository.inventoryRun!.executionStatus = null;

    await assert.rejects(
      fixture.workflow.buildExecutionMessage(runId),
      /approved proposal is unavailable/,
    );
    assert.equal(fixture.drive.moveCalls.length, 0);
  }
});

test("does not execute a missing proposal", async () => {
  const drive = new MutablePilotDrive();
  const { workflow } = createWorkflow({
    configOverride: { organizeFolderWriteEnabled: true },
    driveReader: drive,
    driveMover: drive,
  });

  await assert.rejects(
    workflow.buildExecutionMessage(runId),
    /approved proposal is unavailable/,
  );
  assert.equal(drive.moveCalls.length, 0);
});

test("moves and verifies exactly four proposed files and makes delivery retries read-only", async () => {
  const fixture = await approvedExecutionFixture();

  const first = await fixture.workflow.buildExecutionMessage(runId);
  const retry = await fixture.workflow.buildExecutionMessage(runId);

  assert.equal(first, retry);
  assert.match(first, /Execution completed/);
  assert.equal(fixture.drive.moveCalls.length, 4);
  assert.equal(fixture.drive.countFiles("fldcnRoot123"), 0);
  assert.equal(fixture.drive.countFiles("folder-product"), 2);
  assert.equal(fixture.drive.countFiles("folder-research"), 2);
  assert.equal(fixture.repository.inventoryRun?.executionStatus, "COMPLETED");
  assert.equal(first.includes("folder-product"), false);
  assert.equal(first.includes("file-product-one"), false);
});

test("reconciles a move recorded as requesting after a crash without repeating it", async () => {
  const fixture = await approvedExecutionFixture();
  const record = createExecutionRecord(
    fixture.proposal,
    fixture.observation,
    new Date("2026-08-08T00:00:00.000Z"),
  );
  const firstMove = record.moves[0]!;
  firstMove.status = "REQUESTING";
  fixture.drive.relocate(firstMove.fileToken, firstMove.destinationFolderToken);
  fixture.repository.inventoryRun!.executionCiphertext = fixture.cipher.encrypt(
    JSON.stringify(record),
    executionAssociatedData(runId),
  );
  fixture.repository.inventoryRun!.executionStatus = "RUNNING";

  const reply = await fixture.workflow.buildExecutionMessage(runId);

  assert.match(reply, /Execution completed/);
  assert.equal(fixture.drive.moveCalls.length, 3);
  assert.equal(
    fixture.drive.moveCalls.some((call) => call.fileToken === firstMove.fileToken),
    false,
  );
});

test("does not claim an unrequested destination move as its own", async () => {
  const fixture = await approvedExecutionFixture();
  const record = createExecutionRecord(
    fixture.proposal,
    fixture.observation,
    new Date("2026-08-08T00:00:00.000Z"),
  );
  const firstMove = record.moves[0]!;
  fixture.drive.relocate(firstMove.fileToken, firstMove.destinationFolderToken);
  fixture.repository.inventoryRun!.executionCiphertext = fixture.cipher.encrypt(
    JSON.stringify(record),
    executionAssociatedData(runId),
  );
  fixture.repository.inventoryRun!.executionStatus = "RUNNING";

  const reply = await fixture.workflow.buildExecutionMessage(runId);

  assert.match(reply, /Execution unknown/);
  assert.equal(fixture.drive.moveCalls.length, 0);
  assert.equal(fixture.repository.inventoryRun?.executionStatus, "UNKNOWN");
});

test("stops on an unexpected parent during recovery without issuing a move", async () => {
  const fixture = await approvedExecutionFixture();
  const record = createExecutionRecord(
    fixture.proposal,
    fixture.observation,
    new Date("2026-08-08T00:00:00.000Z"),
  );
  const firstMove = record.moves[0]!;
  const otherDestination = record.moves.find(
    (move) => move.destinationFolderToken !== firstMove.destinationFolderToken,
  )!.destinationFolderToken;
  fixture.drive.relocate(firstMove.fileToken, otherDestination);
  fixture.repository.inventoryRun!.executionCiphertext = fixture.cipher.encrypt(
    JSON.stringify(record),
    executionAssociatedData(runId),
  );
  fixture.repository.inventoryRun!.executionStatus = "RUNNING";

  const reply = await fixture.workflow.buildExecutionMessage(runId);

  assert.match(reply, /Execution unknown/);
  assert.equal(fixture.drive.moveCalls.length, 0);
  assert.equal(fixture.repository.inventoryRun?.executionStatus, "UNKNOWN");
});

test("reconciles an ambiguous provider response from observed Drive state", async () => {
  const fixture = await approvedExecutionFixture();
  fixture.drive.failure = {
    call: 1,
    error: new DriveMoveError("TEMPORARY", true),
    moveBeforeThrow: true,
  };

  const reply = await fixture.workflow.buildExecutionMessage(runId);

  assert.match(reply, /Execution completed/);
  assert.equal(fixture.drive.moveCalls.length, 4);
  assert.equal(fixture.repository.inventoryRun?.executionStatus, "COMPLETED");
});

test("reports unknown and never repeats a successful response that cannot be observed", async () => {
  const fixture = await approvedExecutionFixture();
  fixture.drive.skipMoveOnCall = 1;

  const first = await fixture.workflow.buildExecutionMessage(runId);
  const retry = await fixture.workflow.buildExecutionMessage(runId);

  assert.equal(first, retry);
  assert.match(first, /Execution unknown/);
  assert.match(first, /untouched/);
  assert.equal(fixture.drive.moveCalls.length, 1);
  assert.equal(fixture.repository.inventoryRun?.executionStatus, "UNKNOWN");
  assert.equal(fixture.drive.countFiles("fldcnRoot123"), 4);
});

test("marks only an in-flight request unknown when worker attempts are exhausted", async () => {
  const fixture = await approvedExecutionFixture();
  const record = createExecutionRecord(
    fixture.proposal,
    fixture.observation,
    new Date("2026-08-08T00:00:00.000Z"),
  );
  record.moves[0]!.status = "REQUESTING";
  fixture.repository.inventoryRun!.executionCiphertext = fixture.cipher.encrypt(
    JSON.stringify(record),
    executionAssociatedData(runId),
  );
  fixture.repository.inventoryRun!.executionStatus = "RUNNING";

  const reply = await fixture.workflow.finalizeExhaustedOperation(
    runId,
    "ORGANIZE_FOLDER_EXECUTE",
  );

  assert.match(reply, /Execution unknown/);
  assert.match(reply, /unknown/);
  assert.match(reply, /untouched/);
  assert.equal(fixture.drive.moveCalls.length, 0);
});

test("stops after a verified partial execution and reports untouched files", async () => {
  const fixture = await approvedExecutionFixture();
  fixture.drive.failure = {
    call: 2,
    error: new DriveMoveError("FORBIDDEN", false),
  };

  const reply = await fixture.workflow.buildExecutionMessage(runId);

  assert.match(reply, /Execution partial/);
  assert.match(reply, /failed/);
  assert.match(reply, /untouched/);
  assert.equal(fixture.drive.moveCalls.length, 2);
  assert.equal(fixture.repository.inventoryRun?.executionStatus, "PARTIAL");
  assert.equal(fixture.drive.countFiles("fldcnRoot123"), 3);
});

test("requires a separate undo command, restores the exact baseline, and is idempotent", async () => {
  const fixture = await approvedExecutionFixture();
  await fixture.workflow.buildExecutionMessage(runId);
  const callsAfterExecution = fixture.drive.moveCalls.length;

  const queued = await fixture.workflow.requestUndo({
    proposalId: runId,
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
  });
  assert.match(queued, /Undo is queued/);
  assert.equal(fixture.drive.moveCalls.length, callsAfterExecution);

  const first = await fixture.workflow.buildUndoMessage(runId);
  const retry = await fixture.workflow.buildUndoMessage(runId);
  const duplicateRequest = await fixture.workflow.requestUndo({
    proposalId: runId,
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
  });

  assert.equal(first, retry);
  assert.match(first, /Undo completed/);
  assert.match(duplicateRequest, /already completed/);
  assert.equal(fixture.drive.moveCalls.length, 8);
  assert.equal(fixture.drive.countFiles("fldcnRoot123"), 4);
  assert.equal(fixture.drive.countFiles("folder-product"), 0);
  assert.equal(fixture.drive.countFiles("folder-research"), 0);
  assert.equal(fixture.repository.inventoryRun?.undoStatus, "COMPLETED");
});

test("rechecks the configured pilot boundary when queued undo runs", async () => {
  const fixture = await approvedExecutionFixture();
  await fixture.workflow.buildExecutionMessage(runId);
  await fixture.workflow.requestUndo({
    proposalId: runId,
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
  });
  const callsAfterExecution = fixture.drive.moveCalls.length;
  const { workflow } = createWorkflow({
    repository: fixture.repository,
    cipher: fixture.cipher,
    driveReader: fixture.drive,
    driveMover: fixture.drive,
    configOverride: {
      organizeFolderWriteEnabled: true,
      organizeFolderRootToken: "fldcnOtherRoot",
    },
  });

  const reply = await workflow.buildUndoMessage(runId);

  assert.match(reply, /no longer matches the configured pilot boundary/);
  assert.equal(fixture.drive.moveCalls.length, callsAfterExecution);
  assert.equal(fixture.repository.inventoryRun?.undoStatus, "FAILED");
});

test("rejects undo from another actor or tenant before queueing or moving files", async () => {
  const fixture = await approvedExecutionFixture();
  await fixture.workflow.buildExecutionMessage(runId);
  const callsAfterExecution = fixture.drive.moveCalls.length;

  for (const requester of [
    { requesterOpenId: "ou_other", tenantKey: "tenant_synvo" },
    { requesterOpenId: "ou_victor", tenantKey: "tenant_other" },
  ]) {
    const reply = await fixture.workflow.requestUndo({
      proposalId: runId,
      ...requester,
    });
    assert.match(reply, /not authorized/);
  }
  assert.equal(fixture.drive.moveCalls.length, callsAfterExecution);
  assert.equal(fixture.repository.inventoryRun?.undoStatus, null);
});
