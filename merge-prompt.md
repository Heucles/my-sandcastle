# TASK

Merge the following branches into the current branch:

{{BRANCHES}}

For each branch:

1. BEFORE merging, record the branch's commits (you will need this to close its issue later): `git log --format='%h %ad %s' --date=iso $(git branch --show-current)..<branch>`
2. Run `git merge <branch> --no-edit`
3. If there are merge conflicts, resolve them intelligently by reading both sides and choosing the correct resolution
4. After resolving conflicts, run `npm run typecheck` and `npm run test` to verify everything works
5. If tests fail, fix the issues before proceeding to the next branch

After all branches are merged, make a single commit summarizing the merge.

# CLOSE ISSUES

For each branch that was merged, close its issue using the following command, passing the commit log you recorded before merging as the second argument (it is posted as a comment on the issue, documenting what was done and when):

`bash .sandcastle/tracker.sh close <ID> "<recorded commit log>"`

Here are all the issues:

{{ISSUES}}

Once you've merged everything you can, output <promise>COMPLETE</promise>.
