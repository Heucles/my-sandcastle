// Parallel Planner with Review — four-phase orchestration loop
//
// This template drives a multi-phase workflow:
//   Phase 1 (Plan):             An opus agent analyzes open issues, builds a
//                               dependency graph, and outputs a <plan> JSON
//                               listing unblocked issues with branch names.
//   Phase 2 (Execute + Review): For each issue, a sandbox is created via
//                               createSandbox(). The implementer runs first
//                               (100 iterations). If it produces commits, a
//                               reviewer runs in the same sandbox on the same
//                               branch (1 iteration). All issue pipelines run
//                               concurrently via Promise.allSettled().
//   Phase 3 (Merge):            A single agent merges all completed branches
//                               into the current branch.
//
// The outer loop repeats up to MAX_ITERATIONS times so that newly unblocked
// issues are picked up after each round of merges.
//
// Usage:
//   npx tsx .sandcastle/main.mts
// Or add to package.json:
//   "scripts": { "sandcastle": "npx tsx .sandcastle/main.mts" }

import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { z } from "zod";
import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { createAgentSession, SessionManager, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createSandboxTools } from "./sandbox-tools.mjs";

// The planner emits its plan as JSON inside <plan> tags; Output.object extracts
// and validates it against this schema. We use Zod here, but any Standard
// Schema validator works just as well — Valibot, ArkType, etc. See
// https://standardschema.dev.
const planSchema = z.object({
  issues: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      branch: z.string(),
      // The issue's current tracker status, passed through from the planner's
      // `list`. Drives rework mode: an issue already at "In progress" WITH an
      // open PR and human feedback since the last run is resumed on its existing
      // branch (see resolveMode below) instead of started fresh.
      status: z.string().default("Backlog"),
      // "HITL" issues are human-only and Sandcastle ignores them completely — no
      // sandbox/runbook/code/PR and no Notion write at all. The planner should
      // not even emit them; only "AFK" issues go through the pipeline.
      type: z.enum(["AFK", "HITL"]).default("AFK"),
      // Stacked/incremental work: the branch of the in-flight blocker this issue
      // builds on. The issue's branch is FORKED from it and its PR TARGETS it, so
      // the diff is only this issue's increment. null ⇒ independent (fork from and
      // PR to `development`). Bitbucket auto-retargets the child to `development` when the
      // parent merges. See plan-prompt.md.
      parentBranch: z.string().nullable().default(null),
    }),
  ),
});

// The reviewer emits its verdict as JSON inside <review> tags; review-prompt.md
// must instruct the agent to emit <review>{...}</review>. Unlike the planner
// (top-level run(), which supports the `output` option), sandbox.run() has no
// structured-output support, so we extract and validate from stdout ourselves.
const reviewSchema = z.object({
  verdict: z.enum(["approve", "request-changes"]),
  summary: z.string(),
});

function extractReview(stdout: string): z.infer<typeof reviewSchema> {
  const match = stdout.match(/<review>([\s\S]*?)<\/review>/);
  if (!match) {
    throw new Error("Reviewer did not emit a <review> block.");
  }
  // Strip an optional markdown code fence around the JSON.
  const raw = match[1]!.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  return reviewSchema.parse(JSON.parse(raw));
}

function extractPlan(stdout: string): z.infer<typeof planSchema> {
  const match = stdout.match(/<plan>([\s\S]*?)<\/plan>/);
  if (!match) {
    throw new Error("Planner did not emit a <plan> block.");
  }
  // Strip an optional markdown code fence around the JSON.
  const raw = match[1]!.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  return planSchema.parse(JSON.parse(raw));
}

async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  if (limit <= 0) limit = items.length;
  
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let index = 0;
  
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      try {
        const value = await fn(items[i] as T);
        results[i] = { status: "fulfilled", value };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  });
  
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const concurrencyFlag = process.argv.findIndex((arg) => arg === "--concurrency" || arg === "-c");
let CONCURRENCY_LIMIT = 0; // unlimited by default
if (concurrencyFlag !== -1 && process.argv.length > concurrencyFlag + 1) {
  CONCURRENCY_LIMIT = parseInt(process.argv[concurrencyFlag + 1], 10);
  if (isNaN(CONCURRENCY_LIMIT)) CONCURRENCY_LIMIT = 0;
}

// Maximum number of plan→execute→merge cycles before stopping.
// Raise this if your backlog is large; lower it for a quick smoke-test run.
const MAX_ITERATIONS = 10;

// Shared test databases: Postgres (target)
// on the reinvent-dbs network — see docker-compose.dbs.yml. Started here so a
// fresh checkout works with a single command; volumes persist across runs.
execSync("docker compose -f .sandcastle/docker-compose.dbs.yml up -d --wait", {
  stdio: "inherit",
});

// Every sandbox joins the DB network, sees the legacy estate read-only at
// /home/agent/legacy, and gets the DB URLs agents/tests are told to use.
const sandboxConfig = {
  network: "reinvent-dbs",
  mounts: [
    {
      hostPath: "~/current_reinvent",
      sandboxPath: "/home/agent/legacy",
      readonly: true,
    },
  ],
  env: {
    POSTGRES_URL: "postgres://postgres:reinvent-pg@postgres:5432/postgres",
    // `copyToWorktree: ["node_modules"]` seeds the worktree with the host's
    // node_modules, which are a different platform (darwin) than the linux
    // sandbox. pnpm 10 then wants to purge the mismatched modules dir and, with
    // no TTY, aborts (ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY) — which killed
    // the `pnpm install` hook. CI=true makes pnpm purge non-interactively (its
    // own recommended fix), and keeps all tooling in non-interactive mode.
    CI: "true",
  },
} as const;

// Hooks run inside the sandbox before the agent starts each iteration.
// pnpm install ensures the sandbox always has fresh dependencies. The repo is
// a pnpm 10 workspace (see pnpm-workspace.yaml); its libs/* packages use the
// `workspace:*` protocol, which npm cannot resolve — pnpm is the toolchain.
//
// The Docker image pre-fetches the pnpm dependencies into the global store
// during build via `pnpm fetch`. Because the dependencies are already cached in
// the Linux container, this install is extremely fast and happens entirely offline.
const hooks = {
  sandbox: { onSandboxReady: [{ command: "pnpm install", timeoutMs: 120_000 }] },
};

// The planner only READS (issue list via tracker.sh + repo exploration) and runs
// no workspace code — so it skips the pnpm install entirely and starts instantly.
const plannerHooks = {
  sandbox: { onSandboxReady: [] as ReadonlyArray<{ command: string; timeoutMs?: number }> },
};

// ---------------------------------------------------------------------------
// Tracker / Bitbucket helpers + rework-from-feedback support
// ---------------------------------------------------------------------------

const bb = (args: string) =>
  execSync(`bash .sandcastle/bitbucket.sh ${args}`, { stdio: "pipe" }).toString();
const tracker = (args: string) =>
  execSync(`bash .sandcastle/tracker.sh ${args}`, { stdio: "pipe" }).toString();

// Hidden marker the loop appends to every end-of-run comment (on both the PR and
// the Notion issue). It is how a later round tells its own past comments apart
// from a human's review feedback: the agent posts under the human's identity, so
// author cannot discriminate — the marker + created-time can. The newest
// marker-bearing comment's timestamp is "the last agent run"; any comment newer
// than that and WITHOUT the marker is unaddressed human feedback.
const RUN_MARKER = "<!-- sandcastle:run -->";

/** Epoch ms of a branch's latest commit (local or origin/), or 0 if unknown. */
function branchLastCommitMs(branch: string): number {
  for (const ref of [branch, `origin/${branch}`]) {
    try {
      const secs = execSync(`git log -1 --format=%ct ${ref}`, { stdio: "pipe" })
        .toString()
        .trim();
      if (secs) return Number(secs) * 1000;
    } catch {
      /* try next ref */
    }
  }
  return 0;
}

/** Ensure a branch exists locally so createSandbox can resume its worktree. */
function ensureBranchLocal(branch: string): void {
  try {
    execSync(`git rev-parse --verify --quiet ${branch}`, { stdio: "pipe" });
  } catch {
    execSync(`git fetch origin ${branch}:${branch}`, { stdio: "pipe" });
  }
}

/**
 * Collect human review feedback for an in-flight issue: PR comments + Notion
 * comments that are newer than the last agent run (newest RUN_MARKER comment)
 * and do not themselves carry the marker. Returns a bullet list, or "" when
 * there is nothing new to address. Falls back to the branch's last commit time
 * when no marker exists yet (pre-feature PRs).
 */
function gatherFeedback(issueId: string, branch: string, prId: number): string {
  type C = { ms: number; text: string };
  const parse = (raw: string): unknown[] => {
    try {
      return JSON.parse(raw || "[]");
    } catch {
      return [];
    }
  };
  const notion = parse(tracker(`comments ${issueId}`)) as Array<{
    created_time: string;
    text: string;
  }>;
  const prc = parse(bb(`pr-comments ${prId}`)) as Array<{
    created_on: string;
    text: string;
  }>;
  const all: C[] = [
    ...notion.map((c) => ({ ms: Date.parse(c.created_time), text: c.text ?? "" })),
    ...prc.map((c) => ({ ms: Date.parse(c.created_on), text: c.text ?? "" })),
  ].filter((c) => Number.isFinite(c.ms));

  const markerTimes = all.filter((c) => c.text.includes(RUN_MARKER)).map((c) => c.ms);
  const lastRun = markerTimes.length
    ? Math.max(...markerTimes)
    : branchLastCommitMs(branch);

  return all
    .filter((c) => c.ms > lastRun && !c.text.includes(RUN_MARKER))
    .sort((a, b) => a.ms - b.ms)
    .map((c) => `- ${c.text.trim()}`)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const modelRuntime = await ModelRuntime.create();
const model = modelRuntime.getModel("google", "gemini-3.7-flash") || modelRuntime.getModel("anthropic", "claude-3-7-sonnet-20250219");
if (!model) throw new Error("No model found for Pi");

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // -------------------------------------------------------------------------
  // Phase 1: Plan
  //
  // The planning agent (opus, for deeper reasoning) reads the open issue list,
  // builds a dependency graph, and selects the issues that can be worked in
  // parallel right now (i.e., no blocking dependencies on other open issues).
  //
  // It outputs a <plan> JSON block — Output.object parses and validates it.
  // -------------------------------------------------------------------------
  const { session: plannerSession } = await createAgentSession({
    model,
    modelRuntime,
    tools: ["read", "bash"],
    sessionManager: SessionManager.inMemory(),
  });

  const promptContent = await fs.readFile("./.sandcastle/plan-prompt.md", "utf-8");
  await plannerSession.prompt(promptContent);

  const msgs = plannerSession.agent.state.messages;
  const lastMsg = msgs[msgs.length - 1];
  if (lastMsg?.role !== "assistant" || !lastMsg.content) {
    throw new Error("Planner did not return a valid response.");
  }
  const plannerOutput = lastMsg.content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("");

  const plan = { output: extractPlan(plannerOutput) };

  const issues = plan.output.issues;

  if (issues.length === 0) {
    // No unblocked work — either everything is done or everything is blocked.
    console.log("No unblocked issues to work on. Exiting.");
    break;
  }

  // HITL issues are human-only and Sandcastle IGNORES them completely: no
  // sandbox, no runbook, no code, no PR, and — deliberately — no Notion write of
  // any kind (no status change, no comment). The planner is told not to emit
  // them (see plan-prompt.md); this filter is a silent safety net in case one
  // slips through. Only AFK issues go through the pipeline below.
  const hitl = issues.filter((i) => i.type === "HITL");
  if (hitl.length > 0) {
    console.log(
      `  Ignoring ${hitl.length} HITL issue(s) (human-only; no action taken): ${hitl
        .map((i) => i.id)
        .join(", ")}`,
    );
  }

  const workable = issues.filter((i) => i.type !== "HITL");

  if (workable.length === 0) {
    console.log("Only HITL issues this round — ignored (human-only). Re-planning.");
    continue;
  }

  console.log(
    `Planning complete. ${workable.length} AFK issue(s) to work in parallel:`,
  );
  for (const issue of workable) {
    console.log(`  ${issue.id}: ${issue.title} → ${issue.branch}`);
  }

  // Resolve each issue into a concrete work item with a MODE:
  //   - "rework": the issue is already "In progress" with an OPEN PR AND has
  //     human feedback since the last agent run. Resume its existing branch,
  //     feed the feedback to the implementer, and UPDATE the open PR (no new PR).
  //   - "skip":   "In progress" with an open PR but NO new feedback — awaiting
  //     the human's review. Leave it entirely untouched this round.
  //   - "fresh":  everything else (Backlog, or "In progress" with no open PR).
  //     Normal execute → open a NEW PR. Its stacking parentBranch is validated
  //     against the real open PR (see below) and nulled to `development` when stale.
  //
  // parentBranch validation (fresh only): the planner derives parentBranch from
  // Notion status, which goes stale — a folded/merged issue can still read "In
  // PR" while its branch is gone from origin. Using such a phantom branch as the
  // worktree base fails ("not a valid object name") and as the PR dest fails
  // (curl 22). So a parent with no OPEN PR is treated as already-in-`development`.
  type WorkItem = {
    issue: (typeof workable)[number];
    mode: "fresh" | "rework";
    prId: number | null;
    feedback: string;
  };
  const work: WorkItem[] = [];

  for (const issue of workable) {
    let openPr: { id: number; dest: string } | null = null;
    try {
      const raw = bb(`open-pr ${issue.branch}`).trim();
      if (raw) openPr = JSON.parse(raw);
    } catch {
      openPr = null;
    }

    // In-progress issue with an open PR → rework-or-skip based on new feedback.
    if (issue.status === "In progress" && openPr) {
      const feedback = gatherFeedback(issue.id, issue.branch, openPr.id);
      if (!feedback) {
        console.log(
          `  ⏭ ${issue.id}: open PR #${openPr.id}, no new feedback since last run → skipping (awaiting review)`,
        );
        continue;
      }
      try {
        ensureBranchLocal(issue.branch);
      } catch (err) {
        console.error(`  ✗ ${issue.id}: could not fetch branch for rework: ${err}`);
        continue;
      }
      console.log(`  ↻ ${issue.id}: reworking PR #${openPr.id} from human feedback`);
      work.push({ issue, mode: "rework", prId: openPr.id, feedback });
      continue;
    }

    // Fresh work — validate the stacking parent against its real open PR.
    if (issue.parentBranch) {
      let parentPr = "";
      try {
        parentPr = bb(`open-pr ${issue.parentBranch}`).trim();
      } catch {
        parentPr = "";
      }
      if (!parentPr) {
        console.warn(
          `  ⚠ ${issue.id}: parent ${issue.parentBranch} has no open PR → basing on development`,
        );
        issue.parentBranch = null;
      } else {
        try {
          ensureBranchLocal(issue.parentBranch);
        } catch {
          console.warn(
            `  ⚠ ${issue.id}: could not fetch parent ${issue.parentBranch} → basing on development`,
          );
          issue.parentBranch = null;
        }
      }
    }
    work.push({ issue, mode: "fresh", prId: null, feedback: "" });
  }

  if (work.length === 0) {
    console.log("Nothing to execute this round (all skipped or flagged). Re-planning.");
    continue;
  }

  // -------------------------------------------------------------------------
  // Phase 2: Execute + Review
  //
  // For each work item, create a sandbox via createSandbox() so the implementer
  // and reviewer share the same sandbox instance per branch. The implementer
  // runs first; if it produces commits, the reviewer runs in the same sandbox.
  // Rework items resume their existing branch and receive the human feedback.
  //
  // Promise.allSettled means one failing pipeline doesn't cancel the others.
  // -------------------------------------------------------------------------

  const settled = await mapConcurrent(work, CONCURRENCY_LIMIT, async (item) => {
    const { issue } = item;
      const sandbox = await sandcastle.createSandbox({
        branch: issue.branch,
        // Fork incremental work from its in-flight parent so it already contains
        // the prior changes; independent work forks from `development`. Ignored when the
        // branch already exists (a resumed/rework issue keeps its progress).
        baseBranch: issue.parentBranch ?? "development",
        sandbox: docker(sandboxConfig),
        hooks,
      });

      try {
        // Run the implementer
        async function getCommits(): Promise<string[]> {
          const res = await sandbox.exec("git log --format=%H", { cwd: "/home/agent/workspace" });
          if (res.exitCode !== 0) return [];
          return res.stdout.trim().split("\n").filter(Boolean);
        }

        const preImplementCommits = await getCommits();

        const { session: implSession } = await createAgentSession({
          model,
          modelRuntime,
          customTools: createSandboxTools(sandbox),
          sessionManager: SessionManager.inMemory(),
        });

        let implStdout = "";
        
        // Generate a more semantic log file name using the issue title and ID
        const slug = issue.title.replace(/[^a-zA-Z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();
        const logFilePath = `./.sandcastle/logs/${slug}-${issue.id}-implementer.log`;
        await fs.mkdir("./.sandcastle/logs", { recursive: true });
        
        implSession.subscribe((event) => {
          const timestamp = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
          if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
            const chunk = event.assistantMessageEvent.delta;
            implStdout += chunk;
            process.stdout.write(chunk);
            fs.appendFile(logFilePath, chunk).catch(() => {});
          }
          if (event.type === "tool_execution_start") {
            let argsStr = "";
            try { argsStr = JSON.stringify((event as any).toolArgs || (event as any).args || {}); } catch { }
            const msg = `\n[${timestamp}] [Tool Start: ${event.toolName}] Args: ${argsStr}\n`;
            process.stdout.write(msg);
            fs.appendFile(logFilePath, msg).catch(() => {});
          }
          if (event.type === "tool_execution_update") {
            const output = (event as any).output || (event as any).delta || "";
            if (output) {
              process.stdout.write(output);
              fs.appendFile(logFilePath, output).catch(() => {});
            }
          }
          if (event.type === "tool_execution_end") {
            const ev = event as any;
            const status = ev.isError ? "ERROR" : "SUCCESS";
            let outputText = "";
            try {
              const content = ev.result?.content;
              if (Array.isArray(content) && content[0]?.text) {
                outputText = content.map((c: any) => c.text).join("\n");
              } else if (typeof ev.result === "string") {
                outputText = ev.result;
              } else {
                outputText = JSON.stringify(ev.result);
              }
            } catch { }
            const msg = `\n[${timestamp}] [Tool End: ${event.toolName}] Status: ${status}\nOutput:\n${outputText}\n`;
            process.stdout.write(msg);
            fs.appendFile(logFilePath, msg).catch(() => {});
          }
        });

        let implPrompt = await fs.readFile("./.sandcastle/implement-prompt.md", "utf-8");
        implPrompt = implPrompt
          .replace(/\{\{TASK_ID\}\}/g, String(issue.id))
          .replace(/\{\{ISSUE_TITLE\}\}/g, String(issue.title))
          .replace(/\{\{BRANCH\}\}/g, String(issue.branch))
          .replace(/\{\{FEEDBACK\}\}/g, String(item.feedback));

        await implSession.prompt(implPrompt);

        const postImplementCommits = await getCommits();
        const implementCommits = postImplementCommits
          .filter(sha => !preImplementCommits.includes(sha))
          .map(sha => ({ sha }));

        const implement = { commits: implementCommits, stdout: implStdout };

        // Only review if the implementer produced commits
        if (implement.commits.length > 0) {
          const preReviewCommits = await getCommits();

          const { session: reviewSession } = await createAgentSession({
            model,
            modelRuntime,
            customTools: createSandboxTools(sandbox),
            sessionManager: SessionManager.inMemory(),
          });

          let reviewStdout = "";
          const reviewSlug = issue.title.replace(/[^a-zA-Z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").toLowerCase();
          const reviewLogFilePath = `./.sandcastle/logs/${reviewSlug}-${issue.id}-reviewer.log`;
          
          reviewSession.subscribe((event) => {
            const timestamp = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
            if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
              const chunk = event.assistantMessageEvent.delta;
              reviewStdout += chunk;
              process.stdout.write(chunk);
              fs.appendFile(reviewLogFilePath, chunk).catch(() => {});
            }
            if (event.type === "tool_execution_start") {
              let argsStr = "";
              try { argsStr = JSON.stringify((event as any).toolArgs || (event as any).args || {}); } catch { }
              const msg = `\n[${timestamp}] [Tool Start: ${event.toolName}] Args: ${argsStr}\n`;
              process.stdout.write(msg);
              fs.appendFile(reviewLogFilePath, msg).catch(() => {});
            }
            if (event.type === "tool_execution_update") {
              const output = (event as any).output || (event as any).delta || "";
              if (output) {
                process.stdout.write(output);
                fs.appendFile(reviewLogFilePath, output).catch(() => {});
              }
            }
            if (event.type === "tool_execution_end") {
              const ev = event as any;
              const status = ev.isError ? "ERROR" : "SUCCESS";
              let outputText = "";
              try {
                const content = ev.result?.content;
                if (Array.isArray(content) && content[0]?.text) {
                  outputText = content.map((c: any) => c.text).join("\n");
                } else if (typeof ev.result === "string") {
                  outputText = ev.result;
                } else {
                  outputText = JSON.stringify(ev.result);
                }
              } catch { }
              const msg = `\n[${timestamp}] [Tool End: ${event.toolName}] Status: ${status}\nOutput:\n${outputText}\n`;
              process.stdout.write(msg);
              fs.appendFile(reviewLogFilePath, msg).catch(() => {});
            }
          });

          let revPrompt = await fs.readFile("./.sandcastle/review-prompt.md", "utf-8");
          revPrompt = revPrompt.replace(/\{\{BRANCH\}\}/g, String(issue.branch));

          await reviewSession.prompt(revPrompt);

          const postReviewCommits = await getCommits();
          const reviewCommits = postReviewCommits
            .filter(sha => !preReviewCommits.includes(sha))
            .map(sha => ({ sha }));

          return {
            item,
            review: extractReview(reviewStdout),
            commits: [...implement.commits, ...reviewCommits],
          };
        }

        return { item, review: null, commits: implement.commits };

      } finally {
        await sandbox.close();
      }
    });

  // Log any agents that threw (network error, sandbox crash, etc.).
  for (const [i, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      console.error(
        `  ✗ ${work[i]!.issue.id} (${work[i]!.issue.branch}) failed: ${outcome.reason}`,
      );
    }
  }

  // Only pass branches that actually produced commits to the merge phase.
  // An agent that ran successfully but made no commits has nothing to merge.
  const completed = settled
    .flatMap((o) => (o.status === "fulfilled" ? [o.value] : []))
    .filter(
      (v): v is typeof v & { review: NonNullable<(typeof v)["review"]> } =>
        v.commits.length > 0 && v.review !== null,
    );

  console.log(
    `\nExecution complete. ${completed.length} branch(es) with commits:`,
  );
  for (const { item } of completed) {
    console.log(`  ${item.issue.id}: ${item.issue.branch}`);
  }

  if (completed.length === 0) {
    console.log("No commits produced. Nothing to push.");
    continue;
  }

  // -------------------------------------------------------------------------
  // Phase 3: Merge
  //
  // Currently skipped in favor of external manual/CI merging
  // -------------------------------------------------------------------------

  for (const { item, review } of completed) {
    if (review.verdict !== "approve") continue; // gate
    const { issue } = item;
    // Isolate each issue: a failure here (e.g. a PR-create against a stale dest,
    // or a transient API error) must log and move on, never throw out of the
    // process and discard the other issues' approved work.
    // Every end-of-run comment carries RUN_MARKER so the NEXT round can tell the
    // agent's own comments from post-run human feedback (see gatherFeedback).
    try {
      bb(`push ${issue.branch}`);

      let prId: number;
      let prNote: string;
      if (item.mode === "rework") {
        // The PR already exists; pushing the branch updated it. Do NOT open a new
        // one — just comment on the existing PR that the feedback was addressed.
        prId = item.prId!;
        prNote = `Reworked from your feedback.\n${review.summary}`;
        console.log(`  ${issue.id} → updated PR #${prId} (rework)`);
      } else {
        // Fresh work: open a new PR. Stack on the validated in-flight parent
        // (small incremental diff) or target `development`. Bitbucket retargets the
        // child to `development` when the parent merges.
        const dest = issue.parentBranch ?? "development";
        const pr = JSON.parse(
          bb(`pr ${issue.branch} "${issue.id}: ${issue.title}" ${dest}`),
        );
        prId = pr.id;
        prNote = `PR: ${pr.links}\n${review.summary}`;
        console.log(`  ${issue.id} → In PR (#${prId})`);
      }

      bb(`comment ${prId} ${JSON.stringify(`${review.summary}\n\n${RUN_MARKER}`)}`);
      // Move the issue on the tracker (record PR link/summary + the run marker).
      // Only AFK work reaches here — HITL issues are ignored entirely earlier —
      // so this always lands on "In PR" (which must already exist on the Notion
      // Status property — it can't be created via API).
      execSync(
        `bash .sandcastle/tracker.sh status ${issue.id} "In PR" ${JSON.stringify(`${prNote}\n\n${RUN_MARKER}`)}`,
        { stdio: "pipe" },
      );
    } catch (err) {
      console.error(`  ✗ ${issue.id}: failed to open/update PR or tracker: ${err}`);
    }
  }

  console.log("\nApproved branches pushed and PRs opened/updated.");
}


console.log("\nAll done.");
