ALTER TABLE organize_folder_runs
    ADD COLUMN execution_status text,
    ADD COLUMN execution_ciphertext text,
    ADD COLUMN undo_status text,
    ADD CONSTRAINT organize_folder_runs_execution_status_check
        CHECK (
            execution_status IS NULL
            OR execution_status IN (
                'QUEUED',
                'RUNNING',
                'COMPLETED',
                'PARTIAL',
                'FAILED',
                'UNKNOWN',
                'STALE'
            )
        ),
    ADD CONSTRAINT organize_folder_runs_undo_status_check
        CHECK (
            undo_status IS NULL
            OR undo_status IN (
                'REQUESTED',
                'RUNNING',
                'COMPLETED',
                'PARTIAL',
                'FAILED',
                'UNKNOWN'
            )
        );

ALTER TABLE lark_delivery_jobs
    DROP CONSTRAINT lark_delivery_jobs_kind_check,
    DROP CONSTRAINT lark_delivery_jobs_check,
    ADD CONSTRAINT lark_delivery_jobs_kind_check
        CHECK (
            kind IN (
                'TEXT',
                'ORGANIZE_FOLDER_SCAN',
                'ORGANIZE_FOLDER_EXECUTE',
                'ORGANIZE_FOLDER_UNDO'
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
        );
