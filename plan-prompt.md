# ISSUES

Here are the open issues in the repo:

<issues-json>

!`bash .sandcastle/tracker.sh list`

</issues-json>

The list above has already been filtered to issues ready for work.

Here are the **in-flight** issues — already implemented in a prior round, with an OPEN PR not yet
merged to `development` (status `In PR` / `Qualifying`):

<inflight-json>

!`bash .sandcastle/tracker.sh inflight`

</inflight-json>

An in-flight issue's branch still exists and its PR is open, so new work can be **stacked on top of
it**. A blocker that is neither in the open list nor in-flight is already merged into `development`.

# TASK

Analyze the open issues and build a dependency graph. For each issue, determine whether it **blocks** or **is blocked by** any other open issue.

Each issue carries an explicit `blocked_by` array of tracker page ids — this is the authoritative dependency source. An issue is blocked if any of its `blocked_by` ids appears as the `id` of another issue in the open list above. A `blocked_by` id that is NOT in the open list refers to an already-completed (or other-repo) issue and does not block.

On top of the explicit relations, infer *additional* blocking only when:

- B requires code or infrastructure that A introduces
- B and A modify overlapping files or modules, making concurrent work likely to produce merge conflicts
- B's requirements depend on a decision or API shape that A will establish

**Serialize aggressively when work is incremental.** If two workable issues would both touch the same
foundational files/modules (root config, a shared lib, a schema, the same domain), do NOT emit both
this round — pick the one that logically comes first and treat the other as blocked by it. It is
better to run dependent work in ordered rounds (each built on the last) than to race two branches off
the same base and collide. Only emit issues **together** in one round when they are genuinely
independent (disjoint files, no shared decision).

An issue is **unblocked** if it has zero blocking dependencies on **other open (workable) issues** —
in-flight issues (below) do not block it; they are its stacking parents.

Each issue also carries a `type`: `AFK` (normal implementation) or `HITL` (**human-only**). **Do NOT emit `HITL` issues at all** — Sandcastle ignores them completely (no work, and no Notion action of any kind); a human owns them end to end. Simply exclude every `HITL` issue from your output. A `HITL` issue may still appear as another issue's `blocked_by`; treat that dependency the usual way (an unemitted blocker that isn't in-flight is either merged or human-owned), but never put the `HITL` issue itself in the plan. Only emit `AFK` issues, each with `type: "AFK"`.

Also copy each issue's **`status`** through to your output unchanged (e.g. `Backlog`, `In progress`). The loop uses it: an issue already at `In progress` **with an open PR** and human feedback since the last run is *reworked* on its existing branch (its deterministic `sandcastle/{slug}-{id}` name — so keep the naming rule exact), rather than started fresh. You do not decide rework vs fresh; just emit the accurate `status`.

For each unblocked issue, assign a branch name using the exact format `sandcastle/{slug}-{id}`, where:

- `{slug}` is the issue title lowercased, with every run of non-alphanumeric characters replaced by a single hyphen, trimmed of leading/trailing hyphens, and truncated to 40 characters
- `{id}` is the **full** issue id, unmodified — downstream steps parse it back out of the branch name to close the issue in the tracker, so never shorten or reformat it

Apply this rule mechanically — no creative rewording. It must be deterministic so that re-planning the same issue always produces the same branch name and accumulated progress is preserved.

## parentBranch — where each issue stacks

For each emitted issue, set `parentBranch` so its work builds on the latest relevant changes:

- Look at the issue's `blocked_by` ids (and any blocker you inferred above). If a blocker appears in
  the **in-flight** list, the issue depends on work that is implemented but not yet merged to `development`.
  Set `parentBranch` to that blocker's branch, computed with the **same** `sandcastle/{slug}-{id}`
  rule from the in-flight issue's title + id. The issue is forked from and its PR targets that branch,
  so the diff is only its own increment.
- If several blockers are in-flight, pick the one that is itself furthest along the chain (the most
  dependent), so the stack stays linear.
- If no blocker is in-flight (all merged, or none), set `parentBranch` to `null` — the issue forks
  from and targets `development`.

# OUTPUT

Output your plan as a JSON object wrapped in `<plan>` tags:

<plan>
{"issues": [{"id": "721e52a2-27b6-45e2-b5e4-8d934668dea7", "title": "Fix auth bug", "branch": "sandcastle/fix-auth-bug-721e52a2-27b6-45e2-b5e4-8d934668dea7", "type": "AFK", "status": "Backlog", "parentBranch": null}, ...]}
</plan>

Include only unblocked issues. `parentBranch` is the branch of an in-flight blocker to stack on, or `null` to target `development`. If every issue is blocked, include the single highest-priority candidate (the one with the fewest or weakest dependencies).

Always emit the `<plan>` tags, even when there is nothing to do. If there are no issues to work on at all, output `<plan>{"issues": []}</plan>` so the run can exit cleanly.
