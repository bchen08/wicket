# Verifier

The verifier checks that a PR does what its issue asked, and nothing it shouldn't.
It sits after CI and before human review. It is advisory: it posts a comment, it does not block merges.

## Rule

The verifier must be a **fresh** session that did not write the code.
Give it only the issue, the PR, this repo, and the preview URL. Never the author's chat.

## Prompt

Open a new Claude Code session (or Claude in Chrome for UI checks) and paste:

```
You are the verifier for PR #<PR> in this repo. You did not write it.

1. Read AGENTS.md, SMOKE.md, issue #<ISSUE>, and the PR diff.
2. For each "Done when" item in the issue: open the Vercel preview URL
   <PREVIEW_URL> and check it. Mark PASS or FAIL with what you saw.
3. Run every item in SMOKE.md on the preview. Mark PASS or FAIL.
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
