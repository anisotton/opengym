#!/bin/sh
# Runs `npm test` against a throwaway PostgreSQL: starts postgres:17-alpine, waits for it, sets
# TEST_DATABASE_URL so the tests that need a database (db-migrations.test.js, db-boot.test.js —
# see helpers.mjs's provisionTestDatabase) create their own isolated one per file, then always
# tears the container down, whether the tests passed or not. Everything else in the suite runs
# exactly as it does without this script: DATABASE_URL stays unset for those tests, and server.js
# never touches PostgreSQL for them.
#
# Usage: cd api && npm run test:pg   (or: ./scripts/test-with-pg.sh [extra node --test args…])
set -eu

NAME="opengym-test-pg-$$"
IMAGE="postgres:17-alpine"
USER="opengym"
PASS="opengym"
DB="postgres"   # the maintenance database — provisionTestDatabase() CREATEs its own per test file

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

echo "→ starting ephemeral $IMAGE ($NAME)…"
docker run -d --name "$NAME" \
  -e POSTGRES_USER="$USER" -e POSTGRES_PASSWORD="$PASS" -e POSTGRES_DB="$DB" \
  -p 127.0.0.1::5432 \
  "$IMAGE" >/dev/null

PORT=$(docker inspect -f '{{ (index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort }}' "$NAME")

echo "→ waiting for it to accept connections on 127.0.0.1:$PORT…"
i=0
until docker exec "$NAME" pg_isready -U "$USER" -d "$DB" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "postgres never became ready — last logs:" >&2
    docker logs "$NAME" >&2 || true
    exit 1
  fi
  sleep 0.5
done

export TEST_DATABASE_URL="postgresql://$USER:$PASS@127.0.0.1:$PORT/$DB"
echo "→ TEST_DATABASE_URL=$TEST_DATABASE_URL"
echo "→ running tests…"

cd "$(dirname "$0")/.."
node --test test/*.test.js "$@"
