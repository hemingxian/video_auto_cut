BEGIN;

ALTER TABLE analysis ADD COLUMN IF NOT EXISTS requested_by_owner_id TEXT;
ALTER TABLE analysis ADD COLUMN IF NOT EXISTS requested_material_id TEXT;
ALTER TABLE analysis ADD COLUMN IF NOT EXISTS lease_owner TEXT;
ALTER TABLE analysis ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE analysis ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_analysis_claim
    ON analysis(analysis_status, lease_expires_at, created_at);

CREATE TABLE IF NOT EXISTS vector_outbox (
    analysis_id TEXT PRIMARY KEY REFERENCES analysis(analysis_id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vector_outbox_due
    ON vector_outbox(status, next_retry_at, updated_at);

DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'video_auto_cut') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON analysis, analysis_chunk, vector_outbox
            TO video_auto_cut;
    END IF;
END
$grant$;

COMMIT;
