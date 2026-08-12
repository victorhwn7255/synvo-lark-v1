import { createHash } from "node:crypto";

import {
  NimAnalysisError,
  type NimWorkspaceDecision,
  type NimWorkspaceDocumentProfile,
  type NimWorkspaceTaxonomyFolder,
  type NvidiaNimClient,
} from "../analyze-attachment/nim-client.js";
import type {
  AuthorizedDrivePdfReader,
  WorkspaceDriveInventory,
} from "../analyze-drive-file/authorized-reader.js";
import type {
  KnowledgeRepresentativeEvidence,
} from "../knowledge/repository.js";
import type {
  KnowledgeWorkflow,
} from "../knowledge/workflow.js";
import {
  type DriveFolderInventoryResult,
  type DriveInventory,
  workspaceSnapshotMatches,
} from "./contracts.js";
import {
  isSafeDestinationName,
  normalizeDestinationName,
  workspaceOrganizationPolicy,
} from "./policy.js";
import type { ContentDecision, ProposedTaxonomyFolder } from "./proposal.js";

type WorkspaceReader = Pick<AuthorizedDrivePdfReader, "inspectWorkspace">;
type OrganizationKnowledge = Pick<KnowledgeWorkflow, "prepareWorkspaceOrganization">;
type WorkspaceClassifier = Pick<
  NvidiaNimClient,
  "profileWorkspaceDocuments" | "proposeWorkspaceTaxonomy" | "classifyWorkspaceDocuments"
>;

export type ContentPlanResult =
  | {
      kind: "ready";
      inventoryResult: Extract<DriveFolderInventoryResult, { ok: true }>;
      taxonomy: ProposedTaxonomyFolder[];
      decisions: ContentDecision[];
    }
  | { kind: "inventory_not_ready"; inventoryResult: DriveFolderInventoryResult }
  | { kind: "failed"; message: string; retryable: boolean };

type PlanIdentity = { requesterOpenId: string; tenantKey: string };

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function snapshotWorkspaceInventory(
  runId: string,
  observed: WorkspaceDriveInventory,
): DriveInventory {
  return {
    run_id: runId,
    workspace_identity_digest: digest(observed.rootToken),
    complete: true,
    folders: observed.folders.map((folder) => ({
      ref: folder.token,
      identity_digest: digest(folder.token),
      name: folder.name,
      relative_path: folder.relativePath,
      parent_ref: folder.parentToken,
      depth: folder.depth,
      owned_by_requester: folder.ownedByRequester,
    })),
    files: observed.files.map((file) => ({
      ref: file.token,
      identity_digest: digest(file.token),
      name: file.fileName,
      relative_path: file.relativePath,
      parent_ref: file.parentToken,
      parent_path: file.parentPath,
      version: file.version,
    })),
  };
}

function boundedEvidence(
  chunks: KnowledgeRepresentativeEvidence[],
): string {
  return Array.from(
    chunks
      .map((chunk) => `[page ${chunk.pageNumber}]\n${chunk.text}`)
      .join("\n\n"),
  )
    .slice(0, workspaceOrganizationPolicy.maximumEvidenceCodePointsPerPdf)
    .join("");
}

function exactOpaqueCoverage(
  expected: readonly string[],
  actual: readonly string[],
): boolean {
  return new Set(actual).size === actual.length &&
    expected.length === actual.length &&
    expected.every((id) => actual.includes(id));
}

export class ContentAwareFolderPlanner {
  readonly #reader: WorkspaceReader;
  readonly #knowledge: OrganizationKnowledge;
  readonly #classifier: WorkspaceClassifier;

  constructor(options: {
    reader: WorkspaceReader;
    knowledge: OrganizationKnowledge;
    classifier: WorkspaceClassifier;
  }) {
    this.#reader = options.reader;
    this.#knowledge = options.knowledge;
    this.#classifier = options.classifier;
  }

  async plan(
    runId: string,
    identity: PlanIdentity,
    consentedInventory: DriveInventory,
  ): Promise<ContentPlanResult> {
    try {
      const observed = await this.#reader.inspectWorkspace(identity, {
        maxPdfs: workspaceOrganizationPolicy.maxEligiblePdfs,
      });
      if (observed.files.length === 0) {
        return {
          kind: "inventory_not_ready",
          inventoryResult: {
            ok: false,
            error: {
              code: "UNEXPECTED_WORKSPACE_STATE",
              message: "I couldn’t find any supported PDFs in this workspace.",
              retryable: false,
            },
          },
        };
      }
      const inventory = snapshotWorkspaceInventory(runId, observed);
      if (!workspaceSnapshotMatches(consentedInventory, inventory)) {
        return {
          kind: "inventory_not_ready",
          inventoryResult: {
            ok: false,
            error: {
              code: "UNEXPECTED_WORKSPACE_STATE",
              message: "The workspace changed after you approved analysis. Please review it again.",
              retryable: false,
            },
          },
        };
      }
      const inventoryResult = {
        ok: true as const,
        inventory,
      };
      const evidence = await this.#knowledge.prepareWorkspaceOrganization(
        observed.files,
      );
      const documents = evidence.map((item, index) => ({
        document_id: `D${String(index + 1).padStart(3, "0")}`,
        file_name: item.file.fileName,
        relative_path: item.file.relativePath,
        evidence: boundedEvidence(item.chunks),
      }));
      const profiles: NimWorkspaceDocumentProfile[] = [];
      for (
        let index = 0;
        index < documents.length;
        index += workspaceOrganizationPolicy.maximumProfileBatchSize
      ) {
        const batch = documents.slice(
          index,
          index + workspaceOrganizationPolicy.maximumProfileBatchSize,
        );
        const result = await this.#classifier.profileWorkspaceDocuments({
          documents: batch,
        });
        if (!exactOpaqueCoverage(
          batch.map((document) => document.document_id),
          result.map((profile) => profile.document_id),
        )) {
          throw new NimAnalysisError(
            "INVALID_RESPONSE",
            "NVIDIA returned incomplete workspace document profiles.",
          );
        }
        profiles.push(...result);
      }

      const existingFolderNames = observed.folders
        .filter((folder) => folder.depth === 1 && folder.ownedByRequester)
        .map((folder) => folder.name);
      const proposed = await this.#classifier.proposeWorkspaceTaxonomy({
        profiles,
        existing_folder_names: existingFolderNames,
      });
      const taxonomy = validateTaxonomy(proposed, profiles);
      const decisions: NimWorkspaceDecision[] = [];
      for (
        let index = 0;
        index < profiles.length;
        index += workspaceOrganizationPolicy.maximumClassificationBatchSize
      ) {
        const batch = profiles.slice(
          index,
          index + workspaceOrganizationPolicy.maximumClassificationBatchSize,
        );
        const result = await this.#classifier.classifyWorkspaceDocuments({
          profiles: batch,
          destinations: taxonomy,
        });
        if (!exactOpaqueCoverage(
          batch.map((profile) => profile.document_id),
          result.map((decision) => decision.document_id),
        )) {
          throw new NimAnalysisError(
            "INVALID_RESPONSE",
            "NVIDIA returned incomplete workspace document decisions.",
          );
        }
        decisions.push(...result);
      }
      const filesById = new Map(
        evidence.map((item, index) => [
          documents[index]!.document_id,
          item.file,
        ]),
      );
      const declared = new Map(
        taxonomy.map((folder) => [normalizeDestinationName(folder.name), folder.name]),
      );
      const contentDecisions = decisions.map((decision): ContentDecision => {
        const file = filesById.get(decision.document_id);
        if (!file) {
          throw new NimAnalysisError("INVALID_RESPONSE", "NVIDIA returned an unknown PDF.");
        }
        const destination = decision.destination === "Needs review"
          ? "Needs review"
          : declared.get(normalizeDestinationName(decision.destination));
        if (!destination) {
          throw new NimAnalysisError(
            "INVALID_RESPONSE",
            "NVIDIA returned an undeclared workspace destination.",
          );
        }
        return {
          file_ref: file.token,
          destination,
          rationale: decision.rationale,
        };
      });
      return { kind: "ready", inventoryResult, taxonomy, decisions: contentDecisions };
    } catch (error) {
      if (error instanceof NimAnalysisError) {
        return {
          kind: "failed",
          message: error.message,
          retryable: error.retryable,
        };
      }
      throw error;
    }
  }
}

function validateTaxonomy(
  folders: NimWorkspaceTaxonomyFolder[],
  profiles: NimWorkspaceDocumentProfile[],
): ProposedTaxonomyFolder[] {
  const minimum = singleFolderIsJustified(profiles)
    ? 1
    : workspaceOrganizationPolicy.minimumDestinations;
  if (
    folders.length < minimum ||
    folders.length > workspaceOrganizationPolicy.maximumDestinations
  ) {
    throw new NimAnalysisError("INVALID_RESPONSE", "NVIDIA returned an invalid folder count.");
  }
  const seen = new Set<string>();
  for (const folder of folders) {
    const normalized = normalizeDestinationName(folder.name);
    if (
      !isSafeDestinationName(folder.name) ||
      normalized === "needs review" ||
      seen.has(normalized)
    ) {
      throw new NimAnalysisError("INVALID_RESPONSE", "NVIDIA returned an invalid folder taxonomy.");
    }
    seen.add(normalized);
  }
  return folders.map(({ name, description }) => ({ name, description }));
}

function singleFolderIsJustified(
  profiles: NimWorkspaceDocumentProfile[],
): boolean {
  if (profiles.length < 3) return true;
  const sharedThemes = new Set(
    profiles[0]?.themes.map(normalizeDestinationName) ?? [],
  );
  for (const profile of profiles.slice(1)) {
    const themes = new Set(profile.themes.map(normalizeDestinationName));
    for (const theme of sharedThemes) {
      if (!themes.has(theme)) sharedThemes.delete(theme);
    }
  }
  return sharedThemes.size > 0;
}
