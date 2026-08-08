ALTER TABLE organize_folder_runs
    ADD COLUMN proposal_ciphertext text,
    ADD COLUMN proposal_status text,
    ADD COLUMN proposal_decided_by_open_id text,
    ADD COLUMN proposal_decided_at timestamptz,
    ADD CONSTRAINT organize_folder_runs_proposal_status_check
        CHECK (
            proposal_status IS NULL
            OR proposal_status IN ('PROPOSED', 'APPROVED', 'REJECTED', 'STALE')
        ),
    ADD CONSTRAINT organize_folder_runs_proposal_shape_check
        CHECK (
            (
                proposal_status IS NULL
                AND proposal_ciphertext IS NULL
                AND proposal_decided_by_open_id IS NULL
                AND proposal_decided_at IS NULL
            )
            OR
            (
                proposal_ciphertext IS NOT NULL
                AND proposal_status IN ('PROPOSED', 'STALE')
                AND proposal_decided_by_open_id IS NULL
                AND proposal_decided_at IS NULL
            )
            OR
            (
                proposal_ciphertext IS NOT NULL
                AND proposal_status IN ('APPROVED', 'REJECTED')
                AND proposal_decided_by_open_id IS NOT NULL
                AND proposal_decided_at IS NOT NULL
            )
        );
