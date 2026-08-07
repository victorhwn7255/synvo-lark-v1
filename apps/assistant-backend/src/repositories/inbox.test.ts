import assert from "node:assert/strict";
import test from "node:test";

import type { Pool } from "pg";

import { PostgresInbox } from "./inbox.js";

type StubResult = {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
};

class StubPool {
  readonly calls: Array<{ text: string; values: unknown[] }> = [];
  readonly #responses: Array<() => Promise<StubResult>> = [];

  respondWith(result: StubResult): void {
    this.#responses.push(async () => result);
  }

  rejectWith(error: Error): void {
    this.#responses.push(async () => Promise.reject(error));
  }

  defer(): { resolve: (result: StubResult) => void } {
    let resolveResponse: ((result: StubResult) => void) | undefined;
    const response = new Promise<StubResult>((resolve) => {
      resolveResponse = resolve;
    });
    this.#responses.push(async () => response);
    return {
      resolve(result) {
        assert.ok(resolveResponse);
        resolveResponse(result);
      },
    };
  }

  async query(text: string, values: unknown[]): Promise<StubResult> {
    this.calls.push({ text, values });
    const response = this.#responses.shift();
    if (!response) {
      throw new Error("No stubbed database response");
    }
    return response();
  }
}

function createInbox(pool: StubPool): PostgresInbox {
  return new PostgresInbox(pool as unknown as Pool);
}

test("reserves an event locally while its database claim is in flight", async () => {
  const pool = new StubPool();
  const deferred = pool.defer();
  const inbox = createInbox(pool);
  const now = new Date("2026-08-07T00:00:00.000Z");

  const firstClaim = inbox.claim("event-1", "im.message.receive_v1", now);
  assert.equal(
    await inbox.claim("event-1", "im.message.receive_v1", now),
    false,
  );
  assert.equal(pool.calls.length, 1);

  deferred.resolve({ rows: [{ attempt_count: 1 }], rowCount: 1 });
  assert.equal(await firstClaim, true);
});

test("clears a local reservation when the database claim fails", async () => {
  const pool = new StubPool();
  const inbox = createInbox(pool);
  const now = new Date("2026-08-07T00:00:00.000Z");
  pool.rejectWith(new Error("database unavailable"));

  await assert.rejects(
    inbox.claim("event-2", "im.message.receive_v1", now),
    /database unavailable/,
  );

  pool.respondWith({ rows: [{ attempt_count: 1 }], rowCount: 1 });
  assert.equal(
    await inbox.claim("event-2", "im.message.receive_v1", now),
    true,
  );
});

test("releases local ownership even when the release update fails", async () => {
  const pool = new StubPool();
  const inbox = createInbox(pool);
  const now = new Date("2026-08-07T00:00:00.000Z");
  pool.respondWith({ rows: [{ attempt_count: 1 }], rowCount: 1 });
  assert.equal(
    await inbox.claim("event-3", "im.message.receive_v1", now),
    true,
  );

  pool.rejectWith(new Error("database unavailable"));
  await assert.rejects(
    inbox.release("event-3", "EVENT_PROCESSING_RETRYABLE", now),
    /database unavailable/,
  );

  pool.respondWith({ rows: [{ attempt_count: 2 }], rowCount: 1 });
  assert.equal(
    await inbox.claim("event-3", "im.message.receive_v1", now),
    true,
  );
});

test("guards completion and release with the claimed attempt", async () => {
  const pool = new StubPool();
  const inbox = createInbox(pool);
  const now = new Date("2026-08-07T00:00:00.000Z");
  pool.respondWith({ rows: [{ attempt_count: 7 }], rowCount: 1 });
  assert.equal(
    await inbox.claim("event-4", "im.message.receive_v1", now),
    true,
  );

  pool.respondWith({ rows: [], rowCount: 0 });
  assert.equal(await inbox.complete("event-4"), false);
  const completionCall = pool.calls.at(-1);
  assert.deepEqual(completionCall?.values, ["event-4", 7]);
  assert.match(completionCall?.text ?? "", /attempt_count = \$2/);

  assert.equal(
    await inbox.release("event-4", "EVENT_PROCESSING_RETRYABLE", now),
    false,
  );
  assert.equal(pool.calls.length, 2);
});
