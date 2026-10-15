BEGIN;

CREATE TABLE IF NOT EXISTS material_publication_report (
    report_id TEXT PRIMARY KEY,
    publication_id TEXT NOT NULL REFERENCES material_publication(publication_id),
    reporter_id TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    revision BIGINT NOT NULL DEFAULT 1,
    reviewer_id TEXT,
    review_reason TEXT,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT publication_report_category_check
        CHECK (category IN ('copyright', 'privacy', 'harmful', 'other')),
    CONSTRAINT publication_report_status_check
        CHECK (status IN ('pending', 'reviewing', 'upheld', 'dismissed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_publication_report_active
    ON material_publication_report(reporter_id, publication_id)
    WHERE status IN ('pending', 'reviewing');
CREATE INDEX IF NOT EXISTS idx_publication_report_moderation
    ON material_publication_report(status, created_at, report_id);

ALTER TABLE material_publication_report ENABLE ROW LEVEL SECURITY;
ALTER TABLE material_publication_report FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS publication_report_select_policy ON material_publication_report;
CREATE POLICY publication_report_select_policy ON material_publication_report
    FOR SELECT
    USING (
        reporter_id = current_setting('app.user_id', true)
        OR current_setting('app.actor_role', true) IN ('admin', 'moderator')
    );

DROP POLICY IF EXISTS publication_report_insert_policy ON material_publication_report;
CREATE POLICY publication_report_insert_policy ON material_publication_report
    FOR INSERT
    WITH CHECK (reporter_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS publication_report_moderator_update_policy ON material_publication_report;
CREATE POLICY publication_report_moderator_update_policy ON material_publication_report
    FOR UPDATE
    USING (current_setting('app.actor_role', true) IN ('admin', 'moderator'))
    WITH CHECK (current_setting('app.actor_role', true) IN ('admin', 'moderator'));

DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'video_auto_cut') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON material_publication_report TO video_auto_cut;
    END IF;
END
$grant$;

COMMIT;
