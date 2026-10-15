ALTER TABLE material_publication
    ADD COLUMN IF NOT EXISTS reviewer_id TEXT,
    ADD COLUMN IF NOT EXISTS review_reason TEXT,
    ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

ALTER TABLE material_publication
    DROP CONSTRAINT IF EXISTS material_publication_status_check;
ALTER TABLE material_publication
    ADD CONSTRAINT material_publication_status_check
    CHECK (status IN (
        'pending_review', 'published', 'paused',
        'rejected', 'withdrawn', 'removed'
    )) NOT VALID;
ALTER TABLE material_publication
    VALIDATE CONSTRAINT material_publication_status_check;

CREATE UNIQUE INDEX IF NOT EXISTS uk_material_publication_active
    ON material_publication(material_id)
    WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_material_publication_review_queue
    ON material_publication(status, created_at, publication_id)
    WHERE removed_at IS NULL;

DROP POLICY IF EXISTS publication_moderator_policy ON material_publication;
CREATE POLICY publication_moderator_policy ON material_publication
    FOR ALL
    USING (current_setting('app.actor_role', true) IN ('admin', 'moderator'))
    WITH CHECK (current_setting('app.actor_role', true) IN ('admin', 'moderator'));

DROP POLICY IF EXISTS material_moderator_policy ON material;
CREATE POLICY material_moderator_policy ON material
    FOR ALL
    USING (current_setting('app.actor_role', true) IN ('admin', 'moderator'))
    WITH CHECK (current_setting('app.actor_role', true) IN ('admin', 'moderator'));

DROP POLICY IF EXISTS sync_change_moderator_policy ON sync_change;
CREATE POLICY sync_change_moderator_policy ON sync_change
    FOR ALL
    USING (current_setting('app.actor_role', true) IN ('admin', 'moderator'))
    WITH CHECK (current_setting('app.actor_role', true) IN ('admin', 'moderator'));
