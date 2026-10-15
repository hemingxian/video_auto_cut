DROP POLICY IF EXISTS public_material_import_moderator_policy ON public_material_import;
CREATE POLICY public_material_import_moderator_policy ON public_material_import
    FOR ALL
    USING (current_setting('app.actor_role', true) IN ('admin', 'moderator'))
    WITH CHECK (current_setting('app.actor_role', true) IN ('admin', 'moderator'));
