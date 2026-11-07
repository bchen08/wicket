# How we ship

Agents write code on their own branches. People decide what merges. Vercel deploys whatever is on `main`.

```
Issue (goal + "done when")
   │
   ├─ backend ─▶ Claude Code: branch claude/<issue>-<slug> ─▶ build ─▶ draft PR
   ├─ UI ──────▶ v0: new chat in the emergent project ─▶ iterate ─▶ PR (v0/<slug>)
   └─ both ────▶ split into two issues; Claude's API + types PR merges first
   │
   ▼  every push to a PR branch
CI (lint · typecheck · build)          +  Vercel preview deployment (own URL)
   │
   ├─ red ─▶ paste the failure into the same Claude session / v0 chat ─▶ fix on same branch
   ▼ green
Verifier (fresh session, docs/VERIFIER.md) checks issue + SMOKE.md on the preview
   │
   ├─ NOT READY ─▶ back to the author's session
   ▼ READY
Human review: read the diff, click the preview, approve
   │
   ▼
Squash-merge to main, delete branch
   │
   ▼
Vercel deploys main to production automatically ─▶ run SMOKE.md on production
   │
   └─ broken? ─▶ Vercel "Instant Rollback" first, then a revert PR
```

## What you do after an agent pushes

Nothing, until the PR is green and verified. Pushing never changes the live site.
The only action that ships is a human clicking **Squash and merge** on a PR into `main`.

## Do not use v0's own Publish/Deploy button

Production deploys come only from merges to `main`. That keeps every live change reviewed.
