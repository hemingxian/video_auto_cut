BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS app_user_device (
    owner_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ,
    PRIMARY KEY (owner_id, device_id)
);

CREATE TABLE IF NOT EXISTS material_folder (
    folder_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    parent_folder_id TEXT REFERENCES material_folder(folder_id),
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    revision BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    UNIQUE NULLS NOT DISTINCT (owner_id, parent_folder_id, name_key)
);

CREATE INDEX IF NOT EXISTS idx_material_folder_owner_parent
    ON material_folder(owner_id, parent_folder_id, deleted_at, name_key);

CREATE TABLE IF NOT EXISTS asset (
    asset_id TEXT PRIMARY KEY,
    origin TEXT NOT NULL CHECK (origin IN ('user_upload', 'platform_download')),
    original_file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS asset_version (
    asset_id TEXT NOT NULL REFERENCES asset(asset_id),
    asset_version INTEGER NOT NULL CHECK (asset_version > 0),
    source_sha256 CHAR(64) NOT NULL,
    source_size BIGINT NOT NULL CHECK (source_size > 0),
    source_sha512 CHAR(128),
    cloud_status TEXT NOT NULL DEFAULT 'not_uploaded'
        CHECK (cloud_status IN ('not_uploaded', 'uploading', 'verifying', 'ready', 'failed', 'deleted')),
    storage_session_id TEXT,
    verified_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (asset_id, asset_version)
);

CREATE INDEX IF NOT EXISTS idx_asset_version_fingerprint_candidate
    ON asset_version(source_sha256, source_size);

CREATE UNIQUE INDEX IF NOT EXISTS uk_asset_version_collision_fingerprint
    ON asset_version(source_sha256, source_size, source_sha512)
    WHERE source_sha512 IS NOT NULL;

CREATE TABLE IF NOT EXISTS material (
    material_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    folder_id TEXT NOT NULL REFERENCES material_folder(folder_id),
    asset_id TEXT NOT NULL,
    asset_version INTEGER NOT NULL,
    display_name TEXT NOT NULL,
    added_from TEXT NOT NULL
        CHECK (added_from IN ('user_import', 'task_download', 'cloud_restore', 'public_library')),
    revision BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    FOREIGN KEY (asset_id, asset_version) REFERENCES asset_version(asset_id, asset_version)
);

CREATE INDEX IF NOT EXISTS idx_material_owner_folder
    ON material(owner_id, folder_id, deleted_at, updated_at DESC, material_id);
CREATE INDEX IF NOT EXISTS idx_material_owner_asset
    ON material(owner_id, asset_id, asset_version, deleted_at);

CREATE TABLE IF NOT EXISTS upload_session (
    upload_session_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    material_id TEXT NOT NULL REFERENCES material(material_id),
    asset_id TEXT NOT NULL,
    asset_version INTEGER NOT NULL,
    internal_upload_session_id TEXT,
    upload_mode TEXT NOT NULL CHECK (upload_mode IN ('single', 'multipart')),
    part_size_bytes BIGINT NOT NULL,
    expected_size BIGINT NOT NULL,
    source_sha256 CHAR(64) NOT NULL,
    status TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (asset_id, asset_version) REFERENCES asset_version(asset_id, asset_version)
);

CREATE INDEX IF NOT EXISTS idx_upload_session_owner_status
    ON upload_session(owner_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS upload_part (
    upload_session_id TEXT NOT NULL REFERENCES upload_session(upload_session_id) ON DELETE CASCADE,
    part_number INTEGER NOT NULL CHECK (part_number > 0),
    size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
    checksum_sha256 CHAR(64) NOT NULL,
    etag TEXT,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (upload_session_id, part_number)
);

CREATE TABLE IF NOT EXISTS analysis (
    analysis_id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    asset_version INTEGER NOT NULL,
    analysis_profile_id TEXT NOT NULL,
    embedding_backend TEXT NOT NULL DEFAULT 'qwen-cloud',
    model_name TEXT NOT NULL,
    model_version TEXT NOT NULL DEFAULT 'legacy',
    dimension INTEGER NOT NULL CHECK (dimension = 768),
    result_schema_version INTEGER NOT NULL DEFAULT 1,
    submitted_by_device_id TEXT,
    analysis_status TEXT NOT NULL DEFAULT 'pending',
    vector_sync_status TEXT NOT NULL DEFAULT 'pending',
    chunk_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (asset_id, asset_version, analysis_profile_id),
    FOREIGN KEY (asset_id, asset_version) REFERENCES asset_version(asset_id, asset_version)
);

CREATE TABLE IF NOT EXISTS analysis_chunk (
    analysis_id TEXT NOT NULL REFERENCES analysis(analysis_id) ON DELETE CASCADE,
    chunk_id TEXT NOT NULL,
    start_ms BIGINT NOT NULL CHECK (start_ms >= 0),
    end_ms BIGINT NOT NULL CHECK (end_ms > start_ms),
    caption TEXT NOT NULL DEFAULT '',
    embedding vector(768) NOT NULL,
    cloud_vector_status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (analysis_id, chunk_id)
);

CREATE INDEX IF NOT EXISTS idx_analysis_chunk_embedding_hnsw
    ON analysis_chunk USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS material_publication (
    publication_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    material_id TEXT NOT NULL REFERENCES material(material_id),
    status TEXT NOT NULL,
    consent_version TEXT NOT NULL,
    rights_confirmed BOOLEAN NOT NULL,
    revision BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    removed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS render_material_snapshot (
    run_id TEXT NOT NULL,
    shot_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    download_material BOOLEAN NOT NULL,
    checksum CHAR(64) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, shot_id)
);

CREATE TABLE IF NOT EXISTS render_material_snapshot_item (
    run_id TEXT NOT NULL,
    shot_id TEXT NOT NULL,
    material_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    asset_version INTEGER NOT NULL,
    source_sha256 CHAR(64) NOT NULL,
    PRIMARY KEY (run_id, shot_id, material_id),
    UNIQUE (run_id, shot_id, asset_id, asset_version),
    FOREIGN KEY (run_id, shot_id) REFERENCES render_material_snapshot(run_id, shot_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS idempotency_record (
    owner_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash CHAR(64) NOT NULL,
    response_status INTEGER NOT NULL,
    response_json JSONB NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, operation, idempotency_key)
);

CREATE TABLE IF NOT EXISTS sync_change (
    sequence_id BIGSERIAL PRIMARY KEY,
    owner_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    revision BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sync_change_owner_sequence
    ON sync_change(owner_id, sequence_id);

CREATE TABLE IF NOT EXISTS audit_log (
    audit_id BIGSERIAL PRIMARY KEY,
    actor_id TEXT NOT NULL,
    device_id TEXT,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    result TEXT NOT NULL,
    request_id TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE material_folder ENABLE ROW LEVEL SECURITY;
ALTER TABLE material ENABLE ROW LEVEL SECURITY;
ALTER TABLE upload_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_publication ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS folder_owner_policy ON material_folder;
CREATE POLICY folder_owner_policy ON material_folder
    USING (owner_id = current_setting('app.user_id', true))
    WITH CHECK (owner_id = current_setting('app.user_id', true));
DROP POLICY IF EXISTS material_owner_policy ON material;
CREATE POLICY material_owner_policy ON material
    USING (owner_id = current_setting('app.user_id', true))
    WITH CHECK (owner_id = current_setting('app.user_id', true));
DROP POLICY IF EXISTS upload_owner_policy ON upload_session;
CREATE POLICY upload_owner_policy ON upload_session
    USING (owner_id = current_setting('app.user_id', true))
    WITH CHECK (owner_id = current_setting('app.user_id', true));
DROP POLICY IF EXISTS publication_owner_policy ON material_publication;
CREATE POLICY publication_owner_policy ON material_publication
    USING (owner_id = current_setting('app.user_id', true))
    WITH CHECK (owner_id = current_setting('app.user_id', true));

COMMIT;
