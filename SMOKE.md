# Smoke checklist

Run this on the Vercel preview URL for every PR, and on production after every merge.
These must always work. If an agent's change breaks one, the PR does not merge.

1. The homepage loads with no error and no blank sections.
2. `/api/health` returns `{"status":"ok","service":"emergent"}`.
3. Every link and button in the header goes somewhere real (no dead `#` links).
4. The page is usable at phone width (about 390px): nothing overflows sideways.
5. The browser console shows no red errors on the homepage.
6. The Schedule section lists sessions from `/api/schedule` in time order (no "couldn't load" error).

Add a line here whenever a feature ships that must never break.
