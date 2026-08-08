import assert from "node:assert/strict";
import test from "node:test";

import {
  DRIVE_INVENTORY_USER_SCOPES,
  TokenCipher,
  type LockedGrantResult,
  type OAuthGrantStore,
  type SaveOAuthGrantInput,
  type StoredOAuthGrant,
} from "../../lark/auth/index.js";
import { digestFolderToken, type DriveReader } from "../../lark/drive/index.js";
import type { AppConfig } from "../../config.js";
import type {
  InventoryRun,
  OAuthSession,
  OrganizeFolderRun,
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
  organizeFolderProposalAssociatedData,
  type OrganizeFolderProposal,
} from "./proposal.js";

const runId = "4d872758-1f71-4ed8-b141-a2d193ceea91";
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
  existingRun: OrganizeFolderRun | null = null;
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
  } | null = null;

  async findRunByMessageId(): Promise<OrganizeFolderRun | null> {
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
  }): Promise<ProposalDecisionStoreResult> {
    this.decisionInput = input;
    return this.decisionResult;
  }
}

const noOpReader: DriveReader = {
  async listFolderPage() { throw new Error("unused"); },
  async getMetadata() { throw new Error("unused"); },
};

function request(folderLink: string) {
  return {
    messageId: "om_message",
    chatId: "oc_chat",
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
    folderLink,
  };
}

function grant(scopes: readonly string[] = DRIVE_INVENTORY_USER_SCOPES): StoredOAuthGrant {
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
        return {
          runId,
          startUrl: new URL("http://localhost:3000/oauth/lark/start?request=opaque"),
        };
      },
    },
    tokenBroker: {
      async getAccessToken() { return "access-token"; },
      async recoverAccessToken() { return "recovered-token"; },
      async markAccessTokenRejected() {},
    },
    cipher,
    driveReader: noOpReader,
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

test("returns a bounded read-only authorization link when no grant exists", async () => {
  const { workflow } = createWorkflow();
  const result = await workflow.start(
    request("https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123"),
  );
  assert.equal(result.kind, "authorization_required");
  assert.match(result.replyText, /read-only file and folder metadata/);
  assert.match(result.replyText, /No files will be opened, downloaded, or changed/);
});

test("creates an inventory run only for the exact read-only grant", async () => {
  const accepted = createWorkflow({ grant: grant() });
  assert.equal(
    (await accepted.workflow.start(
      request("https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123"),
    )).kind,
    "inventory_ready",
  );
  assert.ok(accepted.repository.readyRunId);

  const broader = createWorkflow({
    grant: grant([...DRIVE_INVENTORY_USER_SCOPES, "space:document:move"]),
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
  repository.existingRun = {
    id: runId,
    messageId: "om_message",
    chatId: "oc_chat",
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
    state: "COMPLETED",
    oauthGrantId: "grant-id",
  };
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
    inventory_scan_id: "4e41b888-b1b9-46cf-aac8-3e0f35e0d266",
    moves: [
      {
        file_ref: "f1",
        file_name: "[product] - One.pdf",
        destination_ref: "d1",
        destination_name: "Product",
      },
      {
        file_ref: "f2",
        file_name: "[product] - Two.pdf",
        destination_ref: "d1",
        destination_name: "Product",
      },
      {
        file_ref: "f3",
        file_name: "[research] - Three.pdf",
        destination_ref: "d2",
        destination_name: "Research",
      },
      {
        file_ref: "f4",
        file_name: "[research] - Four.pdf",
        destination_ref: "d2",
        destination_name: "Research",
      },
    ],
  };
  repository.inventoryRun = {
    id: runId,
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
    repository.decisionResult = { kind: "recorded", status: decision };
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
    assert.match(reply, /No files were moved/);
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
    assert.match(reply, /No files were changed|No files were moved/);
  }
});

test("rejects a stored proposal encrypted for another run", async () => {
  const repository = new StubRepository();
  const cipher = new TokenCipher(Buffer.alloc(32, 5));
  const proposal = {
    proposal_id: runId,
    inventory_scan_id: "4e41b888-b1b9-46cf-aac8-3e0f35e0d266",
    moves: [],
  } satisfies OrganizeFolderProposal;
  repository.inventoryRun = {
    id: runId,
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
  };
  const { workflow } = createWorkflow({ repository, cipher });
  await assert.rejects(
    workflow.buildProposalMessage(runId),
    /stored organization proposal is invalid/,
  );
});
