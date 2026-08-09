ALTER TABLE organize_folder_runs
    DROP COLUMN workflow_phase,
    DROP COLUMN scan_attempt,
    DROP COLUMN scan_lease_expires_at;
