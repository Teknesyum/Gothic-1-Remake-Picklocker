# Gothic 1 LockPicker

A transparent Electron overlay that solves the plate/dial lock-picking mini-game in Gothic 1 (Remake), sitting on top of the game window. You enter each plate's current position and its interaction directions; the app finds the shortest move sequence and, if you want, applies it automatically via WASD keystrokes.

## Installation

Open PowerShell on Windows and run:

```powershell
irm https://raw.githubusercontent.com/Teknesyum/Gothic-1-Remake-Picklocker/master/install.ps1 | iex
```

This requires [Git](https://git-scm.com/downloads) and [Node.js](https://nodejs.org) to be installed. The script downloads the repo into `%LOCALAPPDATA%\Gothic1LockPicker`, installs dependencies, and drops a hidden-running launcher (`Gothic 1 LockPicker.bat`) on your desktop.

The app checks for updates on every launch and asks whether you want to update if a newer version is available.

## Usage

1. Launch it via `Gothic 1 LockPicker.bat` (or press **F9** in-game to open/close the panel).
2. In **1. Starting Positions**, mark each plate's current position.
3. In **2. Interaction Directions**, enter how each move affects the other plates (same direction / reversed).
4. Click **SOLVE** to see a short solution summary, or go straight to **AUTO-SOLVE** to have it applied to the game.

### Shortcuts

| Key | Action |
| --- | --- |
| `F9` / `F10` / `Ctrl+Space` / `Alt+Z` | Toggle the panel |
| `Alt+X` / `F8` | Emergency-stop a running macro |

### Auto Mode & Passive Mode

- **Auto Mode**: once you've picked a reference corner from the lock screen, the app shows the corner button (and the panel, if you open it) whenever that template is detected on screen, and auto-minimizes the panel when it's no longer detected.
- **Passive Mode**: while the panel is minimized, the corner button stays completely hidden and only reappears when the cursor is right over that spot. The only ways to open the panel are `F9` or hovering that corner and clicking.

## Development

```bash
npm install
npm run electron:dev   # Vite dev server + Electron together
npm run test            # LockSolver unit tests (vitest)
npm run lint             # oxlint
npm run dist              # Build a portable .exe (release/)
```

See [`CLAUDE.md`](CLAUDE.md) for architecture details and design decisions.
