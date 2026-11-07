# Verifier

The verifier checks that a PR does what its issue asked, and nothing it shouldn't.
It sits after CI and before human review. It is advisory: it posts a comment, it does not block merges.

## Rule

The verifier must be a **fresh** session that did not write the code.
Give it only the issue, the PR, this repo, and the preview URL. Never the author's chat.

## Writes on previews

Some checks write data, such as booking through the MCP `book` tool. Those may only run on a preview that has **its own database**. A preview without one writes into the production database, so a test booking would land in the real shop's calendar. There's no cancel tool yet to undo it.

To check, open `<PREVIEW_URL>/api/shops/harts/services`:
- **"Hart's Barbers (preview)"** means this preview uses the Preview database, so writes are allowed.
- **Plain "Hart's Barbers"**, or anything else, means it may be production's database. Skip every check that writes, mark them **SKIPPED: preview shares the production database**, and continue with the read-only checks.

Never write to production. The setup is in [database.md → Production and Preview databases](database.md#production-and-preview-databases).

## Prompt

Open a new Claude Code session (or Claude in Chrome for UI checks) and paste:

```
You are the verifier for PR #<PR> in this repo. You did not write it.

1. Read AGENTS.md, SMOKE.md, issue #<ISSUE>, and the PR diff.
2. For each "Done when" item in the issue: open the Vercel preview URL
   <PREVIEW_URL> and check it. Mark PASS or FAIL with what you saw.
3. Run every item in SMOKE.md on the preview. Mark PASS or FAIL.
   Before ANY check that writes data (e.g. the MCP book tool): open
   <PREVIEW_URL>/api/shops/harts/services. Only if the shop name ends
   in "(preview)" may you write. Otherwise mark those checks
   "SKIPPED: preview shares the production database" and do not write.
   Never write to production.
4. Check the diff only touches files the author's agent owns (AGENTS.md table).
5. Check any new API shape is an exported type in lib/types/ and the UI uses it.

Reply with one PR comment:
- Verdict: READY or NOT READY
- A table of every check with PASS/FAIL and evidence
- A short list of anything the human reviewer should look at closely
Do not fix anything yourself.
```

## After the verifier

- NOT READY → paste the comment into the author's session (same Claude session or v0 chat) and let it push a fix to the same branch.
- READY → a human reviews the diff, clicks through the preview, and squash-merges.
