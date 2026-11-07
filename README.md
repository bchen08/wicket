# emergent

hackathon project.

- **Backend** (`app/api`, `lib`) is written by Claude Code.
- **Frontend** (`components`, pages, styles) is written by v0.
- **Humans** write issues, review PRs, and merge.

Start here:

| File | What it's for |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Rules every agent follows: ownership, branches, contracts, checks |
| [`docs/WORKFLOW.md`](docs/WORKFLOW.md) | How a change goes from issue to production |
| [`docs/VERIFIER.md`](docs/VERIFIER.md) | The independent check between CI and human review |
| [`SMOKE.md`](SMOKE.md) | Things that must always work, checked on every PR |
| [`.github/workflows/ci.yml`](.github/workflows/ci.yml) | Lint, typecheck, and build on every push |

## Run it

```
pnpm install
pnpm dev
```

## Ship a change

1. Open an issue with the **Feature** template. Write "done when" items someone could check.
2. Hand it to Claude Code (backend) or v0 (frontend). The agent works on its own branch and opens a PR.
3. Wait for CI and the Vercel preview. Run the verifier.
4. Review the diff and click through the preview. Squash-merge.
5. Vercel deploys `main` to production. Run `SMOKE.md` on the live site.
