-- Optional verified source/config receipt. Old clients and historical results remain valid.
ALTER TABLE analysis ADD COLUMN IF NOT EXISTS analysis_provenance JSONB;
