ALTER TABLE asset_version
    DROP CONSTRAINT IF EXISTS asset_version_cloud_status_check;

ALTER TABLE asset_version
    ADD CONSTRAINT asset_version_cloud_status_check
    CHECK (cloud_status IN (
        'not_uploaded', 'uploading', 'verifying', 'ready',
        'deleting', 'failed', 'deleted'
    ));

ALTER TABLE asset_version
    ADD COLUMN IF NOT EXISTS cloud_delete_operation_id TEXT;
