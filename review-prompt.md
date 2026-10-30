# TASK

Review the code changes on branch `{{BRANCH}}` and improve code clarity, consistency, and maintainability while preserving exact functionality.

# CONTEXT

## Branch diff (summary)

Only the diffstat is inlined — a large branch's full diff can exceed the
context window. Read the actual changes
yourself, path by path, with `git diff {{TARGET_BRANCH}}...{{BRANCH}} -- <path>` (and
`git show {{BRANCH}}:<path>` for full file contents), prioritizing by the stat below. The
branch is checked out in your working tree, so you can also read files directly.

!`git diff --stat {{TARGET_BRANCH}}...{{BRANCH}}`

## Commits on this branch

!`git log {{TARGET_BRANCH}}..{{BRANCH}} --oneline`

# REVIEW PROCESS

1. **Understand the change**: Read the diffstat and commits above to understand the intent, then pull the per-path diffs you need. On large branches, cover every top-level area of the stat (db, api/jobs/workers, domain, config, tests) rather than reading files in stat order until context runs out.

2. **Analyze for improvements**: Look for opportunities to:
   - Reduce unnecessary complexity and nesting
   - Eliminate redundant code and abstractions
   - Improve readability through clear variable and function names
   - Consolidate related logic
   - Remove unnecessary comments that describe obvious code
   - Avoid nested ternary operators - prefer switch statements or if/else chains
   - Choose clarity over brevity - explicit code is often better than overly compact code

3. **Check correctness**:
   - Does the implementation match the intent? Are edge cases handled?
   - Are new/changed behaviours covered by tests?
   - **Verification Proof**: Did the implementer include explicit proof of their verifications (e.g., test output, typecheck output, or realistic E2E results via `verify.sh`) in the issue comment or PR? If there is no proof that the code actually works, request changes.
   - Are there unsafe casts, `any` types, or unchecked assumptions?
   - Does the change introduce injection vulnerabilities, credential leaks, or other security issues?
   - **No fabricated AWS results**: the sandbox has no AWS access. Any AWS-dependent acceptance criterion (deploy, runtime availability, SSM, DMS validation) must be left as a human step noted in the PR/issue comment, never a claimed result. If the diff asserts an AWS outcome as verified, request changes.

4. **Maintain balance**: Avoid over-simplification that could:
   - Reduce code clarity or maintainability
   - Create overly clever solutions that are hard to understand
   - Combine too many concerns into single functions or components
   - Remove helpful abstractions that improve code organization
   - Make the code harder to debug or extend

5. **Apply project standards**: Follow the coding standards defined in @.sandcastle/CODING_STANDARDS.md

6. **Preserve functionality**: Never change what the code does - only how it does it. All original features, outputs, and behaviors must remain intact.

# EXECUTION

If you find improvements to make:

1. Make the changes directly on this branch
2. Run tests and type checking to ensure nothing is broken
3. Commit describing the refinements

Output your verdict as <review>{"verdict": "approve" | "request-changes", "summary": "..."}</review>

If the code is already clean and well-structured, do nothing.

Once complete, output <promise>COMPLETE</promise>.

