# copyedit-automated-obsidian

Obsidian plugin that runs a paragraph of your writing past a local
language model and shows you the suggested edits as cards you can
accept or reject one at a time. Nothing goes to the cloud.

This is early-stage code. The user-facing name in Obsidian, "Copyedit
AI - Review Edition (WIP)," is provisional.

## What you need

- Obsidian 1.4 or later (desktop only).
- A local HTTP endpoint that speaks the contract at the bottom of this
  file. The plugin defaults to `http://127.0.0.1:8765`, which is where
  the companion server in the parent `copyedit-ai` project listens.
  That server runs Gemma-4-E4B in 4-bit on a single consumer GPU (the
  maintainer uses an RTX 4070 Ti Super, 16 GB VRAM). If you want a
  different backend, point the plugin's `Server endpoint` setting at
  it.

## Install

```bash
git clone https://github.com/YOUR_FORK/copyedit-ai-obsidian
cd copyedit-ai-obsidian
mkdir -p YOUR_VAULT/.obsidian/plugins/copyedit-ai-review
cp manifest.json main.js styles.css YOUR_VAULT/.obsidian/plugins/copyedit-ai-review/
```

In Obsidian: Settings, Community plugins, toggle "Copyedit AI - Review
Edition (WIP)" on. Disable Restricted Mode first if it's on.

## Starting the server

The plugin needs the local server running. You can start it without
leaving Obsidian: open the review pane and click "Start server" (or run
the "Start local server" command). It launches the companion
`copyedit-ai` shim, waits for it to load the model (~10 s), and tells
you when it's ready. "Stop server" shuts it down, and so does disabling
the plugin or quitting Obsidian, so it only runs while you're editing.

Set the Python path, working directory, and module under Settings,
"Local server" first - they default to the maintainer's checkout and
will differ on your machine. If you'd rather run the server yourself,
start it from the parent `copyedit-ai` repo and skip this.

If Obsidian is the Flatpak build, the plugin launches the server on
the host through `flatpak-spawn --host`. That needs a one-time
permission grant (then fully quit and reopen Obsidian):

```bash
flatpak override --user --talk-name=org.freedesktop.Flatpak md.obsidian.Obsidian
```

Without it, Start server fails with "server stopped unexpectedly" and
the plugin shows a notice with the command above.

## Use

Open the side panel from the pencil ribbon icon on the left, or run
"Copyedit AI: Open review pane" from the command palette.

Three ways to ask for suggestions, all available from both the command
palette and the editor right-click menu:

- "Suggest on selection" - highlight a paragraph or two and run it.
- "Suggest on current paragraph" - put your cursor anywhere in a
  paragraph; the plugin walks out to the nearest blank line on each
  side.
- "Suggest on whole note" - splits the note on blank lines and runs
  each paragraph through one at a time. Cards land in the panel as
  they finish, so you can start accepting before the whole note is
  done.

Each suggestion is a card. Three buttons on each:

- Accept rewrites the source. If the file is open in the editor, the
  change goes through Obsidian's undo stack, so Ctrl/Cmd-Z reverts it
  cleanly. If the file isn't open, the change still applies, but undo
  can't see it.
- Reject removes the card.
- Reveal jumps to the span in the source file.

Bulk "Accept all" and "Reject all" sit at the top of the panel.

## Speed

About 25 seconds per paragraph on the default backend. Treat it as an
edit pass you run at the end of a draft, not something you trigger as
you type. A chapter-length whole-note run takes minutes, not seconds.

## Endpoint contract

If you want to plug in your own backend, this is what the plugin
sends and what it expects back.

Request:

```
POST /edit
Content-Type: application/json

{ "passage": "..." }
```

Response:

```
{
  "suggestions": [
    {
      "original_text": "...",
      "proposed_replacement": "...",
      "category": "Mechanics" | "Clarity" | "Style" | "Tone",
      "rationale": "..."
    }
  ],
  "timings": { ... }
}
```

Endpoint URL and per-request timeout live in the plugin settings.

## Known rough edges

- Suggestions live in memory. Close Obsidian and they're gone. Re-run
  when you come back.
- The plugin locates a suggestion's span with a whitespace-flexible
  string match. If the model summarized the original instead of
  quoting it verbatim, Accept can't find the span. The card stays in
  the panel for you to reject.
- Two suggestions that target overlapping spans don't play well
  together. Accept the first and the second's span goes missing.
- The card shows the original and the proposed replacement on two
  colored rows. No word-level inline diff yet.

## License

Apache 2.0. See LICENSE.
