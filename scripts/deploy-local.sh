#!/usr/bin/env bash
set -euo pipefail

refuse() {
  echo "refused: $*" >&2
  exit 1
}

git fetch --quiet origin --tags || refuse "cannot fetch origin"
[ -z "$(git status --porcelain)" ] || refuse "working tree is not clean"
main=$(git rev-parse -q --verify 'refs/remotes/origin/main^{commit}' || true)
[ -n "$main" ] || refuse "origin/main is missing"
head=$(git rev-parse HEAD)
[ "$head" = "$main" ] || refuse "HEAD $head is not origin/main $main"

version=$(node -p 'require("./package.json").version ?? ""')
[ -n "$version" ] || refuse "package.json has no version"
tag="v$version"

local_commit=$(git rev-parse -q --verify "refs/tags/$tag^{commit}" || true)
remote_tags=$(git ls-remote --tags origin "refs/tags/$tag*") || refuse "cannot read tags on origin"
remote_commit=$(awk -v ref="refs/tags/$tag" '
  $2 == ref "^{}" { peeled = $1 }
  $2 == ref { plain = $1 }
  END { print (peeled != "" ? peeled : plain) }
' <<<"$remote_tags")
for commit in "$local_commit" "$remote_commit"; do
  if [ -n "$commit" ] && [ "$commit" != "$head" ]; then
    refuse "tag $tag exists at $commit; bump the version in the story's PR"
  fi
done

global_bin=$(pnpm bin --global 2>/dev/null) || true
[ -n "$global_bin" ] || refuse "pnpm has no global bin directory; set PNPM_HOME and put it on PATH"

db_check='import { databaseUrl, readHostProfile } from "./src/cli/host-profile.ts";
try {
  databaseUrl(readHostProfile());
} catch (error) {
  console.log(error instanceof Error ? error.message : String(error));
  process.exit(1);
}'
reason=$(node --no-warnings --experimental-transform-types --input-type=module -e "$db_check") ||
  refuse "${reason:-cannot load src/cli/host-profile.ts}"

rm -rf .deploy
pnpm build --out-dir .deploy/dist >&2 || refuse "pnpm build failed"
if ! node .deploy/dist/index.js db migrate >&2; then
  echo "refused: db migrate failed" >&2
  exit 1
fi
rm -rf dist && mv .deploy/dist dist && rmdir .deploy || refuse "cannot move the new build into dist"
pnpm link --global >&2 || refuse "pnpm link --global failed"

[ -n "$local_commit" ] || git tag -a "$tag" -m "pod $tag"
[ -n "$remote_commit" ] || git push --quiet origin "refs/tags/$tag" || refuse "cannot push tag $tag"

printf '{"environment":"local","deployment_id":"%s","deployed_revision":"%s","source_commit":"%s"}\n' \
  "$tag" "$head" "$head"
