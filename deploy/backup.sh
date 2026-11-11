#!/usr/bin/env bash
set -euo pipefail
# PGHOST/PGPORT/PGUSER/PGDATABASE and PGPASSFILE must come from a protected file.
# Runtime account intentionally cannot run complete backups. Use a backup role.
case "${PGDATABASE:-}" in sales_workbench|sales_workbench_*) ;; *) exit 1 ;; esac
: "${BACKUP_DIR:?Set a restricted backup directory}"
umask 077
mkdir -p "$BACKUP_DIR"
backup_path=$(mktemp "$BACKUP_DIR/sales_$(date -u +%Y%m%dT%H%M%SZ)_XXXXXX.dump")
trap 'rm -f "$backup_path.partial"' EXIT
if ! pg_dump --format=custom --no-owner --file="$backup_path.partial"; then
  rm -f "$backup_path"
  exit 1
fi
mv "$backup_path.partial" "$backup_path"
sha256sum "$backup_path" > "$backup_path.sha256"
pg_restore --list "$backup_path" > "$backup_path.contents"
echo "Backup created. A real restore into an isolated database is still required."
