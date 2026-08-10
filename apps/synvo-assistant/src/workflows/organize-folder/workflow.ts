import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { z } from "zod";

import {
  ORGANIZE_FOLDER_USER_SCOPES,
  hasExactScopes,
  LarkAuthError,
  type LarkTokenBroker,
  type OAuthGrantStore,
  type TokenCipher,
} from "../../lark/auth/index.js";
import {
  observeAllowlistedFolder,
  digestFolderToken,
  DriveMoveError,
  DriveToolError,
  driveToolError,
  normalizeDriveError,
  parseLarkDriveFolderLink,
  requireAllowlistedRoot,
  withReadOnlyDriveTokenRecovery,
  type DriveMover,
  type DriveReader,
} from "../../lark/drive/index.js";
import type { AppConfig } from "../../config.js";
import type { DeliveryJobKind } from "../../delivery/repository.js";
import type { LarkOAuthService } from "./authorization.js";
import {
  driveFolderInventoryResultAssociatedData,
  type DriveFolderInventoryResult,
} from "./contracts.js";
import {
  formatDriveFolderInventoryResult,
  formatOrganizeFolderProposal,
} from "./inventory-message.js";
import {
  createExecutionRecord,
  executionAssociatedData,
  finalExecutionStatus,
  finalUndoStatus,
  formatExecutionResult,
  formatUndoResult,
  inventoryMatchesApprovedSnapshot,
  inventoryMatchesExecutionTarget,
  observeExecutionParents,
  type ExecutionStatus,
  type ObservedParent,
  type OrganizeFolderExecutionRecord,
  type UndoStatus,
} from "./execution.js";
import {
  buildOrganizeFolderProposal,
  organizeFolderProposalAssociatedData,
  type OrganizeFolderProposal,
} from "./proposal.js";
import type {
  InventoryRun,
  OrganizeFolderRepository,
} from "./repository.js";
import type { ContentAwareFolderPlanner } from "./content-planner.js";

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
  | { kind: "authorization_required" }
  | { kind: "inventory_ready" }
  | { kind: "duplicate" }
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
type ContentPlanner = Pick<ContentAwareFolderPlanner, "plan">;

function normalizeInventoryError(error: unknown): DriveToolError {
  if (!(error instanceof LarkAuthError)) {
    return normalizeDriveError(error);
  }

  switch (error.code) {
    case "OAUTH_REQUIRED":
    case "WRONG_SCOPE":
      return driveToolError(
        "OAUTH_REQUIRED",
        "Please connect Lark Drive before I analyze this folder.",
      );
    case "OAUTH_REVOKED":
      return driveToolError(
        "OAUTH_REVOKED",
        "Your Lark Drive connection has expired or was revoked. Please connect it again.",
      );
    case "OAUTH_RETRYABLE":
      return driveToolError(
        "LARK_RETRYABLE",
        "Lark authorization is temporarily unavailable. Please try again in a moment.",
        true,
      );
    case "WRONG_TENANT":
      return driveToolError(
        "WRONG_TENANT",
        "This Lark Drive connection belongs to a different workspace.",
      );
    case "WRONG_USER":
      return driveToolError(
        "UNAUTHORIZED",
        "This Lark Drive connection belongs to a different user.",
      );
    case "OAUTH_REJECTED":
    case "OAUTH_MALFORMED":
      return driveToolError(
        "LARK_PERMANENT",
        "I couldn’t safely use this Lark Drive connection. Please connect it again.",
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
  readonly #driveMover: DriveMover;
  readonly #contentPlanner?: ContentPlanner;

  constructor(options: {
    config: AppConfig;
    grantStore: OAuthGrantStore;
    repository: OrganizeFolderRepository;
    oauthService: OAuthAuthorizationStarter;
    tokenBroker: AccessTokenProvider;
    cipher: TokenCipher;
    driveReader: DriveReader;
    driveMover: DriveMover;
    contentPlanner?: ContentPlanner;
  }) {
    this.#config = options.config;
    this.#grantStore = options.grantStore;
    this.#repository = options.repository;
    this.#oauthService = options.oauthService;
    this.#tokenBroker = options.tokenBroker;
    this.#cipher = options.cipher;
    this.#driveReader = options.driveReader;
    this.#driveMover = options.driveMover;
    this.#contentPlanner = options.contentPlanner;
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
          : "Please send a valid Lark Drive link for the approved folder.";
      return { kind: "rejected", replyText: message };
    }

    if (!this.#contentPlanner) {
      return {
        kind: "rejected",
        replyText: "Content-aware folder organization isn’t available right now.",
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
    const rootTokenDigest = digestFolderToken(
      this.#config.organizeFolderRootToken,
    );

    if (!grantUsable) {
      const created = await this.#oauthService.createPendingAuthorization({
        messageId: request.messageId,
        chatId: request.chatId,
        requesterOpenId: request.requesterOpenId,
        tenantKey: request.tenantKey,
        rootTokenDigest,
      });
      if (!created) {
        return { kind: "duplicate" };
      }
      return { kind: "authorization_required" };
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
      return { kind: "duplicate" };
    }
    return { kind: "inventory_ready" };
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

    if (!this.#contentPlanner) {
      return this.#storeAndFormat(runId, {
        ok: false,
        error: {
          code: "INTERNAL",
          message: "Content-aware folder organization is not configured.",
          retryable: false,
        },
      });
    }
    const plan = await this.#contentPlanner.plan(
      `https://larksuite.com/drive/folder/${this.#config.organizeFolderRootToken}`,
    );
    if (plan.kind === "failed") {
      if (plan.retryable) {
        throw new Error("The content-aware folder plan should be retried.");
      }
      return this.#storeAndFormat(runId, {
        ok: false,
        error: {
          code: "INTERNAL",
          message: plan.message,
          retryable: false,
        },
      });
    }
    const result: DriveFolderInventoryResult = plan.inventoryResult.ok
      ? {
          ok: true,
          inventory: { ...plan.inventoryResult.inventory, run_id: runId },
        }
      : plan.inventoryResult;
    return this.#storeAndFormat(
      runId,
      result,
      plan.kind === "ready" ? plan.decisions : undefined,
    );
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
        : "I couldn’t record that decision safely. No files were changed.";
    }
    if (!z.uuid().safeParse(input.proposalId).success) {
      return "I couldn’t recognize that proposal. No files were changed.";
    }

    const stored = await this.#repository.recordProposalDecision({
      ...input,
      decidedAt: new Date(),
      executionJobId:
        input.decision === "APPROVED" &&
        this.#config.organizeFolderWriteEnabled
          ? randomUUID()
          : undefined,
    });
    if (stored.kind === "not_found") {
      return "I couldn’t find that proposal for your account. No files were changed.";
    }
    if (stored.kind === "recorded") {
      return this.#formatDecision(
        input.proposalId,
        stored.status,
        false,
        stored.executionQueued,
      );
    }
    if (stored.status === "STALE") {
      return "This proposal is out of date because the folder changed. Please start a fresh folder analysis. No files were changed.";
    }
    if (stored.status === "PROPOSED") {
      return "I couldn’t record that proposal decision safely. No files were changed.";
    }
    if (stored.status === input.decision) {
      return this.#formatDecision(
        input.proposalId,
        stored.status,
        true,
        false,
      );
    }
    return [
      `Proposal ${input.proposalId} was already ${stored.status.toLowerCase()}.`,
      "I kept the original decision and ignored the conflicting request.",
      "",
      "No files were changed.",
    ].join("\n");
  }

  async requestUndo(input: {
    proposalId: string;
    requesterOpenId: string;
    tenantKey: string;
  }): Promise<string> {
    try {
      this.#assertActorAllowed(input);
    } catch (error) {
      return error instanceof DriveToolError
        ? `${error.safeError.message}\n\nNo files were changed.`
        : "I couldn’t start that undo safely. No files were changed.";
    }
    if (!z.uuid().safeParse(input.proposalId).success) {
      return "I couldn’t recognize that proposal. No files were changed.";
    }
    if (!this.#config.organizeFolderWriteEnabled) {
      return "File changes are paused by the operator safety switch, so I can’t undo these moves right now. No files were changed.";
    }
    const run = await this.#repository.findInventoryRunById(input.proposalId);
    if (
      !run ||
      run.requesterOpenId !== input.requesterOpenId ||
      run.tenantKey !== input.tenantKey ||
      !this.#runMatchesMutationBoundary(run) ||
      !run.executionCiphertext ||
      (run.executionStatus !== "COMPLETED" &&
        run.executionStatus !== "PARTIAL")
    ) {
      return "I couldn’t find any verified file moves to undo for this proposal. No files were changed.";
    }
    const record = this.#decryptExecutionRecord(
      input.proposalId,
      run.executionCiphertext,
    );
    const verifiedMoves = record.moves.filter(
      (move) => move.status === "VERIFIED",
    );
    if (verifiedMoves.length === 0) {
      return "There are no verified moved files to restore for this proposal. No files were changed.";
    }
    if (!record.undo) {
      record.undo = {
        requestedByOpenId: input.requesterOpenId,
        requestedAt: new Date().toISOString(),
        moves: verifiedMoves.map((move) => ({
          fileRef: move.fileRef,
          status: "PENDING",
        })),
      };
    }
    const requested = await this.#repository.requestUndo({
      ...input,
      deliveryJobId: randomUUID(),
      executionCiphertext: this.#encryptExecutionRecord(record),
    });
    if (requested.kind === "recorded") {
      return `Undo is queued for proposal ${input.proposalId}. I’ll verify every file after it is restored.`;
    }
    if (requested.kind === "existing") {
      return `Undo for proposal ${input.proposalId} is already ${requested.status.toLowerCase()}.`;
    }
    return requested.kind === "not_ready"
      ? "This proposal isn’t ready to undo yet. No files were changed."
      : "I couldn’t find that proposal for your account. No files were changed.";
  }

  async buildExecutionMessage(proposalId: string): Promise<string> {
    let run = await this.#repository.findInventoryRunById(proposalId);
    if (!run) {
      throw new Error("The approved proposal is unavailable.");
    }
    if (!this.#runMatchesMutationBoundary(run)) {
      await this.#repository.storeExecution({
        proposalId,
        status: "FAILED",
        ciphertext: run.executionCiphertext,
      });
      return "I stopped because this proposal no longer matches the approved folder. No files were changed.";
    }
    if (
      run.proposalStatus === "STALE" ||
      run.executionStatus === "STALE"
    ) {
      return "The folder changed after this proposal was created, so I stopped safely. Please start a fresh folder analysis. No files were changed.";
    }
    if (run.proposalStatus !== "APPROVED") {
      throw new Error("The approved proposal is unavailable.");
    }
    if (
      run.executionCiphertext &&
      ["COMPLETED", "PARTIAL", "FAILED", "UNKNOWN"].includes(
        run.executionStatus ?? "",
      )
    ) {
      return formatExecutionResult(
        this.#decryptExecutionRecord(proposalId, run.executionCiphertext),
        run.executionStatus as ExecutionStatus,
      );
    }
    if (!this.#config.organizeFolderWriteEnabled) {
      await this.#repository.storeExecution({
        proposalId,
        status: "FAILED",
        ciphertext: run.executionCiphertext,
      });
      return "File changes are paused by the operator safety switch, so I didn’t move anything.";
    }
    if (!(await this.#repository.startExecution(proposalId))) {
      throw new Error("The approved proposal could not be claimed for execution.");
    }
    run = (await this.#repository.findInventoryRunById(proposalId))!;

    let record: OrganizeFolderExecutionRecord;
    if (run.executionCiphertext) {
      record = this.#decryptExecutionRecord(
        proposalId,
        run.executionCiphertext,
      );
    } else {
      const approvedResult = this.#decryptStoredResult(
        proposalId,
        run.resultCiphertext,
      );
      if (!approvedResult.ok || !run.proposalCiphertext) {
        throw new Error("The approved proposal snapshot is unavailable.");
      }
      const observation = await this.#observeFolder(
        proposalId,
        run.requesterOpenId,
        run.tenantKey,
      );
      if (
        !inventoryMatchesApprovedSnapshot(
          approvedResult.inventory,
          observation.inventory,
        )
      ) {
        await this.#repository.markProposalStale(proposalId);
        return "The Drive folder changed after this proposal was created, so I stopped safely. Please start a fresh folder analysis. No files were changed.";
      }
      record = createExecutionRecord(
        this.#decryptStoredProposal(proposalId, run.proposalCiphertext),
        observation,
        new Date(),
      );
      await this.#storeExecutionRecord(proposalId, "RUNNING", record);
    }

    for (const move of record.moves) {
      const locations = await this.#observeParents(
        record,
        run.requesterOpenId,
        run.tenantKey,
      );
      const before = locations.get(move.fileRef) ?? "MISSING";
      move.observedParent = before;

      if (move.status === "VERIFIED") {
        if (before !== "DESTINATION") {
          move.status = "UNKNOWN";
          move.errorCode = "VERIFIED_PARENT_CHANGED";
          break;
        }
        continue;
      }
      if (move.status === "REQUESTING") {
        if (before === "DESTINATION") {
          move.status = "VERIFIED";
          move.verifiedAt = new Date().toISOString();
          await this.#storeExecutionRecord(proposalId, "RUNNING", record);
          continue;
        }
        move.status = "UNKNOWN";
        move.errorCode = "INTERRUPTED_MOVE_NOT_RECONCILED";
        break;
      }
      if (before === "DESTINATION") {
        move.status = "UNKNOWN";
        move.errorCode = "UNREQUESTED_DESTINATION_PARENT";
        break;
      }
      if (before !== "ROOT") {
        move.status = "UNKNOWN";
        move.errorCode = `UNEXPECTED_PARENT_${before}`;
        break;
      }

      move.status = "REQUESTING";
      move.attemptedAt = new Date().toISOString();
      await this.#storeExecutionRecord(proposalId, "RUNNING", record);
      let moveError: DriveMoveError | null = null;
      try {
        await this.#moveFile(
          run.requesterOpenId,
          run.tenantKey,
          move.fileToken,
          move.destinationFolderToken,
        );
      } catch (error) {
        moveError =
          error instanceof DriveMoveError
            ? error
            : new DriveMoveError("TEMPORARY", true);
      }

      const after = await this.#observeExpectedParent(
        record,
        run.requesterOpenId,
        run.tenantKey,
        move.fileRef,
        "DESTINATION",
        moveError === null || moveError.ambiguous,
      );
      move.observedParent = after;
      if (after === "DESTINATION") {
        move.status = "VERIFIED";
        move.verifiedAt = new Date().toISOString();
        delete move.errorCode;
        await this.#storeExecutionRecord(proposalId, "RUNNING", record);
        continue;
      }
      move.status = moveError === null || moveError.ambiguous
        ? "UNKNOWN"
        : "FAILED";
      move.errorCode = moveError?.code ?? "MOVE_NOT_VERIFIED";
      break;
    }

    if (record.moves.every((move) => move.status === "VERIFIED")) {
      const finalObservation = await this.#observeFolder(
        proposalId,
        run.requesterOpenId,
        run.tenantKey,
      );
      if (!inventoryMatchesExecutionTarget(record, finalObservation.inventory)) {
        record.errorCode = "FINAL_TARGET_MISMATCH";
      }
    }
    record.finishedAt = new Date().toISOString();
    const status = finalExecutionStatus(record);
    await this.#storeExecutionRecord(proposalId, status, record);
    return formatExecutionResult(record, status);
  }

  async buildUndoMessage(proposalId: string): Promise<string> {
    let run = await this.#repository.findInventoryRunById(proposalId);
    if (!run?.executionCiphertext || !run.undoStatus) {
      throw new Error("The undo request is unavailable.");
    }
    if (!this.#runMatchesMutationBoundary(run)) {
      await this.#repository.storeUndo({
        proposalId,
        status: "FAILED",
        ciphertext: run.executionCiphertext,
      });
      return "I stopped the undo because this proposal no longer matches the approved folder. No files were changed.";
    }
    let record = this.#decryptExecutionRecord(
      proposalId,
      run.executionCiphertext,
    );
    if (["COMPLETED", "PARTIAL", "FAILED", "UNKNOWN"].includes(run.undoStatus)) {
      return formatUndoResult(record, run.undoStatus);
    }
    if (!this.#config.organizeFolderWriteEnabled) {
      await this.#repository.storeUndo({
        proposalId,
        status: "FAILED",
        ciphertext: this.#encryptExecutionRecord(record),
      });
      return "File changes are paused by the operator safety switch, so I couldn’t restore the files.";
    }
    if (!(await this.#repository.startUndo(proposalId))) {
      throw new Error("The undo request could not be claimed.");
    }
    run = (await this.#repository.findInventoryRunById(proposalId))!;
    record = this.#decryptExecutionRecord(
      proposalId,
      run.executionCiphertext!,
    );
    if (!record.undo) {
      throw new Error("The undo confirmation is unavailable.");
    }
    record.undo.startedAt ??= new Date().toISOString();
    await this.#storeUndoRecord(proposalId, "RUNNING", record);

    for (const undoMove of record.undo.moves) {
      const move = record.moves.find(
        (candidate) => candidate.fileRef === undoMove.fileRef,
      );
      if (!move || move.status !== "VERIFIED") {
        undoMove.status = "UNKNOWN";
        undoMove.errorCode = "EXECUTION_NOT_VERIFIED";
        break;
      }
      const before = (
        await this.#observeParents(
          record,
          run.requesterOpenId,
          run.tenantKey,
        )
      ).get(move.fileRef) ?? "MISSING";
      undoMove.observedParent = before;
      if (undoMove.status === "VERIFIED") {
        if (before !== "ROOT") {
          undoMove.status = "UNKNOWN";
          undoMove.errorCode = "RESTORED_PARENT_CHANGED";
          break;
        }
        continue;
      }
      if (before === "ROOT") {
        undoMove.status = "VERIFIED";
        undoMove.verifiedAt = new Date().toISOString();
        await this.#storeUndoRecord(proposalId, "RUNNING", record);
        continue;
      }
      if (undoMove.status === "REQUESTING") {
        undoMove.status = "UNKNOWN";
        undoMove.errorCode = "INTERRUPTED_UNDO_NOT_RECONCILED";
        break;
      }
      if (before !== "DESTINATION") {
        undoMove.status = "UNKNOWN";
        undoMove.errorCode = `UNEXPECTED_PARENT_${before}`;
        break;
      }

      undoMove.status = "REQUESTING";
      undoMove.attemptedAt = new Date().toISOString();
      await this.#storeUndoRecord(proposalId, "RUNNING", record);
      let moveError: DriveMoveError | null = null;
      try {
        await this.#moveFile(
          run.requesterOpenId,
          run.tenantKey,
          move.fileToken,
          move.originalFolderToken,
        );
      } catch (error) {
        moveError =
          error instanceof DriveMoveError
            ? error
            : new DriveMoveError("TEMPORARY", true);
      }
      const after = await this.#observeExpectedParent(
        record,
        run.requesterOpenId,
        run.tenantKey,
        move.fileRef,
        "ROOT",
        moveError === null || moveError.ambiguous,
      );
      undoMove.observedParent = after;
      if (after === "ROOT") {
        undoMove.status = "VERIFIED";
        undoMove.verifiedAt = new Date().toISOString();
        delete undoMove.errorCode;
        await this.#storeUndoRecord(proposalId, "RUNNING", record);
        continue;
      }
      undoMove.status = moveError === null || moveError.ambiguous
        ? "UNKNOWN"
        : "FAILED";
      undoMove.errorCode = moveError?.code ?? "UNDO_NOT_VERIFIED";
      break;
    }

    if (record.undo.moves.every((move) => move.status === "VERIFIED")) {
      const approved = this.#decryptStoredResult(proposalId, run.resultCiphertext);
      const restored = await this.#observeFolder(
        proposalId,
        run.requesterOpenId,
        run.tenantKey,
      );
      if (
        !approved.ok ||
        !inventoryMatchesApprovedSnapshot(approved.inventory, restored.inventory)
      ) {
        record.undo.errorCode = "FINAL_BASELINE_MISMATCH";
      }
    }
    record.undo.finishedAt = new Date().toISOString();
    const status = finalUndoStatus(record);
    await this.#storeUndoRecord(proposalId, status, record);
    return formatUndoResult(record, status);
  }

  async finalizeExhaustedOperation(
    runId: string,
    kind: DeliveryJobKind,
  ): Promise<string> {
    if (kind === "ORGANIZE_FOLDER_SCAN") {
      return this.finalizeExhaustedInventory(runId);
    }
    const run = await this.#repository.findInventoryRunById(runId);
    if (!run?.executionCiphertext) {
      if (kind === "ORGANIZE_FOLDER_EXECUTE") {
        await this.#repository.storeExecution({
          proposalId: runId,
          status: "UNKNOWN",
          ciphertext: null,
        });
        return "Execution could not be reconciled after several attempts. No success is claimed.";
      }
      throw new Error("The exhausted undo record is unavailable.");
    }
    const record = this.#decryptExecutionRecord(runId, run.executionCiphertext);
    if (kind === "ORGANIZE_FOLDER_EXECUTE") {
      for (const move of record.moves) {
        if (move.status === "REQUESTING") {
          move.status = "UNKNOWN";
          move.errorCode = "EXECUTION_ATTEMPTS_EXHAUSTED";
        }
      }
      record.finishedAt = new Date().toISOString();
      const status = finalExecutionStatus(record);
      await this.#storeExecutionRecord(runId, status, record);
      return formatExecutionResult(record, status);
    }
    if (kind === "ORGANIZE_FOLDER_UNDO" && record.undo) {
      for (const move of record.undo.moves) {
        if (move.status === "REQUESTING") {
          move.status = "UNKNOWN";
          move.errorCode = "UNDO_ATTEMPTS_EXHAUSTED";
        }
      }
      record.undo.finishedAt = new Date().toISOString();
      const status = finalUndoStatus(record);
      await this.#storeUndoRecord(runId, status, record);
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
    const action = decision === "APPROVED" ? "approved" : "rejected";
    const outcome =
      decision === "REJECTED"
        ? "No files were moved."
        : duplicate
          ? "No execution was queued because this approval was already recorded."
        : executionQueued
          ? "Execution is queued. I’ll verify every file before reporting the result."
          : "Your approval is saved, but file changes are paused by the operator safety switch.";
    return [
      `Proposal ${proposalId} ${duplicate ? "was already" : "is now"} ${action}.`,
      "",
      outcome,
    ].join("\n");
  }

  async #observeFolder(
    operationId: string,
    requesterOpenId: string,
    tenantKey: string,
  ) {
    const accessToken = await this.#tokenBroker.getAccessToken(
      requesterOpenId,
      tenantKey,
    );
    return observeAllowlistedFolder(this.#driveReader, {
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
    });
  }

  async #observeParents(
    record: OrganizeFolderExecutionRecord,
    requesterOpenId: string,
    tenantKey: string,
  ): Promise<Map<string, ObservedParent>> {
    const accessToken = await this.#tokenBroker.getAccessToken(
      requesterOpenId,
      tenantKey,
    );
    const recovered = await withReadOnlyDriveTokenRecovery(
      {
        accessToken,
        recoverAccessToken: (rejectedAccessToken) =>
          this.#tokenBroker.recoverAccessToken(
            requesterOpenId,
            tenantKey,
            rejectedAccessToken,
          ),
        markAccessTokenRejected: (rejectedAccessToken) =>
          this.#tokenBroker.markAccessTokenRejected(
            requesterOpenId,
            tenantKey,
            rejectedAccessToken,
          ),
      },
      (currentAccessToken) =>
        observeExecutionParents(this.#driveReader, {
          accessToken: currentAccessToken,
          record,
        }),
    );
    return recovered.result;
  }

  async #observeExpectedParent(
    record: OrganizeFolderExecutionRecord,
    requesterOpenId: string,
    tenantKey: string,
    fileRef: string,
    expected: ObservedParent,
    allowSettling: boolean,
  ): Promise<ObservedParent> {
    let observed =
      (
        await this.#observeParents(record, requesterOpenId, tenantKey)
      ).get(fileRef) ?? "MISSING";
    if (!allowSettling || observed === expected) {
      return observed;
    }
    for (const delayMs of [250, 750]) {
      await wait(delayMs);
      observed =
        (
          await this.#observeParents(record, requesterOpenId, tenantKey)
        ).get(fileRef) ?? "MISSING";
      if (observed === expected) {
        break;
      }
    }
    return observed;
  }

  async #moveFile(
    requesterOpenId: string,
    tenantKey: string,
    fileToken: string,
    destinationFolderToken: string,
  ): Promise<void> {
    let accessToken = await this.#tokenBroker.getAccessToken(
      requesterOpenId,
      tenantKey,
    );
    try {
      await this.#driveMover.moveFile({
        accessToken,
        fileToken,
        destinationFolderToken,
      });
      return;
    } catch (error) {
      if (!(error instanceof DriveMoveError) || error.code !== "UNAUTHORIZED") {
        throw error;
      }
    }
    accessToken = await this.#tokenBroker.recoverAccessToken(
      requesterOpenId,
      tenantKey,
      accessToken,
    );
    try {
      await this.#driveMover.moveFile({
        accessToken,
        fileToken,
        destinationFolderToken,
      });
    } catch (error) {
      if (error instanceof DriveMoveError && error.code === "UNAUTHORIZED") {
        await this.#tokenBroker.markAccessTokenRejected(
          requesterOpenId,
          tenantKey,
          accessToken,
        );
      }
      throw error;
    }
  }

  #encryptExecutionRecord(record: OrganizeFolderExecutionRecord): string {
    // Defends native Drive tokens and operation history against database-only
    // compromise while binding them to one proposal run.
    return this.#cipher.encrypt(
      JSON.stringify(record),
      executionAssociatedData(record.proposalId),
    );
  }

  #decryptExecutionRecord(
    proposalId: string,
    ciphertext: string,
  ): OrganizeFolderExecutionRecord {
    try {
      return JSON.parse(
        this.#cipher.decrypt(
          ciphertext,
          executionAssociatedData(proposalId),
        ),
      ) as OrganizeFolderExecutionRecord;
    } catch {
      throw new Error("The stored execution result is invalid.");
    }
  }

  async #storeExecutionRecord(
    proposalId: string,
    status: ExecutionStatus,
    record: OrganizeFolderExecutionRecord,
  ): Promise<void> {
    if (
      !(await this.#repository.storeExecution({
        proposalId,
        status,
        ciphertext: this.#encryptExecutionRecord(record),
      }))
    ) {
      throw new Error("The execution result could not be stored.");
    }
  }

  async #storeUndoRecord(
    proposalId: string,
    status: UndoStatus,
    record: OrganizeFolderExecutionRecord,
  ): Promise<void> {
    if (
      !(await this.#repository.storeUndo({
        proposalId,
        status,
        ciphertext: this.#encryptExecutionRecord(record),
      }))
    ) {
      throw new Error("The undo result could not be stored.");
    }
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

  #runMatchesMutationBoundary(run: InventoryRun): boolean {
    return (
      run.requesterOpenId === this.#config.authorizedOpenId &&
      run.tenantKey === this.#config.authorizedTenantKey &&
      run.rootTokenDigest ===
        digestFolderToken(this.#config.organizeFolderRootToken) &&
      run.oauthGrantId !== null &&
      run.oauthGrantMatchesSubject
    );
  }

  async #collectInventory(
    operationId: string,
    requesterOpenId: string,
    tenantKey: string,
  ): Promise<DriveFolderInventoryResult> {
    try {
      const observation = await this.#observeFolder(
        operationId,
        requesterOpenId,
        tenantKey,
      );
      return { ok: true, inventory: observation.inventory };
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
          "The content-aware folder proposal could not be completed after several attempts.",
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
    decisions?: Parameters<typeof buildOrganizeFolderProposal>[2],
  ): Promise<string> {
    const successfulBaseline = result.ok && result.inventory.baseline_matches;
    const resultCiphertext = this.#cipher.encrypt(
      JSON.stringify(result),
      driveFolderInventoryResultAssociatedData(runId),
    );
    const proposal = successfulBaseline && decisions
      ? buildOrganizeFolderProposal(result.inventory, runId, decisions)
      : null;
    // Defends proposal contents against database-only compromise and binds
    // them to this workflow run.
    const proposalCiphertext = proposal
      ? this.#cipher.encrypt(
          JSON.stringify(proposal),
          organizeFolderProposalAssociatedData(runId),
        )
      : null;
    const approvable =
      proposal !== null && (proposal.needs_review?.length ?? 0) === 0;
    const stored = approvable
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
          errorCode: proposal
            ? "NEEDS_REVIEW"
            : result.ok
              ? "UNEXPECTED_SANDBOX_STATE"
              : result.error.code,
          proposalCiphertext,
          proposalStatus: null,
        });
    if (!stored) {
      throw new Error("The read-only inventory result could not be stored.");
    }
    return proposal
      ? formatOrganizeFolderProposal(proposal)
      : formatDriveFolderInventoryResult(result);
  }
}
