UPDATE material_publication
SET published_at=updated_at
WHERE status='published' AND published_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_material_publication_published
    ON material_publication(published_at DESC, publication_id DESC)
    WHERE status='published' AND removed_at IS NULL;

CREATE TABLE IF NOT EXISTS public_material_import (
    owner_id TEXT NOT NULL,
    publication_id TEXT NOT NULL REFERENCES material_publication(publication_id),
    material_id TEXT NOT NULL REFERENCES material(material_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, publication_id),
    UNIQUE (owner_id, material_id)
);

ALTER TABLE public_material_import ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_material_import FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS public_material_import_owner_policy ON public_material_import;
CREATE POLICY public_material_import_owner_policy ON public_material_import
    USING (owner_id = current_setting('app.user_id', true))
    WITH CHECK (owner_id = current_setting('app.user_id', true));

DROP POLICY IF EXISTS publication_public_read_policy ON material_publication;
CREATE POLICY publication_public_read_policy ON material_publication
    FOR SELECT
    USING (status='published' AND removed_at IS NULL);

DROP POLICY IF EXISTS material_public_read_policy ON material;
CREATE POLICY material_public_read_policy ON material
    FOR SELECT
    USING (EXISTS (
        SELECT 1 FROM material_publication p
        WHERE p.material_id=material.material_id
          AND p.status='published'
          AND p.removed_at IS NULL
    ));
