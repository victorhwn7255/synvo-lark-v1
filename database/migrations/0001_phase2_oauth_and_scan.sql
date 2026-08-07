CREATE TABLE IF NOT EXISTS lark_oauth_grants (
    id uuid PRIMARY KEY,
    open_id text NOT NULL,
    tenant_key text NOT NULL,
    access_token_ciphertext text NOT NULL,
    refresh_token_ciphertext text NOT NULL,
    granted_scopes text[] NOT NULL,
    access_expires_at timestamptz NOT NULL,
    refresh_expires_at timestamptz NOT NULL,
    refresh_version integer NOT NULL CHECK (refresh_version > 0),
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_key, open_id)
);

CREATE TABLE IF NOT EXISTS inbox_events (
    event_id text PRIMARY KEY,
    event_type text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organize_folder_runs (
    id uuid PRIMARY KEY,
    message_id text NOT NULL UNIQUE,
    chat_id text NOT NULL,
    requester_open_id text NOT NULL,
    tenant_key text NOT NULL,
    root_token_digest text NOT NULL,
    oauth_grant_id uuid REFERENCES lark_oauth_grants(id),
    state text NOT NULL CHECK (
        state IN (
            'AWAITING_OAUTH',
            'READY_TO_SCAN',
            'SCANNING',
            'COMPLETED',
            'FAILED_NO_CHANGE'
        )
    ),
    terminal_error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS organize_folder_runs_actor_idx
    ON organize_folder_runs (tenant_key, requester_open_id, created_at DESC);

CREATE TABLE IF NOT EXISTS lark_oauth_sessions (
    id uuid PRIMARY KEY,
    run_id uuid NOT NULL REFERENCES organize_folder_runs(id) ON DELETE CASCADE,
    request_token_digest text NOT NULL UNIQUE,
    state_digest text UNIQUE,
    requester_open_id text NOT NULL,
    tenant_key text NOT NULL,
    chat_id text NOT NULL,
    redirect_uri text NOT NULL,
    requested_scopes text[] NOT NULL,
    code_verifier_ciphertext text,
    started_at timestamptz,
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (state_digest IS NULL AND code_verifier_ciphertext IS NULL AND started_at IS NULL)
        OR
        (state_digest IS NOT NULL AND code_verifier_ciphertext IS NOT NULL AND started_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS lark_oauth_sessions_expiry_idx
    ON lark_oauth_sessions (expires_at)
    WHERE consumed_at IS NULL;
