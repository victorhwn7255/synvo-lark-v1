import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  DRIVE_INVENTORY_USER_SCOPES,
  hasExactScopes,
  LarkAuthError,
  type LarkTokenBroker,
  type OAuthGrantStore,
  type TokenCipher,
} from "../../lark/auth/index.js";
import {
  buildAllowlistedFolderInventory,
  digestFolderToken,
  DriveToolError,
  driveToolError,
  normalizeDriveError,
  parseLarkDriveFolderLink,
  requireAllowlistedRoot,
  type DriveReader,
} from "../../lark/drive/index.js";
import type { AppConfig } from "../../config.js";
import type { LarkOAuthService } from "./authorization.js";
import {
  driveFolderInventoryResultAssociatedData,
  driveFolderInventoryResultSchema,
  type DriveFolderInventoryResult,
} from "./contracts.js";
import {
  formatDriveFolderInventoryResult,
  formatOrganizeFolderProposal,
} from "./inventory-message.js";
import {
  buildOrganizeFolderProposal,
  organizeFolderProposalAssociatedData,
  type OrganizeFolderProposal,
} from "./proposal.js";
import type { OrganizeFolderRepository } from "./repository.js";

export type OrganizeFolderRequest = {
  messageId: string;
  chatId: string;
  requesterOpenId: string;
  tenantKey: string;
  folderLink: string;
};

export type ReadOnlyFolderInventoryRequest = Pick<
  OrganizeFolderRequest,
  "requesterOpenId" | "tenantKey" | "folderLink"
>;

export type OrganizeFolderStartResult =
  | { kind: "authorization_required"; runId: string; replyText: string }
  | { kind: "inventory_ready"; runId: string; replyText: string }
  | { kind: "duplicate"; replyText: string }
  | { kind: "rejected"; replyText: string };

export type ProposalDecision = "APPROVED" | "REJECTED";

type OAuthAuthorizationStarter = Pick<
  LarkOAuthService,
  "createPendingAuthorization"
>;
type AccessTokenProvider = Pick<
  LarkTokenBroker,
  "getAccessToken" | "recoverAccessToken" | "markAccessTokenRejected"
>;

function normalizeInventoryError(error: unknown): DriveToolError {
  if (!(error instanceof LarkAuthError)) {
    return normalizeDriveError(error);
  }

  switch (error.code) {
    case "OAUTH_REQUIRED":
    case "WRONG_SCOPE":
      return driveToolError(
        "OAUTH_REQUIRED",
        "Lark authorization is required.",
      );
    case "OAUTH_REVOKED":
      return driveToolError(
        "OAUTH_REVOKED",
        "The Lark authorization is no longer usable.",
      );
    case "OAUTH_RETRYABLE":
      return driveToolError(
        "LARK_RETRYABLE",
        "Lark authorization is temporarily unavailable.",
        true,
      );
    case "WRONG_TENANT":
      return driveToolError(
        "WRONG_TENANT",
        "The stored Lark authorization belongs to a different tenant.",
      );
    case "WRONG_USER":
      return driveToolError(
        "UNAUTHORIZED",
        "The stored Lark authorization does not match the requesting user.",
      );
    case "OAUTH_REJECTED":
    case "OAUTH_MALFORMED":
      return driveToolError(
        "LARK_PERMANENT",
        "The Lark authorization could not be used safely.",
      );
  }
}

export class OrganizeFolderWorkflow {
  readonly #config: AppConfig;
  readonly #grantStore: OAuthGrantStore;
  readonly #repository: OrganizeFolderRepository;
  readonly #oauthService: OAuthAuthorizationStarter;
  readonly #tokenBroker: AccessTokenProvider;
  readonly #cipher: TokenCipher;
  readonly #driveReader: DriveReader;

  constructor(options: {
    config: AppConfig;
    grantStore: OAuthGrantStore;
    repository: OrganizeFolderRepository;
    oauthService: OAuthAuthorizationStarter;
    tokenBroker: AccessTokenProvider;
    cipher: TokenCipher;
    driveReader: DriveReader;
  }) {
    this.#config = options.config;
    this.#grantStore = options.grantStore;
    this.#repository = options.repository;
    this.#oauthService = options.oauthService;
    this.#tokenBroker = options.tokenBroker;
    this.#cipher = options.cipher;
    this.#driveReader = options.driveReader;
  }

  async start(
    request: OrganizeFolderRequest,
  ): Promise<OrganizeFolderStartResult> {
    try {
      this.#assertRequestAllowed(request);
    } catch (error) {
      const message =
        error instanceof DriveToolError
          ? error.safeError.message
          : "Provide a valid allowlisted Lark Drive folder link.";
      return { kind: "rejected", replyText: message };
    }

    if (await this.#repository.findRunByMessageId(request.messageId)) {
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
      hasExactScopes(grant.grantedScopes, DRIVE_INVENTORY_USER_SCOPES);
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
          "Read-only Lark Drive authorization is required.",
          "",
          `Authorize this request: ${pending.startUrl.toString()}`,
          "",
          "The link expires in 10 minutes. The assistant requests folder-list access, read-only file and folder metadata, and offline refresh access.",
          "No files will be opened, downloaded, or changed.",
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

  async readInventory(
    request: ReadOnlyFolderInventoryRequest,
  ): Promise<DriveFolderInventoryResult> {
    try {
      this.#assertRequestAllowed(request);
      return await this.#collectInventory(
        randomUUID(),
        request.requesterOpenId,
        request.tenantKey,
      );
    } catch (error) {
      return { ok: false, error: normalizeInventoryError(error).safeError };
    }
  }

  async buildProposalMessage(runId: string): Promise<string> {
    const run = await this.#repository.findInventoryRunById(runId);
    if (!run) {
      throw new Error("The read-only inventory run was not found.");
    }
    if (
      run.rootTokenDigest !==
      digestFolderToken(this.#config.organizeFolderRootToken)
    ) {
      throw new Error("The run does not target the approved pilot folder.");
    }
    if (run.state === "COMPLETED" || run.state === "FAILED_NO_CHANGE") {
      if (run.proposalCiphertext) {
        return formatOrganizeFolderProposal(
          this.#decryptStoredProposal(runId, run.proposalCiphertext),
        );
      }
      return formatDriveFolderInventoryResult(
        this.#decryptStoredResult(runId, run.resultCiphertext),
      );
    }
    if (!run.oauthGrantId || !run.oauthGrantMatchesSubject) {
      return this.#storeAndFormat(runId, {
        ok: false,
        error: {
          code: run.oauthGrantId ? "UNAUTHORIZED" : "OAUTH_REQUIRED",
          message: run.oauthGrantId
            ? "The stored Lark authorization does not match the requesting user."
            : "Lark authorization is required.",
          retryable: false,
        },
      });
    }
    if (run.state !== "READY_TO_SCAN" && run.state !== "SCANNING") {
      throw new Error("The read-only inventory run is not ready.");
    }

    const result = await this.#collectInventory(
      runId,
      run.requesterOpenId,
      run.tenantKey,
    );

    if (!result.ok && result.error?.retryable) {
      throw new Error("The read-only folder inventory should be retried.");
    }
    return this.#storeAndFormat(runId, result);
  }

  async decideProposal(input: {
    proposalId: string;
    requesterOpenId: string;
    tenantKey: string;
    decision: ProposalDecision;
  }): Promise<string> {
    try {
      this.#assertActorAllowed(input);
    } catch (error) {
      return error instanceof DriveToolError
        ? `${error.safeError.message}\n\nNo files were changed.`
        : "This proposal cannot be decided.\n\nNo files were changed.";
    }
    if (!z.uuid().safeParse(input.proposalId).success) {
      return "Provide a valid proposal ID.\n\nNo files were changed.";
    }

    const stored = await this.#repository.recordProposalDecision({
      ...input,
      decidedAt: new Date(),
    });
    if (stored.kind === "not_found") {
      return "That proposal is unavailable for this user and tenant.\n\nNo files were changed.";
    }
    if (stored.kind === "recorded") {
      return this.#formatDecision(input.proposalId, stored.status, false);
    }
    if (stored.status === "STALE") {
      return "That proposal is stale. Run /organize-folder again.\n\nNo files were changed.";
    }
    if (stored.status === "PROPOSED") {
      return "That proposal could not be decided safely.\n\nNo files were changed.";
    }
    if (stored.status === input.decision) {
      return this.#formatDecision(input.proposalId, stored.status, true);
    }
    return [
      `Proposal ${input.proposalId} was already ${stored.status.toLowerCase()}.`,
      "The conflicting decision was not recorded.",
      "",
      "No files were changed.",
    ].join("\n");
  }

  #formatDecision(
    proposalId: string,
    decision: "APPROVED" | "REJECTED",
    duplicate: boolean,
  ): string {
    const action = decision === "APPROVED" ? "approved" : "rejected";
    return [
      `Proposal ${proposalId} ${duplicate ? "was already" : "is now"} ${action}.`,
      "",
      "No files were moved. Drive execution remains disabled.",
    ].join("\n");
  }

  #assertRequestAllowed(request: ReadOnlyFolderInventoryRequest): void {
    this.#assertActorAllowed(request);

    const requestedToken = parseLarkDriveFolderLink(request.folderLink);
    requireAllowlistedRoot(
      requestedToken,
      this.#config.organizeFolderRootToken,
    );
  }

  #assertActorAllowed(request: {
    requesterOpenId: string;
    tenantKey: string;
  }): void {
    if (
      request.tenantKey !== this.#config.authorizedTenantKey
    ) {
      throw driveToolError(
        "WRONG_TENANT",
        "This tenant is not authorized for the Drive pilot.",
      );
    }
    if (
      request.requesterOpenId !== this.#config.authorizedOpenId
    ) {
      throw driveToolError(
        "UNAUTHORIZED",
        "This account is not authorized for the Drive pilot.",
      );
    }
  }

  async #collectInventory(
    operationId: string,
    requesterOpenId: string,
    tenantKey: string,
  ): Promise<DriveFolderInventoryResult> {
    try {
      const accessToken = await this.#tokenBroker.getAccessToken(
        requesterOpenId,
        tenantKey,
      );
      const inventory = await buildAllowlistedFolderInventory(
        this.#driveReader,
        {
          runId: operationId,
          requesterOpenId,
          rootToken: this.#config.organizeFolderRootToken,
          accessToken,
          recoverAccessToken: (rejectedToken) =>
            this.#tokenBroker.recoverAccessToken(
              requesterOpenId,
              tenantKey,
              rejectedToken,
            ),
          markAccessTokenRejected: (rejectedToken) =>
            this.#tokenBroker.markAccessTokenRejected(
              requesterOpenId,
              tenantKey,
              rejectedToken,
            ),
        },
      );
      return { ok: true, inventory };
    } catch (error) {
      return { ok: false, error: normalizeInventoryError(error).safeError };
    }
  }

  async finalizeExhaustedInventory(runId: string): Promise<string> {
    return this.#storeAndFormat(runId, {
      ok: false,
      error: {
        code: "INTERNAL",
        message:
          "The read-only inventory could not be completed after several attempts.",
        retryable: false,
      },
    });
  }

  #decryptStoredResult(
    runId: string,
    ciphertext: string | null,
  ): DriveFolderInventoryResult {
    if (!ciphertext) {
      throw new Error("The stored read-only inventory result is unavailable.");
    }
    try {
      return JSON.parse(
        this.#cipher.decrypt(
          ciphertext,
          driveFolderInventoryResultAssociatedData(runId),
        ),
      ) as DriveFolderInventoryResult;
    } catch {
      throw new Error("The stored read-only inventory result is invalid.");
    }
  }

  #decryptStoredProposal(
    runId: string,
    ciphertext: string,
  ): OrganizeFolderProposal {
    try {
      return JSON.parse(
        this.#cipher.decrypt(
          ciphertext,
          organizeFolderProposalAssociatedData(runId),
        ),
      ) as OrganizeFolderProposal;
    } catch {
      throw new Error("The stored organization proposal is invalid.");
    }
  }

  async #storeAndFormat(
    runId: string,
    result: DriveFolderInventoryResult,
  ): Promise<string> {
    const validated = driveFolderInventoryResultSchema.parse(result);
    const successfulBaseline =
      validated.ok && validated.inventory?.baseline_matches === true;
    const resultCiphertext = this.#cipher.encrypt(
      JSON.stringify(validated),
      driveFolderInventoryResultAssociatedData(runId),
    );
    const proposal = successfulBaseline
      ? buildOrganizeFolderProposal(validated.inventory!, runId)
      : null;
    // Defends proposal contents against database-only compromise and binds
    // them to this workflow run.
    const proposalCiphertext = proposal
      ? this.#cipher.encrypt(
          JSON.stringify(proposal),
          organizeFolderProposalAssociatedData(runId),
        )
      : null;
    const stored = successfulBaseline
      ? await this.#repository.storeInventoryResult({
          runId,
          resultCiphertext,
          state: "COMPLETED",
          errorCode: null,
          proposalCiphertext: proposalCiphertext!,
          proposalStatus: "PROPOSED",
        })
      : await this.#repository.storeInventoryResult({
          runId,
          resultCiphertext,
          state: "FAILED_NO_CHANGE",
          errorCode:
            validated.error?.code ?? "UNEXPECTED_SANDBOX_STATE",
          proposalCiphertext: null,
          proposalStatus: null,
        });
    if (!stored) {
      throw new Error("The read-only inventory result could not be stored.");
    }
    return proposal
      ? formatOrganizeFolderProposal(proposal)
      : formatDriveFolderInventoryResult(validated);
  }
}
