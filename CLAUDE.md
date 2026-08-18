# copyedit-ai-obsidian - notes for Claude

This is a **standalone Obsidian plugin repo** extracted from the
parent copyedit-ai project on 2026-05-16. The plugin lives here so it
can be tracked, published to Obsidian's community plugin gallery, and
versioned independently of the model-training repo at
`../copyedit-ai/`.

## Contract summary

- Plugin id: `copyedit-ai-review`
- User-facing name: "Copyedit AI - Review Edition (WIP)"
- Talks to the local shim at `http://127.0.0.1:8765/edit` (configurable
  in settings). The shim is at `../copyedit-ai/src/copyedit/serve/server.py`
  in the parent repo and is the source of truth for the editor/critic
  prompts.
- Request: `POST /edit {"passage": str, "user_rules": str, "keep_spelling": bool}`
  (`keep_spelling` default true: the shim drops British/Canadian <-> American
  spelling-variant suggestions; dash-style swaps are always dropped - both
  deterministic rules from `copyedit.change_types`, added 2026-08-17/18).
- Response: `{"suggestions": [{"original_text", "proposed_replacement",
  "category", "rationale"}], "timings": {...}}`.

The shim is NOT part of this repo. Users running the plugin against
their own backend can swap the endpoint in the settings tab.

## How it works

1. User runs "Suggest edits on selection" / "...on current paragraph" /
   "...on whole note" from the command palette or the editor right-click
   menu.
2. The text is POSTed to the shim. For whole-note, the plugin splits on
   blank lines and sequences paragraph-sized requests; suggestions
   accumulate in the panel as each finishes.
3. Returned suggestions are pushed into `this.suggestions` (in-memory
   array on the plugin instance), each tagged with the source file
   path.
4. The side panel (a custom `ItemView`) is activated and re-rendered.
   Each suggestion is a card with Accept / Reject / Reveal.
5. Accept calls `applyToFile(sug)`:
   - If the source file is currently open in a markdown leaf, use
     `editor.replaceRange` so Ctrl/Cmd-Z reverts cleanly.
   - Otherwise read via `vault.read`, splice with the replacement,
     write via `vault.modify`. No editor undo step.
6. Reject splices the card out of `this.suggestions`.
7. Reveal opens (or focuses) the source file and scrolls to the located
   span.

Span location uses `fuzzyFind` in `main.js` - a whitespace-flexible
regex match. Handles LLM whitespace normalization; does not handle
paraphrased quotes.

## What NOT to add yet

- **Persistence across Obsidian restart.** In-memory only is the MVP
  contract.
- **Word-level inline diff.** The colored Original/Suggested rows are
  the agreed visualization for v0.
- **Multi-vault sync.**
- **A dedicated undo stack** beyond what the editor/vault provide.
- **Real-time edit-as-you-type triggers.** This is a deliberate "edit
  pass" verb, not Grammarly-style red-underline (the ~25 s latency
  rules that out).

## Known limitations

- **Stale spans.** A suggestion captured at time T may be impossible to
  apply at time T+n if the user has edited or moved the span. Accept
  fails silently with a Notice; the card stays in the panel so the
  user can re-decide.
- **Overlapping suggestions.** Accepting the first of two overlapping
  cards invalidates the second.
- **Vault-level accept undo.** When the file is NOT open at accept
  time, the change is written via `vault.modify` and is not in any
  editor's undo stack.

## Files

- `manifest.json` - plugin manifest (id: `copyedit-ai-review`)
- `main.js` - all logic; vanilla JS, no build
- `styles.css` - side panel card styling; auto-loaded by Obsidian
- `versions.json` - Obsidian convention: plugin version -> min Obsidian version
- `LICENSE` - Apache 2.0 (matches the parent copyedit-ai project)
- `README.md` - end-user install + use
- `CLAUDE.md` - this file

## Deploy to a vault

Source of truth for development: this directory.
Deployed copy in the user's writing vault:
`"/home/hq/Documents/Writing/Scum & Villainy/Scum & Villainy Notes/.obsidian/plugins/copyedit-ai-review/"`

After editing `main.js`, `styles.css`, or `manifest.json` here, copy
the three plugin files into the vault deploy directory. Reload the
plugin in Obsidian (Settings -> Community plugins -> toggle off and
on) to pick up the change. `README.md`, `CLAUDE.md`, `LICENSE`, and
`versions.json` do NOT need to be in the vault deploy.

```bash
SRC=/home/hq/Documents/DevWork/copyedit-ai-obsidian/obsidian-ai-copyeditor
DEST="/home/hq/Documents/Writing/Scum & Villainy/Scum & Villainy Notes/.obsidian/plugins/copyedit-ai-review/"
cp "$SRC/manifest.json" "$SRC/main.js" "$SRC/styles.css" "$DEST"
```

## Working name

The user-facing display name in `manifest.json` is "Copyedit AI -
Review Edition (WIP)". When the user picks a final name, update
manifest.json `name` and the command-palette prefixes in main.js.

## Companion shim

The shim must be running for the plugin to do anything useful. The
plugin can start and stop it for you:

- Start server / Stop server button in the review pane header, or the
  "Start / Stop local server" commands.
- The plugin spawns `python -u -m copyedit.serve.server` (paths in the
  "Local server" settings section) as a child of Obsidian via Node's
  `child_process`, polls `/health`, and reports when ready. It refuses
  to double-bind if a server is already answering on the endpoint.
- Lifecycle is tied to the plugin: Stop, disabling the plugin, or
  quitting Obsidian sends SIGTERM (`onunload`), so the shim is never
  left running in the background. A crash that skips `onunload` can
  leak it; the next Start detects the live port and declines to start
  a second.
- Settings keys: `serverPython`, `serverCwd`, `serverModule`. Defaults
  are machine-specific (the maintainer's checkout) - sanitize before
  publishing to the community gallery.
- Flatpak Obsidian (the maintainer's install): a plain spawn() runs
  inside the sandbox, where the runtime's python3 (3.12) shadows the
  host interpreter and the venv's 3.10 site-packages are invisible -
  the shim dies on import with exit 1 ("server stopped unexpectedly").
  When `FLATPAK_ID` is set, the plugin instead spawns
  `flatpak-spawn --host --watch-bus /bin/sh -c 'cd "$0" && exec "$1" -u -m "$2"' cwd py mod`.
  Requires the org.freedesktop.Flatpak talk permission:
  `flatpak override --user --talk-name=org.freedesktop.Flatpak md.obsidian.Obsidian`,
  then a full Obsidian restart. `--watch-bus` kills the host process if
  the sandbox dies without onunload, preserving the no-leak contract.
  The plugin detects the "Portal call failed" stderr line and shows a
  notice with the override command.

Manual fallback - start it yourself from the parent repo:
```bash
cd ../copyedit-ai
.venv/bin/python -u -m copyedit.serve.server > /tmp/copyedit_shim.log 2>&1 &
```

## Sibling reference: Inline Alpha

An earlier exploratory edition (`obsidian-plugin/` in the parent
`copyedit-ai/` repo) inserted `%% %%` comments inline instead of
opening a side panel. It is frozen reference code and intentionally
NOT in this repo's history.
