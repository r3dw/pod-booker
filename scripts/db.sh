#!/usr/bin/env bash
# Run SQL against the Supabase database using SUPABASE_DB_URL from .env.local.
# The URL (which contains the DB password) is never printed.
#
#   scripts/db.sh apply supabase/migrations/<file>.sql   # run a migration (all-or-nothing)
#   scripts/db.sh test                                    # run every file in supabase/tests (rolled back)
#   scripts/db.sh sql "select ..."                        # one-off query
set -euo pipefail
cd "$(dirname "$0")/.."

PSQL="${PSQL:-/opt/homebrew/opt/libpq/bin/psql}"
DBURL="$(grep '^SUPABASE_DB_URL=' .env.local | cut -d= -f2-)"
[ -n "$DBURL" ] || { echo "SUPABASE_DB_URL is not set in .env.local" >&2; exit 1; }

run() { "$PSQL" "$DBURL" -X -v ON_ERROR_STOP=1 "$@" 2>&1 | sed -E 's#postgres(ql)?://[^ ]+#<redacted>#g'; return "${PIPESTATUS[0]}"; }

case "${1:-}" in
  apply) run --single-transaction -q -f "$2" && echo "applied $2" ;;
  test)
    status=0
    for f in supabase/tests/*.sql; do
      echo "== $f"
      run -q -f "$f" | sed -E 's/^psql:[^:]+:[0-9]+: //' | grep -v -e '^$' -e 'WarnSendingBroadcastMessage' || status=1
    done
    exit $status ;;
  sql) run -c "$2" ;;
  *) sed -n '2,8p' "$0"; exit 1 ;;
esac
