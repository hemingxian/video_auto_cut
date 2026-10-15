BEGIN;

CREATE TABLE IF NOT EXISTS generation_run (
    run_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    task_revision BIGINT NOT NULL CHECK (task_revision >= 1),
    request_checksum CHAR(64) NOT NULL,
    manifest_checksum CHAR(64) NOT NULL,
    status TEXT NOT NULL DEFAULT 'prepared',
    stage TEXT NOT NULL DEFAULT 'material_manifest_ready',
    progress NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
    revision BIGINT NOT NULL DEFAULT 1,
    current_shot_id TEXT,
    current_material_id TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    CONSTRAINT generation_run_status_check
        CHECK (status IN ('prepared', 'running', 'succeeded', 'failed', 'canceled')),
    CONSTRAINT generation_run_task_revision_unique
        UNIQUE (owner_id, task_id, task_revision)
);

CREATE INDEX IF NOT EXISTS idx_generation_run_owner_updated
    ON generation_run(owner_id, updated_at DESC, run_id);

ALTER TABLE render_material_snapshot
    ADD COLUMN IF NOT EXISTS shot_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE render_material_snapshot_item
    ADD COLUMN IF NOT EXISTS material_order INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_render_snapshot_run_order
    ON render_material_snapshot(run_id, shot_order, shot_id);
CREATE INDEX IF NOT EXISTS idx_render_snapshot_item_order
    ON render_material_snapshot_item(run_id, shot_id, material_order, material_id);

ALTER TABLE generation_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE generation_run FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS generation_run_owner_policy ON generation_run;
CREATE POLICY generation_run_owner_policy ON generation_run
    USING (owner_id = current_setting('app.user_id', true))
    WITH CHECK (owner_id = current_setting('app.user_id', true));

DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'video_auto_cut') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON generation_run TO video_auto_cut;
    END IF;
END
$grant$;

COMMIT;
