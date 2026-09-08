# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Passive Mode: the corner button stays hidden while the panel is minimized and only reappears when the cursor hovers over it.
- Configurable R-key delay, optional Space press after the lock opens, and persisted settings (timing values included).
- AGPL-3.0-or-later license, DCO 1.1 and CONTRIBUTING guidelines.
- README with installation, usage, shortcuts and mode descriptions (translated to English).

### Changed
- Auto-hide feature renamed to Auto Mode.
- Auto-solve now resets the lock with R before starting; countdown shortened and solution view enlarged.
- Top-left corner button shrunk; its hitbox synchronized with the new size.

### Fixed
- Corner button disappearing completely in Passive Mode.
- False PowerShell error warning after an emergency stop; R wait time extended.
- Edge data lost when decreasing and then increasing the plate count.

## [1.2.0] - 2026-08-09

### Added
- SOLVE and AUTO-SOLVE buttons.
- Auto-hide toggle.
- PowerShell installer (`install.ps1`) and self-update on launch via `git pull`.

## [1.1.0] - 2026-08-08

### Added
- WASD focus guard.
- Solution preview.
- Unit tests and packaging (electron-builder).

### Changed
- Macro engine made DirectInput compatible.

### Fixed
- Mouse click leaking through the overlay.
- Overlay conflicting with the game's fullscreen mode.
- Panel alignment issue and other UI fixes.

## [1.0.0] - 2026-08-08

### Added
- Initial release of Gothic 1 LockPicker: transparent Electron overlay that solves the plate lock-picking mini-game and applies the solution through WASD keystrokes.

[Unreleased]: https://github.com/Teknesyum/Gothic-1-Remake-Picklocker/compare/v1.2...HEAD
[1.2.0]: https://github.com/Teknesyum/Gothic-1-Remake-Picklocker/compare/v1.1...v1.2
[1.1.0]: https://github.com/Teknesyum/Gothic-1-Remake-Picklocker/compare/v1.0...v1.1
[1.0.0]: https://github.com/Teknesyum/Gothic-1-Remake-Picklocker/releases/tag/v1.0
