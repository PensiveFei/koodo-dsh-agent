## Problem

What is broken or missing, and how it shows up. If the UI silently does nothing, say so explicitly —
that usually means a failure path with no toast (see `docs/ARCHITECTURE.md` §5).

## Change

What this PR does, and why this approach. Keep one concern per PR.

## Verification

How you checked it. Paste the relevant output:

```
node tests/check.mjs
node tests/hook-test.mjs
# node tests/hook-test.mjs --live   (if you have Koodo + DSH running)
```

- [ ] `node tests/check.mjs` passes (it scans for leaked local paths and validates the plugin format)
- [ ] `node tests/hook-test.mjs` passes
- [ ] Tried it in a real Koodo install (say which Koodo / DSH / Node versions below)

Environment used:

- Koodo:
- DSH:
- Node / OS:
