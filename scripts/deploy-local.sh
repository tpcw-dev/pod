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

[ -n "$local_commit" ] || git tag -a "$tag" -m "pod $tag"
[ -n "$remote_commit" ] || git push --quiet origin "refs/tags/$tag"

pnpm build >&2
pnpm link --global >&2

printf '{"environment":"local","deployment_id":"%s","deployed_revision":"%s","source_commit":"%s"}\n' \
  "$tag" "$head" "$head"
