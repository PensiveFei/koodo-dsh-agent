---
name: Bug report
about: Something in the panel, gateway or launcher does not work
title: "[Bug] "
labels: bug
---

## What happened

A clear description of the problem.

## Where it happens

- [ ] Koodo plugin installation (nothing happens when I confirm / "plugin verification failed")
- [ ] The floating panel (does not appear / no reply / no progress)
- [ ] Selection translate or dictionary
- [ ] The resident launcher (panel disappears, debug port, supervisor)
- [ ] The gateway (`/health`, streaming, model routing)

## To reproduce

1. Koodo version (Settings → About):
2. DSH version:
3. Node version (`node -v`):
4. OS:
5. Installed with `node install.mjs`?  yes / no
6. Launched via `koodo-dsh.cmd`?  yes / no

## Logs

**Koodo renderer console** — this is where silent failures show up:

```
# %APPDATA%\koodo-reader\logs\debug.log  (Windows)
# ~/Library/Logs/koodo-reader/debug.log  (macOS)
```

```
paste the last relevant lines here
```

**Supervisor log** (`<runtime>/supervisor.log`):

```
paste here
```

## Expected behavior

What should have happened instead?
