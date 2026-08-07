ALTER TABLE lark_oauth_grants
    ADD COLUMN IF NOT EXISTS scope_profile text;

UPDATE lark_oauth_grants
   SET scope_profile = 'phase2_readonly'
 WHERE scope_profile IS NULL;

ALTER TABLE lark_oauth_grants
    ALTER COLUMN scope_profile SET NOT NULL;

ALTER TABLE lark_oauth_grants
    DROP CONSTRAINT IF EXISTS lark_oauth_grants_tenant_key_open_id_key;

ALTER TABLE lark_oauth_grants
    ADD CONSTRAINT lark_oauth_grants_subject_profile_key
    UNIQUE (tenant_key, open_id, scope_profile);

ALTER TABLE organize_folder_runs
    ADD COLUMN IF NOT EXISTS workflow_phase integer;

UPDATE organize_folder_runs
   SET workflow_phase = 2
 WHERE workflow_phase IS NULL;

ALTER TABLE organize_folder_runs
    ALTER COLUMN workflow_phase SET NOT NULL;

ALTER TABLE organize_folder_runs
    ADD CONSTRAINT organize_folder_runs_workflow_phase_check
    CHECK (workflow_phase IN (2, 3));

CREATE INDEX IF NOT EXISTS organize_folder_runs_phase_created_idx
    ON organize_folder_runs (workflow_phase, created_at DESC);

CREATE TABLE IF NOT EXISTS phase3_mutation_batches (
    id uuid PRIMARY KEY,
    operation_key text NOT NULL UNIQUE,
    run_id uuid NOT NULL REFERENCES organize_folder_runs(id),
    oauth_grant_id uuid NOT NULL REFERENCES lark_oauth_grants(id),
    requester_open_id text NOT NULL,
    tenant_key text NOT NULL,
    root_token_digest text NOT NULL,
    manifest_ciphertext text NOT NULL,
    manifest_digest text NOT NULL,
    baseline_digest text NOT NULL,
    state text NOT NULL CHECK (
        state IN (
            'PREPARED',
            'EXECUTING',
            'RESTORED',
            'FAILED_KNOWN_STATE',
            'NEEDS_ATTENTION'
        )
    ),
    confirmation_digest text,
    confirmed_at timestamptz,
    execution_attempt integer NOT NULL DEFAULT 0 CHECK (execution_attempt >= 0),
    lease_expires_at timestamptz,
    terminal_error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (confirmation_digest IS NULL AND confirmed_at IS NULL)
        OR
        (confirmation_digest IS NOT NULL AND confirmed_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS phase3_mutation_batches_run_idx
    ON phase3_mutation_batches (run_id, created_at DESC);

CREATE TABLE IF NOT EXISTS phase3_move_attempts (
    id uuid PRIMARY KEY,
    batch_id uuid NOT NULL REFERENCES phase3_mutation_batches(id) ON DELETE CASCADE,
    direction text NOT NULL CHECK (direction IN ('FORWARD', 'RESTORE')),
    attempt_key text NOT NULL UNIQUE,
    state text NOT NULL CHECK (
        state IN (
            'INTENT_RECORDED',
            'REQUESTING',
            'RECONCILING',
            'VERIFIED',
            'FAILED_KNOWN_STATE',
            'NEEDS_ATTENTION'
        )
    ),
    request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0 AND request_count <= 3),
    intent_ciphertext text NOT NULL,
    response_ciphertext text,
    observation_ciphertext text,
    last_error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (batch_id, direction)
);

CREATE INDEX IF NOT EXISTS phase3_move_attempts_batch_idx
    ON phase3_move_attempts (batch_id, created_at);
