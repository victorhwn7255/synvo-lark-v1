import assert from "node:assert/strict";
import test from "node:test";

import type { AppConfig } from "../../config.js";
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
  type DriveFolderCreator,
  type DriveMover,
} from "../../lark/drive/index.js";
import type { WorkspaceDriveInventory } from "../analyze-drive-file/authorized-reader.js";
import { snapshotWorkspaceInventory, type ContentPlanResult } from "./content-planner.js";
import type { ExecutionStatus, UndoStatus } from "./execution.js";
import type {
  InventoryRun,
  OAuthSession,
  OrganizeFolderRepository,
  ProposalDecisionStoreResult,
  StoreInventoryResultInput,
} from "./repository.js";
import { OrganizeFolderWorkflow } from "./workflow.js";

const rootToken = "fldcnRoot123";
const folderLink = `https://synvo-ai.sg.larksuite.com/drive/folder/${rootToken}`;
const identity = { requesterOpenId: "ou_victor", tenantKey: "tenant_synvo" };
const config: AppConfig = {
  appId: "cli_0123456789abcdef",
  appSecret: "app-secret",
  databaseUrl: "postgresql://local",
  httpHost: "127.0.0.1",
  httpPort: 3000,
  larkOAuthRedirectUri: "http://localhost:3000/oauth/lark/callback",
  oauthTokenEncryptionKey: Buffer.alloc(32, 1).toString("base64url"),
  authorizedOpenId: identity.requesterOpenId,
  authorizedTenantKey: identity.tenantKey,
  organizeFolderRootToken: rootToken,
  organizeFolderWriteEnabled: false,
  llmApiKey: "nvapi-test-key-that-is-long-enough",
  voyageApiKey: "voyage-test-key-with-safe-length",
};

function grant(): StoredOAuthGrant {
  return {
    id: "4e41b888-b1b9-46cf-aac8-3e0f35e0d266",
    openId: identity.requesterOpenId,
    tenantKey: identity.tenantKey,
    accessTokenCiphertext: "ciphertext",
    refreshTokenCiphertext: "ciphertext",
    grantedScopes: [...ORGANIZE_FOLDER_USER_SCOPES],
    accessExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    refreshExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    refreshVersion: 1,
    revokedAt: null,
  };
}

class StubGrantStore implements OAuthGrantStore {
  stored: StoredOAuthGrant | null = grant();
  async findBySubject() { return this.stored; }
  async save(input: SaveOAuthGrantInput) { return input; }
  async withLockedGrant<T>(
    _openId: string,
    _tenantKey: string,
    operation: (value: StoredOAuthGrant) => Promise<LockedGrantResult<T>>,
  ): Promise<T> {
    if (!this.stored) throw new Error("No grant");
    return (await operation(this.stored)).result;
  }
}

class StubRepository implements OrganizeFolderRepository {
  run: InventoryRun | null = null;
  createdInput: Parameters<OrganizeFolderRepository["createReadyRun"]>[0] | null = null;
  decisionInput: Parameters<OrganizeFolderRepository["recordProposalDecision"]>[0] | null = null;
  decisionResult: ProposalDecisionStoreResult | null = null;
  staleCalls = 0;

  async hasRunForMessage() { return this.run !== null; }
  async findInventoryRunById(runId: string) {
    return this.run?.id === runId ? this.run : null;
  }
  async createReadyRun(input: Parameters<OrganizeFolderRepository["createReadyRun"]>[0]) {
    this.createdInput = input;
    this.run = {
      id: input.id,
      chatId: input.chatId,
      requesterOpenId: input.requesterOpenId,
      tenantKey: input.tenantKey,
      state: "READY_TO_SCAN",
      rootTokenDigest: input.rootTokenDigest,
      oauthGrantId: input.oauthGrantId,
      oauthGrantMatchesSubject: true,
      resultCiphertext: input.consentSnapshotCiphertext,
      proposalCiphertext: null,
      proposalStatus: null,
      executionCiphertext: null,
      executionStatus: null,
      undoStatus: null,
      operationMessageId: null,
    };
    return true;
  }
  async createAwaitingOAuthRun() { return true; }
  async startOAuthSession(): Promise<OAuthSession | null> { return null; }
  async consumeOAuthSession(): Promise<OAuthSession | null> { return null; }
  async bindGrantToRun() {}
  async markRunFailed() {}
  async storeInventoryResult(input: StoreInventoryResultInput) {
    if (!this.run || this.run.id !== input.runId) return false;
    this.run.state = input.state;
    this.run.resultCiphertext = input.resultCiphertext;
    this.run.proposalCiphertext = input.proposalCiphertext;
    this.run.proposalStatus = input.proposalStatus;
    return true;
  }
  async recordProposalDecision(
    input: Parameters<OrganizeFolderRepository["recordProposalDecision"]>[0],
  ): Promise<ProposalDecisionStoreResult> {
    this.decisionInput = input;
    if (this.decisionResult) return this.decisionResult;
    if (
      !this.run ||
      this.run.id !== input.proposalId ||
      this.run.chatId !== input.chatId
    ) return { kind: "not_found" };
    this.run.proposalStatus = input.decision;
    if (input.operationMessageId) {
      this.run.operationMessageId = input.operationMessageId;
    }
    if (input.executionJobId) this.run.executionStatus = "QUEUED";
    return {
      kind: "recorded",
      status: input.decision,
      executionQueued: Boolean(input.executionJobId),
    };
  }
  async markProposalStale() {
    if (!this.run) return false;
    this.staleCalls += 1;
    this.run.proposalStatus = "STALE";
    this.run.executionStatus = "STALE";
    return true;
  }
  async startExecution() {
    if (!this.run) return false;
    this.run.executionStatus = "RUNNING";
    return true;
  }
  async storeExecution(input: { status: ExecutionStatus; ciphertext: string | null }) {
    if (!this.run) return false;
    this.run.executionStatus = input.status;
    this.run.executionCiphertext = input.ciphertext;
    return true;
  }
  async requestUndo(input: {
    executionCiphertext: string;
    operationMessageId?: string;
  }) {
    if (!this.run?.executionCiphertext) return { kind: "not_ready" } as const;
    if (this.run.undoStatus) return { kind: "existing", status: this.run.undoStatus } as const;
    this.run.executionCiphertext = input.executionCiphertext;
    this.run.undoStatus = "REQUESTED";
    if (input.operationMessageId) {
      this.run.operationMessageId = input.operationMessageId;
    }
    return { kind: "recorded" } as const;
  }
  async startUndo() {
    if (!this.run) return false;
    this.run.undoStatus = "RUNNING";
    return true;
  }
  async storeUndo(input: { status: UndoStatus; ciphertext: string }) {
    if (!this.run) return false;
    this.run.undoStatus = input.status;
    this.run.executionCiphertext = input.ciphertext;
    return true;
  }
}

class MutableWorkspace implements DriveMover, DriveFolderCreator {
  readonly rootToken = rootToken;
  readonly folders = [
    { token: "folder-inbox", name: "Inbox", relativePath: "Inbox", parentToken: rootToken, depth: 1, ownedByRequester: true },
    { token: "folder-engineering", name: "Engineering", relativePath: "Engineering", parentToken: rootToken, depth: 1, ownedByRequester: true },
  ];
  readonly files = Array.from({ length: 15 }, (_, index) => ({
    token: `file-${index + 1}`,
    name: `document-${String(index + 1).padStart(2, "0")}.pdf`,
    fileName: `document-${String(index + 1).padStart(2, "0")}.pdf`,
    relativePath: `Inbox / document-${String(index + 1).padStart(2, "0")}.pdf`,
    parentToken: "folder-inbox",
    parentPath: "Inbox",
    depth: 2,
    version: "1",
  }));
  createCalls: string[] = [];
  moveCalls: Array<{ fileToken: string; destinationFolderToken: string }> = [];
  createAmbiguously = false;
  createFailure: DriveMoveError | null = null;
  moveAmbiguously = false;
  interruptAfterFirstMoveObservation = false;
  interruptionTriggered = false;
  failMoveCallNumber: number | null = null;
  collisionAfterInspections: number | null = null;
  readonly events: string[] = [];

  async inspectWorkspace(): Promise<WorkspaceDriveInventory> {
    if (this.collisionAfterInspections !== null) {
      this.collisionAfterInspections -= 1;
      if (this.collisionAfterInspections === 0) {
        this.collisionAfterInspections = null;
        this.folders.push({
          token: "folder-unapproved-research",
          name: "Research",
          relativePath: "Research",
          parentToken: rootToken,
          depth: 1,
          ownedByRequester: true,
        });
      }
    }
    if (
      this.interruptAfterFirstMoveObservation &&
      !this.interruptionTriggered &&
      this.moveCalls.length === 1
    ) {
      this.interruptionTriggered = true;
      throw new Error("Simulated process interruption");
    }
    return {
      rootToken: this.rootToken,
      folders: this.folders.map((folder) => ({ ...folder })),
      files: this.files.map((file) => ({ ...file })),
    };
  }
  async createFolder(input: { parentFolderToken: string; name: string }) {
    assert.equal(input.parentFolderToken, rootToken);
    this.createCalls.push(input.name);
    this.events.push(`create:${input.name}`);
    if (this.createFailure) throw this.createFailure;
    const folderToken = `folder-${input.name.toLowerCase()}`;
    if (!this.folders.some((folder) => folder.token === folderToken)) {
      this.folders.push({
        token: folderToken,
        name: input.name,
        relativePath: input.name,
        parentToken: rootToken,
        depth: 1,
        ownedByRequester: true,
      });
    }
    if (this.createAmbiguously) {
      this.createAmbiguously = false;
      throw new DriveMoveError("TIMEOUT", true);
    }
    return { folderToken };
  }
  async moveFile(input: { fileToken: string; destinationFolderToken: string }) {
    this.moveCalls.push(input);
    this.events.push(`move:${input.fileToken}`);
    if (this.failMoveCallNumber === this.moveCalls.length) {
      throw new DriveMoveError("PERMANENT", false);
    }
    const file = this.files.find((candidate) => candidate.token === input.fileToken);
    const destination = this.folders.find(
      (candidate) => candidate.token === input.destinationFolderToken,
    );
    if (!file || !destination) throw new DriveMoveError("NOT_FOUND", false);
    file.parentToken = destination.token;
    file.parentPath = destination.name;
    file.relativePath = `${destination.name} / ${file.fileName}`;
    if (this.moveAmbiguously) {
      this.moveAmbiguously = false;
      throw new DriveMoveError("TIMEOUT", true);
    }
  }
}

function buildPlan(runId: string, workspace: MutableWorkspace): ContentPlanResult {
  const inventory = snapshotWorkspaceInventory(runId, {
    rootToken: workspace.rootToken,
    folders: workspace.folders,
    files: workspace.files,
  });
  return {
    kind: "ready",
    inventoryResult: { ok: true, inventory },
    taxonomy: [
      { name: "Engineering", description: "Technical product documentation." },
      { name: "Research", description: "Research and analytical documents." },
    ],
    decisions: inventory.files.map((file, index) => ({
      file_ref: file.ref,
      destination: index % 2 === 0 ? "Engineering" : "Research",
      rationale: "The indexed evidence supports this destination.",
    })),
  };
}

function fixture(options: {
  writeEnabled?: boolean;
  workspace?: MutableWorkspace;
  grantAvailable?: boolean;
} = {}) {
  const workspace = options.workspace ?? new MutableWorkspace();
  const repository = new StubRepository();
  const grantStore = new StubGrantStore();
  if (options.grantAvailable === false) grantStore.stored = null;
  const cipher = new TokenCipher(Buffer.alloc(32, 7));
  let reconciliations = 0;
  let recoveredTokens = 0;
  let rejectedTokens = 0;
  let authorizationDelivery: "queued" | "inline" | undefined;
  const workflow = new OrganizeFolderWorkflow({
    config: {
      ...config,
      organizeFolderWriteEnabled: options.writeEnabled ?? false,
    },
    grantStore,
    repository,
    oauthService: {
      async createPendingAuthorization(input) {
        authorizationDelivery = input.delivery;
        return {
          created: true,
          startUrl: new URL(
            "http://localhost:3000/oauth/lark/start?request=test-token",
          ),
        };
      },
    },
    tokenBroker: {
      async getAccessToken() { return "access-token"; },
      async recoverAccessToken() { recoveredTokens += 1; return "recovered-token"; },
      async markAccessTokenRejected() { rejectedTokens += 1; },
    },
    cipher,
    workspaceReader: workspace,
    driveMover: workspace,
    folderCreator: workspace,
    knowledge: { async reconcileWorkspacePaths() { reconciliations += 1; return 15; } },
    contentPlanner: { async plan(runId) { return buildPlan(runId, workspace); } },
  });
  return {
    workflow,
    repository,
    workspace,
    reconciliations: () => reconciliations,
    recoveredTokens: () => recoveredTokens,
    rejectedTokens: () => rejectedTokens,
    authorizationDelivery: () => authorizationDelivery,
  };
}

function request(messageId = "om_message") {
  return { messageId, chatId: "oc_chat", ...identity, folderLink };
}

async function prepareProposal(testFixture: ReturnType<typeof fixture>) {
  const consent = await testFixture.workflow.prepareConsent(request());
  assert.equal(consent.kind, "ready");
  if (consent.kind !== "ready") throw new Error("Consent was not ready");
  assert.equal((await testFixture.workflow.start({
    ...request(),
    consentSnapshotDigest: consent.snapshotDigest,
    consentExpiresAt: consent.expiresAt,
  })).kind, "inventory_ready");
  const proposalId = testFixture.repository.run!.id;
  const message = await testFixture.workflow.buildProposalMessage(proposalId);
  return { proposalId, message };
}

test("consents to an exact recursive 15-PDF snapshot and stores only encrypted provider consent", async () => {
  const testFixture = fixture();
  const consent = await testFixture.workflow.prepareConsent(request());
  assert.equal(consent.kind, "ready");
  if (consent.kind !== "ready") return;
  assert.equal(consent.inventory.inventory.files.length, 15);
  assert.match(consent.snapshotDigest, /^[0-9a-f]{64}$/u);
  assert.equal((await testFixture.workflow.start({
    ...request(),
    consentSnapshotDigest: consent.snapshotDigest,
    consentExpiresAt: consent.expiresAt,
  })).kind, "inventory_ready");
  assert.ok(testFixture.repository.createdInput?.consentSnapshotCiphertext);
  assert.equal(
    testFixture.repository.createdInput!.consentSnapshotCiphertext.includes("document-01.pdf"),
    false,
  );
});

test("returns the inline welcome-card OAuth link when the user grant is unavailable", async () => {
  const testFixture = fixture({ grantAvailable: false });
  const consent = await testFixture.workflow.prepareConsent({
    ...request("om_welcome"),
    authorizationDelivery: "inline",
  });

  assert.equal(consent.kind, "authorization_required");
  if (consent.kind !== "authorization_required") return;
  assert.equal(consent.authorizationUrl.pathname, "/oauth/lark/start");
  assert.equal(consent.authorizationUrl.searchParams.get("request"), "test-token");
  assert.equal(testFixture.authorizationDelivery(), "inline");
  assert.equal(testFixture.repository.run, null);
});

test("rejects expired consent, changed snapshots, external links, and wrong actors before providers", async (t) => {
  await t.test("expired", async () => {
    const testFixture = fixture();
    assert.equal((await testFixture.workflow.start({
      ...request(),
      consentSnapshotDigest: "a".repeat(64),
      consentExpiresAt: Date.now() - 1,
    })).kind, "rejected");
  });
  await t.test("changed", async () => {
    const testFixture = fixture();
    const consent = await testFixture.workflow.prepareConsent(request());
    assert.equal(consent.kind, "ready");
    if (consent.kind !== "ready") return;
    testFixture.workspace.files[0]!.version = "2";
    assert.equal((await testFixture.workflow.start({
      ...request(),
      consentSnapshotDigest: consent.snapshotDigest,
      consentExpiresAt: consent.expiresAt,
    })).kind, "rejected");
    assert.equal(testFixture.repository.run, null);
  });
  await t.test("boundary", async () => {
    const testFixture = fixture();
    assert.equal((await testFixture.workflow.prepareConsent({
      ...request(), folderLink: "https://example.com/drive/folder/fldcnRoot123",
    })).kind, "rejected");
    assert.equal((await testFixture.workflow.prepareConsent({
      ...request(), requesterOpenId: "ou_other",
    })).kind, "rejected");
  });
});

test("builds one dynamic proposal with complete file coverage and no writes", async () => {
  const testFixture = fixture();
  const { proposalId, message } = await prepareProposal(testFixture);
  assert.match(message, /Engineering/u);
  assert.match(message, /Research/u);
  assert.match(message, /15 PDFs/u);
  assert.equal(testFixture.workspace.createCalls.length, 0);
  assert.equal(testFixture.workspace.moveCalls.length, 0);
  const reread = await testFixture.workflow.readProposalMessage({ proposalId, chatId: "oc_chat", ...identity });
  assert.equal(reread, message);
});

test("approval queues execution only while the operator write switch is enabled", async () => {
  const disabled = fixture();
  const disabledProposal = await prepareProposal(disabled);
  assert.match(await disabled.workflow.decideProposal({
    proposalId: disabledProposal.proposalId,
    chatId: "oc_chat",
    ...identity,
    decision: "APPROVED",
  }), /paused/u);
  assert.equal(disabled.repository.decisionInput?.executionJobId, undefined);

  const enabled = fixture({ writeEnabled: true });
  const enabledProposal = await prepareProposal(enabled);
  assert.match(await enabled.workflow.decideProposal({
    proposalId: enabledProposal.proposalId,
    chatId: "oc_chat",
    ...identity,
    decision: "APPROVED",
    operationMessageId: "om_approval_progress",
  }), /queued/u);
  assert.ok(enabled.repository.decisionInput?.executionJobId);
  assert.equal(
    await enabled.workflow.getOperationMessageId(enabledProposal.proposalId),
    "om_approval_progress",
  );
});

test("proposal reads and decisions are bound to the originating chat", async () => {
  const testFixture = fixture({ writeEnabled: true });
  const { proposalId } = await prepareProposal(testFixture);

  assert.match(await testFixture.workflow.readProposalMessage({
    proposalId,
    chatId: "oc_other",
    ...identity,
  }), /couldn’t find/u);
  assert.match(await testFixture.workflow.decideProposal({
    proposalId,
    chatId: "oc_other",
    ...identity,
    decision: "APPROVED",
  }), /couldn’t find/u);
  assert.equal(testFixture.repository.run?.proposalStatus, "PROPOSED");
});

test("expires an old proposal before it can queue execution", async () => {
  const testFixture = fixture({ writeEnabled: true });
  const { proposalId } = await prepareProposal(testFixture);
  testFixture.repository.decisionResult = { kind: "existing", status: "STALE" };
  const beforeDecision = Date.now();

  assert.match(await testFixture.workflow.decideProposal({
    proposalId,
    chatId: "oc_chat",
    ...identity,
    decision: "APPROVED",
  }), /out of date/u);
  assert.ok(
    testFixture.repository.decisionInput!.proposalNotBefore!.getTime() <= beforeDecision,
  );
  assert.equal(testFixture.repository.decisionInput?.executionJobId !== undefined, true);
  assert.equal(testFixture.workspace.createCalls.length, 0);
  assert.equal(testFixture.workspace.moveCalls.length, 0);
});

test("creates approved folders, moves and verifies all PDFs, reconciles RAG paths, then undoes", async () => {
  const testFixture = fixture({ writeEnabled: true });
  testFixture.workspace.createAmbiguously = true;
  testFixture.workspace.moveAmbiguously = true;
  const { proposalId } = await prepareProposal(testFixture);
  await testFixture.workflow.decideProposal({ proposalId, chatId: "oc_chat", ...identity, decision: "APPROVED" });
  const execution = await testFixture.workflow.buildExecutionMessage(proposalId);
  assert.match(execution, /completed/iu);
  assert.equal(testFixture.workspace.createCalls.length, 1);
  assert.equal(testFixture.workspace.moveCalls.length, 15);
  assert.equal(testFixture.workspace.events[0], "create:Research");
  assert.equal(
    testFixture.workspace.events.slice(1).every((event) => event.startsWith("move:")),
    true,
  );
  assert.equal(testFixture.workspace.files.every((file) => file.parentPath !== "Inbox"), true);
  assert.equal(testFixture.reconciliations(), 1);

  assert.match(await testFixture.workflow.requestUndo({
    proposalId,
    chatId: "oc_chat",
    ...identity,
    operationMessageId: "om_undo_progress",
  }), /queued/u);
  assert.equal(
    await testFixture.workflow.getOperationMessageId(proposalId),
    "om_undo_progress",
  );
  const undo = await testFixture.workflow.buildUndoMessage(proposalId);
  assert.match(undo, /completed/iu);
  assert.equal(testFixture.workspace.files.every((file) => file.parentToken === "folder-inbox"), true);
  assert.equal(testFixture.workspace.folders.some((folder) => folder.name === "Research"), true);
  assert.equal(testFixture.reconciliations(), 2);
  assert.match(
    await testFixture.workflow.requestUndo({ proposalId, chatId: "oc_chat", ...identity }),
    /already completed/u,
  );
  assert.equal(testFixture.workspace.moveCalls.length, 30);
});

test("stops once and requests fresh authorization when Lark denies folder creation scope", async () => {
  const testFixture = fixture({ writeEnabled: true });
  testFixture.workspace.createFailure = new DriveMoveError(
    "REAUTHORIZATION_REQUIRED",
    false,
  );
  const { proposalId } = await prepareProposal(testFixture);
  await testFixture.workflow.decideProposal({
    proposalId,
    chatId: "oc_chat",
    ...identity,
    decision: "APPROVED",
  });

  const execution = await testFixture.workflow.buildExecutionMessage(proposalId);

  assert.match(execution, /fresh authorization/iu);
  assert.equal(testFixture.workspace.createCalls.length, 1);
  assert.equal(testFixture.workspace.moveCalls.length, 0);
  assert.equal(testFixture.recoveredTokens(), 0);
  assert.equal(testFixture.rejectedTokens(), 0);
  assert.equal(testFixture.repository.run?.executionStatus, "FAILED");
});

test("stops on a top-level folder-name collision before creating or moving anything", async () => {
  const testFixture = fixture({ writeEnabled: true });
  const { proposalId } = await prepareProposal(testFixture);
  await testFixture.workflow.decideProposal({
    proposalId,
    chatId: "oc_chat",
    ...identity,
    decision: "APPROVED",
  });
  testFixture.workspace.collisionAfterInspections = 2;

  assert.match(await testFixture.workflow.buildExecutionMessage(proposalId), /stopped/u);
  assert.equal(testFixture.workspace.createCalls.length, 0);
  assert.equal(testFixture.workspace.moveCalls.length, 0);
  assert.equal(testFixture.repository.run?.executionStatus, "UNKNOWN");
});

test("records verified partial work after an unambiguous provider failure", async () => {
  const testFixture = fixture({ writeEnabled: true });
  const { proposalId } = await prepareProposal(testFixture);
  await testFixture.workflow.decideProposal({ proposalId, chatId: "oc_chat", ...identity, decision: "APPROVED" });
  testFixture.workspace.failMoveCallNumber = 2;

  const result = await testFixture.workflow.buildExecutionMessage(proposalId);
  assert.match(result, /stopped/iu);
  assert.match(result, /Moved and verified: 1 files/u);
  assert.equal(testFixture.repository.run?.executionStatus, "PARTIAL");
  assert.equal(testFixture.workspace.moveCalls.length, 2);
  assert.equal(testFixture.workspace.files[0]!.parentPath, "Engineering");
  assert.equal(testFixture.workspace.files[1]!.parentPath, "Inbox");

  const repeated = await testFixture.workflow.buildExecutionMessage(proposalId);
  assert.equal(repeated, result);
  assert.equal(testFixture.workspace.moveCalls.length, 2);
});

test("resumes safely after an interruption without repeating an applied move", async () => {
  const testFixture = fixture({ writeEnabled: true });
  const { proposalId } = await prepareProposal(testFixture);
  await testFixture.workflow.decideProposal({ proposalId, chatId: "oc_chat", ...identity, decision: "APPROVED" });
  testFixture.workspace.interruptAfterFirstMoveObservation = true;

  await assert.rejects(
    testFixture.workflow.buildExecutionMessage(proposalId),
    /Simulated process interruption/u,
  );
  assert.equal(testFixture.workspace.moveCalls.length, 1);
  assert.equal(testFixture.workspace.files[0]!.parentPath, "Engineering");
  assert.equal(testFixture.repository.run?.executionStatus, "RUNNING");

  const resumed = await testFixture.workflow.buildExecutionMessage(proposalId);
  assert.match(resumed, /completed/iu);
  assert.equal(testFixture.workspace.moveCalls.length, 15);
  assert.equal(testFixture.workspace.files.every((file) => file.parentPath !== "Inbox"), true);
  assert.equal(testFixture.repository.run?.executionStatus, "COMPLETED");
});

test("revalidates the approved snapshot immediately before writes and marks drift stale", async () => {
  const testFixture = fixture({ writeEnabled: true });
  const { proposalId } = await prepareProposal(testFixture);
  await testFixture.workflow.decideProposal({ proposalId, chatId: "oc_chat", ...identity, decision: "APPROVED" });
  testFixture.workspace.files[0]!.version = "changed";
  assert.match(await testFixture.workflow.buildExecutionMessage(proposalId), /changed/u);
  assert.equal(testFixture.repository.staleCalls, 1);
  assert.equal(testFixture.workspace.createCalls.length, 0);
  assert.equal(testFixture.workspace.moveCalls.length, 0);
});

test("rejecting a proposal is idempotent and never changes Drive", async () => {
  const testFixture = fixture({ writeEnabled: true });
  const { proposalId } = await prepareProposal(testFixture);
  const first = await testFixture.workflow.decideProposal({
    proposalId, chatId: "oc_chat", ...identity, decision: "REJECTED",
  });
  testFixture.repository.decisionResult = { kind: "existing", status: "REJECTED" };
  const second = await testFixture.workflow.decideProposal({
    proposalId, chatId: "oc_chat", ...identity, decision: "REJECTED",
  });
  assert.match(first, /No files or folders were changed/u);
  assert.match(second, /already rejected/u);
  assert.equal(testFixture.workspace.createCalls.length, 0);
  assert.equal(testFixture.workspace.moveCalls.length, 0);
});

test("read-only inventory remains available without provider calls or mutations", async () => {
  const testFixture = fixture();
  const result = await testFixture.workflow.readInventory({ ...identity, folderLink });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.inventory.files.length, 15);
  assert.equal(testFixture.workspace.createCalls.length, 0);
  assert.equal(testFixture.workspace.moveCalls.length, 0);
  assert.equal(digestFolderToken(rootToken).length, 64);
});
