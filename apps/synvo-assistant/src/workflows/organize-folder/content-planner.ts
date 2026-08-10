import { SynvoMcpClientError } from "../../mcp/client.js";
import {
  NimAnalysisError,
  type NimOrganizationDecision,
  type NvidiaNimClient,
} from "../analyze-attachment/nim-client.js";
import { safeAnalysisFailureMessage } from "../analyze-attachment/workflow.js";
import type { DriveFolderInventoryResult } from "./contracts.js";
import type { ContentDecision } from "./proposal.js";

type ReadOnlyFolderTools = {
  connect(): Promise<void>;
  close(): Promise<void>;
  inventory(folderUrl: string): Promise<DriveFolderInventoryResult>;
  analyze(
    folderUrl: string,
    fileName: string,
  ): Promise<
    | {
        ok: true;
        analysis: {
          filename: string;
          text: string;
        };
      }
    | { ok: false; error: { message: string; retryable: boolean } }
  >;
};

type OrganizationClassifier = Pick<NvidiaNimClient, "classifyOrganization">;

export type ContentPlanResult =
  | {
      kind: "ready";
      inventoryResult: Extract<DriveFolderInventoryResult, { ok: true }>;
      decisions: ContentDecision[];
    }
  | {
      kind: "inventory_not_ready";
      inventoryResult: DriveFolderInventoryResult;
    }
  | {
      kind: "failed";
      message: string;
      retryable: boolean;
    };

export class ContentAwareFolderPlanner {
  readonly #tools: ReadOnlyFolderTools;
  readonly #classifier: OrganizationClassifier;

  constructor(options: {
    tools: ReadOnlyFolderTools;
    classifier: OrganizationClassifier;
  }) {
    this.#tools = options.tools;
    this.#classifier = options.classifier;
  }

  async plan(folderUrl: string): Promise<ContentPlanResult> {
    try {
      await this.#tools.connect();
      const inventoryResult = await this.#tools.inventory(folderUrl);
      if (!inventoryResult.ok || !inventoryResult.inventory.baseline_matches) {
        return { kind: "inventory_not_ready", inventoryResult };
      }

      const files = inventoryResult.inventory.files;
      const analyzed: Array<{ file_name: string; analysis: string }> = [];
      for (let index = 0; index < files.length; index += 2) {
        const batch = files.slice(index, index + 2);
        const results = await Promise.all(
          batch.map(async (file) => ({
            expectedName: file.name,
            result: await this.#tools.analyze(folderUrl, file.name),
          })),
        );
        for (const { expectedName, result } of results) {
          if (!result.ok) {
            return {
              kind: "failed",
              message: result.error.message,
              retryable: result.error.retryable,
            };
          }
          if (result.analysis.filename !== expectedName) {
            return {
              kind: "failed",
              message: "The analyzed file did not match the requested inventory item.",
              retryable: false,
            };
          }
          analyzed.push({
            file_name: expectedName,
            analysis: result.analysis.text,
          });
        }
      }

      const decisions = await this.#classifier.classifyOrganization({
        files: analyzed,
      });
      return {
        kind: "ready",
        inventoryResult,
        decisions: decisions.map(toContentDecision),
      };
    } catch (error) {
      if (error instanceof NimAnalysisError) {
        return {
          kind: "failed",
          message:
            safeAnalysisFailureMessage(error) ??
            "Content classification is temporarily unavailable.",
          retryable: error.retryable,
        };
      }
      if (error instanceof SynvoMcpClientError) {
        return {
          kind: "failed",
          message: "The read-only Synvo tools are temporarily unavailable.",
          retryable: true,
        };
      }
      throw error;
    } finally {
      await this.#tools.close().catch(() => {});
    }
  }
}

function toContentDecision(
  decision: NimOrganizationDecision,
): ContentDecision {
  return {
    file_name: decision.file_name,
    destination: decision.destination,
    rationale: decision.rationale,
  };
}
