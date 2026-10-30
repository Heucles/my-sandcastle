# Coding Standards — node-platform

Loaded by the reviewer agent during code review; the implementer should follow it from the start.

## Style

- JavaScript (not TypeScript) with `jsconfig.json` + `tsc --noEmit` typecheck; JSDoc types on exported functions.
- `standard` lint + prettier — no semicolons, camelCase variables/functions, PascalCase classes.
- Named exports only; no default exports.
- Conventional commits (commitlint); Sandcastle commits keep the `RALPH:` prefix convention.
- SQL: always parameterized (`?`/`$1` bindings). String-built SQL is a review blocker, even in translations.

## Testing

- Test external behavior through a module's public interface — a repository's queries against a real database, an API's contract over HTTP. Never assert SQL strings or private internals.
- A migrated data layer is proven by identical observable behavior on Postgres — passing integration tests plus source-vs-target parity against the live DBs (see `docs/RUNBOOK.md`), not by code inspection or per-issue validation docs.
- Batch jobs: fixture-based input→output tests around the read/compute/write cycle.
- New code needs ≥80% coverage (SonarQube gate); greenfield domains (job-orchestration) are held to the full gate from their first commit.
- Test placement: `{dir}/tests/unit/{filename}.test.js` and `{dir}/tests/integration/{filename}.test.js`.

## Architecture / Design Premises

- **Deep modules:** simple, stable interfaces hiding powerful implementations. The exemplar is the shared connection manager — Postgres support goes *behind* the existing interface, selected by config; consumers change nothing.
- **Domain-first boundaries:** a domain owns exactly one Postgres schema; its migrations and repositories live once, in the domain folder holding its API. Cross-schema access is policy-forbidden (ADR-recorded exceptions only).
- **Repository pattern:** all SQL lives in `db/repositories`; handlers and services never embed queries.
- **Layer template per domain:** `api / jobs / workers / domain / db (migrations + repositories) / contracts`. Business logic in `domain`, transport in `api`, side effects at the edges.
- **Config over API change:** dialect flips, endpoint switches, and feature cuts are configuration, not new interfaces.
- **Translate 1:1, don't redesign:** migration waves port SQL and behavior faithfully (backticks→quotes, upsert syntax, date functions). Architectural rewrites are out of scope unless the issue says otherwise.
- **No new shared-library publishing:** shared code is a workspace package consumed by path — a fix reaches every consumer on the next build.
