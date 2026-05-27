#!/usr/bin/env bash
# LAX CRM — Backup script
# Dumps the production Postgres + encrypted env vars to the Railway bucket.
# Keeps only the N most recent backups (BACKUP_RETENTION).
#
# Usage:
#   ./backup.sh                    # tag: timestamp
#   ./backup.sh "before-logo-fix"  # tag: timestamp + label
#
# Requires:
#   - railway CLI logged in, project linked
#   - awscli, gpg in PATH (or in ~/homebrew/bin)
#   - ~/.config/lax-crm-backups/env  (S3 creds + GPG passphrase file)

set -euo pipefail

# ─── Load brew PATH if installed in home ────────────────────────────────
[ -d "$HOME/homebrew/bin" ] && export PATH="$HOME/homebrew/bin:$PATH"

# ─── Load config ────────────────────────────────────────────────────────
CONFIG="$HOME/.config/lax-crm-backups/env"
if [ ! -f "$CONFIG" ]; then
  echo "✗ Missing config: $CONFIG" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$CONFIG"

# ─── Prerequisites ──────────────────────────────────────────────────────
for cmd in railway gpg aws gzip; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "✗ Missing command: $cmd"; exit 1; }
done

# ─── Naming ─────────────────────────────────────────────────────────────
TS=$(date -u +"%Y%m%d-%H%M%S")
LABEL=${1:-manual}
# sanitize label (a-z, 0-9, -)
LABEL=$(echo "$LABEL" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed 's/--*/-/g; s/^-//; s/-$//')
PREFIX="${TS}_${LABEL}"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

DUMP_FILE="$TMP_DIR/${PREFIX}.sql.gz"
ENV_FILE="$TMP_DIR/${PREFIX}.env.gpg"

echo "▸ Backup tag: $PREFIX"
echo "▸ Working dir: $TMP_DIR"

# ─── 1) Dump Postgres via railway ssh ───────────────────────────────────
echo "▸ Dumping Postgres (via railway ssh → Database service)..."
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

railway ssh --service Database \
  'PGPASSWORD=$POSTGRES_PASSWORD pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-acl --clean --if-exists --format=plain' \
  | gzip -9 > "$DUMP_FILE"

SIZE=$(du -h "$DUMP_FILE" | awk '{print $1}')
echo "  ✓ Dump: $SIZE"

# Quick sanity check: dump must be non-trivial
BYTES=$(stat -f%z "$DUMP_FILE" 2>/dev/null || stat -c%s "$DUMP_FILE")
if [ "$BYTES" -lt 1024 ]; then
  echo "✗ Dump is suspiciously small (<1KB). Aborting."
  exit 1
fi

# ─── 2) Export env vars from Railway and encrypt with GPG ───────────────
echo "▸ Exporting env vars and encrypting..."
PASS_FILE="${GPG_PASSPHRASE_FILE:-$HOME/.config/lax-crm-backups/gpg-passphrase}"
if [ ! -f "$PASS_FILE" ]; then
  echo "✗ Missing GPG passphrase file: $PASS_FILE"
  echo "  Create it once with: printf 'MyStrongPass' > $PASS_FILE && chmod 600 $PASS_FILE"
  exit 1
fi

# Combine env vars from the app + database services into one annotated file
{
  echo "# LAX CRM env vars snapshot — $TS"
  echo "# === Service: LAX Group CRM ==="
  railway variables --service "LAX Group CRM" --kv
  echo ""
  echo "# === Service: Database ==="
  railway variables --service Database --kv
} > "$TMP_DIR/${PREFIX}.env"

gpg --batch --yes --pinentry-mode loopback \
  --passphrase-file "$PASS_FILE" \
  --symmetric --cipher-algo AES256 \
  --output "$ENV_FILE" "$TMP_DIR/${PREFIX}.env"
rm "$TMP_DIR/${PREFIX}.env"
echo "  ✓ Env vars encrypted"

# ─── 3) Upload to Railway bucket (S3-compatible) ────────────────────────
echo "▸ Uploading to bucket $S3_BUCKET..."
S3="aws --endpoint-url=$S3_ENDPOINT s3"
$S3 cp "$DUMP_FILE" "s3://$S3_BUCKET/$(basename "$DUMP_FILE")" --only-show-errors
$S3 cp "$ENV_FILE"  "s3://$S3_BUCKET/$(basename "$ENV_FILE")"  --only-show-errors
echo "  ✓ Uploaded both files"

# ─── 4) Rotation: keep only BACKUP_RETENTION newest pairs ───────────────
echo "▸ Rotating (keep $BACKUP_RETENTION most recent)..."
# List .sql.gz files, sort by name desc (timestamp prefix → newest first),
# skip the first N, delete the rest along with their .env.gpg twins.
TO_DELETE=$($S3 ls "s3://$S3_BUCKET/" \
  | awk '{print $NF}' \
  | grep -E '\.sql\.gz$' \
  | sort -r \
  | tail -n "+$((BACKUP_RETENTION + 1))" \
  | sed 's/\.sql\.gz$//')

if [ -z "$TO_DELETE" ]; then
  echo "  · Nothing to rotate (≤$BACKUP_RETENTION backups in bucket)"
else
  echo "$TO_DELETE" | while read -r base; do
    [ -z "$base" ] && continue
    echo "  · Deleting old: $base.{sql.gz,env.gpg}"
    $S3 rm "s3://$S3_BUCKET/${base}.sql.gz" --only-show-errors || true
    $S3 rm "s3://$S3_BUCKET/${base}.env.gpg" --only-show-errors || true
  done
fi

# ─── Done ───────────────────────────────────────────────────────────────
echo ""
echo "✅ Backup complete: $PREFIX"
echo "   bucket = $S3_BUCKET"
echo "   region = $S3_REGION"
echo ""
echo "Current backups in bucket:"
$S3 ls "s3://$S3_BUCKET/" | awk '{printf "   %s  %s  %s\n", $1, $3, $4}'
