#!/bin/zsh
set -Eeuo pipefail

echo "============================================================"
echo "P6.3 — CREATE HERMES MOBILE IOS REPOSITORY"
echo "============================================================"

SOURCE="$HOME/hermes-agent-ios"
TARGET="$HOME/hermes-mobile-ios"

if [ ! -d "$SOURCE" ]; then
  echo "ERROR=SOURCE_NOT_FOUND"
  exit 1
fi

if [ -d "$TARGET" ]; then
  echo "ERROR=TARGET_ALREADY_EXISTS"
  exit 1
fi

cd "$SOURCE"

echo "=== SOURCE ==="
echo "branch=$(git branch --show-current)"
echo "commit=$(git rev-parse HEAD)"

echo
echo "=== CREATE TARGET ==="

mkdir -p "$TARGET"

echo
echo "=== COPY MOBILE ==="

rsync -av \
apps/mobile/ \
"$TARGET/mobile/"

echo
echo "=== COPY SHARED ==="

mkdir -p "$TARGET/packages"

rsync -av \
apps/shared/ \
"$TARGET/packages/shared/"

echo
echo "=== COPY UI RENDERER ==="

rsync -av \
apps/desktop/src/ \
"$TARGET/packages/ui-renderer/"

cp apps/desktop/package.json \
"$TARGET/packages/ui-renderer-package.json"

cp apps/desktop/vite.config.ts \
"$TARGET/packages/ui-renderer-vite.config.ts"

echo
echo "=== COPY ROOT FILES ==="

cp package.json "$TARGET/"
cp package-lock.json "$TARGET/"

echo
echo "=== COPY DOCUMENTATION ==="

for f in \
MOBILE_BOUNDARY_DECISION.md \
IOS_EVENT_CONTRACT.md \
IOS_REPOSITORY_EXTRACTION_PLAN.md \
MOBILE_UX_SAFE_AREA_FIX.md
do
 if [ -f "$f" ]; then
   cp "$f" "$TARGET/"
 fi
done

echo
echo "=== INIT GIT ==="

cd "$TARGET"

git init
git add .
git commit -m "chore: initialize Hermes Mobile iOS standalone repository"

echo
echo "=== INVENTORY ==="

echo "mobile_files=$(find mobile -type f | wc -l)"
echo "shared_files=$(find packages/shared -type f | wc -l)"
echo "ui_files=$(find packages/ui-renderer -type f | wc -l)"

echo
echo "=== FORBIDDEN CHECK ==="

for item in \
hermes_cli \
gateway \
agent \
electron \
docker \
Dockerfile \
docker-compose.yml
do
 if find . -path "*$item*" | grep -q .; then
   echo "FOUND_FORBIDDEN=$item"
 else
   echo "OK=$item"
 fi
done

echo
echo "============================================================"
echo "CANONICAL STATUS"
echo "============================================================"
echo "block=P6_3_CREATE_HERMES_MOBILE_IOS_REPOSITORY"
echo "gate=PASS"
echo "source_mutation=NONE"
echo "new_repo=$TARGET"
echo "rollback=REMOVE_TARGET_DIRECTORY_ONLY"
echo "next=P6_4_STANDALONE_IOS_BUILD_VALIDATION"
echo "============================================================"
