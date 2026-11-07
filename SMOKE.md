# Smoke checklist

Run this on the Vercel preview URL for every PR, and on production after every merge.
These must always work. If an agent's change breaks one, the PR does not merge.

1. The homepage loads with no error and no blank sections.
2. `/api/health` returns `{"status":"ok","service":"emergent"}`.
3. Every link and button in the header goes somewhere real (no dead `#` links).

Add a line here whenever a feature ships that must never break.
