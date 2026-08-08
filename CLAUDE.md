# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run electron:dev   # Start Vite dev server + Electron together (via start.js)
npm run dev             # Vite dev server only (renderer at http://127.0.0.1:5173)
npm run build           # tsc -b && vite build (renderer only; no electron-builder packaging script yet)
npm run lint             # oxlint
npm run preview          # Preview the built renderer
```

There is no test suite in this repo.

## Architecture

This is an Electron overlay app for solving the plate/dial lock-picking minigame in Gothic 1. It runs as a transparent, frameless, always-on-top, click-through window layered over the game, and helps the player by computing the shortest sequence of moves and (optionally) auto-executing it as keystrokes.

**Process split:**
- `main.cjs` — Electron main process. Creates the single fullscreen overlay `BrowserWindow` (transparent, `frame: false`, `skipTaskbar: true`).
- `preload.cjs` — contextBridge, exposes `window.electronAPI` to the renderer (`getDesktopSourceId`, `setOverlayInteractive`, `setPanelState`, `setTargetingState`, `executeMacro`, `onMacroStep`, `onMacroFinished`, `onTogglePanel`). This is the only surface between renderer and main; all IPC channel names are defined here and mirrored by `ipcMain.on/handle` calls in `main.cjs`.
- `src/App.tsx` — renderer (React). All UI and screen-capture/template-matching logic lives here as one component.
- `src/LockSolver.ts` — pure, Electron-agnostic algorithm module.

**Click-through / hit-testing (main.cjs):** Since the overlay covers the whole screen, `main.cjs` runs a 30ms `setInterval` polling `screen.getCursorScreenPoint()` against the window bounds to decide whether the window should catch mouse events (`setIgnoreMouseEvents`) or pass them through to the game underneath. It catches clicks when the panel is open, when actively targeting a screen region, or when the cursor is over the 100x100 hamburger-button hitbox top-left; otherwise it's click-through. This polling loop is the mechanism that makes the overlay coexist with the game window — don't replace it with pure CSS/DOM pointer-events without preserving this OS-level behavior.

**Screen capture / auto show-hide (App.tsx):** The renderer requests a desktop source id from main (`desktopCapturer` via IPC) and opens a `getUserMedia` stream using the Chrome `desktop` media source. When a target screen region + reference pixel template is set, it polls the video frame once per second, diffs a 50x50 region against the stored template (RGB average diff, threshold 15), and auto-toggles the panel + overlay interactivity based on whether the lock UI is currently on screen.

**Lock solver (`LockSolver.ts`):** The lock is modeled as a vector of plate offsets (`state: number[]`) bounded by `±LIMIT` (4). Each move is a row in `movesMatrix` applied with direction ±1. `findShortestSolution` is a BFS over states to the all-zero goal. Because BFS order doesn't minimize how often the player has to switch move type, `optimizeGrouping`/`searchBest` is a separate DP pass (memoized on `current+remaining+lastType`) that reorders the same multiset of moves to minimize the number of distinct move-type groups, since switching move type is the expensive action in-game. The result is then run-length compressed (`{name, count}`) for display and for macro execution.

**Macro execution (main.cjs):** `execute-macro` IPC builds a PowerShell script using `System.Windows.Forms.SendKeys` and spawns it via `child_process.spawn('powershell.exe', ...)`, streaming `STEP:<n>` markers back over stdout to drive the renderer's step-by-step progress UI.

**Dev startup (`start.js`):** Not using `concurrently` despite it being a dependency — it manually spawns Vite, waits 2s, then spawns Electron with `NODE_ENV=development`, and on Electron exit force-kills the Vite process tree via `taskkill` (Windows-specific).
