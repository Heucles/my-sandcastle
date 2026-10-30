#!/usr/bin/env bash
# Bitbucket helper for Sandcastle's merge phase.
#
# Usage:
#   bitbucket.sh push <branch>              — push branch without persisting the token in the remote
#   bitbucket.sh pr <branch> <title> [dest] — create a PR into <dest> (default development); prints {id, links}
#   bitbucket.sh open-pr <branch>           — print the OPEN PR {id, dest} for a source branch, if any
#   bitbucket.sh comment <pr_id> <text>     — post a comment on a PR
#   bitbucket.sh pr-comments <pr_id>        — list a PR's comments (JSON array; for feedback detection)
set -euo pipefail

# Load credentials from .sandcastle/.env (BB_EMAIL, BB_TOKEN, optional
# BB_WORKSPACE/BB_REPO overrides).
ENV_FILE="$(dirname "${BASH_SOURCE[0]}")/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi
: "${BB_EMAIL:?BB_EMAIL not set — add it to .sandcastle/.env}"
: "${BB_TOKEN:?BB_TOKEN not set — add it to .sandcastle/.env}"

# Derive workspace/slug from origin unless overridden in .env.
origin=$(git remote get-url origin)
path=${origin#*bitbucket.org?}          # strips https://…bitbucket.org/ or git@bitbucket.org:
path=${path%.git}
BB_WORKSPACE=${BB_WORKSPACE:-${path%%/*}}
BB_REPO=${BB_REPO:-${path##*/}}
API="https://api.bitbucket.org/2.0/repositories/${BB_WORKSPACE}/${BB_REPO}"

cmd=${1:?usage: bitbucket.sh <push|pr|comment> ...}
shift

case "$cmd" in
  push)
    branch=${1:?usage: bitbucket.sh push <branch>}
    git push --force "https://x-bitbucket-api-token-auth:${BB_TOKEN}@bitbucket.org/${BB_WORKSPACE}/${BB_REPO}.git" "$branch"
    ;;
  pr)
    branch=${1:?usage: bitbucket.sh pr <branch> <title> [dest]}
    title=${2:?usage: bitbucket.sh pr <branch> <title> [dest]}
    # Optional destination branch — defaults to development. Used to STACK a dependent
    # PR on its in-flight parent branch so the diff is only the increment;
    # Bitbucket auto-retargets the child to development when the parent merges.
    dest=${3:-development}
    jq -n --arg title "$title" --arg branch "$branch" --arg dest "$dest" \
      '{title: $title, source: {branch: {name: $branch}}, destination: {branch: {name: $dest}}, close_source_branch: true}' |
      curl -sf --user "${BB_EMAIL}:${BB_TOKEN}" \
        -X POST "${API}/pullrequests" \
        -H "Content-Type: application/json" \
        --data @- | jq '{id, links: .links.html.href}'
    ;;
  open-pr)
    # Print the OPEN pull request for a source branch (id + destination), or
    # nothing when none is open. Lets the planner/loop tell whether a blocker is
    # still in-flight (stack on it) or already merged (target development).
    branch=${1:?usage: bitbucket.sh open-pr <branch>}
    q="source.branch.name=\"${branch}\" AND state=\"OPEN\""
    curl -sf --user "${BB_EMAIL}:${BB_TOKEN}" -G "${API}/pullrequests" \
      --data-urlencode "q=${q}" --data-urlencode 'fields=values.id,values.destination.branch.name' |
      jq -c '.values[0] // empty | {id, dest: .destination.branch.name}'
    ;;
  pr-comments)
    # List a PR's comments as a JSON array, newest concerns first is not
    # required — the caller (main.mts) filters by created_on. Deleted comments
    # are dropped. `author` is the display name; note it is NOT a reliable
    # agent-vs-human discriminator (the agent comments via the human's token),
    # so the caller keys on a run marker + created_on, not on author.
    pr_id=${1:?usage: bitbucket.sh pr-comments <pr_id>}
    curl -sf --user "${BB_EMAIL}:${BB_TOKEN}" -G "${API}/pullrequests/${pr_id}/comments" \
      --data-urlencode 'pagelen=100' \
      --data-urlencode 'fields=values.id,values.created_on,values.deleted,values.user.display_name,values.parent.id,values.content.raw' |
      jq -c '[.values[] | select(.deleted != true) | {
        id, created_on,
        author: (.user.display_name // ""),
        parent_id: (.parent.id // null),
        text: (.content.raw // "")
      }]'
    ;;
  comment)
    pr_id=${1:?usage: bitbucket.sh comment <pr_id> <text>}
    text=${2:?usage: bitbucket.sh comment <pr_id> <text>}
    jq -n --arg text "$text" '{content: {raw: $text}}' |
      curl -sf --user "${BB_EMAIL}:${BB_TOKEN}" \
        -X POST "${API}/pullrequests/${pr_id}/comments" \
        -H "Content-Type: application/json" \
        --data @-
    ;;
  *)
    echo "unknown command: $cmd (expected push|pr|open-pr|comment|pr-comments)" >&2
    exit 2
    ;;
esac
