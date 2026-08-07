import type { Pool } from "pg";

import {
  driveScanResultAssociatedData,
  driveScanFolderResultSchema,
  type DriveScanFolderResult,
} from "@synvo/contracts";
import type { LarkTokenBroker, TokenCipher } from "@synvo/lark-auth";

import { driveToolError } from "../modules/drive/errors.js";
import { digestFolderToken } from "../modules/drive/folder-link.js";
import type { DriveScanContext } from "../modules/drive/scan-folder.js";

const scanLeaseDuration = "2 minutes";

type ClaimedRunRow = {
  id: string;
  requester_open_id: string;
  tenant_key: string;
  oauth_grant_id: string;
  scan_attempt: number;
};

type RunDiagnosticRow = {
  state: string;
  root_token_digest: string;
  oauth_grant_id: string | null;
  oauth_grant_matches_subject: boolean;
  scan_result_ciphertext: string | null;
};

export type DriveRunResolution =
  | {
      kind: "claimed";
      scanAttempt: number;
      loadContext(): Promise<DriveScanContext>;
    }
  | {
      kind: "cached";
      result: DriveScanFolderResult;
    };

export class PostgresDriveRunRepository {
  readonly #pool: Pool;
  readonly #tokenBroker: LarkTokenBroker;
  readonly #cipher: TokenCipher;
  readonly #rootToken: string;
  readonly #rootTokenDigest: string;

  constructor(options: {
    pool: Pool;
    tokenBroker: LarkTokenBroker;
    cipher: TokenCipher;
    rootToken: string;
  }) {
    this.#pool = options.pool;
    this.#tokenBroker = options.tokenBroker;
    this.#cipher = options.cipher;
    this.#rootToken = options.rootToken;
    this.#rootTokenDigest = digestFolderToken(options.rootToken);
  }

  async resolve(runId: string): Promise<DriveRunResolution> {
    const result = await this.#pool.query<ClaimedRunRow>(
      `UPDATE organize_folder_runs AS run
          SET state = 'SCANNING',
              scan_attempt = run.scan_attempt + 1,
              scan_lease_expires_at = now() + $3::interval,
              updated_at = now()
         FROM lark_oauth_grants AS oauth_grant
        WHERE run.id = $1
          AND run.root_token_digest = $2
          AND (
            run.state = 'READY_TO_SCAN'
            OR (
              run.state = 'SCANNING'
              AND (
                run.scan_lease_expires_at IS NULL
                OR run.scan_lease_expires_at <= now()
              )
            )
          )
          AND run.oauth_grant_id = oauth_grant.id
          AND run.requester_open_id = oauth_grant.open_id
          AND run.tenant_key = oauth_grant.tenant_key
      RETURNING run.id,
                run.requester_open_id,
                run.tenant_key,
                run.oauth_grant_id,
                run.scan_attempt`,
      [runId, this.#rootTokenDigest, scanLeaseDuration],
    );
    const run = result.rows[0];
    if (!run) {
      return this.#resolveUnclaimedRun(runId);
    }

    return {
      kind: "claimed",
      scanAttempt: run.scan_attempt,
      loadContext: async () => {
        const accessToken = await this.#tokenBroker.getAccessToken(
          run.requester_open_id,
          run.tenant_key,
        );
        return {
          runId: run.id,
          requesterOpenId: run.requester_open_id,
          rootToken: this.#rootToken,
          accessToken,
          recoverAccessToken: (rejectedAccessToken) =>
            this.#tokenBroker.recoverAccessToken(
              run.requester_open_id,
              run.tenant_key,
              rejectedAccessToken,
            ),
          markAccessTokenRejected: (rejectedAccessToken) =>
            this.#tokenBroker.markAccessTokenRejected(
              run.requester_open_id,
              run.tenant_key,
              rejectedAccessToken,
            ),
        };
      },
    };
  }

  async complete(
    runId: string,
    scanAttempt: number,
    result: DriveScanFolderResult,
  ): Promise<void> {
    const validated = driveScanFolderResultSchema.parse(result);
    if (!validated.ok || !validated.inventory) {
      throw driveToolError(
        "INTERNAL",
        "The read-only inventory result could not be stored safely.",
      );
    }

    await this.#persistTerminalResult({
      runId,
      scanAttempt,
      result: validated,
      state: validated.inventory.baseline_matches
        ? "COMPLETED"
        : "FAILED_NO_CHANGE",
      errorCode: validated.inventory.baseline_matches
        ? null
        : "UNEXPECTED_SANDBOX_STATE",
    });
  }

  async fail(
    runId: string,
    scanAttempt: number,
    result: DriveScanFolderResult,
  ): Promise<void> {
    const validated = driveScanFolderResultSchema.parse(result);
    if (validated.ok || !validated.error) {
      throw driveToolError(
        "INTERNAL",
        "The read-only inventory failure could not be stored safely.",
      );
    }

    if (validated.error.retryable) {
      await this.#releaseRetryableFailure(runId, scanAttempt);
      return;
    }

    await this.#persistTerminalResult({
      runId,
      scanAttempt,
      result: validated,
      state: "FAILED_NO_CHANGE",
      errorCode: validated.error.code,
    });
  }

  async #resolveUnclaimedRun(runId: string): Promise<DriveRunResolution> {
    const diagnostic = await this.#pool.query<RunDiagnosticRow>(
      `SELECT run.state,
              run.root_token_digest,
              run.oauth_grant_id,
              run.scan_result_ciphertext,
              EXISTS (
                SELECT 1
                  FROM lark_oauth_grants AS oauth_grant
                 WHERE oauth_grant.id = run.oauth_grant_id
                   AND oauth_grant.open_id = run.requester_open_id
                   AND oauth_grant.tenant_key = run.tenant_key
              ) AS oauth_grant_matches_subject
         FROM organize_folder_runs AS run
        WHERE run.id = $1`,
      [runId],
    );
    const run = diagnostic.rows[0];
    if (!run) {
      throw driveToolError(
        "RUN_NOT_FOUND",
        "The read-only inventory run was not found.",
      );
    }
    if (run.root_token_digest !== this.#rootTokenDigest) {
      throw driveToolError(
        "ROOT_NOT_ALLOWLISTED",
        "The run does not target the approved pilot sandbox.",
      );
    }
    if (run.state === "COMPLETED" || run.state === "FAILED_NO_CHANGE") {
      return {
        kind: "cached",
        result: this.#decryptCachedResult(runId, run.scan_result_ciphertext),
      };
    }
    if (!run.oauth_grant_id) {
      throw driveToolError(
        "OAUTH_REQUIRED",
        "Lark authorization is required.",
      );
    }
    if (!run.oauth_grant_matches_subject) {
      throw driveToolError(
        "UNAUTHORIZED",
        "The stored Lark authorization does not match the requesting user.",
      );
    }

    throw driveToolError(
      "RUN_NOT_READY",
      run.state === "SCANNING"
        ? "The read-only inventory run is already being scanned."
        : "The read-only inventory run is not ready.",
      true,
    );
  }

  #decryptCachedResult(
    runId: string,
    ciphertext: string | null,
  ): DriveScanFolderResult {
    if (!ciphertext) {
      throw driveToolError(
        "INTERNAL",
        "The stored read-only inventory result is unavailable.",
      );
    }

    try {
      return driveScanFolderResultSchema.parse(
        JSON.parse(
          this.#cipher.decrypt(
            ciphertext,
            driveScanResultAssociatedData(runId),
          ),
        ),
      );
    } catch {
      throw driveToolError(
        "INTERNAL",
        "The stored read-only inventory result could not be loaded safely.",
      );
    }
  }

  async #releaseRetryableFailure(
    runId: string,
    scanAttempt: number,
  ): Promise<void> {
    const update = await this.#pool.query(
      `UPDATE organize_folder_runs
          SET state = 'READY_TO_SCAN',
              terminal_error_code = NULL,
              scan_result_ciphertext = NULL,
              scan_lease_expires_at = NULL,
              updated_at = now()
        WHERE id = $1
          AND state = 'SCANNING'
          AND scan_attempt = $2
      RETURNING id`,
      [runId, scanAttempt],
    );
    if (update.rowCount !== 1) {
      throw driveToolError(
        "RUN_NOT_READY",
        "The read-only inventory scan lease is no longer current.",
        true,
      );
    }
  }

  async #persistTerminalResult(input: {
    runId: string;
    scanAttempt: number;
    result: DriveScanFolderResult;
    state: "COMPLETED" | "FAILED_NO_CHANGE";
    errorCode: string | null;
  }): Promise<void> {
    const ciphertext = this.#cipher.encrypt(
      JSON.stringify(input.result),
      driveScanResultAssociatedData(input.runId),
    );
    const update = await this.#pool.query(
      `UPDATE organize_folder_runs
          SET state = $3,
              terminal_error_code = $4,
              scan_result_ciphertext = $5,
              scan_lease_expires_at = NULL,
              updated_at = now()
        WHERE id = $1
          AND state = 'SCANNING'
          AND scan_attempt = $2
      RETURNING id`,
      [
        input.runId,
        input.scanAttempt,
        input.state,
        input.errorCode,
        ciphertext,
      ],
    );
    if (update.rowCount !== 1) {
      throw driveToolError(
        "RUN_NOT_READY",
        "The read-only inventory scan lease is no longer current.",
        true,
      );
    }
  }
}
