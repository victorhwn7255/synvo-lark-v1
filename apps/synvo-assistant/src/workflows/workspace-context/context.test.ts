import assert from "node:assert/strict";
import test from "node:test";

import { DriveToolError, driveToolError } from "../../lark/drive/errors.js";
import type {
  MySpaceRootListPage,
  MySpaceRootReader,
} from "../../lark/drive/read-client.js";
import {
  loadWorkspaceContext,
} from "./context.js";

class RootReader implements MySpaceRootReader {
  readonly accessTokens: string[] = [];
  response: MySpaceRootListPage = {
    items: [
      { token: "other-3", name: "test_directory_3", type: "folder" },
      { token: "root-secret-123", name: "Test_Synvo_AI_Assistant", type: "folder" },
      { token: "file", name: "top-level.pdf", type: "file" },
      { token: "other-2", name: "test_directory_2", type: "folder" },
    ],
    hasMore: false,
  };

  async listMySpaceRootPage(input: {
    accessToken: string;
  }): Promise<MySpaceRootListPage> {
    this.accessTokens.push(input.accessToken);
    return this.response;
  }
}

function tokenBroker(overrides: {
  initialToken?: string;
  recoveredToken?: string;
} = {}) {
  const calls = { recovered: 0, rejected: 0 };
  return {
    calls,
    broker: {
      async getAccessToken(openId: string, tenantKey: string) {
        assert.equal(openId, "ou_victor");
        assert.equal(tenantKey, "tenant_synvo");
        return overrides.initialToken ?? "access-token";
      },
      async recoverAccessToken(
        openId: string,
        tenantKey: string,
        rejectedToken: string,
      ) {
        assert.equal(openId, "ou_victor");
        assert.equal(tenantKey, "tenant_synvo");
        assert.equal(rejectedToken, overrides.initialToken ?? "access-token");
        calls.recovered += 1;
        return overrides.recoveredToken ?? "recovered-token";
      },
      async markAccessTokenRejected(
        openId: string,
        tenantKey: string,
        rejectedToken: string,
      ) {
        assert.equal(openId, "ou_victor");
        assert.equal(tenantKey, "tenant_synvo");
        assert.equal(rejectedToken, overrides.recoveredToken ?? "recovered-token");
        calls.rejected += 1;
      },
    },
  };
}

test("matches the active workspace by exact token and returns sorted folder names", async () => {
  const reader = new RootReader();
  const { broker } = tokenBroker();

  const context = await loadWorkspaceContext({
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
    activeRootToken: "root-secret-123",
    tokenBroker: broker,
    driveReader: reader,
  });

  assert.deepEqual(context, {
    activeWorkspaceName: "Test_Synvo_AI_Assistant",
    otherFolderNames: ["test_directory_2", "test_directory_3"],
  });
  assert.deepEqual(reader.accessTokens, ["access-token"]);
  assert.equal(JSON.stringify(context).includes("root-secret-123"), false);
});

test("does not guess the active workspace from an identical name", async () => {
  const reader = new RootReader();
  reader.response = {
    items: [
      { token: "wrong-token", name: "Test_Synvo_AI_Assistant", type: "folder" },
    ],
    hasMore: false,
  };
  const { broker } = tokenBroker();

  assert.equal(
    await loadWorkspaceContext({
      requesterOpenId: "ou_victor",
      tenantKey: "tenant_synvo",
      activeRootToken: "root-secret-123",
      tokenBroker: broker,
      driveReader: reader,
    }),
    null,
  );
});

test("recovers one rejected token and revokes after a second rejection", async () => {
  const reader = new RootReader();
  reader.listMySpaceRootPage = async ({ accessToken }) => {
    reader.accessTokens.push(accessToken);
    throw driveToolError("UNAUTHORIZED", "safe", false, {
      authFailure: "ACCESS_TOKEN_REJECTED",
    });
  };
  const { broker, calls } = tokenBroker();

  await assert.rejects(
    loadWorkspaceContext({
      requesterOpenId: "ou_victor",
      tenantKey: "tenant_synvo",
      activeRootToken: "root-secret-123",
      tokenBroker: broker,
      driveReader: reader,
    }),
    (error: unknown) =>
      error instanceof DriveToolError &&
      error.safeError.code === "OAUTH_REVOKED",
  );
  assert.deepEqual(reader.accessTokens, ["access-token", "recovered-token"]);
  assert.deepEqual(calls, { recovered: 1, rejected: 1 });
});

test("retries My Folders once with the recovered access token", async () => {
  const reader = new RootReader();
  const originalResponse = reader.response;
  reader.listMySpaceRootPage = async ({ accessToken }) => {
    reader.accessTokens.push(accessToken);
    if (accessToken === "access-token") {
      throw driveToolError("UNAUTHORIZED", "safe", false, {
        authFailure: "ACCESS_TOKEN_REJECTED",
      });
    }
    return originalResponse;
  };
  const { broker, calls } = tokenBroker();

  const context = await loadWorkspaceContext({
    requesterOpenId: "ou_victor",
    tenantKey: "tenant_synvo",
    activeRootToken: "root-secret-123",
    tokenBroker: broker,
    driveReader: reader,
  });

  assert.equal(context?.activeWorkspaceName, "Test_Synvo_AI_Assistant");
  assert.deepEqual(reader.accessTokens, ["access-token", "recovered-token"]);
  assert.deepEqual(calls, { recovered: 1, rejected: 0 });
});

test("does not access Drive when the stored grant is unusable", async () => {
  const reader = new RootReader();
  const privateFailure = new Error("private wrong-scope grant");

  await assert.rejects(
    loadWorkspaceContext({
      requesterOpenId: "ou_victor",
      tenantKey: "tenant_synvo",
      activeRootToken: "root-secret-123",
      tokenBroker: {
        async getAccessToken() {
          throw privateFailure;
        },
        async recoverAccessToken() {
          throw new Error("Unexpected recovery");
        },
        async markAccessTokenRejected() {
          throw new Error("Unexpected revocation");
        },
      },
      driveReader: reader,
    }),
    (error: unknown) => error === privateFailure,
  );
  assert.deepEqual(reader.accessTokens, []);
});
