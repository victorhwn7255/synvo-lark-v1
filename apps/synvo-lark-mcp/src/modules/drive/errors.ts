import type { DriveInventorySafeError } from "@synvo/contracts";

export type DriveToolErrorMetadata = {
  authFailure?: "ACCESS_TOKEN_REJECTED" | "FORBIDDEN";
};

export class DriveToolError extends Error {
  readonly safeError: DriveInventorySafeError;
  readonly metadata: DriveToolErrorMetadata;

  constructor(
    safeError: DriveInventorySafeError,
    metadata: DriveToolErrorMetadata = {},
  ) {
    super(safeError.message);
    this.name = "DriveToolError";
    this.safeError = safeError;
    this.metadata = metadata;
  }
}

export function driveToolError(
  code: DriveInventorySafeError["code"],
  message: string,
  retryable = false,
  metadata: DriveToolErrorMetadata = {},
): DriveToolError {
  return new DriveToolError({ code, message, retryable }, metadata);
}

export function normalizeDriveError(error: unknown): DriveToolError {
  if (error instanceof DriveToolError) {
    return error;
  }

  const record =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : {};
  const records = [record];
  let cause = record.cause;
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof cause !== "object" || cause === null) {
      break;
    }
    const causeRecord = cause as Record<string, unknown>;
    records.push(causeRecord);
    cause = causeRecord.cause;
  }
  const response =
    typeof record.response === "object" && record.response !== null
      ? (record.response as Record<string, unknown>)
      : {};
  const status =
    typeof response.status === "number"
      ? response.status
      : typeof record.status === "number"
        ? record.status
        : undefined;
  const errorCodes = records.flatMap((candidate) =>
    typeof candidate.code === "string" || typeof candidate.code === "number"
      ? [String(candidate.code)]
      : [],
  );
  const errorNames = records.flatMap((candidate) =>
    typeof candidate.name === "string" ? [candidate.name] : [],
  );
  const hasErrorCode = (code: string): boolean => errorCodes.includes(code);
  const hasErrorName = (name: string): boolean => errorNames.includes(name);

  if (status === 403) {
    return driveToolError(
      "UNAUTHORIZED",
      "Lark denied the read-only Drive request.",
      false,
      { authFailure: "FORBIDDEN" },
    );
  }
  if (status === 401 || hasErrorCode("99991679")) {
    return driveToolError(
      "UNAUTHORIZED",
      "Lark rejected the read-only Drive access token.",
      false,
      { authFailure: "ACCESS_TOKEN_REJECTED" },
    );
  }
  if (status === 404) {
    return driveToolError(
      "LARK_PERMANENT",
      "The allowlisted Lark Drive resource is unavailable.",
    );
  }
  if (status === 429) {
    return driveToolError(
      "LARK_RETRYABLE",
      "Lark rate-limited the read-only Drive request.",
      true,
    );
  }
  if (status !== undefined && status >= 500) {
    return driveToolError(
      "LARK_RETRYABLE",
      "Lark Drive is temporarily unavailable.",
      true,
    );
  }
  if (
    hasErrorCode("ABORT_ERR") ||
    hasErrorCode("ECONNABORTED") ||
    hasErrorCode("ETIMEDOUT") ||
    hasErrorCode("UND_ERR_CONNECT_TIMEOUT") ||
    hasErrorCode("UND_ERR_HEADERS_TIMEOUT") ||
    hasErrorCode("UND_ERR_BODY_TIMEOUT") ||
    hasErrorName("AbortError") ||
    hasErrorName("TimeoutError")
  ) {
    return driveToolError(
      "LARK_RETRYABLE",
      "The read-only Lark Drive request timed out.",
      true,
    );
  }
  if (
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "EPIPE",
      "EAI_AGAIN",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "ENOTFOUND",
      "UND_ERR_SOCKET",
    ].some(hasErrorCode)
  ) {
    return driveToolError(
      "LARK_RETRYABLE",
      "The read-only Lark Drive connection failed temporarily.",
      true,
    );
  }

  return driveToolError(
    "LARK_PERMANENT",
    "The read-only Lark Drive request failed.",
  );
}
