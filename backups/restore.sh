#!/usr/bin/env bash
# LAX CRM — Restore script
# Restores a Postgres dump from the Railway bucket.
#
# ⚠️  THIS REPLACES THE PRODUCTION DATABASE. Confirms twice before running.
#
# Usage:
#   ./restore.sh                   # list available backups, prompts for choice
#   ./restore.sh 20260528-001234   # restore the backup matching that prefix
#
# Requires:
#   - railway CLI logged in, project linked
#   - awscli, gpg in PATH (or in ~/homebrew/bin)
#   - ~/.config/lax-crm-backups/env

set -euo pipefail

[ -d "$HOME/homebrew/bin" ] && export PATH="$HOME/homebrew/bin:$PATH"

CONFIG="$HOME/.config/lax-crm-backups/env"
[ -f "$CONFIG" ] || { echo "✗ Missing config: $CONFIG" >&2; exit 1; }
# shellcheck disable=SC1090
source "$CONFIG"

for cmd in railway aws gunzip; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "✗ Missing command: $cmd"; exit 1; }
done

S3="aws --endpoint-url=$S3_ENDPOINT s3"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

# ─── List or pick backup ────────────────────────────────────────────────
if [ $# -eq 0 ]; then
  echo "Available backups in bucket $S3_BUCKET:"
  $S3 ls "s3://$S3_BUCKET/" | awk '{print $NF}' | grep -E '\.sql\.gz$' | sort -r | nl
  echo ""
  echo "Re-run with: ./restore.sh <timestamp-or-prefix>"
  echo "   e.g.   ./restore.sh 20260528-001234"
  exit 0
fi

QUERY="$1"
MATCH=$($S3 ls "s3://$S3_BUCKET/" | awk '{print $NF}' | grep -E '\.sql\.gz$' | grep "$QUERY" | head -1 || true)

if [ -z "$MATCH" ]; then
  echo "✗ No backup matching '$QUERY' in s3://$S3_BUCKET/"
  exit 1
fi

echo "▸ Found: $MATCH"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "▸ Downloading..."
$S3 cp "s3://$S3_BUCKET/$MATCH" "$TMP/$MATCH" --only-show-errors

# ─── Sanity check + double confirm ──────────────────────────────────────
SIZE=$(du -h "$TMP/$MATCH" | awk '{print $1}')
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  ⚠️  ABOUT TO REPLACE PRODUCTION DATABASE"
echo "  ──────────────────────────────────────"
echo "  Source : $MATCH ($SIZE)"
echo "  Target : project=$RAILWAY_PROJECT_ID  env=production  service=Database"
echo "  Mode   : pg_dump used --clean --if-exists, so existing tables drop first"
echo "═══════════════════════════════════════════════════════════════"
echo ""
read -r -p "Type 'RESTORE' (uppercase) to proceed, anything else aborts: " ANS
[ "$ANS" = "RESTORE" ] || { echo "✗ Aborted."; exit 1; }

read -r -p "Are you really sure? Type the backup prefix '$QUERY' to confirm: " ANS2
[ "$ANS2" = "$QUERY" ] || { echo "✗ Confirmation mismatch. Aborted."; exit 1; }

# ─── Restore via railway ssh → psql ─────────────────────────────────────
echo ""
echo "▸ Restoring (streaming through railway ssh)..."
gunzip -c "$TMP/$MATCH" \
  | railway ssh --service Database \
      'PGPASSWORD=$POSTGRES_PASSWORD psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 --quiet'

echo ""
echo "✅ Restore complete from $MATCH"
echo "   Verify the app at production URL and check key tables."
