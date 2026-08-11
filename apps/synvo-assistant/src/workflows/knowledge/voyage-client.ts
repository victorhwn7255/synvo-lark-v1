import {
  KNOWLEDGE_EMBEDDING_BATCH_SIZE,
  KNOWLEDGE_EMBEDDING_DIMENSIONS,
  KNOWLEDGE_EMBEDDING_MIN_REQUEST_INTERVAL_MS,
  KNOWLEDGE_EMBEDDING_MODEL,
  KNOWLEDGE_MAX_PROVIDER_RESPONSE_BYTES,
  KNOWLEDGE_PROVIDER_TIMEOUT_MS,
} from "./policy.js";

const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";

export class VoyageEmbeddingError extends Error {
  readonly retryable: boolean;
  readonly category: "INVALID_RESPONSE" | "RATE_LIMITED" | "REJECTED" | "TIMEOUT" | "UNAVAILABLE";

  constructor(
    message: string,
    retryable = false,
    category: VoyageEmbeddingError["category"] = retryable
      ? "UNAVAILABLE"
      : "INVALID_RESPONSE",
  ) {
    super(message);
    this.name = "VoyageEmbeddingError";
    this.retryable = retryable;
    this.category = category;
  }
}

export type VoyageEmbeddingProgress = {
  completedBatches: number;
  totalBatches: number;
};

export type VoyageEmbeddingHooks = {
  beforeBatch?: () => Promise<void>;
  onBatchComplete?: (progress: VoyageEmbeddingProgress) => Promise<void>;
};

async function wait(ms: number): Promise<void> {
  if (ms > 0) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declared) &&
    declared > KNOWLEDGE_MAX_PROVIDER_RESPONSE_BYTES
  ) {
    throw new VoyageEmbeddingError("Voyage returned an oversized response");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > KNOWLEDGE_MAX_PROVIDER_RESPONSE_BYTES) {
    throw new VoyageEmbeddingError("Voyage returned an oversized response");
  }
  return Buffer.from(bytes).toString("utf8");
}

function parseEmbeddings(raw: string, expectedCount: number): number[][] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new VoyageEmbeddingError("Voyage returned malformed JSON");
  }
  if (typeof value !== "object" || value === null || !("data" in value)) {
    throw new VoyageEmbeddingError("Voyage returned an invalid embedding response");
  }
  const data = (value as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length !== expectedCount) {
    throw new VoyageEmbeddingError("Voyage returned the wrong number of embeddings");
  }
  const ordered = [...data].sort((left, right) => {
    const leftIndex = typeof left === "object" && left !== null && "index" in left
      ? Number((left as { index: unknown }).index)
      : Number.NaN;
    const rightIndex = typeof right === "object" && right !== null && "index" in right
      ? Number((right as { index: unknown }).index)
      : Number.NaN;
    return leftIndex - rightIndex;
  });
  return ordered.map((item, expectedIndex) => {
    if (typeof item !== "object" || item === null) {
      throw new VoyageEmbeddingError("Voyage returned an invalid embedding item");
    }
    const record = item as { index?: unknown; embedding?: unknown };
    if (record.index !== expectedIndex || !Array.isArray(record.embedding)) {
      throw new VoyageEmbeddingError("Voyage returned embeddings out of order");
    }
    if (
      record.embedding.length !== KNOWLEDGE_EMBEDDING_DIMENSIONS ||
      !record.embedding.every(
        (component) => typeof component === "number" && Number.isFinite(component),
      )
    ) {
      throw new VoyageEmbeddingError("Voyage returned an invalid embedding dimension");
    }
    return record.embedding as number[];
  });
}

export class VoyageEmbeddingClient {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #minRequestIntervalMs: number;
  readonly #timeoutMs: number;
  #nextRequestAt = 0;

  constructor(options: {
    apiKey: string;
    fetchImplementation?: typeof fetch;
    minRequestIntervalMs?: number;
    timeoutMs?: number;
  }) {
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#minRequestIntervalMs =
      options.minRequestIntervalMs ?? KNOWLEDGE_EMBEDDING_MIN_REQUEST_INTERVAL_MS;
    this.#timeoutMs = options.timeoutMs ?? KNOWLEDGE_PROVIDER_TIMEOUT_MS;
  }

  async embedDocuments(
    texts: string[],
    hooks: VoyageEmbeddingHooks = {},
  ): Promise<number[][]> {
    const result: number[][] = [];
    const totalBatches = Math.ceil(texts.length / KNOWLEDGE_EMBEDDING_BATCH_SIZE);
    let completedBatches = 0;
    for (let offset = 0; offset < texts.length; offset += KNOWLEDGE_EMBEDDING_BATCH_SIZE) {
      await hooks.beforeBatch?.();
      result.push(
        ...(await this.#embed(
          texts.slice(offset, offset + KNOWLEDGE_EMBEDDING_BATCH_SIZE),
          "document",
        )),
      );
      completedBatches += 1;
      await hooks.onBatchComplete?.({ completedBatches, totalBatches });
    }
    return result;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [embedding] = await this.#embed([text], "query");
    if (!embedding) {
      throw new VoyageEmbeddingError("Voyage returned no query embedding");
    }
    return embedding;
  }

  async #embed(
    texts: string[],
    inputType: "document" | "query",
  ): Promise<number[][]> {
    if (texts.length < 1 || texts.length > KNOWLEDGE_EMBEDDING_BATCH_SIZE) {
      throw new VoyageEmbeddingError("Voyage embedding batch is invalid");
    }
    return this.#request(texts, inputType);
  }

  async #request(
    texts: string[],
    inputType: "document" | "query",
  ): Promise<number[][]> {
    await this.#paceRequest();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(VOYAGE_EMBEDDINGS_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          input: texts,
          model: KNOWLEDGE_EMBEDDING_MODEL,
          input_type: inputType,
          output_dimension: KNOWLEDGE_EMBEDDING_DIMENSIONS,
          output_dtype: "float",
          truncation: false,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const record = typeof error === "object" && error !== null
        ? error as { name?: unknown }
        : {};
      throw new VoyageEmbeddingError(
        record.name === "AbortError"
          ? "Voyage embedding request timed out"
          : "Voyage is temporarily unavailable",
        true,
        record.name === "AbortError" ? "TIMEOUT" : "UNAVAILABLE",
      );
    } finally {
      clearTimeout(timer);
    }
    const raw = await readBoundedResponse(response);
    if (!response.ok) {
      if (response.status === 429 || response.status >= 500) {
        throw new VoyageEmbeddingError(
          "Voyage is temporarily unavailable",
          true,
          response.status === 429 ? "RATE_LIMITED" : "UNAVAILABLE",
        );
      }
      if (response.status === 401 || response.status === 403) {
        throw new VoyageEmbeddingError(
          "Voyage rejected the configured credential",
          false,
          "REJECTED",
        );
      }
      throw new VoyageEmbeddingError(
        "Voyage rejected the embedding request",
        false,
        "REJECTED",
      );
    }
    return parseEmbeddings(raw, texts.length);
  }

  async #paceRequest(): Promise<void> {
    const now = Date.now();
    const requestAt = Math.max(now, this.#nextRequestAt);
    this.#nextRequestAt = requestAt + this.#minRequestIntervalMs;
    await wait(requestAt - now);
  }
}
