import { z } from "zod";

const defaultApiOrigin = "https://open.larksuite.com";
const defaultRequestTimeoutMs = 10_000;

export type DriveMoveFailureCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "TEMPORARY"
  | "TIMEOUT"
  | "MALFORMED"
  | "PERMANENT";

export class DriveMoveError extends Error {
  readonly code: DriveMoveFailureCode;
  readonly ambiguous: boolean;

  constructor(code: DriveMoveFailureCode, ambiguous: boolean) {
    super(`Lark Drive move failed: ${code}`);
    this.name = "DriveMoveError";
    this.code = code;
    this.ambiguous = ambiguous;
  }
}

export interface DriveMover {
  moveFile(input: {
    accessToken: string;
    fileToken: string;
    destinationFolderToken: string;
  }): Promise<void>;
}

function transportError(error: unknown): DriveMoveError {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) {
      break;
    }
    const record = current as Record<string, unknown>;
    if (
      record.name === "AbortError" ||
      record.name === "TimeoutError" ||
      [
        "ABORT_ERR",
        "ETIMEDOUT",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT",
      ].includes(String(record.code ?? ""))
    ) {
      return new DriveMoveError("TIMEOUT", true);
    }
    current = record.cause;
  }
  return new DriveMoveError("TEMPORARY", true);
}

function responseError(status: number, providerCode?: number): DriveMoveError {
  if (status === 401 || providerCode === 99991679) {
    return new DriveMoveError("UNAUTHORIZED", false);
  }
  if (status === 403) {
    return new DriveMoveError("FORBIDDEN", false);
  }
  if (status === 404) {
    return new DriveMoveError("NOT_FOUND", false);
  }
  if (status === 429 || providerCode === 1061045) {
    return new DriveMoveError("RATE_LIMITED", false);
  }
  if (status >= 500) {
    return new DriveMoveError("TEMPORARY", true);
  }
  return new DriveMoveError("PERMANENT", false);
}

export class LarkDriveMover implements DriveMover {
  readonly #fetcher: typeof fetch;
  readonly #apiOrigin: string;
  readonly #requestTimeoutMs: number;

  constructor(options: {
    fetcher?: typeof fetch;
    apiOrigin?: string;
    requestTimeoutMs?: number;
  } = {}) {
    this.#fetcher = options.fetcher ?? fetch;
    this.#apiOrigin = options.apiOrigin ?? defaultApiOrigin;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? defaultRequestTimeoutMs;
    if (!Number.isInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs <= 0) {
      throw new Error("Drive move timeout must be a positive integer");
    }
  }

  async moveFile(input: {
    accessToken: string;
    fileToken: string;
    destinationFolderToken: string;
  }): Promise<void> {
    const url = new URL(
      `/open-apis/drive/v1/files/${encodeURIComponent(input.fileToken)}/move`,
      this.#apiOrigin,
    );
    let response: Response;
    try {
      response = await this.#fetcher(url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${input.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "file",
          folder_token: input.destinationFolderToken,
        }),
      });
    } catch (error) {
      throw transportError(error);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (!response.ok) {
        throw responseError(response.status);
      }
      throw new DriveMoveError("MALFORMED", true);
    }
    const envelope = z.object({ code: z.number().int() }).safeParse(body);
    if (!envelope.success) {
      throw new DriveMoveError("MALFORMED", true);
    }
    if (!response.ok || envelope.data.code !== 0) {
      throw responseError(
        response.status,
        envelope.data.code,
      );
    }
  }
}
