import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { z } from "zod";

import type { AppConfig } from "../../config.js";
import type { DeliveryJobKind } from "../../delivery/repository.js";
import {
  ORGANIZE_FOLDER_USER_SCOPES,
  hasExactScopes,
  LarkAuthError,
  type LarkTokenBroker,
  type OAuthGrantStore,
  type TokenCipher,
} from "../../lark/auth/index.js";
import {
  digestFolderToken,
  DriveMoveError,
  DriveToolError,
  driveToolError,
  normalizeDriveError,
  parseLarkDriveFolderLink,
  requireAllowlistedRoot,
  type DriveFolderCreator,
  type DriveMover,
} from "../../lark/drive/index.js";
import type {
  AuthorizedDrivePdfReader,
  WorkspaceDriveInventory,
} from "../analyze-drive-file/authorized-reader.js";
import type { KnowledgeWorkflow } from "../knowledge/workflow.js";
import type { LarkOAuthService } from "./authorization.js";
import {
  snapshotWorkspaceInventory,
  type ContentAwareFolderPlanner,
} from "./content-planner.js";
import {
  driveFolderInventoryResultAssociatedData,
  type DriveFolderInventoryResult,
  workspaceSnapshotDigest,
} from "./contracts.js";
import {
  createExecutionRecord,
  executionAssociatedData,
  finalExecutionStatus,
  finalUndoStatus,
  formatExecutionResult,
  formatUndoResult,
  inventoryMatchesApprovedSnapshot,
  inventoryMatchesExecutionTarget,
  inventoryMatchesUndoTarget,
  type ExecutionStatus,
  type OrganizeFolderExecutionRecord,
  type UndoStatus,
} from "./execution.js";
import {
  formatDriveFolderInventoryResult,
  formatOrganizeFolderProposal,
} from "./inventory-message.js";
import { normalizeDestinationName, workspaceOrganizationPolicy } from "./policy.js";
import {
  buildOrganizeFolderProposal,
  organizeFolderProposalAssociatedData,
  type OrganizeFolderProposal,
  type ProposedTaxonomyFolder,
  type ContentDecision,
} from "./proposal.js";
import type { InventoryRun, OrganizeFolderRepository } from "./repository.js";

export type OrganizeFolderRequest = {
  messageId: string;
  chatId: string;
  requesterOpenId: string;
  tenantKey: string;
  folderLink: string;
  authorizationDelivery?: "queued" | "inline";
};

export type ReadOnlyFolderInventoryRequest = Pick<
  OrganizeFolderRequest,
  "requesterOpenId" | "tenantKey"
> & { folderLink?: string };

export type OrganizeFolderStartResult =
  | { kind: "authorization_required" }
  | { kind: "inventory_ready" }
  | { kind: "duplicate" }
  | { kind: "rejected"; replyText: string };

export type WorkspaceOrganizationConsentResult =
  | { kind: "authorization_required"; authorizationUrl: URL }
  | { kind: "duplicate" }
  | {
      kind: "ready";
      inventory: DriveFolderInventoryResult & { ok: true };
      snapshotDigest: string;
      expiresAt: number;
    }
  | { kind: "rejected"; replyText: string };

export type ProposalDecision = "APPROVED" | "REJECTED";

type OAuthAuthorizationStarter = Pick<LarkOAuthService, "createPendingAuthorization">;
type AccessTokenProvider = Pick<
  LarkTokenBroker,
  "getAccessToken" | "recoverAccessToken" | "markAccessTokenRejected"
>;
type WorkspaceReader = Pick<AuthorizedDrivePdfReader, "inspectWorkspace">;
type OrganizationKnowledge = Pick<KnowledgeWorkflow, "reconcileWorkspacePaths">;
type ContentPlanner = Pick<ContentAwareFolderPlanner, "plan">;

function normalizeInventoryError(error: unknown): DriveToolError {
  if (!(error instanceof LarkAuthError)) return normalizeDriveError(error);
  switch (error.code) {
    case "OAUTH_REQUIRED":
    case "WRONG_SCOPE":
      return driveToolError("OAUTH_REQUIRED", "Please connect Lark Drive before I inspect this workspace.");
    case "OAUTH_REVOKED":
      return driveToolError("OAUTH_REVOKED", "Your Lark Drive connection expired or was revoked. Please connect it again.");
    case "OAUTH_RETRYABLE":
      return driveToolError("LARK_RETRYABLE", "Lark authorization is temporarily unavailable. Please try again.", true);
    case "WRONG_TENANT":
      return driveToolError("WRONG_TENANT", "This Lark Drive connection belongs to a different workspace.");
    case "WRONG_USER":
      return driveToolError("UNAUTHORIZED", "This Lark Drive connection belongs to a different user.");
    default:
      return driveToolError("LARK_PERMANENT", "I couldn’t safely use this Lark Drive connection. Please connect it again.");
  }
}

export class OrganizeFolderWorkflow {
  readonly #config: AppConfig;
  readonly #grantStore: OAuthGrantStore;
  readonly #repository: OrganizeFolderRepository;
  readonly #oauthService: OAuthAuthorizationStarter;
  readonly #tokenBroker: AccessTokenProvider;
  readonly #cipher: TokenCipher;
  readonly #workspaceReader: WorkspaceReader;
  readonly #driveMover: DriveMover;
  readonly #folderCreator: DriveFolderCreator;
  readonly #knowledge: OrganizationKnowledge;
  readonly #contentPlanner: ContentPlanner;

  constructor(options: {
    config: AppConfig;
    grantStore: OAuthGrantStore;
    repository: OrganizeFolderRepository;
    oauthService: OAuthAuthorizationStarter;
    tokenBroker: AccessTokenProvider;
    cipher: TokenCipher;
    workspaceReader: WorkspaceReader;
    driveMover: DriveMover;
    folderCreator: DriveFolderCreator;
    knowledge: OrganizationKnowledge;
    contentPlanner: ContentPlanner;
  }) {
    this.#config = options.config;
    this.#grantStore = options.grantStore;
    this.#repository = options.repository;
    this.#oauthService = options.oauthService;
    this.#tokenBroker = options.tokenBroker;
    this.#cipher = options.cipher;
    this.#workspaceReader = options.workspaceReader;
    this.#driveMover = options.driveMover;
    this.#folderCreator = options.folderCreator;
    this.#knowledge = options.knowledge;
    this.#contentPlanner = options.contentPlanner;
  }

  async prepareConsent(
    request: OrganizeFolderRequest,
  ): Promise<WorkspaceOrganizationConsentResult> {
    try {
      this.#assertRequestAllowed(request);
    } catch (error) {
      return {
        kind: "rejected",
        replyText: error instanceof DriveToolError
          ? error.safeError.message
          : "Please use the active Synvo workspace.",
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
      hasExactScopes(grant.grantedScopes, ORGANIZE_FOLDER_USER_SCOPES);
    const rootTokenDigest = digestFolderToken(this.#config.organizeFolderRootToken);
    if (!grantUsable) {
      if (await this.#repository.hasRunForMessage(request.messageId)) {
        return { kind: "duplicate" };
      }
      const created = await this.#oauthService.createPendingAuthorization({
        messageId: request.messageId,
        chatId: request.chatId,
        requesterOpenId: request.requesterOpenId,
        tenantKey: request.tenantKey,
        rootTokenDigest,
        delivery: request.authorizationDelivery,
      });
      return created.created
        ? {
            kind: "authorization_required",
            authorizationUrl: created.startUrl,
          }
        : { kind: "duplicate" };
    }
    try {
      const inventory = {
        ok: true as const,
        inventory: snapshotWorkspaceInventory(
          randomUUID(),
          await this.#inspectWorkspace(request),
        ),
      };
      return {
        kind: "ready",
        inventory,
        snapshotDigest: workspaceSnapshotDigest(inventory.inventory),
        expiresAt: Date.now() + workspaceOrganizationPolicy.consentTtlMs,
      };
    } catch (error) {
      return {
        kind: "rejected",
        replyText: normalizeInventoryError(error).safeError.message,
      };
    }
  }

  async start(
    request: OrganizeFolderRequest & {
      consentSnapshotDigest: string;
      consentExpiresAt: number;
    },
  ): Promise<OrganizeFolderStartResult> {
    try {
      this.#assertRequestAllowed(request);
    } catch (error) {
      return {
        kind: "rejected",
        replyText: error instanceof DriveToolError
          ? error.safeError.message
          : "Please use the active Synvo workspace.",
      };
    }
    if (
      !/^[0-9a-f]{64}$/u.test(request.consentSnapshotDigest) ||
      !Number.isSafeInteger(request.consentExpiresAt) ||
      request.consentExpiresAt <= Date.now()
    ) {
      return {
        kind: "rejected",
        replyText: "That analysis approval expired. Please review the workspace again.",
      };
    }
    if (await this.#repository.hasRunForMessage(request.messageId)) {
      return { kind: "duplicate" };
    }
    const grant = await this.#grantStore.findBySubject(
      request.requesterOpenId,
      request.tenantKey,
    );
    const grantUsable =
      grant !== null &&
      grant.revokedAt === null &&
      grant.refreshExpiresAt > new Date() &&
      hasExactScopes(grant.grantedScopes, ORGANIZE_FOLDER_USER_SCOPES);
    if (!grantUsable) {
      return {
        kind: "rejected",
        replyText: "Please reconnect Lark Drive, then review this workspace again.",
      };
    }
    const runId = randomUUID();
    let consentedInventory: DriveFolderInventoryResult & { ok: true };
    try {
      const observed = snapshotWorkspaceInventory(
        runId,
        await this.#inspectWorkspace(request),
      );
      if (workspaceSnapshotDigest(observed) !== request.consentSnapshotDigest) {
        return {
          kind: "rejected",
          replyText: "The workspace changed after you reviewed it. Please review a fresh analysis request.",
        };
      }
      consentedInventory = { ok: true, inventory: observed };
    } catch (error) {
      return {
        kind: "rejected",
        replyText: normalizeInventoryError(error).safeError.message,
      };
    }
    const rootTokenDigest = digestFolderToken(
      this.#config.organizeFolderRootToken,
    );
    // Defends the exact provider-consent snapshot against changes while the queued worker waits.
    const consentSnapshotCiphertext = this.#cipher.encrypt(
      JSON.stringify(consentedInventory),
      driveFolderInventoryResultAssociatedData(runId),
    );
    const created = await this.#repository.createReadyRun({
      id: runId,
      messageId: request.messageId,
      chatId: request.chatId,
      requesterOpenId: request.requesterOpenId,
      tenantKey: request.tenantKey,
      rootTokenDigest,
      oauthGrantId: grant.id,
      consentSnapshotCiphertext,
      deliveryJobId: randomUUID(),
    });
    return created ? { kind: "inventory_ready" } : { kind: "duplicate" };
  }

  async readProposalMessage(input: {
    proposalId: string;
    chatId: string;
    requesterOpenId: string;
    tenantKey: string;
  }): Promise<string> {
    try {
      this.#assertActorAllowed(input);
    } catch {
      return "I couldn’t open that workspace proposal safely.";
    }
    if (!z.uuid().safeParse(input.proposalId).success) {
      return "I couldn’t recognize that workspace proposal.";
    }
    const run = await this.#repository.findInventoryRunById(input.proposalId);
    if (
      !run ||
      run.chatId !== input.chatId ||
      run.requesterOpenId !== input.requesterOpenId ||
      run.tenantKey !== input.tenantKey ||
      !run.proposalCiphertext
    ) {
      return "I couldn’t find that workspace proposal.";
    }
    return formatOrganizeFolderProposal(
      this.#decryptProposal(input.proposalId, run.proposalCiphertext),
    );
  }

  async readInventory(
    request: ReadOnlyFolderInventoryRequest,
  ): Promise<DriveFolderInventoryResult> {
    try {
      this.#assertActorAllowed(request);
      if (request.folderLink) this.#assertFolderLinkAllowed(request.folderLink);
      const observed = await this.#inspectWorkspace(request);
      return { ok: true, inventory: snapshotWorkspaceInventory(randomUUID(), observed) };
    } catch (error) {
      return { ok: false, error: normalizeInventoryError(error).safeError };
    }
  }

  async buildProposalMessage(runId: string): Promise<string> {
    const run = await this.#requireRun(runId);
    if (run.state === "COMPLETED" || run.state === "FAILED_NO_CHANGE") {
      return run.proposalCiphertext
        ? formatOrganizeFolderProposal(this.#decryptProposal(runId, run.proposalCiphertext))
        : formatDriveFolderInventoryResult(this.#decryptResult(runId, run.resultCiphertext));
    }
    if (!run.oauthGrantId || !run.oauthGrantMatchesSubject) {
      return this.#storeFailure(runId, run.oauthGrantId ? "UNAUTHORIZED" : "OAUTH_REQUIRED", "Lark authorization is required.");
    }
    if (run.state !== "READY_TO_SCAN" && run.state !== "SCANNING") {
      throw new Error("The workspace analysis run is not ready.");
    }
    const consentedResult = this.#decryptResult(runId, run.resultCiphertext);
    if (!consentedResult.ok) {
      return this.#storeFailure(runId, "UNEXPECTED_WORKSPACE_STATE", "The approved workspace snapshot is unavailable.");
    }
    const plan = await this.#contentPlanner.plan(runId, {
      requesterOpenId: run.requesterOpenId,
      tenantKey: run.tenantKey,
    }, consentedResult.inventory);
    if (plan.kind === "failed") {
      if (plan.retryable) throw new Error("The content-aware workspace plan should be retried.");
      return this.#storeFailure(runId, "INTERNAL", plan.message);
    }
    if (plan.kind === "inventory_not_ready") {
      return this.#storeResult(runId, plan.inventoryResult);
    }
    return this.#storeResult(
      runId,
      plan.inventoryResult,
      plan.taxonomy,
      plan.decisions,
    );
  }

  async decideProposal(input: {
    proposalId: string;
    chatId: string;
    requesterOpenId: string;
    tenantKey: string;
    decision: ProposalDecision;
    operationMessageId?: string;
  }): Promise<string> {
    try {
      this.#assertActorAllowed(input);
    } catch (error) {
      return error instanceof DriveToolError
        ? `${error.safeError.message}\n\nNo files were changed.`
        : "I couldn’t record that decision safely. No files were changed.";
    }
    if (!z.uuid().safeParse(input.proposalId).success) {
      return "I couldn’t recognize that workspace proposal. No files were changed.";
    }
    const stored = await this.#repository.recordProposalDecision({
      ...input,
      decidedAt: new Date(),
      proposalNotBefore: new Date(
        Date.now() - workspaceOrganizationPolicy.proposalTtlMs,
      ),
      executionJobId:
        input.decision === "APPROVED" && this.#config.organizeFolderWriteEnabled
          ? randomUUID()
          : undefined,
      operationMessageId: input.operationMessageId,
    });
    if (stored.kind === "not_found") {
      return "I couldn’t find that workspace proposal for your account. No files were changed.";
    }
    if (stored.kind === "recorded") {
      return this.#formatDecision(input.proposalId, stored.status, false, stored.executionQueued);
    }
    if (stored.status === "STALE") {
      return "This proposal is out of date because the workspace changed. Please start a fresh analysis. No files were changed.";
    }
    if (stored.status === input.decision) {
      return this.#formatDecision(input.proposalId, stored.status, true, false);
    }
    return `Proposal ${input.proposalId} was already ${stored.status.toLowerCase()}.\nI kept the original decision. No files were changed.`;
  }

  async requestUndo(input: {
    proposalId: string;
    chatId: string;
    requesterOpenId: string;
    tenantKey: string;
    operationMessageId?: string;
  }): Promise<string> {
    try {
      this.#assertActorAllowed(input);
    } catch {
      return "I couldn’t start that undo safely. No files were changed.";
    }
    if (!z.uuid().safeParse(input.proposalId).success) {
      return "I couldn’t recognize that workspace proposal. No files were changed.";
    }
    if (!this.#config.organizeFolderWriteEnabled) {
      return "Workspace changes are paused by the operator safety switch, so I can’t undo them right now.";
    }
    const run = await this.#repository.findInventoryRunById(input.proposalId);
    if (
      !run ||
      run.chatId !== input.chatId ||
      run.requesterOpenId !== input.requesterOpenId ||
      run.tenantKey !== input.tenantKey ||
      !this.#runMatchesMutationBoundary(run) ||
      !run.executionCiphertext ||
      !["COMPLETED", "PARTIAL"].includes(run.executionStatus ?? "")
    ) {
      return "I couldn’t find verified workspace moves to undo. No files were changed.";
    }
    const record = this.#decryptExecution(input.proposalId, run.executionCiphertext);
    const verified = record.moves.filter((move) => move.status === "VERIFIED");
    if (verified.length === 0) return "There are no verified moved files to restore.";
    record.undo ??= {
      requestedByOpenId: input.requesterOpenId,
      requestedAt: new Date().toISOString(),
      moves: verified.map((move) => ({ fileRef: move.fileRef, status: "PENDING" })),
    };
    const requested = await this.#repository.requestUndo({
      ...input,
      deliveryJobId: randomUUID(),
      executionCiphertext: this.#encryptExecution(record),
      operationMessageId: input.operationMessageId,
    });
    if (requested.kind === "recorded") {
      return `Undo is queued for proposal ${input.proposalId}. I’ll verify every restored parent.`;
    }
    if (requested.kind === "existing") {
      return `Undo for proposal ${input.proposalId} is already ${requested.status.toLowerCase()}.`;
    }
    return "That workspace proposal is not ready to undo. No files were changed.";
  }

  async getOperationMessageId(proposalId: string): Promise<string | null> {
    return (await this.#repository.findInventoryRunById(proposalId))
      ?.operationMessageId ?? null;
  }

  async buildExecutionMessage(proposalId: string): Promise<string> {
    let run = await this.#requireRun(proposalId);
    if (!this.#runMatchesMutationBoundary(run)) {
      await this.#repository.storeExecution({ proposalId, status: "FAILED", ciphertext: run.executionCiphertext });
      return "I stopped because this proposal no longer matches the approved workspace.";
    }
    if (run.proposalStatus === "STALE" || run.executionStatus === "STALE") {
      return "The workspace changed after this proposal was created, so I stopped safely.";
    }
    if (run.proposalStatus !== "APPROVED") throw new Error("The approved proposal is unavailable.");
    if (
      run.executionCiphertext &&
      ["COMPLETED", "PARTIAL", "FAILED", "UNKNOWN"].includes(run.executionStatus ?? "")
    ) {
      return formatExecutionResult(
        this.#decryptExecution(proposalId, run.executionCiphertext),
        run.executionStatus as ExecutionStatus,
      );
    }
    if (!this.#config.organizeFolderWriteEnabled) {
      await this.#repository.storeExecution({ proposalId, status: "FAILED", ciphertext: run.executionCiphertext });
      return "Workspace changes are paused by the operator safety switch, so I didn’t change anything.";
    }
    if (!(await this.#repository.startExecution(proposalId))) {
      throw new Error("The approved workspace proposal could not be claimed.");
    }
    run = await this.#requireRun(proposalId);
    const approved = this.#decryptResult(proposalId, run.resultCiphertext);
    if (!approved.ok || !run.proposalCiphertext) {
      throw new Error("The approved workspace snapshot is unavailable.");
    }
    let record = run.executionCiphertext
      ? this.#decryptExecution(proposalId, run.executionCiphertext)
      : undefined;
    if (!record) {
      const observed = await this.#inspectWorkspace(run);
      const observedSnapshot = snapshotWorkspaceInventory(proposalId, observed);
      if (!inventoryMatchesApprovedSnapshot(approved.inventory, observedSnapshot)) {
        await this.#repository.markProposalStale(proposalId);
        return "The workspace changed after this proposal was created, so I stopped before making changes.";
      }
      record = createExecutionRecord(
        this.#decryptProposal(proposalId, run.proposalCiphertext),
        approved.inventory,
        this.#config.organizeFolderRootToken,
        new Date(),
      );
      await this.#storeExecution(proposalId, "RUNNING", record);
    }

    for (const destination of record.destinations) {
      if (destination.action === "REUSE") continue;
      const observed = await this.#inspectWorkspace(run);
      const matches = observed.folders.filter(
        (folder) =>
          folder.depth === 1 &&
          folder.ownedByRequester &&
          normalizeDestinationName(folder.name) === normalizeDestinationName(destination.name),
      );
      if (destination.status === "VERIFIED") {
        if (matches.length !== 1 || matches[0]!.token !== destination.folderToken) {
          destination.status = "UNKNOWN";
          destination.errorCode = "CREATED_FOLDER_CHANGED";
          break;
        }
        continue;
      }
      if (destination.status === "REQUESTING") {
        if (matches.length === 1) {
          destination.folderToken = matches[0]!.token;
          destination.createdByExecution = true;
          destination.status = "VERIFIED";
          destination.verifiedAt = new Date().toISOString();
          await this.#storeExecution(proposalId, "RUNNING", record);
          continue;
        }
        destination.status = "UNKNOWN";
        destination.errorCode = "INTERRUPTED_CREATE_NOT_RECONCILED";
        break;
      }
      if (matches.length !== 0) {
        destination.status = "UNKNOWN";
        destination.errorCode = "UNAPPROVED_FOLDER_COLLISION";
        break;
      }
      destination.status = "REQUESTING";
      destination.attemptedAt = new Date().toISOString();
      await this.#storeExecution(proposalId, "RUNNING", record);
      let createError: DriveMoveError | null = null;
      try {
        const created = await this.#createFolder(run, destination.name);
        destination.folderToken = created.folderToken;
      } catch (error) {
        createError = error instanceof DriveMoveError ? error : new DriveMoveError("TEMPORARY", true);
      }
      let settled: string | null = null;
      try {
        settled = await this.#observeDestination(
          run,
          destination.name,
          destination.folderToken,
        );
      } catch (error) {
        createError ??= error instanceof DriveMoveError
          ? error
          : new DriveMoveError("TEMPORARY", true);
      }
      if (settled) {
        destination.folderToken = settled;
        destination.createdByExecution = true;
        destination.status = "VERIFIED";
        destination.verifiedAt = new Date().toISOString();
        delete destination.errorCode;
        await this.#storeExecution(proposalId, "RUNNING", record);
        continue;
      }
      destination.status = createError?.ambiguous === false ? "FAILED" : "UNKNOWN";
      destination.errorCode = createError?.code ?? "CREATE_NOT_VERIFIED";
      break;
    }

    if (record.destinations.every((folder) => folder.status === "VERIFIED")) {
      for (const move of record.moves) {
        const destination = record.destinations.find((folder) => folder.name === move.destinationName);
        if (destination?.status !== "VERIFIED" || !destination.folderToken) break;
        move.destinationFolderToken = destination.folderToken;
        const before = await this.#observeFileParent(run, move.fileRef);
        if (move.status === "VERIFIED") {
          if (before !== move.destinationFolderToken) {
            move.status = "UNKNOWN";
            move.errorCode = "VERIFIED_PARENT_CHANGED";
            break;
          }
          continue;
        }
        if (move.status === "REQUESTING") {
          if (before === move.destinationFolderToken) {
            move.status = "VERIFIED";
            move.verifiedAt = new Date().toISOString();
            await this.#storeExecution(proposalId, "RUNNING", record);
            continue;
          }
          move.status = "UNKNOWN";
          move.errorCode = "INTERRUPTED_MOVE_NOT_RECONCILED";
          break;
        }
        if (before !== move.originalFolderToken) {
          move.status = "UNKNOWN";
          move.errorCode = "UNEXPECTED_SOURCE_PARENT";
          break;
        }
        move.status = "REQUESTING";
        move.attemptedAt = new Date().toISOString();
        await this.#storeExecution(proposalId, "RUNNING", record);
        let moveError: DriveMoveError | null = null;
        try {
          await this.#moveFile(run, move.fileRef, move.destinationFolderToken);
        } catch (error) {
          moveError = error instanceof DriveMoveError ? error : new DriveMoveError("TEMPORARY", true);
        }
        const after = await this.#observeExpectedParent(run, move.fileRef, move.destinationFolderToken);
        if (after === move.destinationFolderToken) {
          move.status = "VERIFIED";
          move.verifiedAt = new Date().toISOString();
          delete move.errorCode;
          await this.#storeExecution(proposalId, "RUNNING", record);
          continue;
        }
        move.status = moveError?.ambiguous === false ? "FAILED" : "UNKNOWN";
        move.errorCode = moveError?.code ?? "MOVE_NOT_VERIFIED";
        break;
      }
    }

    if (
      record.destinations.every((folder) => folder.status === "VERIFIED") &&
      record.moves.every((move) => move.status === "VERIFIED")
    ) {
      const observed = snapshotWorkspaceInventory(proposalId, await this.#inspectWorkspace(run));
      if (!inventoryMatchesExecutionTarget(record, approved.inventory, observed)) {
        record.errorCode = "FINAL_TARGET_MISMATCH";
      } else {
        try {
          record.knowledgePathsUpdated =
            await this.#knowledge.reconcileWorkspacePaths();
        } catch {
          record.knowledgeReconciliationError = "PATH_RECONCILIATION_FAILED";
        }
      }
    }
    record.finishedAt = new Date().toISOString();
    const status = finalExecutionStatus(record);
    await this.#storeExecution(proposalId, status, record);
    return formatExecutionResult(record, status);
  }

  async buildUndoMessage(proposalId: string): Promise<string> {
    let run = await this.#requireRun(proposalId);
    if (!run.executionCiphertext || !run.undoStatus) throw new Error("The undo request is unavailable.");
    let record = this.#decryptExecution(proposalId, run.executionCiphertext);
    if (["COMPLETED", "PARTIAL", "FAILED", "UNKNOWN"].includes(run.undoStatus)) {
      return formatUndoResult(record, run.undoStatus);
    }
    if (!this.#config.organizeFolderWriteEnabled) {
      await this.#repository.storeUndo({ proposalId, status: "FAILED", ciphertext: this.#encryptExecution(record) });
      return "Workspace changes are paused by the operator safety switch, so I couldn’t restore the files.";
    }
    if (!(await this.#repository.startUndo(proposalId))) throw new Error("The undo could not be claimed.");
    run = await this.#requireRun(proposalId);
    record = this.#decryptExecution(proposalId, run.executionCiphertext!);
    if (!record.undo) throw new Error("The undo confirmation is unavailable.");
    record.undo.startedAt ??= new Date().toISOString();
    await this.#storeUndo(proposalId, "RUNNING", record);
    for (const undo of record.undo.moves) {
      const move = record.moves.find((candidate) => candidate.fileRef === undo.fileRef);
      if (!move || move.status !== "VERIFIED") {
        undo.status = "UNKNOWN";
        undo.errorCode = "EXECUTION_NOT_VERIFIED";
        break;
      }
      const before = await this.#observeFileParent(run, move.fileRef);
      if (undo.status === "VERIFIED") {
        if (before !== move.originalFolderToken) {
          undo.status = "UNKNOWN";
          undo.errorCode = "RESTORED_PARENT_CHANGED";
          break;
        }
        continue;
      }
      if (before === move.originalFolderToken) {
        undo.status = "VERIFIED";
        undo.verifiedAt = new Date().toISOString();
        await this.#storeUndo(proposalId, "RUNNING", record);
        continue;
      }
      if (undo.status === "REQUESTING") {
        undo.status = "UNKNOWN";
        undo.errorCode = "INTERRUPTED_UNDO_NOT_RECONCILED";
        break;
      }
      if (before !== move.destinationFolderToken) {
        undo.status = "UNKNOWN";
        undo.errorCode = "UNEXPECTED_UNDO_SOURCE_PARENT";
        break;
      }
      undo.status = "REQUESTING";
      undo.attemptedAt = new Date().toISOString();
      await this.#storeUndo(proposalId, "RUNNING", record);
      let moveError: DriveMoveError | null = null;
      try {
        await this.#moveFile(run, move.fileRef, move.originalFolderToken);
      } catch (error) {
        moveError = error instanceof DriveMoveError ? error : new DriveMoveError("TEMPORARY", true);
      }
      const after = await this.#observeExpectedParent(run, move.fileRef, move.originalFolderToken);
      if (after === move.originalFolderToken) {
        undo.status = "VERIFIED";
        undo.verifiedAt = new Date().toISOString();
        delete undo.errorCode;
        await this.#storeUndo(proposalId, "RUNNING", record);
        continue;
      }
      undo.status = moveError?.ambiguous === false ? "FAILED" : "UNKNOWN";
      undo.errorCode = moveError?.code ?? "UNDO_NOT_VERIFIED";
      break;
    }
    if (record.undo.moves.every((move) => move.status === "VERIFIED")) {
      const approved = this.#decryptResult(proposalId, run.resultCiphertext);
      const observed = snapshotWorkspaceInventory(proposalId, await this.#inspectWorkspace(run));
      if (!approved.ok || !inventoryMatchesUndoTarget(approved.inventory, observed)) {
        record.undo.errorCode = "FINAL_BASELINE_MISMATCH";
      } else {
        try {
          record.undo.knowledgePathsUpdated =
            await this.#knowledge.reconcileWorkspacePaths();
        } catch {
          record.undo.knowledgeReconciliationError = "PATH_RECONCILIATION_FAILED";
        }
      }
    }
    record.undo.finishedAt = new Date().toISOString();
    const status = finalUndoStatus(record);
    await this.#storeUndo(proposalId, status, record);
    return formatUndoResult(record, status);
  }

  async finalizeExhaustedOperation(runId: string, kind: DeliveryJobKind): Promise<string> {
    if (kind === "ORGANIZE_FOLDER_SCAN") {
      return this.#storeFailure(runId, "INTERNAL", "The workspace proposal could not be completed after several attempts.");
    }
    const run = await this.#requireRun(runId);
    if (!run.executionCiphertext) {
      await this.#repository.storeExecution({ proposalId: runId, status: "UNKNOWN", ciphertext: null });
      return "The workspace operation could not be reconciled after several attempts. No success is claimed.";
    }
    const record = this.#decryptExecution(runId, run.executionCiphertext);
    if (kind === "ORGANIZE_FOLDER_EXECUTE") {
      for (const operation of [...record.destinations, ...record.moves]) {
        if (operation.status === "REQUESTING") operation.status = "UNKNOWN";
      }
      record.finishedAt = new Date().toISOString();
      const status = finalExecutionStatus(record);
      await this.#storeExecution(runId, status, record);
      return formatExecutionResult(record, status);
    }
    if (kind === "ORGANIZE_FOLDER_UNDO" && record.undo) {
      for (const operation of record.undo.moves) {
        if (operation.status === "REQUESTING") operation.status = "UNKNOWN";
      }
      record.undo.finishedAt = new Date().toISOString();
      const status = finalUndoStatus(record);
      await this.#storeUndo(runId, status, record);
      return formatUndoResult(record, status);
    }
    throw new Error("The exhausted workflow job kind is unsupported.");
  }

  #formatDecision(
    proposalId: string,
    decision: "APPROVED" | "REJECTED",
    duplicate: boolean,
    executionQueued: boolean,
  ): string {
    const outcome = decision === "REJECTED"
      ? "No files or folders were changed."
      : duplicate
        ? "No second execution was queued."
        : executionQueued
          ? "Execution is queued. I’ll verify every created folder and moved file."
          : "Approval is saved, but workspace changes are paused by the operator safety switch.";
    return `Proposal ${proposalId} ${duplicate ? "was already" : "is now"} ${decision.toLowerCase()}.\n\n${outcome}`;
  }

  async #inspectWorkspace(identity: { requesterOpenId: string; tenantKey: string }): Promise<WorkspaceDriveInventory> {
    return this.#workspaceReader.inspectWorkspace(identity, {
      maxPdfs: workspaceOrganizationPolicy.maxEligiblePdfs,
    });
  }

  async #observeDestination(
    identity: { requesterOpenId: string; tenantKey: string },
    name: string,
    expectedToken?: string,
  ): Promise<string | null> {
    for (const delay of [0, 250, 750]) {
      if (delay) await wait(delay);
      const observed = await this.#inspectWorkspace(identity);
      const matches = observed.folders.filter(
        (folder) =>
          folder.depth === 1 &&
          folder.ownedByRequester &&
          normalizeDestinationName(folder.name) === normalizeDestinationName(name),
      );
      if (matches.length === 1 && (!expectedToken || matches[0]!.token === expectedToken)) {
        return matches[0]!.token;
      }
      if (matches.length > 1) return null;
    }
    return null;
  }

  async #observeFileParent(
    identity: { requesterOpenId: string; tenantKey: string },
    fileRef: string,
  ): Promise<string | null> {
    return (await this.#inspectWorkspace(identity)).files.find((file) => file.token === fileRef)?.parentToken ?? null;
  }

  async #observeExpectedParent(
    identity: { requesterOpenId: string; tenantKey: string },
    fileRef: string,
    expectedParent: string,
  ): Promise<string | null> {
    let parent: string | null = null;
    for (const delay of [0, 250, 750]) {
      if (delay) await wait(delay);
      parent = await this.#observeFileParent(identity, fileRef);
      if (parent === expectedParent) break;
    }
    return parent;
  }

  async #createFolder(
    identity: { requesterOpenId: string; tenantKey: string },
    name: string,
  ): Promise<{ folderToken: string }> {
    return this.#mutateWithToken(identity, (accessToken) =>
      this.#folderCreator.createFolder({
        accessToken,
        parentFolderToken: this.#config.organizeFolderRootToken,
        name,
      }),
    );
  }

  async #moveFile(
    identity: { requesterOpenId: string; tenantKey: string },
    fileToken: string,
    destinationFolderToken: string,
  ): Promise<void> {
    await this.#mutateWithToken(identity, (accessToken) =>
      this.#driveMover.moveFile({ accessToken, fileToken, destinationFolderToken }),
    );
  }

  async #mutateWithToken<T>(
    identity: { requesterOpenId: string; tenantKey: string },
    operation: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    let token = await this.#tokenBroker.getAccessToken(identity.requesterOpenId, identity.tenantKey);
    try {
      return await operation(token);
    } catch (error) {
      if (!(error instanceof DriveMoveError) || error.code !== "UNAUTHORIZED") throw error;
    }
    token = await this.#tokenBroker.recoverAccessToken(identity.requesterOpenId, identity.tenantKey, token);
    try {
      return await operation(token);
    } catch (error) {
      if (error instanceof DriveMoveError && error.code === "UNAUTHORIZED") {
        await this.#tokenBroker.markAccessTokenRejected(identity.requesterOpenId, identity.tenantKey, token);
      }
      throw error;
    }
  }

  #assertRequestAllowed(request: OrganizeFolderRequest): void {
    this.#assertActorAllowed(request);
    this.#assertFolderLinkAllowed(request.folderLink);
  }

  #assertFolderLinkAllowed(folderLink: string): void {
    requireAllowlistedRoot(
      parseLarkDriveFolderLink(folderLink),
      this.#config.organizeFolderRootToken,
    );
  }

  #assertActorAllowed(request: { requesterOpenId: string; tenantKey: string }): void {
    if (request.tenantKey !== this.#config.authorizedTenantKey) {
      throw driveToolError("WRONG_TENANT", "This tenant is not authorized for the workspace pilot.");
    }
    if (request.requesterOpenId !== this.#config.authorizedOpenId) {
      throw driveToolError("UNAUTHORIZED", "This account is not authorized for the workspace pilot.");
    }
  }

  #runMatchesMutationBoundary(run: InventoryRun): boolean {
    return (
      run.requesterOpenId === this.#config.authorizedOpenId &&
      run.tenantKey === this.#config.authorizedTenantKey &&
      run.rootTokenDigest === digestFolderToken(this.#config.organizeFolderRootToken) &&
      run.oauthGrantId !== null &&
      run.oauthGrantMatchesSubject
    );
  }

  async #requireRun(runId: string): Promise<InventoryRun> {
    const run = await this.#repository.findInventoryRunById(runId);
    if (!run) throw new Error("The workspace workflow run was not found.");
    if (run.rootTokenDigest !== digestFolderToken(this.#config.organizeFolderRootToken)) {
      throw new Error("The workflow run does not target the active workspace.");
    }
    return run;
  }

  #encryptExecution(record: OrganizeFolderExecutionRecord): string {
    // Defends native Drive tokens and operation history against DB-only compromise.
    return this.#cipher.encrypt(JSON.stringify(record), executionAssociatedData(record.proposalId));
  }

  #decryptExecution(proposalId: string, ciphertext: string): OrganizeFolderExecutionRecord {
    try {
      return JSON.parse(this.#cipher.decrypt(ciphertext, executionAssociatedData(proposalId))) as OrganizeFolderExecutionRecord;
    } catch {
      throw new Error("The stored workspace execution result is invalid.");
    }
  }

  #decryptResult(runId: string, ciphertext: string | null): DriveFolderInventoryResult {
    if (!ciphertext) throw new Error("The stored workspace inventory is unavailable.");
    try {
      return JSON.parse(this.#cipher.decrypt(ciphertext, driveFolderInventoryResultAssociatedData(runId))) as DriveFolderInventoryResult;
    } catch {
      throw new Error("The stored workspace inventory is invalid.");
    }
  }

  #decryptProposal(runId: string, ciphertext: string): OrganizeFolderProposal {
    try {
      return JSON.parse(this.#cipher.decrypt(ciphertext, organizeFolderProposalAssociatedData(runId))) as OrganizeFolderProposal;
    } catch {
      throw new Error("The stored workspace proposal is invalid.");
    }
  }

  async #storeExecution(proposalId: string, status: ExecutionStatus, record: OrganizeFolderExecutionRecord): Promise<void> {
    if (!(await this.#repository.storeExecution({ proposalId, status, ciphertext: this.#encryptExecution(record) }))) {
      throw new Error("The workspace execution result could not be stored.");
    }
  }

  async #storeUndo(proposalId: string, status: UndoStatus, record: OrganizeFolderExecutionRecord): Promise<void> {
    if (!(await this.#repository.storeUndo({ proposalId, status, ciphertext: this.#encryptExecution(record) }))) {
      throw new Error("The workspace undo result could not be stored.");
    }
  }

  async #storeFailure(runId: string, code: string, message: string): Promise<string> {
    return this.#storeResult(runId, {
      ok: false,
      error: { code: code as "INTERNAL", message, retryable: false },
    });
  }

  async #storeResult(
    runId: string,
    result: DriveFolderInventoryResult,
    taxonomy?: ProposedTaxonomyFolder[],
    decisions?: ContentDecision[],
  ): Promise<string> {
    const resultCiphertext = this.#cipher.encrypt(
      JSON.stringify(result),
      driveFolderInventoryResultAssociatedData(runId),
    );
    const proposal = result.ok && taxonomy && decisions
      ? buildOrganizeFolderProposal(result.inventory, runId, taxonomy, decisions)
      : null;
    const proposalCiphertext = proposal
      ? this.#cipher.encrypt(JSON.stringify(proposal), organizeFolderProposalAssociatedData(runId))
      : null;
    const stored = proposal
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
          errorCode: result.ok ? "UNEXPECTED_WORKSPACE_STATE" : result.error.code,
          proposalCiphertext: null,
          proposalStatus: null,
        });
    if (!stored) throw new Error("The workspace analysis result could not be stored.");
    return proposal ? formatOrganizeFolderProposal(proposal) : formatDriveFolderInventoryResult(result);
  }
}
