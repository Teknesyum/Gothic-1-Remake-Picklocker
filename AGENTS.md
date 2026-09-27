# Gothic 1 LockPicker

Transparent Electron overlay that solves the Gothic 1 lock-pick minigame and can replay the solution as keystrokes.

| Path | What |
|---|---|
| `main.cjs` | Main process: overlay window, click-through polling, global shortcuts, self-update |
| `preload.cjs` | Only IPC bridge; plain CommonJS, check with `node --check preload.cjs` |
| `macro.cjs` | PowerShell `SendInput` keystroke engine and focus guard |
| `src/App.tsx` | Whole renderer UI and screen-template matching |
| `src/LockSolver.ts` | Pure BFS + grouping solver, tested in `src/LockSolver.test.ts` |
| `teknesyum-ui/` | Generated theme tokens; colours, radii, durations come only from here |
| `assets/` | Icon master (`icon.svg`) and generated `.ico`/`.png` |
| `docs/architecture.md` | Design decisions and the bugs they prevent; read before changing main/macro |

Commands: `npm run electron:dev`, `npm run test`, `npm run lint`, `npm run build`, `npm run dist`.

UI changes follow the Teknesyum UI standard: `scan.js` must stay clean for touched files.
Repository text is English. Scratch goes to `tmp/`, finished files to `trash/`.
