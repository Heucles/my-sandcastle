# Sandcastle Orchestration Harness

Sandcastle is an automated agent loop designed to pick up migration tasks (issues) and execute them sequentially or in parallel using AI agents.

## Architecture

The orchestration script (`main.mts`) is driven by the **Pi SDK** (`@earendil-works/pi-coding-agent`), executing in three distinct phases:

### Phase 1: Plan
The planner agent reads the issue tracker (Notion, via `tracker.sh`) and the local workspace to build a dependency graph of open issues.
- **Agent**: Pi (`claude-3-7-sonnet-20250219` or fallback)
- **Tools**: Standard host tools (`read`, `bash`)
- **Output**: A JSON block indicating which AFK issues are unblocked and ready to be worked on.

### Phase 2: Execute & Review
For each unblocked issue, a **Docker sandbox** is created. The sandbox mounts the legacy codebase as read-only and connects to the `reinvent-dbs` database network (Postgres target). The spawned Docker container will have the tag of the task (the issue's branch or ID) attached to its name for easy identification.

**How Sandboxing Works with Pi:**
Even though the Pi Agent session itself runs on the host machine, it is completely restricted to the sandbox. All file reads, writes, and terminal commands are executed by routing them through Sandcastle's `sandbox.exec()` API. The agent cannot touch the host filesystem directly; it operates entirely inside the isolated container.

1. **Implementer**: An agent session is started to work on the issue.
   - **Tools**: Custom `sandbox_*` tools (`sandbox_bash`, `sandbox_read`, `sandbox_write`, `sandbox_edit`) defined in `sandbox-tools.mts`. These tools execute commands *inside* the Docker container.
   - **Output**: Commits to the issue's branch.
2. **Reviewer**: If the implementer produces commits, a second agent session runs in the same sandbox to review the diff against the coding standards and the issue spec.
   - **Output**: An approval or request for changes.

### Phase 3: Merge
*(Currently skipped in favor of external manual/CI merging)*
Historically, this phase merged approved branches back to `main`.

## Differences from Matt Pocock's Original Sandcastle

This repository uses a customized version of Sandcastle with several key differences from the original `@ai-hero/sandcastle` implementation:

1. **Pi SDK Integration**: Instead of using Sandcastle's built-in agent drivers (e.g., `sandcastle.claudeCode`), this version orchestrates the agents using the `@earendil-works/pi-coding-agent` (Pi) SDK natively.
2. **Custom Docker Tools**: Because Pi handles its own tool execution, we wrap Sandcastle's `sandbox.exec()` API in custom Pi tools (`sandbox_bash`, `sandbox_read`, `sandbox_write`, `sandbox_edit`) to ensure the agent interacts exclusively with the isolated container.
3. **Model Selection**: The default model is `gemini-3.7-flash` (with Anthropic fallbacks), whereas the original defaults to Claude Opus/Sonnet.
4. **Structured Output Extraction**: The original relies on `sandcastle.Output.object` to enforce Zod schemas on the `<plan>` blocks. Since Pi doesn't have a 1:1 equivalent yet, this version uses manual Regex and `JSON.parse` extraction in `main.mts`.
5. **Merge Phase**: The final auto-merge phase (Phase 3) is deliberately disabled here to allow for manual human review and CI/CD validation before branches are merged to `main`.

## Running Sandcastle

```bash
npm run sandcastle
# or
npx tsx .sandcastle/main.mts
```

## Legacy Databases
The sandbox attaches to the `reinvent-dbs` network. The migration target is Postgres (`POSTGRES_URL`). The legacy MySQL database requirement has been deprecated and removed from the automated loop.

## Custom Docker Image & Pre-fetched Dependencies

To dramatically speed up the sandbox startup time, we don't copy your host machine's `node_modules` into the container. Instead, the Docker image pre-fetches the dependencies into the Linux `pnpm` global cache during the build phase (`pnpm fetch`). 

When Sandcastle spins up a new container, the sandbox hook simply runs `pnpm install`, which unpacks the pre-downloaded Linux binaries instantly and completely offline.

Because the `Dockerfile` needs to copy the `pnpm-lock.yaml` from the root of your repository to build this cache, you **must build the image from the repository root**, rather than using the default Sandcastle CLI command.

To rebuild the image (e.g., after modifying your dependencies):
```bash
docker build --build-arg AGENT_UID=$(id -u) --build-arg AGENT_GID=$(id -g) -t sandcastle:node-platform -f .sandcastle/Dockerfile .
```