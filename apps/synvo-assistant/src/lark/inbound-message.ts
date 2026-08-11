const RECONNECT_GRACE_MS = 5 * 60_000;

type InboundMessageDatabase = {
  query(
    sql: string,
    values: unknown[],
  ): Promise<{ rowCount: number | null }>;
};

export function isRecentLarkMessage(
  createTime: string | undefined,
  startedAt: Date,
): boolean {
  if (!createTime) {
    return true;
  }
  const createdAt = Number(createTime);
  return !Number.isFinite(createdAt) ||
    createdAt >= startedAt.getTime() - RECONNECT_GRACE_MS;
}

export class PostgresInboundMessageStore {
  readonly #pool: InboundMessageDatabase;

  constructor(pool: InboundMessageDatabase) {
    this.#pool = pool;
  }

  async claim(tenantKey: string, messageId: string): Promise<boolean> {
    const result = await this.#pool.query(
      `INSERT INTO lark_inbound_messages (tenant_key, message_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [tenantKey, messageId],
    );
    return (result.rowCount ?? 0) === 1;
  }
}
