CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE workspace_chunks (
    tenant_key text NOT NULL,
    user_open_id text NOT NULL,
    workspace_folder_token text NOT NULL,
    source_kind text NOT NULL CHECK (source_kind IN ('drive_file', 'chat_attachment')),
    source_key text NOT NULL,
    source_name text NOT NULL,
    source_version_or_hash text NOT NULL,
    page_number integer NOT NULL CHECK (page_number > 0),
    heading text,
    chunk_index integer NOT NULL CHECK (chunk_index >= 0),
    chunk_text text NOT NULL CHECK (length(chunk_text) > 0),
    embedding vector(1024) NOT NULL,
    indexed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (
        tenant_key,
        user_open_id,
        workspace_folder_token,
        source_kind,
        source_key,
        chunk_index
    )
);

CREATE INDEX workspace_chunks_scope_idx
    ON workspace_chunks (tenant_key, user_open_id, workspace_folder_token);

ALTER TABLE lark_delivery_jobs
    DROP CONSTRAINT lark_delivery_jobs_kind_check,
    DROP CONSTRAINT lark_delivery_jobs_shape_check,
    ADD CONSTRAINT lark_delivery_jobs_kind_check
        CHECK (
            kind IN (
                'TEXT',
                'ORGANIZE_FOLDER_SCAN',
                'ORGANIZE_FOLDER_EXECUTE',
                'ORGANIZE_FOLDER_UNDO',
                'ANALYZE_ATTACHMENT',
                'ANALYZE_DRIVE_FILE',
                'KNOWLEDGE'
            )
        ),
    ADD CONSTRAINT lark_delivery_jobs_shape_check
        CHECK (
            (
                kind = 'TEXT'
                AND (
                    payload_ciphertext IS NOT NULL
                    OR state IN ('COMPLETED', 'FAILED')
                )
            )
            OR
            (
                kind IN (
                    'ORGANIZE_FOLDER_SCAN',
                    'ORGANIZE_FOLDER_EXECUTE',
                    'ORGANIZE_FOLDER_UNDO'
                )
                AND run_id IS NOT NULL
            )
            OR
            (
                kind IN ('ANALYZE_ATTACHMENT', 'ANALYZE_DRIVE_FILE', 'KNOWLEDGE')
                AND run_id IS NULL
            )
        );
