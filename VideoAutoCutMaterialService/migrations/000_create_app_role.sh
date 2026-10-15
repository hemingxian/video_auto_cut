#!/bin/sh
set -eu

if [ -z "${MATERIAL_APP_DATABASE_PASSWORD:-}" ]; then
  echo "MATERIAL_APP_DATABASE_PASSWORD is required" >&2
  exit 1
fi

psql --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set app_password="$MATERIAL_APP_DATABASE_PASSWORD" <<-'SQL'
SELECT format(
  'CREATE ROLE video_auto_cut LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT',
  :'app_password'
) WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='video_auto_cut') \gexec
GRANT CONNECT ON DATABASE video_auto_cut_material TO video_auto_cut;
GRANT USAGE ON SCHEMA public TO video_auto_cut;
SQL
