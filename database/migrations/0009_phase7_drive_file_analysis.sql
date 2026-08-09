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
                'ANALYZE_DRIVE_FILE'
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
                kind IN ('ANALYZE_ATTACHMENT', 'ANALYZE_DRIVE_FILE')
                AND run_id IS NULL
            )
        );
