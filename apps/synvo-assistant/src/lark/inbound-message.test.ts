import assert from "node:assert/strict";
import test from "node:test";

import {
  isRecentLarkMessage,
  PostgresInboundMessageStore,
} from "./inbound-message.js";

test("claims one Lark message exactly once", async () => {
  const observed: unknown[][] = [];
  let claims = 0;
  const store = new PostgresInboundMessageStore({
    async query(_sql: unknown, values?: unknown[]) {
      observed.push(values ?? []);
      claims += 1;
      return { rowCount: claims === 1 ? 1 : 0 } as never;
    },
  });

  assert.equal(await store.claim("tenant", "om_message"), true);
  assert.equal(await store.claim("tenant", "om_message"), false);
  assert.deepEqual(observed, [
    ["tenant", "om_message"],
    ["tenant", "om_message"],
  ]);
});

test("ignores stale reconnect events while accepting current or unclocked events", () => {
  const startedAt = new Date("2026-08-11T09:00:00.000Z");

  assert.equal(
    isRecentLarkMessage("1786438499999", startedAt),
    false,
  );
  assert.equal(
    isRecentLarkMessage("1786438500000", startedAt),
    true,
  );
  assert.equal(isRecentLarkMessage(undefined, startedAt), true);
  assert.equal(isRecentLarkMessage("invalid", startedAt), true);
});
