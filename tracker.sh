#!/usr/bin/env bash
# Notion-backed issue tracker for Sandcastle.
# Tasks are pages in the Notion database below; the "Status" status property
# marks availability: Backlog / In Progress = open, Done = closed.
set -euo pipefail

# Load the token from .sandcastle/.env when not already in the environment.
ENV_FILE="$(dirname "${BASH_SOURCE[0]}")/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi
: "${NOTION_TOKEN:?NOTION_TOKEN not set — add it to .sandcastle/.env}"

DB_ID="722e23a6-1727-4849-ac30-81a017bde78b"
# Only issues assigned to this person (matched against any people property).
ASSIGNEE="Heucles"
# This host repo's name — list only returns issues whose "Repo" select matches,
# so each monorepo's Sandcastle picks its own slice of the shared backlog.
# Set per host repo: node-platform | python-engine | infra.
REPO_NAME="node-platform"
API="https://api.notion.com/v1"
H=(-H "Authorization: Bearer $NOTION_TOKEN" -H "Notion-Version: 2022-06-28" -H "Content-Type: application/json")

# Plain text of a page's content blocks (one line per block).
page_body() {
  curl -sf "$API/blocks/$1/children?page_size=100" "${H[@]}" |
    jq -r '[.results[] | .[.type]? | objects | select(has("rich_text")) | [.rich_text[].plain_text] | join("")] | join("\n")'
}

page_title='[.properties[] | select(.type=="title") | .title[].plain_text] | join("")'

# Accept a bare page id or anything that embeds one (e.g. a Sandcastle branch
# name like sandcastle/fix-auth-bug-<uuid>) and return the trailing UUID.
normalize_id() {
  local raw="$1" id
  id=$(grep -oE '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{32}' <<<"$raw" | tail -1)
  if [ -z "$id" ]; then
    echo "tracker.sh: no page id found in '$raw'" >&2
    return 1
  fi
  echo "$id"
}

case "${1:-}" in
  list)
    jq -n --arg repo "$REPO_NAME" \
      '{filter: {and: [
        {or: [{property: "Status", status: {equals: "Backlog"}},
              {property: "Status", status: {equals: "In progress"}}]},
        {property: "Repo", select: {equals: $repo}}
      ]}}' |
      curl -sf -X POST "$API/databases/$DB_ID/query" "${H[@]}" --data @- |
      jq -c --arg who "$ASSIGNEE" '.results[]
        | select([.properties[] | select(.type=="people") | .people[].name // ""] | any(. | ascii_downcase | contains($who | ascii_downcase)))' |
      jq -c "{id: .id, title: ($page_title), status: .properties.Status.status.name,
              type: (.properties.Type.select.name // \"AFK\"),
              blocked_by: [.properties[\"Blocked by\"].relation[]?.id]}" |
      while IFS= read -r row; do
        id=$(jq -r .id <<<"$row")
        jq --arg body "$(page_body "$id")" '. + {body: $body}' <<<"$row"
      done | jq -s .
    ;;
  inflight)
    # Issues with an OPEN PR not yet merged to main — status "In PR" (AFK) or
    # "Qualifying" (HITL). The planner cross-references a workable issue's
    # blocked_by against these ids to decide its stacked-PR parent branch: a
    # blocker listed here is in-flight (stack on it); one that is absent is
    # already merged (target main). Lightweight — id + title + status only.
    jq -n --arg repo "$REPO_NAME" \
      '{filter: {and: [
        {or: [{property: "Status", status: {equals: "In PR"}},
              {property: "Status", status: {equals: "Qualifying"}}]},
        {property: "Repo", select: {equals: $repo}}
      ]}}' |
      curl -sf -X POST "$API/databases/$DB_ID/query" "${H[@]}" --data @- |
      jq -c --arg who "$ASSIGNEE" '.results[]
        | select([.properties[] | select(.type=="people") | .people[].name // ""] | any(. | ascii_downcase | contains($who | ascii_downcase)))' |
      jq -c "{id: .id, title: ($page_title), status: .properties.Status.status.name}" |
      jq -s .
    ;;
  comments)
    # List a page's comments as a JSON array (id, created_time, discussion_id,
    # text). Used by main.mts to detect human review feedback: comments newer
    # than the last agent run marker and not carrying that marker. Author is not
    # a reliable agent-vs-human discriminator here (API comments are attributed
    # to a user id, not the integration bot), so the caller keys on the marker +
    # created_time, not on author.
    ID=$(normalize_id "${2:?usage: tracker.sh comments <ID>}")
    curl -sf "$API/comments?block_id=$ID&page_size=100" "${H[@]}" |
      jq -c '[.results[] | {
        id,
        created_time,
        discussion_id,
        text: ([.rich_text[].plain_text] | join(""))
      }]'
    ;;
  view)
    ID=$(normalize_id "${2:?usage: tracker.sh view <ID>}")
    curl -sf "$API/pages/$ID" "${H[@]}" |
      jq --arg body "$(page_body "$ID")" \
        "{id: .id, title: ($page_title), status: .properties.Status.status.name, url: .url, body: \$body}"
    ;;
  status)
    # tracker.sh status <ID> <status-name> [comment]
    # Optional comment (e.g. PR link, commit log) is posted on the page before
    # the Status property is updated, so the issue records what happened.
    ID=$(normalize_id "${2:?usage: tracker.sh status <ID> <status-name> [comment]}")
    STATUS="${3:?usage: tracker.sh status <ID> <status-name> [comment]}"
    SUMMARY="${4:-}"
    if [ -n "$SUMMARY" ]; then
      jq -n --arg id "$ID" --arg text "$SUMMARY" \
        '{parent: {page_id: $id}, rich_text: [{text: {content: ($text | .[0:2000])}}]}' |
        curl -sf -X POST "$API/comments" "${H[@]}" --data @- >/dev/null
    fi
    jq -n --arg status "$STATUS" '{properties: {Status: {status: {name: $status}}}}' |
      curl -sf -X PATCH "$API/pages/$ID" "${H[@]}" --data @- |
      jq -r --arg status "$STATUS" '"\($status): " + .id'
    ;;
  close)
    ID="${2:?usage: tracker.sh close <ID> [commit log]}"
    SUMMARY=""
    if [ -n "${3:-}" ]; then
      SUMMARY="Closed by Sandcastle. Commits:"$'\n'"$3"
    fi
    "$0" status "$ID" "Done" "$SUMMARY"
    ;;
  create)
    # tracker.sh create <AFK|HITL> <title> [blocked_by_id]
    # Body is read from stdin: one Notion paragraph block per non-empty line.
    # Repo is fixed to this host repo ($REPO_NAME); Status starts at Backlog;
    # the page is assigned to $ASSIGNEE so it shows up in `list`. The title and
    # people property names + the assignee's user id are discovered from the DB
    # schema at runtime, so nothing is hardcoded.
    TYPE="${2:?usage: tracker.sh create <AFK|HITL> <title> [blocked_by_id]}"
    TITLE="${3:?usage: tracker.sh create <AFK|HITL> <title> [blocked_by_id]}"
    BLOCKED="${4:-}"

    SCHEMA=$(curl -sf "$API/databases/$DB_ID" "${H[@]}")
    TITLE_PROP=$(jq -r '.properties | to_entries[] | select(.value.type=="title") | .key' <<<"$SCHEMA" | head -1)
    PEOPLE_PROP=$(jq -r '.properties | to_entries[] | select(.value.type=="people") | .key' <<<"$SCHEMA" | head -1)
    # Resolve the assignee's user id WITHOUT GET /users: Notion Personal Access
    # Tokens are blocked from that endpoint (403 restricted_resource), so honor an
    # explicit NOTION_ASSIGNEE_ID override, else harvest the id from an existing
    # page already assigned to $ASSIGNEE — the DB-query endpoint returns
    # people[].id, which PATs may read. Empty id => page is created unassigned and
    # won't appear in `list` (which filters by assignee).
    ASSIGNEE_ID="${NOTION_ASSIGNEE_ID:-}"
    if [[ -z "$ASSIGNEE_ID" ]]; then
      ASSIGNEE_ID=$(jq -n '{page_size: 100}' |
        curl -sf -X POST "$API/databases/$DB_ID/query" "${H[@]}" --data @- |
        jq -r --arg who "$ASSIGNEE" \
          '[.results[].properties[]? | select(.type=="people") | .people[]?
            | select((.name // "") | ascii_downcase | contains($who | ascii_downcase)) | .id]
           | first // ""')
    fi

    # One paragraph block per non-empty stdin line (Notion caps rich_text at 2000 chars).
    CHILDREN=$(jq -Rn '[inputs | select(length>0) | {object:"block", type:"paragraph", paragraph:{rich_text:[{type:"text", text:{content: .[0:2000]}}]}}]')

    jq -n \
      --arg db "$DB_ID" --arg titleProp "$TITLE_PROP" --arg title "$TITLE" \
      --arg repo "$REPO_NAME" --arg type "$TYPE" \
      --arg peopleProp "$PEOPLE_PROP" --arg assignee "$ASSIGNEE_ID" \
      --arg blocked "$BLOCKED" --argjson children "$CHILDREN" \
      '{parent: {database_id: $db},
        properties: (
          {($titleProp): {title: [{text: {content: $title}}]},
           "Repo": {select: {name: $repo}},
           "Type": {select: {name: $type}},
           "Status": {status: {name: "Backlog"}}}
          + (if ($assignee != "" and $peopleProp != "") then {($peopleProp): {people: [{id: $assignee}]}} else {} end)
          + (if $blocked != "" then {"Blocked by": {relation: [{id: $blocked}]}} else {} end)
        ),
        children: $children}' |
      curl -sf -X POST "$API/pages" "${H[@]}" --data @- |
      jq -r '"created: " + .id + "\n" + .url'
    ;;
  *)
    echo "usage: tracker.sh {list|inflight|comments <ID>|view <ID>|status <ID> <status-name> [comment]|close <ID> [commit log]|create <AFK|HITL> <title> [blocked_by_id]}" >&2
    exit 1
    ;;
esac
