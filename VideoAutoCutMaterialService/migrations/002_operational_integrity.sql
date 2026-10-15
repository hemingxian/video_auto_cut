BEGIN;

ALTER TABLE upload_session
    DROP CONSTRAINT IF EXISTS upload_session_status_check;
ALTER TABLE upload_session
    ADD CONSTRAINT upload_session_status_check
    CHECK (status IN ('created', 'uploading', 'verifying', 'ready', 'failed', 'canceled', 'expired'))
    NOT VALID;
ALTER TABLE upload_session VALIDATE CONSTRAINT upload_session_status_check;

CREATE INDEX IF NOT EXISTS idx_upload_part_session_completed
    ON upload_part(upload_session_id, completed_at, part_number);
CREATE INDEX IF NOT EXISTS idx_render_snapshot_owner_created
    ON render_material_snapshot(owner_id, created_at DESC, run_id, shot_id);

ALTER TABLE app_user_device ENABLE ROW LEVEL SECURITY;
ALTER TABLE upload_part ENABLE ROW LEVEL SECURITY;
ALTER TABLE render_material_snapshot ENABLE ROW LEVEL SECURITY;
ALTER TABLE render_material_snapshot_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_change ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS device_owner_policy ON app_user_device;
CREATE POLICY device_owner_policy ON app_user_device
    USING (owner_id = current_setting('app.user_id', true))
    WITH CHECK (owner_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS upload_part_owner_policy ON upload_part;
CREATE POLICY upload_part_owner_policy ON upload_part
    USING (EXISTS (
        SELECT 1 FROM upload_session s
        WHERE s.upload_session_id = upload_part.upload_session_id
          AND s.owner_id = current_setting('app.user_id', true)
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM upload_session s
        WHERE s.upload_session_id = upload_part.upload_session_id
          AND s.owner_id = current_setting('app.user_id', true)
    ));

DROP POLICY IF EXISTS render_snapshot_owner_policy ON render_material_snapshot;
CREATE POLICY render_snapshot_owner_policy ON render_material_snapshot
    USING (owner_id = current_setting('app.user_id', true))
    WITH CHECK (owner_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS render_snapshot_item_owner_policy ON render_material_snapshot_item;
CREATE POLICY render_snapshot_item_owner_policy ON render_material_snapshot_item
    USING (EXISTS (
        SELECT 1 FROM render_material_snapshot s
        WHERE s.run_id = render_material_snapshot_item.run_id
          AND s.shot_id = render_material_snapshot_item.shot_id
          AND s.owner_id = current_setting('app.user_id', true)
    ))
    WITH CHECK (EXISTS (
        SELECT 1 FROM render_material_snapshot s
        WHERE s.run_id = render_material_snapshot_item.run_id
          AND s.shot_id = render_material_snapshot_item.shot_id
          AND s.owner_id = current_setting('app.user_id', true)
    ));

DROP POLICY IF EXISTS sync_change_owner_policy ON sync_change;
CREATE POLICY sync_change_owner_policy ON sync_change
    USING (owner_id = current_setting('app.user_id', true))
    WITH CHECK (owner_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS audit_actor_policy ON audit_log;
CREATE POLICY audit_actor_policy ON audit_log
    USING (actor_id = current_setting('app.user_id', true))
    WITH CHECK (actor_id = current_setting('app.user_id', true));

COMMIT;
