import type { LarkTokenBroker } from "../../lark/auth/token-broker.js";
import {
  listMySpaceRootCompletely,
  type MySpaceRootReader,
} from "../../lark/drive/read-client.js";
import { withReadOnlyDriveTokenRecovery } from "../../lark/drive/errors.js";

type AccessTokenProvider = Pick<
  LarkTokenBroker,
  "getAccessToken" | "recoverAccessToken" | "markAccessTokenRejected"
>;

export type WorkspaceContext = {
  activeWorkspaceName: string;
  otherFolderNames: string[];
};

export async function loadWorkspaceContext(input: {
  requesterOpenId: string;
  tenantKey: string;
  activeRootToken: string;
  tokenBroker: AccessTokenProvider;
  driveReader: MySpaceRootReader;
}): Promise<WorkspaceContext | null> {
  const { requesterOpenId, tenantKey, tokenBroker } = input;
  const accessToken = await tokenBroker.getAccessToken(requesterOpenId, tenantKey);
  const { result: items } = await withReadOnlyDriveTokenRecovery(
    {
      accessToken,
      recoverAccessToken: (rejectedAccessToken) =>
        tokenBroker.recoverAccessToken(requesterOpenId, tenantKey, rejectedAccessToken),
      markAccessTokenRejected: (rejectedAccessToken) =>
        tokenBroker.markAccessTokenRejected(requesterOpenId, tenantKey, rejectedAccessToken),
    },
    (currentAccessToken) =>
      listMySpaceRootCompletely(input.driveReader, {
        accessToken: currentAccessToken,
        maxPages: 5,
        maxItems: 200,
      }),
  );

  const folders = items.filter((item) => item.type === "folder");
  const activeWorkspace = folders.find(
    (item) => item.token === input.activeRootToken,
  );
  if (!activeWorkspace) {
    return null;
  }

  return {
    activeWorkspaceName: activeWorkspace.name,
    otherFolderNames: folders
      .filter((item) => item.token !== input.activeRootToken)
      .map((item) => item.name)
      .sort(),
  };
}
