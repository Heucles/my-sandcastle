# TASK

Fix issue {{TASK_ID}}: {{ISSUE_TITLE}}

Pull in the issue using `bash .sandcastle/tracker.sh view {{TASK_ID}}`. If it has a parent PRD, pull that in too.

Only work on the issue specified.

Work on branch {{BRANCH}}. Make commits and run tests. This branch has already been forked from the
**latest** base — either `main` or, when this issue builds on earlier work that is still in an open
PR, that parent branch — so the prior changes are already present in your working tree. Build on what
is here; do not re-create scaffolding, shared libs, or config that already exists. Its PR is opened
against that same base, so keep your diff to this issue's own increment.

# REWORK (human feedback)

<feedback>
{{FEEDBACK}}
</feedback>

If the `<feedback>` block above is **non-empty**, this is a **rework**, not a fresh start: this branch
already has an open PR and the human has requested the changes listed above. Your job is to **address
exactly that feedback** — nothing more. The prior implementation is already committed on this branch;
read it, apply the requested adjustments, keep the diff minimal and scoped to what was asked, and do
NOT re-scaffold, broaden scope, or redo already-approved work. Commit; pushing updates the **same**
open PR (no new PR is opened). If the feedback is unclear or you disagree, leave a comment on the issue
explaining, and make the smallest reasonable change.

If the `<feedback>` block is empty (or shows only `{{FEEDBACK}}`), ignore this section — it is normal
fresh work.

# ENVIRONMENT

- **Databases:** `POSTGRES_URL` points at the migration **target** Postgres; create your own database/schema named `issue_<num>` for this issue's work. It persists across runs — schemas migrated by earlier issues are already there.
- **External API Mocking (WireMock):** The sandbox runs a WireMock instance (`http://wiremock:8080`) to mock inter-service HTTP calls (e.g., `context-personal`, external providers). When writing realistic tests, you MUST configure the test to point its HTTP clients at the WireMock URL. You can seed mock responses dynamically within your tests using the WireMock Admin API (`POST http://wiremock:8080/__admin/mappings`), or by writing JSON stub files directly to `.sandcastle/wiremock/mappings/`.
- **No AWS access:** this sandbox has no AWS credentials, deliberately. When acceptance criteria require AWS (deploys, Lambda runtime availability, SSM, DMS validation), do NOT attempt it and NEVER fabricate a result. Capture the exact commands/console steps and expected evidence in your issue comment for a human to run while the PR is open. Do NOT create per-issue AWS-checklist docs.

# HITL ISSUES

You will never be dispatched on a `HITL` issue — those are **human-only** and Sandcastle ignores them
completely: the planner does not emit them and the loop takes no action on them at all (no sandbox, no
runbook, no code, no PR, no tracker update). If you somehow find yourself on one, do nothing and stop.
Only `AFK` issues reach you.

# CONTEXT

Here are the last 10 commits:

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

# EXPLORATION

Explore the repo and fill your context window with relevant information that will allow you to complete the task.

Pay extra attention to test files that touch the relevant parts of the code.

**Read `docs/adr/0001-platform-conventions.md` first — it is binding.** In particular:
- Shared code lives in `libs/*`; domains under `domains/*`. There is no `packages/*`.
- Use `@reinvent-finance/commons`' `SqlConnectionManager` for ALL database access (dual-dialect,
  `DATABASE_DIALECT`-selected). Do NOT add a per-domain `db/pool.js` or `connectionManager.js`.
- When you IMPORT a library into `libs/*`, rewrite its `README.md` to monorepo reality: it is a
  `workspace:*` dependency, not a published package — strip "install as a library" (`pnpm add @…`),
  registry/publish, per-lib `husky init`, CI-badge, and "launch new version" instructions, and fix
  legacy file-path examples. Keep the real API/usage docs.

# EXECUTION

If applicable, use RGR to complete the task.

1. RED: write one test
2. GREEN: write the implementation to pass that test
3. REPEAT until done
4. REFACTOR the code

# FEEDBACK LOOPS

Before committing, run `npm run typecheck`, `npm run test`, and the realism verification script `bash .sandcastle/verify.sh` (if available) to ensure the code works in a full environment.
**CRITICAL:** You must capture the output of these verification commands (tests, typechecks, and the `verify.sh` results) and save them to include in your final issue comment as proof that your work is verified.

# COMMIT

Make a git commit. A husky `commit-msg` hook enforces **Conventional Commits** (commitlint), and a
`pre-commit` hook runs lint-staged — do NOT bypass them with `--no-verify`. The commit message must:

1. Use a Conventional Commits **subject**: `type(scope): subject` — e.g.
   `feat(job-orchestration): add run repository`, `chore(libs/commons): fold dual-dialect manager`.
   Allowed types: build, chore, ci, docs, feat, fix, perf, refactor, revert, style, test.
2. In the **body** (after a blank line): a `RALPH:` marker line, the task completed + PRD reference,
   key decisions made, files changed, and any blockers/notes for the next iteration.

Keep it concise. (The old `RALPH:`-prefixed subject is retired — it fails commitlint.)

# THE ISSUE

If the task is not complete, leave a comment on the issue with what was done and what is blocking.

Once complete, leave a final comment on the issue. **This comment MUST include the proof of your verifications** (e.g., the terminal output showing `npm run test`, `npm run typecheck`, and `bash .sandcastle/verify.sh` passing) so the human reviewer can see that the code actually works in the realistic sandbox.

Do NOT run `bash .sandcastle/tracker.sh close`. The issue must remain open so the orchestration script can automatically move it to "In PR" later. Your only job is to commit the code and output <promise>COMPLETE</promise>.

Once complete, output <promise>COMPLETE</promise>.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.
