#!/usr/bin/env bash
set -euo pipefail
# For deployments where PostgreSQL runs in a local Docker container.
# No connection password or customer content is printed.
: "${PG_CONTAINER:?Set the dedicated PostgreSQL container name}"
: "${BACKUP_DIR:?Set a root-only backup directory}"
[[ "${PG_DATABASE:-}" == "sales_workbench" ]] || exit 1
umask 077
install -d -m 700 "$BACKUP_DIR"
backup_path=$(mktemp "$BACKUP_DIR/sales_$(date -u +%Y%m%dT%H%M%SZ)_XXXXXX.dump")
trap 'rm -f "$backup_path.partial"' EXIT
if ! docker exec "$PG_CONTAINER" pg_dump -U postgres -d "$PG_DATABASE" --format=custom --no-owner > "$backup_path.partial"; then
  rm -f "$backup_path"
  exit 1
fi
docker exec -i "$PG_CONTAINER" pg_restore --list < "$backup_path.partial" > "$backup_path.contents"
mv "$backup_path.partial" "$backup_path"
sha256sum "$backup_path" > "$backup_path.sha256"
echo 'Sales database backup and archive listing saved. Restore verification is separate.'
