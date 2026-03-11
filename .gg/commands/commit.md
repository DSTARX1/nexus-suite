---
name: commit
description: Run checks, commit with AI message, and push
---

1. Run quality checks:
   `npx tsc --noEmit` — fix ALL type errors before continuing.
   `npx vitest run --reporter=verbose 2>&1 | tail -30` — fix any test failures.

2. Review changes: run `git status`, `git diff --staged`, and `git diff`.

3. Stage relevant files with `git add` (specific files, not `-A`).

4. Generate a commit message:
   - Start with a verb (Add/Update/Fix/Remove/Refactor)
   - Be specific and concise, one line preferred

5. Commit and push:
   `git commit -m "your generated message"`
   `git push`
