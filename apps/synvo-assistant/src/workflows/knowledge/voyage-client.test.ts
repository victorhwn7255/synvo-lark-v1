import assert from "node:assert/strict";
import test from "node:test";

import {
  KNOWLEDGE_EMBEDDING_BATCH_SIZE,
  KNOWLEDGE_EMBEDDING_DIMENSIONS,
} from "./policy.js";
import { VoyageEmbeddingClient, VoyageEmbeddingError } from "./voyage-client.js";

function embedding(value = 0.1): number[] {
  return Array.from({ length: KNOWLEDGE_EMBEDDING_DIMENSIONS }, () => value);
}

function responseFor(count: number): Response {
  return Response.json({
    data: Array.from({ length: count }, (_, index) => ({
      index,
      embedding: embedding(index + 0.1),
    })),
  });
}

test("uses fixed voyage-4 document and query contracts with bounded batching", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const client = new VoyageEmbeddingClient({
    apiKey: "v".repeat(32),
    minRequestIntervalMs: 0,
    fetchImplementation: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return responseFor((body.input as string[]).length);
    },
  });

  const documents = await client.embedDocuments(
    Array.from({ length: KNOWLEDGE_EMBEDDING_BATCH_SIZE + 1 }, () => "text"),
  );
  const query = await client.embedQuery("question");

  assert.equal(documents.length, KNOWLEDGE_EMBEDDING_BATCH_SIZE + 1);
  assert.equal(query.length, KNOWLEDGE_EMBEDDING_DIMENSIONS);
  assert.deepEqual(bodies.map((body) => body.input_type), ["document", "document", "query"]);
  assert.ok(bodies.every((body) => body.model === "voyage-4"));
  assert.ok(bodies.every((body) => body.output_dimension === 1_024));
  assert.ok(bodies.every((body) => body.truncation === false));
});

test("paces consecutive requests for the reduced Voyage account limits", async () => {
  const requestTimes: number[] = [];
  const client = new VoyageEmbeddingClient({
    apiKey: "v".repeat(32),
    minRequestIntervalMs: 20,
    fetchImplementation: async (_url, init) => {
      requestTimes.push(Date.now());
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return responseFor(body.input.length);
    },
  });

  await client.embedDocuments(
    Array.from({ length: KNOWLEDGE_EMBEDDING_BATCH_SIZE + 1 }, () => "text"),
  );

  assert.equal(requestTimes.length, 2);
  assert.ok((requestTimes[1] ?? 0) - (requestTimes[0] ?? 0) >= 15);
});

test("reports each completed embedding batch and stops before the next batch", async () => {
  let requests = 0;
  let beforeBatches = 0;
  const completed: number[] = [];
  const client = new VoyageEmbeddingClient({
    apiKey: "v".repeat(32),
    minRequestIntervalMs: 0,
    fetchImplementation: async (_url, init) => {
      requests += 1;
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return responseFor(body.input.length);
    },
  });

  await assert.rejects(
    client.embedDocuments(
      Array.from({ length: KNOWLEDGE_EMBEDDING_BATCH_SIZE + 1 }, () => "text"),
      {
        beforeBatch: async () => {
          beforeBatches += 1;
          if (beforeBatches === 2) throw new Error("stopped");
        },
        onBatchComplete: async (progress) => {
          completed.push(progress.completedBatches);
        },
      },
    ),
    /stopped/u,
  );
  assert.equal(requests, 1);
  assert.deepEqual(completed, [1]);
});

test("rejects malformed, missing, and wrong-dimensional embeddings", async () => {
  for (const response of [
    new Response("not json"),
    Response.json({ data: [] }),
    Response.json({ data: [{ index: 0, embedding: [1, 2] }] }),
    Response.json({ data: [{ index: 1, embedding: embedding() }] }),
  ]) {
    const client = new VoyageEmbeddingClient({
      apiKey: "v".repeat(32),
      minRequestIntervalMs: 0,
      fetchImplementation: async () => response.clone(),
    });
    await assert.rejects(
      client.embedQuery("question"),
      (error: unknown) => error instanceof VoyageEmbeddingError,
    );
  }
});

test("leaves retryable rate limits to the durable delivery worker", async () => {
  let calls = 0;
  const client = new VoyageEmbeddingClient({
    apiKey: "v".repeat(32),
    minRequestIntervalMs: 0,
    fetchImplementation: async () => {
      calls += 1;
      return new Response("busy", {
        status: 429,
        headers: { "retry-after": "0" },
      });
    },
  });
  await assert.rejects(
    client.embedQuery("question"),
    (error: unknown) =>
      error instanceof VoyageEmbeddingError &&
      error.retryable &&
      error.category === "RATE_LIMITED",
  );
  assert.equal(calls, 1);
});

test("categorizes a persistent rate limit without exposing its response", async () => {
  const client = new VoyageEmbeddingClient({
    apiKey: "v".repeat(32),
    minRequestIntervalMs: 0,
    fetchImplementation: async () =>
      new Response("private provider response", {
        status: 429,
        headers: { "retry-after": "0" },
      }),
  });
  await assert.rejects(
    client.embedQuery("question"),
    (error: unknown) =>
      error instanceof VoyageEmbeddingError &&
      error.retryable &&
      error.category === "RATE_LIMITED" &&
      !error.message.includes("private provider response"),
  );
});

test("bounds timeout failures without exposing provider content", async () => {
  const client = new VoyageEmbeddingClient({
    apiKey: "v".repeat(32),
    minRequestIntervalMs: 0,
    timeoutMs: 1,
    fetchImplementation: async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("private text"), { name: "AbortError" }));
        });
      }),
  });
  await assert.rejects(
    client.embedQuery("question"),
    (error: unknown) =>
      error instanceof VoyageEmbeddingError &&
      error.retryable &&
      !error.message.includes("private text"),
  );
});
