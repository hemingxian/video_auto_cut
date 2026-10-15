BEGIN;

CREATE TABLE IF NOT EXISTS generation_run_event (
    event_sequence BIGSERIAL PRIMARY KEY,
    owner_id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES generation_run(run_id) ON DELETE CASCADE,
    revision BIGINT NOT NULL,
    status TEXT NOT NULL,
    stage TEXT NOT NULL,
    progress NUMERIC(5, 2) NOT NULL CHECK (progress >= 0 AND progress <= 100),
    current_shot_id TEXT,
    current_material_id TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_generation_run_event_owner_run
    ON generation_run_event(owner_id, run_id, event_sequence);

ALTER TABLE generation_run_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE generation_run_event FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS generation_run_event_owner_policy ON generation_run_event;
CREATE POLICY generation_run_event_owner_policy ON generation_run_event
    USING (owner_id = current_setting('app.user_id', true))
    WITH CHECK (owner_id = current_setting('app.user_id', true));

DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'video_auto_cut') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON generation_run_event TO video_auto_cut;
        GRANT USAGE, SELECT ON SEQUENCE generation_run_event_event_sequence_seq TO video_auto_cut;
    END IF;
END
$grant$;

COMMIT;
