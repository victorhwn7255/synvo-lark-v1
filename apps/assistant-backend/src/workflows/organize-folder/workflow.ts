import { randomUUID } from "node:crypto";

import type { OAuthGrantStore } from "@synvo/lark-auth";
import { hasExactScopes, DRIVE_INVENTORY_USER_SCOPES } from "@synvo/lark-auth";
import {
  digestFolderToken,
  DriveToolError,
  parseLarkDriveFolderLink,
  requireAllowlistedRoot,
} from "@synvo/lark-mcp/drive";

import type { AppConfig } from "../../config.js";
import type { DriveInventoryClient } from "../../mcp/client.js";
import type { LarkOAuthService } from "../../oauth/service.js";
import type { OrganizeFolderRepository } from "../../repositories/organize-folder.js";
import { formatDriveFolderInventoryResult } from "./inventory-message.js";

export type OrganizeFolderRequest = {
  messageId: string;
  chatId: string;
  requesterOpenId: string;
  tenantKey: string;
  folderLink: string;
};

export type OrganizeFolderStartResult =
  | { kind: "authorization_required"; runId: string; replyText: string }
  | { kind: "inventory_ready"; runId: string; replyText: string }
  | { kind: "duplicate"; replyText: string }
  | { kind: "rejected"; replyText: string };

type OAuthAuthorizationStarter = Pick<
  LarkOAuthService,
  "createPendingAuthorization"
>;

export class OrganizeFolderWorkflow {
  readonly #config: AppConfig;
  readonly #grantStore: OAuthGrantStore;
  readonly #repository: OrganizeFolderRepository;
  readonly #oauthService: OAuthAuthorizationStarter;
  readonly #mcpClient: DriveInventoryClient;
  readonly #requiredScopes: readonly string[];
  readonly #authorizationPurpose: "read-only inventory" | "one-file move spike";

  constructor(options: {
    config: AppConfig;
    grantStore: OAuthGrantStore;
    repository: OrganizeFolderRepository;
    oauthService: OAuthAuthorizationStarter;
    mcpClient: DriveInventoryClient;
    requiredScopes?: readonly string[];
    authorizationPurpose?: "read-only inventory" | "one-file move spike";
  }) {
    this.#config = options.config;
    this.#grantStore = options.grantStore;
    this.#repository = options.repository;
    this.#oauthService = options.oauthService;
    this.#mcpClient = options.mcpClient;
    this.#requiredScopes = options.requiredScopes ?? DRIVE_INVENTORY_USER_SCOPES;
    this.#authorizationPurpose =
      options.authorizationPurpose ?? "read-only inventory";
  }

  async start(
    request: OrganizeFolderRequest,
  ): Promise<OrganizeFolderStartResult> {
    if (
      (this.#config.authorizedOpenId &&
        request.requesterOpenId !== this.#config.authorizedOpenId) ||
      (this.#config.authorizedTenantKey &&
        request.tenantKey !== this.#config.authorizedTenantKey)
    ) {
      return {
        kind: "rejected",
        replyText: "This account is not authorized for the Drive pilot.",
      };
    }

    try {
      const requestedToken = parseLarkDriveFolderLink(request.folderLink);
      requireAllowlistedRoot(
        requestedToken,
        this.#config.organizeFolderRootToken,
      );
    } catch (error) {
      const message =
        error instanceof DriveToolError
          ? error.safeError.message
          : "Provide a valid allowlisted Lark Drive folder link.";
      return { kind: "rejected", replyText: message };
    }

    const existing = await this.#repository.findRunByMessageId(request.messageId);
    if (existing) {
      return {
        kind: "duplicate",
        replyText: "This request is already being processed.",
      };
    }

    const grant = await this.#grantStore.findBySubject(
      request.requesterOpenId,
      request.tenantKey,
    );
    const grantUsable =
      grant !== null &&
      grant.revokedAt === null &&
      grant.refreshExpiresAt > new Date() &&
      hasExactScopes(grant.grantedScopes, this.#requiredScopes);
    const rootTokenDigest = digestFolderToken(
      this.#config.organizeFolderRootToken,
    );

    if (!grantUsable) {
      const pending = await this.#oauthService.createPendingAuthorization({
        messageId: request.messageId,
        chatId: request.chatId,
        requesterOpenId: request.requesterOpenId,
        tenantKey: request.tenantKey,
        rootTokenDigest,
      });
      if (!pending) {
        return {
          kind: "duplicate",
          replyText: "This request is already being processed.",
        };
      }
      return {
        kind: "authorization_required",
        runId: pending.runId,
        replyText: [
          this.#authorizationPurpose === "one-file move spike"
            ? "Lark Drive move pilot authorization is required."
            : "Read-only Lark Drive authorization is required.",
          "",
          `Authorize this request: ${pending.startUrl.toString()}`,
          "",
          this.#authorizationPurpose === "one-file move spike"
            ? "The link expires in 10 minutes. This requests exactly metadata, folder-list, offline refresh, and one-file move access."
            : "The link expires in 10 minutes. The assistant requests folder-list access, read-only file and folder metadata, and offline refresh access.",
          this.#authorizationPurpose === "one-file move spike"
            ? "No mutation occurs during authorization or inventory. A separate operator confirmation is required for the move spike."
            : "No files will be opened, downloaded, or changed.",
        ].join("\n"),
      };
    }

    const runId = randomUUID();
    const created = await this.#repository.createReadyRun({
      id: runId,
      messageId: request.messageId,
      chatId: request.chatId,
      requesterOpenId: request.requesterOpenId,
      tenantKey: request.tenantKey,
      rootTokenDigest,
      oauthGrantId: grant.id,
      deliveryJobId: randomUUID(),
    });
    if (!created) {
      return {
        kind: "duplicate",
        replyText: "This request is already being processed.",
      };
    }
    return {
      kind: "inventory_ready",
      runId,
      replyText:
        "Authorization found. Building a read-only inventory of the approved pilot folder...",
    };
  }

  async buildInventoryMessage(runId: string): Promise<string> {
    const result = await this.#mcpClient.getFolderInventory(runId).catch(() => {
      throw new Error(
        "The read-only folder inventory failed before a safe result was available.",
      );
    });

    if (!result.ok && result.error?.retryable) {
      throw new Error("The read-only folder inventory should be retried.");
    }
    return formatDriveFolderInventoryResult(result);
  }
}
