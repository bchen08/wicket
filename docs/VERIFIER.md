# Verifier

The verifier checks that a PR does what its issue asked, and nothing it shouldn't.
It sits after CI and before human review. It is advisory: it posts a comment, it does not block merges.

## Rule

The verifier must be a **fresh** session that did not write the code.
Give it only the issue, the PR, this repo, the preview URL and the bypass secret. Never the author's chat.

## Step 0: `pnpm smoke`

From a checkout of the PR branch, on any computer with Node and pnpm:

```bash
pnpm smoke <PREVIEW_URL> --commit <PR head sha> --bypass <secret>
```

- `<PR head sha>`: the PR's latest commit, e.g. `gh pr view <PR> --json headRefOid -q .headRefOid`.
- `<secret>`: the Vercel Protection Bypass for Automation secret (deployments see it as `VERCEL_AUTOMATION_BYPASS_SECRET`). Get it from a teammate. Never paste it into a PR comment.

It reads `<PREVIEW_URL>/api/status`, runs every **[smoke]** item in [SMOKE.md](../SMOKE.md), and prints a table of PASS / FAIL / SKIPPED with evidence. Its last line is the verdict:

- **`BLOCKED: …`** (exit 2): the environment isn't ready. For example, Vercel hasn't deployed the PR's head commit yet, the Preview database is on an older schema, or a variable is missing. **It is not a code failure.** Report the problems verbatim and stop. Whoever owns the environment fixes it (each problem says what to fix and where), then the verifier runs again.
- **`FAIL: …`** (exit 1): a check failed. The PR is NOT READY; the failing rows are the evidence.
- **`PASS: …`** (exit 0): carry on. Any SKIPPED rows still need a human.

## Writes on previews

Some checks write data, such as booking through the MCP `book` tool. Those may only run where `/api/status` shows `"writesAllowed": true`:

- On a preview, that means it uses the **Preview database** (its shop is named "Hart's Barbers (preview)"). A preview on any other database is BLOCKED, because it might be production's.
- In production it is always `false`. Never write to production.

`pnpm smoke` checks this itself, and declines every booking it makes. Before any write you make by hand (approving a booking in step 2, for example), open `<PREVIEW_URL>/api/status` yourself; if `writesAllowed` is `false`, mark that check **SKIPPED: writes not allowed here** and don't write.

The Preview database is shared by every PR and rebuilt by the most recent PR that changed `supabase/`. See [database.md → The Preview database keeps itself current](database.md#the-preview-database-keeps-itself-current).

## Then: in a browser

In a browser signed in to the team's Vercel account:

1. Each "Done when" item in the issue.
2. The **[browser]** items in SMOKE.md: the page checks, such as unlocking `/console` with the Preview access code `harts-preview`, and the approval page (`/approve/not-a-real-token`, and a real link from a booking you make through an MCP client).

## Prompt

Open a new Claude Code session (or Claude in Chrome for UI checks) and paste:

```
You are the verifier for PR #<PR> in this repo. You did not write it.

0. From a checkout of the PR branch, run:
     pnpm smoke <PREVIEW_URL> --commit <PR head sha> --bypass <secret>
   If its last line starts with "BLOCKED", the environment isn't ready.
   That is not a code failure: reply with one PR comment, "Verdict: BLOCKED
   (environment not ready)" followed by the BLOCKED line verbatim, and stop.
   Otherwise keep its table for your report.

Rule for every step below: before ANY check that writes data (e.g. the
MCP book tool, or tapping Approve), open <PREVIEW_URL>/api/status. Only if
database.writesAllowed is true may you write. Otherwise mark those checks
"SKIPPED: writes not allowed here" and do not write. Never write to production.

1. Read AGENTS.md, SMOKE.md, issue #<ISSUE>, and the PR diff.
2. For each "Done when" item in the issue: check it on <PREVIEW_URL> in a
   browser signed in to Vercel. Mark PASS, FAIL or SKIPPED with what you saw.
3. Run the SMOKE.md items marked [browser] on the preview (unlock /console
   with harts-preview; the approval page). The [smoke] items are step 0's.
   Mark PASS, FAIL or SKIPPED.
4. Check the diff only touches files the author's agent owns (AGENTS.md table).
5. Check any new API shape is an exported type in lib/types/ and the UI uses it.

Reply with one PR comment:
- Verdict: READY or NOT READY. If any check is SKIPPED, say how many
  in the verdict line, e.g. "READY, 2 checks skipped". A skipped check
  is not a pass.
- A table of every check (pnpm smoke's rows, then yours) with
  PASS/FAIL/SKIPPED and evidence
- A short list of anything the human reviewer should look at closely,
  starting with every SKIPPED check: a human must verify those
Do not fix anything yourself. Never paste the bypass secret into the comment.
```

## After the verifier

- BLOCKED → fix the environment, not the code: the problems say what (often: re-run **Actions → Preview database → Run workflow** on the PR's branch, set a variable in Vercel, or wait for the deployment). Then run the verifier again.
- NOT READY → paste the comment into the author's session (same Claude session or v0 chat) and let it push a fix to the same branch.
- READY → a human reviews the diff, clicks through the preview, and squash-merges.
- READY with skipped checks → before merging, a human verifies each skipped check. Either fix the environment so `/api/status` shows `writesAllowed: true` and run the check there, or run it locally (see [frontdesk-api.md → Try the full loop](frontdesk-api.md#try-the-full-loop)).
