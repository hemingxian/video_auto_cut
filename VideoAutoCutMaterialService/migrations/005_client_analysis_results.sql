BEGIN;

ALTER TABLE analysis
    ADD COLUMN IF NOT EXISTS embedding_backend TEXT NOT NULL DEFAULT 'qwen-cloud';
ALTER TABLE analysis
    ADD COLUMN IF NOT EXISTS model_version TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE analysis
    ADD COLUMN IF NOT EXISTS result_schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE analysis
    ADD COLUMN IF NOT EXISTS submitted_by_device_id TEXT;

COMMIT;
