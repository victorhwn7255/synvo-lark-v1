import assert from "node:assert/strict";
import test from "node:test";

import type {
  LockedGrantResult,
  OAuthGrantStore,
  SaveOAuthGrantInput,
  StoredOAuthGrant,
} from "@synvo/lark-auth";
import { PHASE_2_USER_SCOPES } from "@synvo/lark-auth";

import type { AppConfig } from "../../config.js";
import type { DriveInventoryClient } from "../../mcp/client.js";
import type {
  OAuthSession,
  OrganizeFolderRun,
  Phase2Repository,
} from "../../repositories/phase2.js";
import { OrganizeFolderWorkflow } from "./service.js";

const config: AppConfig = {
  appId: "cli_0123456789abcdef",
  appSecret: "app-secret",
  databaseUrl: "postgresql://local",
  httpHost: "127.0.0.1",
  httpPort: 3000,
  larkOAuthRedirectUri: "http://localhost:3000/oauth/lark/callback",
  oauthTokenEncryptionKey: Buffer.alloc(32, 1).toString("base64url"),
  organizeFolderRootToken: "fldcnRoot123",
  organizeFolderWriteEnabled: false,
};

class StubGrantStore implements OAuthGrantStore {
  grant: StoredOAuthGrant | null = null;
  findCalls = 0;

  async findBySubject(): Promise<StoredOAuthGrant | null> {
    this.findCalls += 1;
    return this.grant;
  }

  async save(input: SaveOAuthGrantInput): Promise<StoredOAuthGrant> {
    this.grant = input;
    return input;
  }

  async withLockedGrant<T>(
    _openId: string,
    _tenantKey: string,
    operation: (grant: StoredOAuthGrant) => Promise<LockedGrantResult<T>>,
  ): Promise<T> {
    if (!this.grant) {
      throw new Error("No grant");
    }
    return (await operation(this.grant)).result;
  }
}

class StubRepository implements Phase2Repository {
  readyRunId: string | null = null;
  findCalls = 0;

  async findRunByMessageId(): Promise<OrganizeFolderRun | null> {
    this.findCalls += 1;
    return null;
  }
  async createReadyRun(input: { id: string }): Promise<boolean> {
    this.readyRunId = input.id;
    return true;
  }
  async createAwaitingOAuthRun(): Promise<boolean> {
    return true;
  }
  async startOAuthSession(): Promise<OAuthSession | null> {
    return null;
  }
  async consumeOAuthSession(): Promise<OAuthSession | null> {
    return null;
  }
  async bindGrantToRun(): Promise<void> {}
  async markRunFailed(): Promise<void> {}
}

const mcpClient: DriveInventoryClient = {
  async scanFolder(runId) {
    return {
      ok: false,
      error: {
        code: "RUN_NOT_READY",
        message: `Run ${runId} is not ready.`,
        retryable: false,
      },
    };
  },
  async close() {},
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

function createWorkflow(options: {
  grant?: StoredOAuthGrant | null;
  configOverride?: Partial<AppConfig>;
  mcpClient?: DriveInventoryClient;
} = {}) {
  const grantStore = new StubGrantStore();
  grantStore.grant = options.grant ?? null;
  const repository = new StubRepository();
  const workflow = new OrganizeFolderWorkflow({
    config: { ...config, ...options.configOverride },
    grantStore,
    repository,
    oauthService: {
      async createPendingAuthorization() {
        return {
          runId: "4d872758-1f71-4ed8-b141-a2d193ceea91",
          startUrl: new URL(
            "http://localhost:3000/oauth/lark/start?request=opaque",
          ),
        };
      },
    },
    mcpClient: options.mcpClient ?? mcpClient,
  });
  return { workflow, repository };
}

test("rejects an external link before authorization or Drive access", async () => {
  const { workflow } = createWorkflow();
  const result = await workflow.start(
    request("https://example.com/drive/folder/fldcnRoot123"),
  );

  assert.equal(result.kind, "rejected");
});

test("rejects a valid Lark sibling folder without revealing its token", async () => {
  const { workflow } = createWorkflow();
  const result = await workflow.start(
    request("https://synvo-ai.larksuite.com/drive/folder/fldcnSibling"),
  );

  assert.equal(result.kind, "rejected");
  assert.equal(result.replyText.includes("fldcnSibling"), false);
});

test("returns a user-bound authorization link when no grant exists", async () => {
  const { workflow } = createWorkflow();
  const result = await workflow.start(
    request("https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123"),
  );

  assert.equal(result.kind, "authorization_required");
  assert.match(result.replyText, /expires in 10 minutes/);
  assert.match(result.replyText, /read-only file and folder metadata/);
  assert.match(result.replyText, /No files will be opened, downloaded, or changed/);
});

test("rejects users outside the configured pilot identity before Drive lookup", async (t) => {
  for (const identity of [
    { requesterOpenId: "ou_someone_else", tenantKey: "tenant_synvo" },
    { requesterOpenId: "ou_victor", tenantKey: "tenant_other" },
  ]) {
    await t.test(`${identity.requesterOpenId}:${identity.tenantKey}`, async () => {
      const { workflow, repository } = createWorkflow({
        configOverride: {
          authorizedOpenId: "ou_victor",
          authorizedTenantKey: "tenant_synvo",
        },
      });
      const result = await workflow.start({
        ...request("https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123"),
        ...identity,
      });

      assert.equal(result.kind, "rejected");
      assert.equal(repository.findCalls, 0);
    });
  }
});

test("creates a read-only scan run for a refreshable minimum-scope grant", async () => {
  const grant: StoredOAuthGrant = {
    id: "4e41b888-b1b9-46cf-aac8-3e0f35e0d266",
    openId: "ou_victor",
    tenantKey: "tenant_synvo",
    accessTokenCiphertext: "ciphertext",
    refreshTokenCiphertext: "ciphertext",
    grantedScopes: [...PHASE_2_USER_SCOPES],
    accessExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    refreshExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    refreshVersion: 1,
    revokedAt: null,
  };
  const { workflow, repository } = createWorkflow({ grant });
  const result = await workflow.start(
    request("https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123"),
  );

  assert.equal(result.kind, "scan_ready");
  assert.equal(repository.readyRunId, result.kind === "scan_ready" ? result.runId : null);
});

test("requires authorization when a stored grant has any scope outside Phase 2", async (t) => {
  for (const extraScope of [
    "drive:drive",
    "space:document:move",
    "drive:file:download",
  ]) {
    await t.test(extraScope, async () => {
      const grant: StoredOAuthGrant = {
        id: "4e41b888-b1b9-46cf-aac8-3e0f35e0d266",
        openId: "ou_victor",
        tenantKey: "tenant_synvo",
        accessTokenCiphertext: "ciphertext",
        refreshTokenCiphertext: "ciphertext",
        grantedScopes: [...PHASE_2_USER_SCOPES, extraScope],
        accessExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
        refreshExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
        refreshVersion: 1,
        revokedAt: null,
      };
      const { workflow, repository } = createWorkflow({ grant });

      const result = await workflow.start(
        request("https://synvo-ai.larksuite.com/drive/folder/fldcnRoot123"),
      );

      assert.equal(result.kind, "authorization_required");
      assert.equal(repository.readyRunId, null);
    });
  }
});

test("propagates a retryable structured MCP failure to the delivery worker", async () => {
  const providerDetail = "private provider response must not escape";
  const { workflow } = createWorkflow({
    mcpClient: {
      async scanFolder() {
        return {
          ok: false,
          error: {
            code: "LARK_RETRYABLE",
            message: providerDetail,
            retryable: true,
          },
        };
      },
      async close() {},
    },
  });

  await assert.rejects(
    workflow.scan("4d872758-1f71-4ed8-b141-a2d193ceea91"),
    (error: unknown) =>
      error instanceof Error &&
      /should be retried/.test(error.message) &&
      !error.message.includes(providerDetail),
  );
});

test("propagates a sanitized MCP transport failure to the delivery worker", async () => {
  const providerDetail = "private transport response must not escape";
  const { workflow } = createWorkflow({
    mcpClient: {
      async scanFolder() {
        throw new Error(providerDetail);
      },
      async close() {},
    },
  });

  await assert.rejects(
    workflow.scan("4d872758-1f71-4ed8-b141-a2d193ceea91"),
    (error: unknown) =>
      error instanceof Error &&
      /safe result/.test(error.message) &&
      !error.message.includes(providerDetail),
  );
});

test("formats a nonretryable safe MCP failure for Lark delivery", async () => {
  const { workflow } = createWorkflow({
    mcpClient: {
      async scanFolder() {
        return {
          ok: false,
          error: {
            code: "OAUTH_REVOKED",
            message: "The Lark authorization is no longer usable.",
            retryable: false,
          },
        };
      },
      async close() {},
    },
  });

  assert.equal(
    await workflow.scan("4d872758-1f71-4ed8-b141-a2d193ceea91"),
    "The Lark authorization is no longer usable.\n\nNo files were changed.",
  );
});
