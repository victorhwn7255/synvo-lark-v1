CREATE TABLE lark_inbound_messages (
    tenant_key text NOT NULL,
    message_id text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_key, message_id)
);
