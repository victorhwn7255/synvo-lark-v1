import { z } from "zod";

const defaultApiOrigin = "https://open.larksuite.com";
const defaultRequestTimeoutMs = 10_000;

const moveResponseSchema = z.object({
  code: z.literal(0),
  msg: z.string().optional(),
  data: z.object({ task_id: z.string().min(1).optional() }).optional(),
});

export type DriveMoveResult = {
  taskId?: string;
  requestId?: string;
};

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
  }): Promise<DriveMoveResult>;
}

export type LarkDriveMoverOptions = {
  fetcher?: typeof fetch;
  apiOrigin?: string;
  requestTimeoutMs?: number;
};

function nestedRecords(error: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) {
      break;
    }
    const record = current as Record<string, unknown>;
    records.push(record);
    current = record.cause;
  }
  return records;
}

function normalizeTransportError(error: unknown): DriveMoveError {
  if (error instanceof DriveMoveError) {
    return error;
  }
  const records = nestedRecords(error);
  const codes = records.flatMap((record) =>
    typeof record.code === "string" ? [record.code] : [],
  );
  const names = records.flatMap((record) =>
    typeof record.name === "string" ? [record.name] : [],
  );
  if (
    codes.some((code) =>
      [
        "ABORT_ERR",
        "ETIMEDOUT",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT",
      ].includes(code),
    ) ||
    names.some((name) => name === "AbortError" || name === "TimeoutError")
  ) {
    return new DriveMoveError("TIMEOUT", true);
  }
  return new DriveMoveError("TEMPORARY", true);
}

function responseFailure(status: number, providerCode?: number): DriveMoveError {
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

  constructor(options: LarkDriveMoverOptions = {}) {
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
  }): Promise<DriveMoveResult> {
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
      throw normalizeTransportError(error);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (!response.ok) {
        throw responseFailure(response.status);
      }
      throw new DriveMoveError("MALFORMED", true);
    }
    const envelope = z.object({ code: z.number().int() }).safeParse(body);
    if (!response.ok || !envelope.success || envelope.data.code !== 0) {
      throw responseFailure(
        response.status,
        envelope.success ? envelope.data.code : undefined,
      );
    }
    const parsed = moveResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new DriveMoveError("MALFORMED", true);
    }
    return {
      taskId: parsed.data.data?.task_id,
      requestId:
        response.headers.get("x-tt-logid") ??
        response.headers.get("x-request-id") ??
        undefined,
    };
  }
}
