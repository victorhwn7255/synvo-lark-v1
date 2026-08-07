ALTER TABLE inbox_events
    ADD COLUMN status text,
    ADD COLUMN attempt_count integer NOT NULL DEFAULT 0,
    ADD COLUMN lease_expires_at timestamptz,
    ADD COLUMN completed_at timestamptz,
    ADD COLUMN last_error_code text;

UPDATE inbox_events
   SET status = 'COMPLETED',
       completed_at = received_at
 WHERE status IS NULL;

ALTER TABLE inbox_events
    ALTER COLUMN status SET NOT NULL,
    ALTER COLUMN status SET DEFAULT 'PROCESSING',
    ADD CONSTRAINT inbox_events_status_check
        CHECK (status IN ('PROCESSING', 'COMPLETED')),
    ADD CONSTRAINT inbox_events_attempt_count_check
        CHECK (attempt_count >= 0);

ALTER TABLE organize_folder_runs
    ADD COLUMN scan_attempt integer NOT NULL DEFAULT 0,
    ADD COLUMN scan_lease_expires_at timestamptz,
    ADD COLUMN scan_result_ciphertext text,
    ADD CONSTRAINT organize_folder_runs_scan_attempt_check
        CHECK (scan_attempt >= 0);

CREATE TABLE lark_delivery_jobs (
    id uuid PRIMARY KEY,
    dedupe_key text NOT NULL UNIQUE,
    run_id uuid REFERENCES organize_folder_runs(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('TEXT', 'ORGANIZE_FOLDER_SCAN')),
    chat_id text NOT NULL,
    payload_ciphertext text,
    state text NOT NULL DEFAULT 'PENDING' CHECK (
        state IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')
    ),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    available_at timestamptz NOT NULL DEFAULT now(),
    lease_expires_at timestamptz,
    expires_at timestamptz,
    last_error_code text,
    delivered_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (
        (
            kind = 'TEXT'
            AND (
                payload_ciphertext IS NOT NULL
                OR state IN ('COMPLETED', 'FAILED')
            )
        )
        OR
        (kind = 'ORGANIZE_FOLDER_SCAN' AND run_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX lark_delivery_jobs_scan_run_idx
    ON lark_delivery_jobs (run_id)
    WHERE kind = 'ORGANIZE_FOLDER_SCAN';

CREATE INDEX lark_delivery_jobs_pending_idx
    ON lark_delivery_jobs (available_at, created_at)
    WHERE state IN ('PENDING', 'PROCESSING');
