# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run electron:dev    # Start Vite dev server + Electron together (via start.js)
npm run dev             # Vite dev server only (renderer at http://127.0.0.1:5173)
npm run build           # tsc -b && vite build (renderer only)
npm run test            # vitest run — LockSolver unit + property tests
npm run lint            # oxlint
npm run preview         # Preview the built renderer
npm run dist            # build + electron-builder --win portable → release/*.exe
npm run dist:installer  # build + electron-builder --win nsis
```

Tests live in `src/LockSolver.test.ts` (vitest, node environment). They cover the solver
only — the Electron/PowerShell layers have no automated coverage.

## Architecture

This is an Electron overlay app for solving the plate/dial lock-picking minigame in Gothic 1. It runs as a transparent, frameless, always-on-top, click-through window layered over the game, and helps the player by computing the shortest sequence of moves and (optionally) auto-executing it as keystrokes.

**Process split:**
- `main.cjs` — Electron main process. Creates the single overlay `BrowserWindow` (transparent, `frame: false`, `skipTaskbar: true`), sized to the primary display's full `bounds` (not `fullscreen: true` — see caveat below), pinned with `setAlwaysOnTop(true, 'screen-saver')`.

**Overlay must not be OS-fullscreen:** the window is a borderless window sized to the screen, not `fullscreen: true`. Windows only lets one real fullscreen surface own the screen at a time, so a second fullscreen window (ours) competing with the game for that slot causes either side to get minimized/demoted intermittently — this is what made the panel appear to silently close. `alwaysOnTop` alone also isn't enough to beat a game's own topmost/exclusive surface; use the `'screen-saver'` level, the highest Electron exposes.

**If the overlay still doesn't render above the game at all:** that's very likely the game running in *exclusive* fullscreen (DirectDraw/Direct3D owns the whole screen buffer directly) rather than fullscreen-*windowed*. No overlay — ours, Discord's, RTSS — can draw on top of a true exclusive-fullscreen surface; this is an OS/GPU limitation, not something fixable from Electron. Gothic 1 has a windowed/borderless toggle in `Gothic.ini` (`zStartupWindowed` under `[ENGINE]`, plus matching the screen resolution) — point the user there if this comes up again.

**Global shortcuts don't need window focus:** `globalShortcut.register` (F9/F10/Ctrl+Space/Alt+Z, Alt+X/F8 for abort) are OS-level hotkeys and fire regardless of which window has focus or whether the game has exclusive input — no alt-tab required to toggle the panel or abort a macro. Mouse click-through (`setIgnoreMouseEvents`) is likewise driven by cursor screen position, not window activation state.
- `preload.cjs` — contextBridge, exposes `window.electronAPI` to the renderer (`getDesktopSourceId`, `setOverlayInteractive`, `setPanelState`, `setTargetingState`, `executeMacro`, `cancelMacro`, `onMacroStep`, `onMacroFocus`, `onMacroFinished`, `onMacroAbort`, `onTogglePanel`). This is the only surface between renderer and main; all IPC channel names are defined here and mirrored by `ipcMain.on/handle` calls in `main.cjs`. **This file is plain CommonJS — Electron does not transpile preload scripts, so TypeScript syntax here silently kills the whole bridge** (`window.electronAPI` becomes `undefined` and every renderer call no-ops through `?.`). `node --check preload.cjs` catches it.
- `macro.cjs` — keystroke engine; builds and runs the PowerShell script (see below).
- `src/App.tsx` — renderer (React). All UI and screen-capture/template-matching logic lives here as one component.
- `src/LockSolver.ts` — pure, Electron-agnostic algorithm module.

**Click-through / hit-testing (main.cjs):** Since the overlay covers the whole screen, `main.cjs` runs a 30ms `setInterval` polling `screen.getCursorScreenPoint()` against the window bounds to decide whether the window should catch mouse events (`setIgnoreMouseEvents`) or pass them through to the game underneath. It catches clicks when the panel is open, when actively targeting a screen region, or when the cursor is over the 100x100 hamburger-button hitbox top-left; otherwise it's click-through. This polling loop is the mechanism that makes the overlay coexist with the game window — don't replace it with pure CSS/DOM pointer-events without preserving this OS-level behavior.

**Screen capture / auto show-hide (App.tsx):** The renderer requests a desktop source id from main (`desktopCapturer` via IPC) and opens a `getUserMedia` stream using the Chrome `desktop` media source. When a target screen region + reference pixel template is set, it polls the video frame once per second, diffs a 50x50 region against the stored template (RGB average diff, threshold 15), and auto-toggles the panel + overlay interactivity based on whether the lock UI is currently on screen.

**Lock solver (`LockSolver.ts`):** The lock is modeled as a vector of plate offsets (`state: number[]`) bounded by `±LIMIT` (4). Each move is a row in `movesMatrix` applied with direction ±1. `findShortestSolution` is a BFS over states to the all-zero goal. Because BFS order doesn't minimize how often the player has to switch move type, `optimizeGrouping`/`searchBest` is a separate DP pass (memoized on `current+remaining+lastType`) that reorders the same multiset of moves to minimize the number of distinct move-type groups, since switching move type is the expensive action in-game. The result is then run-length compressed (`{name, count}`) for display and for macro execution. Both searches are budgeted (`MAX_BFS_STATES`, `MAX_DP_NODES`): the state space is `7^plates`, so an unsolvable 12-plate lock would otherwise hang the UI. Exhausting the BFS budget reports "no solution"; exhausting the DP budget just falls back to the unoptimized (still valid) BFS ordering.

**Macro execution (`macro.cjs`, wired up in `main.cjs`):** `execute-macro` IPC hands the step list to `runMacro`, which generates a PowerShell script, writes it to a temp `.ps1`, and runs it with `-File` (not `-Command` — avoids quoting problems on long scripts). Design constraints, all of which have already bitten this project:

- Gothic 1 reads the keyboard through **DirectInput**, which ignores the window message queue. `SendKeys::SendWait` therefore does nothing in-game. The script instead P/Invokes `SendInput` with `KEYEVENTF_SCANCODE` (set-1 scancodes in `SCANCODES`), which enters the real input stream.
- Each key is an explicit **keydown → hold → keyup** pair. A zero-length press is invisible to an engine that samples input once per frame. `holdTime` and `delay` are both user-tunable in the panel.
- The overlay holds focus when the user clicks "Apply", so the script **re-focuses the game window** first: it finds a process from `DEFAULTS.processNames`, taps ALT (works around the `SetForegroundWindow` foreground-lock rule), then calls `SetForegroundWindow`. It reports `FOCUS:ok|fail|none` on stdout and the panel warns the user on the non-ok cases.
- stdout is parsed **line-by-line with a carry buffer**. A single chunk routinely contains several `STEP:` markers; regex-matching once per chunk drops all but the first.
- A `finally` block releases every mapped scancode, and `cancel-macro` (panel Stop button / `Alt+X` / `F8`) kills the process tree and then runs `releaseAllKeys()` — otherwise an interrupted macro can leave a key stuck down in the game.

**Packaging:** `build.files` in `package.json` is an explicit allowlist ending in `!node_modules/**/*`. Nothing in `dependencies` is needed at runtime (Vite bundles the renderer; `main.cjs` uses only Electron built-ins), and without that exclusion electron-builder pulls the entire production dependency tree into the asar.

**Dev startup (`start.js`):** Not using `concurrently` despite it being a dependency — it manually spawns Vite, waits 2s, then spawns Electron with `NODE_ENV=development`, and on Electron exit force-kills the Vite process tree via `taskkill` (Windows-specific).
