# Safelight Batch Tools

Batch editing panel for [Safelight](https://github.com/anthonyreimche/SafeLight). Adds a **Batch** panel (Library module, right rail; also available from the View menu in Develop).

## Features

**Sync settings** — copies the active photo's develop settings to every other selected photo. Choose which parameter groups to copy (basic tone, white balance, tone curve, HSL, color grading, detail, lens corrections, effects, crop/transform, masks, heal/clone). Each target gets its own undoable history entry.

**Relative adjustment** — nudge one parameter (exposure, contrast, temperature, …) by a delta on all selected photos, clamped to valid ranges. Existing edits are preserved.

**Reset selected** — resets all selected photos to original (undoable per photo).

## Settings (⚙ in the Extensions panel)

| Setting | Default | Effect |
|---|---|---|
| Sync mode | merge | *Merge* overwrites only checked groups; *replace* copies the entire recipe |
| Geometry safety | on | Skips crop/transform/masks/heal on targets whose pixel dimensions differ from the source |
| Confirm when syncing more than | 10 | Confirmation prompt threshold (0 = off) |
| History label | "Batch sync" | Label written into each photo's edit history |
| Remember group selection | on | Persists the group checkboxes across sessions |
| Show relative adjustments | on | Toggles the panel section |

## Install

Extensions panel → enter `owner/safelight-batch-tools` (or the repo URL).

## Build

```
npm install
npm run build   # src/index.jsx → dist/index.js (committed)
```

React is taken from `api.react` at activate time and is not bundled. UI uses inline styles on Safelight's CSS variables, so it follows every theme and doesn't depend on the app's compiled Tailwind classes.

## Notes

- The sync engine drives the develop store (`loadEdit → commitEdit`) per photo, so persistence, undo history and cross-window broadcast behave exactly like manual edits. The original develop session is restored when the batch finishes.
- Grid thumbnails refresh from the persisted edit state the next time they re-render; an immediate refresh hook isn't exposed by the v1 API.
