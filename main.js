// Copyedit AI - Review Edition (working name)
//
// Side-panel UX. Each suggestion is a card. Accept applies the edit to the
// source file; reject discards it. Suggestions persist across editor focus
// changes until the user explicitly dismisses them.
//
// Vanilla JS, no build step. Companion to the local serve shim at
// src/copyedit/serve/server.py.

'use strict';

const obsidian = require('obsidian');
// Desktop-only plugin (manifest isDesktopOnly), so Node's child_process is
// available in the renderer. Used solely to launch/stop the local serve
// shim from a button; the plugin never spawns anything on mobile.
const { spawn } = require('child_process');

const VIEW_TYPE = 'copyedit-ai-review-pane';
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8765/edit';
// Machine-specific defaults for the in-app Start server button. These point
// at the maintainer's local copyedit-ai checkout; override in Settings on a
// different machine (or before publishing).
const DEFAULT_SERVER_PYTHON = '/home/hq/Documents/DevWork/copyedit-ai/.venv/bin/python';
const DEFAULT_SERVER_CWD = '/home/hq/Documents/DevWork/copyedit-ai';
const DEFAULT_SERVER_MODULE = 'copyedit.serve.server';
const DEFAULT_SETTINGS = {
  endpoint: DEFAULT_ENDPOINT,
  timeoutMs: 90000,
  enableMechanics: true,
  enableClarity: true,
  enableStyle: true,
  enableTone: true,
  userRules: '',
  // Keep the author's spelling convention (British/Canadian vs American):
  // the shim drops suggestions whose only substantive change is a spelling
  // variant. Default on.
  keepSpelling: true,
  serverPython: DEFAULT_SERVER_PYTHON,
  serverCwd: DEFAULT_SERVER_CWD,
  serverModule: DEFAULT_SERVER_MODULE,
};
const FEEDBACK_FILE = 'feedback.jsonl';
// Synthesis endpoint is the same host as the /edit endpoint, swapped path.
function synthesizeUrlFor(editUrl) {
  try {
    const u = new URL(editUrl);
    u.pathname = u.pathname.replace(/\/edit\/?$/, '/synthesize-rules');
    return u.toString();
  } catch (_) {
    return editUrl.replace(/\/edit\/?$/, '/synthesize-rules');
  }
}

// Health endpoint is the same host as the /edit endpoint, swapped path.
function healthUrlFor(editUrl) {
  try {
    const u = new URL(editUrl);
    u.pathname = u.pathname.replace(/\/edit\/?$/, '/health');
    return u.toString();
  } catch (_) {
    return editUrl.replace(/\/edit\/?$/, '/health');
  }
}

// Heuristic: does this fetch error look like "nothing is listening" rather
// than a server-side error? Chromium surfaces a refused connection as a
// TypeError ("Failed to fetch"); Node-side errors carry ECONNREFUSED.
function looksLikeServerDown(err) {
  if (!err) return false;
  if (err.name === 'TypeError') return true;
  const m = (err.message || '').toLowerCase();
  return m.includes('failed to fetch')
      || m.includes('econnrefused')
      || m.includes('connection refused')
      || m.includes('err_connection_refused')
      || m.includes('networkerror');
}


// --- helpers -----------------------------------------------------------------

let suggestionCounter = 0;
function nextSuggestionId() {
  suggestionCounter += 1;
  return `sug-${Date.now().toString(36)}-${suggestionCounter}`;
}

// Fuzzy whitespace match: finds `needle` in `haystack` allowing any run of
// whitespace in the needle to match any run of whitespace in the haystack.
// Returns {start, end} indices into haystack, or null.
function fuzzyFind(haystack, needle) {
  if (!needle) return null;
  const direct = haystack.indexOf(needle);
  if (direct !== -1) return { start: direct, end: direct + needle.length };
  const escaped = needle
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+');
  try {
    const re = new RegExp(escaped);
    const m = haystack.match(re);
    if (m && m.index !== undefined) {
      return { start: m.index, end: m.index + m[0].length };
    }
  } catch (_) {}
  return null;
}

// Loose locator for the Reveal action. Tries the strict matcher first;
// if that fails, progressively trims the needle from the end, then the
// start, then both, looking for a hit. Trim is capped at ~30% of the
// needle length so we don't degenerate into matching any short
// substring. Returns {start, end, approximate} or null.
//
// Reveal-only: Accept should NEVER use this. Partial-match accept would
// replace text outside what the suggestion was actually about.
function fuzzyFindLoose(haystack, needle) {
  needle = (needle || '').trim();
  if (!needle) return null;
  const exact = fuzzyFind(haystack, needle);
  if (exact) return { ...exact, approximate: false };

  const maxTrim = Math.min(40, Math.floor(needle.length * 0.3));
  const minLen = Math.max(20, needle.length - maxTrim);
  for (let trim = 1; trim <= maxTrim; trim++) {
    // End-trim: most common - LLM captured trailing punctuation or a
    // tail word that the user edited away.
    if (needle.length - trim >= minLen) {
      const hit = fuzzyFind(haystack, needle.slice(0, -trim));
      if (hit) return { ...hit, approximate: true };
    }
    // Start-trim: less common but symmetric.
    if (needle.length - trim >= minLen) {
      const hit = fuzzyFind(haystack, needle.slice(trim));
      if (hit) return { ...hit, approximate: true };
    }
    // Both-ends trim, paying double.
    if (needle.length - trim * 2 >= minLen) {
      const hit = fuzzyFind(haystack, needle.slice(trim, needle.length - trim));
      if (hit) return { ...hit, approximate: true };
    }
  }
  return null;
}


// --- side panel view ---------------------------------------------------------

class ReviewPaneView extends obsidian.ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Copyedit AI: Review'; }
  getIcon() { return 'pencil-line'; }

  async onOpen() {
    this.render();
  }
  async onClose() {}

  render() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass('copyedit-ai-review');

    const header = root.createDiv({ cls: 'copyedit-ai-header' });
    header.createEl('h3', { text: 'Copyedit AI - Review' });

    // Local-server control. Lets you start/stop the shim without leaving
    // Obsidian; the server only runs while the plugin manages it.
    const serverRow = header.createDiv({ cls: 'copyedit-ai-server' });
    const starting = this.plugin.serverStarting;
    const managed = !!this.plugin.serverProcess;
    const dot = serverRow.createSpan({ cls: 'copyedit-ai-server-dot' });
    dot.toggleClass('is-on', managed && !starting);
    dot.toggleClass('is-starting', starting);
    const statusSpan = serverRow.createSpan({ cls: 'copyedit-ai-server-status' });
    statusSpan.setText(
      starting ? 'Server: starting...'
      : managed ? 'Server: running'
      : 'Server: not started by plugin'
    );
    const serverBtn = serverRow.createEl('button', {
      text: starting ? 'Starting...' : managed ? 'Stop server' : 'Start server',
    });
    serverBtn.disabled = starting;
    serverBtn.addEventListener('click', () =>
      managed ? this.plugin.stopServer() : this.plugin.startServer());

    const allSugs = this.plugin.suggestions;
    const sugs = allSugs.filter((s) => this.plugin.isCategoryEnabled(s.category));
    const hidden = allSugs.length - sugs.length;
    const counts = header.createDiv({ cls: 'copyedit-ai-counts' });
    counts.setText(
      allSugs.length === 0
        ? 'No pending suggestions. Run "Suggest edits on selection" from the command palette.'
        : hidden > 0
        ? `${sugs.length} visible, ${hidden} hidden by category filter (Settings -> Copyedit AI)`
        : `${sugs.length} pending suggestion${sugs.length === 1 ? '' : 's'}`
    );

    if (sugs.length > 0) {
      const actions = header.createDiv({ cls: 'copyedit-ai-bulk' });
      const acceptAll = actions.createEl('button', { text: 'Accept all visible' });
      acceptAll.addEventListener('click', () => this.plugin.acceptAll());
      const rejectAll = actions.createEl('button', { text: 'Reject all visible' });
      rejectAll.addEventListener('click', () => this.plugin.rejectAll());
    }

    const list = root.createDiv({ cls: 'copyedit-ai-list' });
    for (const sug of sugs) {
      this.renderCard(list, sug);
    }
  }

  renderCard(parent, sug) {
    const card = parent.createDiv({ cls: 'copyedit-ai-card' });
    card.dataset.id = sug.id;

    const meta = card.createDiv({ cls: 'copyedit-ai-meta' });
    const cat = meta.createSpan({ cls: 'copyedit-ai-category' });
    cat.setText(sug.category || 'Edit');
    const src = meta.createSpan({ cls: 'copyedit-ai-source' });
    const fname = sug.sourceFile ? sug.sourceFile.split('/').pop() : '(no file)';
    src.setText(fname);

    const diff = card.createDiv({ cls: 'copyedit-ai-diff' });
    const origRow = diff.createDiv({ cls: 'copyedit-ai-orig' });
    origRow.createSpan({ cls: 'copyedit-ai-label', text: 'Original' });
    origRow.createSpan({ cls: 'copyedit-ai-text', text: sug.original_text });
    const propRow = diff.createDiv({ cls: 'copyedit-ai-prop' });
    propRow.createSpan({ cls: 'copyedit-ai-label', text: 'Suggested' });
    propRow.createSpan({ cls: 'copyedit-ai-text', text: sug.proposed_replacement });

    if (sug.rationale) {
      card.createDiv({ cls: 'copyedit-ai-rationale', text: sug.rationale });
    }

    const noteRow = card.createDiv({ cls: 'copyedit-ai-note' });
    const noteInput = noteRow.createEl('input', {
      type: 'text',
      placeholder: 'Why? (optional - logged for future training)',
    });
    noteInput.value = sug.userNote || '';
    noteInput.addEventListener('input', () => { sug.userNote = noteInput.value; });

    const buttons = card.createDiv({ cls: 'copyedit-ai-buttons' });
    const acceptBtn = buttons.createEl('button',
      { text: 'Accept', cls: 'mod-cta' });
    acceptBtn.addEventListener('click', () => this.plugin.acceptSuggestion(sug.id));
    const rejectBtn = buttons.createEl('button', { text: 'Reject' });
    rejectBtn.addEventListener('click', () => this.plugin.rejectSuggestion(sug.id));
    const locateBtn = buttons.createEl('button', { text: 'Reveal' });
    locateBtn.addEventListener('click', () => this.plugin.revealSuggestion(sug.id));
  }
}


// --- plugin ------------------------------------------------------------------

class CopyeditAIReviewPlugin extends obsidian.Plugin {
  async onload() {
    await this.loadSettings();

    /** @type {Array<{id,original_text,proposed_replacement,category,rationale,sourceFile}>} */
    this.suggestions = [];

    // Local server lifecycle. serverProcess is the spawned child when the
    // plugin manages the shim; null otherwise (not running, or running but
    // started outside the plugin). _stoppingServer suppresses the
    // "unexpected exit" notice during a deliberate stop/unload.
    this.serverProcess = null;
    this.serverStarting = false;
    this._stoppingServer = false;

    this.registerView(VIEW_TYPE, (leaf) => new ReviewPaneView(leaf, this));

    this.addRibbonIcon('pencil-line', 'Copyedit AI: Open review pane', () => this.activatePane());

    this.addCommand({
      id: 'open-review-pane',
      name: 'Open review pane',
      callback: () => this.activatePane(),
    });
    this.addCommand({
      id: 'suggest-on-selection',
      name: 'Suggest edits on selection',
      editorCallback: (editor) => this.runOnSelection(editor),
    });
    this.addCommand({
      id: 'suggest-on-paragraph',
      name: 'Suggest edits on current paragraph',
      editorCallback: (editor) => this.runOnCurrentParagraph(editor),
    });
    this.addCommand({
      id: 'suggest-on-note',
      name: 'Suggest edits on whole note (paragraph-by-paragraph)',
      editorCallback: (editor) => this.runOnWholeNote(editor),
    });
    this.addCommand({
      id: 'clear-pending',
      name: 'Clear all pending suggestions',
      callback: () => this.rejectAll(),
    });
    this.addCommand({
      id: 'start-server',
      name: 'Start local server',
      callback: () => this.startServer(),
    });
    this.addCommand({
      id: 'stop-server',
      name: 'Stop local server',
      callback: () => this.stopServer(),
    });
    this.addCommand({
      id: 'synthesize-rules',
      name: 'Synthesize rules from feedback log',
      callback: () => this.synthesizeRulesFromFeedback(),
    });

    // Right-click context menu in the editor.
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor) => {
        const hasSelection = !!(editor.getSelection() || '').trim();
        menu.addSeparator();
        if (hasSelection) {
          menu.addItem((item) => item
            .setTitle('Copyedit AI: Suggest on selection')
            .setIcon('pencil-line')
            .onClick(() => this.runOnSelection(editor)));
        }
        menu.addItem((item) => item
          .setTitle('Copyedit AI: Suggest on current paragraph')
          .setIcon('pencil-line')
          .onClick(() => this.runOnCurrentParagraph(editor)));
        menu.addItem((item) => item
          .setTitle('Copyedit AI: Suggest on whole note')
          .setIcon('pencil-line')
          .onClick(() => this.runOnWholeNote(editor)));
      })
    );

    this.addSettingTab(new ReviewSettingTab(this.app, this));

    this.statusBar = this.addStatusBarItem();
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
    // Tie the managed server's lifetime to the plugin: disabling the
    // plugin or quitting Obsidian shuts the shim down, so it is never
    // left running in the background. (A crash that skips onunload can
    // leak it; the next Start detects the live port and declines to
    // double-bind.)
    if (this.serverProcess) {
      this._stoppingServer = true;
      try { this.serverProcess.kill('SIGTERM'); } catch (_) {}
      this.serverProcess = null;
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }

  async activatePane() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  refreshPane() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view && typeof view.render === 'function') view.render();
    }
  }

  // --- generation -----------------------------------------------------------

  async runOnSelection(editor) {
    const sel = editor.getSelection();
    if (!sel || !sel.trim()) {
      new obsidian.Notice('Copyedit AI: no selection.');
      return;
    }
    const file = this.app.workspace.getActiveFile();
    await this.fetchAndStash(sel, file ? file.path : '');
  }

  async runOnCurrentParagraph(editor) {
    const cursor = editor.getCursor();
    let start = cursor.line, end = cursor.line;
    while (start > 0 && editor.getLine(start - 1).trim() !== '') start--;
    const lastLine = editor.lineCount() - 1;
    while (end < lastLine && editor.getLine(end + 1).trim() !== '') end++;
    const text = editor.getRange({ line: start, ch: 0 },
                                 { line: end, ch: editor.getLine(end).length });
    if (!text.trim()) {
      new obsidian.Notice('Copyedit AI: empty paragraph.');
      return;
    }
    const file = this.app.workspace.getActiveFile();
    await this.fetchAndStash(text, file ? file.path : '');
  }

  /**
   * Run on the whole note, paragraph-by-paragraph. The shim was validated
   * on paragraph-sized passages (~350-800 chars in the eval set); sending
   * a multi-page note as one passage would drift out of distribution.
   * Sequences requests one at a time (the shim is single-GPU; parallelism
   * would not help). Suggestions accumulate in the panel as each
   * paragraph completes; the user can start accepting before all are
   * done.
   */
  async runOnWholeNote(editor) {
    const text = editor.getValue();
    if (!text || !text.trim()) {
      new obsidian.Notice('Copyedit AI: empty note.');
      return;
    }
    const paragraphs = text
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && p.length >= 40); // skip very short bits
    if (paragraphs.length === 0) {
      new obsidian.Notice('Copyedit AI: no paragraphs to process.');
      return;
    }
    const file = this.app.workspace.getActiveFile();
    const sourceFile = file ? file.path : '';
    const N = paragraphs.length;
    let totalSuggestions = 0;
    let failures = 0;
    const t0 = Date.now();
    new obsidian.Notice(
      `Copyedit AI: processing ${N} paragraph${N === 1 ? '' : 's'} (~${Math.ceil(N * 25 / 60)} min)...`
    );
    await this.activatePane();
    for (let i = 0; i < N; i++) {
      this.statusBar.setText(`Copyedit AI: paragraph ${i + 1}/${N}...`);
      let payload;
      try {
        payload = await this.callServer(paragraphs[i]);
      } catch (err) {
        failures += 1;
        console.error(`copyedit-ai whole-note paragraph ${i + 1} failed`, err);
        continue;
      }
      const incoming = (payload && payload.suggestions) || [];
      for (const s of incoming) {
        this.suggestions.push({
          id: nextSuggestionId(),
          original_text: s.original_text || '',
          proposed_replacement: s.proposed_replacement || '',
          category: s.category || '',
          rationale: s.rationale || '',
          sourceFile,
        });
      }
      totalSuggestions += incoming.length;
      this.refreshPane();
    }
    this.statusBar.setText('');
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    const tail = failures > 0 ? ` (${failures} paragraph${failures === 1 ? '' : 's'} failed)` : '';
    new obsidian.Notice(
      `Copyedit AI: whole-note done. ${totalSuggestions} suggestion${totalSuggestions === 1 ? '' : 's'} from ${N} paragraph${N === 1 ? '' : 's'} (${elapsed}s).${tail}`
    );
  }

  async fetchAndStash(text, sourceFile) {
    this.statusBar.setText('Copyedit AI: thinking...');
    const t0 = Date.now();
    let payload;
    try {
      payload = await this.callServer(text);
    } catch (err) {
      this.statusBar.setText('');
      const hint = (!this.serverProcess && looksLikeServerDown(err))
        ? ' - is the local server running? Open the review pane and click "Start server".'
        : '';
      new obsidian.Notice('Copyedit AI error: ' + err.message + hint);
      console.error('copyedit-ai server call failed', err);
      return;
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const incoming = (payload && payload.suggestions) || [];
    if (incoming.length === 0) {
      this.statusBar.setText('');
      new obsidian.Notice(`Copyedit AI: no edits suggested (${elapsed}s).`);
      return;
    }
    for (const s of incoming) {
      this.suggestions.push({
        id: nextSuggestionId(),
        original_text: s.original_text || '',
        proposed_replacement: s.proposed_replacement || '',
        category: s.category || '',
        rationale: s.rationale || '',
        sourceFile,
      });
    }
    this.statusBar.setText('');
    new obsidian.Notice(
      `Copyedit AI: ${incoming.length} suggestion${incoming.length === 1 ? '' : 's'} added (${elapsed}s).`
    );
    await this.activatePane();
    this.refreshPane();
  }

  async callServer(passage) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
    try {
      const r = await fetch(this.settings.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          passage,
          user_rules: this.settings.userRules || '',
          keep_spelling: this.settings.keepSpelling !== false,
        }),
        signal: controller.signal,
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}${detail ? ': ' + detail : ''}`);
      }
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // --- local server lifecycle -----------------------------------------------

  /** Probe the /health endpoint (derived from the /edit endpoint). Returns
   * true if something is listening and healthy, false on any error/timeout. */
  async isServerUp(timeoutMs) {
    timeoutMs = timeoutMs || 1500;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await fetch(healthUrlFor(this.settings.endpoint), { signal: controller.signal });
      return r.ok;
    } catch (_) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Launch the local serve shim as a child of Obsidian. Refuses to start a
   * second instance if one is already managed, already starting, or already
   * answering on the endpoint (so we never collide on the port). The child
   * is killed on Stop and on plugin unload, so it stays up only while you
   * are editing.
   */
  async startServer() {
    if (this.serverStarting) {
      new obsidian.Notice('Copyedit AI: server is already starting...');
      return;
    }
    if (this.serverProcess) {
      new obsidian.Notice('Copyedit AI: server already running (managed by this plugin).');
      return;
    }
    if (await this.isServerUp()) {
      new obsidian.Notice('Copyedit AI: a server is already answering on the endpoint; not starting another.');
      this.refreshPane();
      return;
    }
    const py = (this.settings.serverPython || '').trim();
    const cwd = (this.settings.serverCwd || '').trim();
    const mod = (this.settings.serverModule || '').trim();
    if (!py || !cwd || !mod) {
      new obsidian.Notice('Copyedit AI: set the server Python, working dir, and module in Settings first.');
      return;
    }

    this.serverStarting = true;
    this.refreshPane();

    // Under the Flatpak build of Obsidian, spawn() runs inside the sandbox:
    // the runtime's python3 shadows the host interpreter, so the venv's
    // site-packages are invisible and the shim dies on import. flatpak-spawn
    // --host escapes to the real system; it requires the org.freedesktop.Flatpak
    // talk permission (flatpak override --user --talk-name=org.freedesktop.Flatpak
    // md.obsidian.Obsidian). --watch-bus kills the host process if Obsidian
    // dies without running onunload, so the shim still can't leak.
    const inFlatpak = !!process.env.FLATPAK_ID;
    let child;
    try {
      if (inFlatpak) {
        // sh -c wrapper instead of --directory: argv after the script string
        // binds to $0/$1/$2, so paths pass through without shell-quoting risk.
        child = spawn('flatpak-spawn', [
          '--host', '--watch-bus',
          '/bin/sh', '-c', 'cd "$0" && exec "$1" -u -m "$2"', cwd, py, mod,
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
      } else {
        child = spawn(py, ['-u', '-m', mod], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      }
    } catch (err) {
      this.serverStarting = false;
      this.refreshPane();
      new obsidian.Notice('Copyedit AI: could not launch server: ' + err.message);
      return;
    }
    this.serverProcess = child;

    let portalHintShown = false;
    const log = (d) => {
      const s = d.toString();
      if (inFlatpak && !portalHintShown && s.includes('Portal call failed')) {
        portalHintShown = true;
        new obsidian.Notice(
          'Copyedit AI: Obsidian\'s Flatpak sandbox is not allowed to run host commands. ' +
          'Run this once in a terminal, then fully quit and reopen Obsidian:\n' +
          'flatpak override --user --talk-name=org.freedesktop.Flatpak md.obsidian.Obsidian',
          20000);
      }
      console.log('[copyedit-ai server]', s.trimEnd());
    };
    child.stdout.on('data', log);
    child.stderr.on('data', log);
    child.on('error', (err) => {
      // Fires e.g. when the Python path is wrong (ENOENT).
      console.error('copyedit-ai server process error', err);
      new obsidian.Notice('Copyedit AI: server process error: ' + err.message);
      if (this.serverProcess === child) this.serverProcess = null;
      this.serverStarting = false;
      this.refreshPane();
    });
    child.on('exit', (code, signal) => {
      console.log(`copyedit-ai server exited (code=${code}, signal=${signal})`);
      const deliberate = this._stoppingServer;
      if (this.serverProcess === child) this.serverProcess = null;
      this.serverStarting = false;
      this._stoppingServer = false;
      if (!deliberate) {
        new obsidian.Notice(`Copyedit AI: server stopped unexpectedly (${code == null ? signal : 'code ' + code}).`);
      }
      this.refreshPane();
    });

    new obsidian.Notice('Copyedit AI: starting local server (model loads in ~10 s)...');
    const ready = await this._waitForHealth(60000);
    this.serverStarting = false;
    this.refreshPane();
    if (ready) {
      new obsidian.Notice('Copyedit AI: server ready.');
    } else if (this.serverProcess) {
      new obsidian.Notice('Copyedit AI: server launched but not healthy yet - check the developer console.');
    }
  }

  /** Poll /health until healthy, the process dies, or the deadline passes. */
  async _waitForHealth(maxMs) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (!this.serverProcess) return false; // died during startup
      if (await this.isServerUp(2000)) return true;
      await new Promise((res) => setTimeout(res, 1000));
    }
    return false;
  }

  /** Stop the plugin-managed server. SIGTERM, escalating to SIGKILL after a
   * grace period. Does nothing to a server the plugin did not start. */
  async stopServer() {
    if (!this.serverProcess) {
      new obsidian.Notice('Copyedit AI: no plugin-managed server to stop.');
      return;
    }
    const child = this.serverProcess;
    this._stoppingServer = true;
    try {
      child.kill('SIGTERM');
    } catch (err) {
      this._stoppingServer = false;
      new obsidian.Notice('Copyedit AI: could not stop server: ' + err.message);
      return;
    }
    new obsidian.Notice('Copyedit AI: stopping server...');
    setTimeout(() => {
      if (this.serverProcess === child) {
        try { child.kill('SIGKILL'); } catch (_) {}
      }
    }, 5000);
  }

  // --- accept / reject ------------------------------------------------------

  isCategoryEnabled(category) {
    const n = (category || '').toLowerCase();
    if (n.startsWith('mech')) return this.settings.enableMechanics;
    if (n.startsWith('clar')) return this.settings.enableClarity;
    if (n.startsWith('style') || n.startsWith('tone')) {
      return n.startsWith('style')
        ? this.settings.enableStyle
        : this.settings.enableTone;
    }
    // Unknown category (model emitted something off-rubric): show it.
    return true;
  }

  /**
   * Append one record to the per-vault feedback log
   * (.obsidian/plugins/<id>/feedback.jsonl). Each record carries the
   * decision, the suggestion, and the optional user note. The log is
   * append-only JSONL so it stays portable as training data.
   */
  async logFeedback(sug, action, opts) {
    opts = opts || {};
    const record = {
      timestamp: new Date().toISOString(),
      action,            // "accept" | "reject"
      bulk: !!opts.bulk, // set true for accept-all / reject-all sweeps
      source_file: sug.sourceFile || '',
      category: sug.category || '',
      original_text: sug.original_text || '',
      proposed_replacement: sug.proposed_replacement || '',
      rationale: sug.rationale || '',
      user_note: (sug.userNote || '').trim(),
    };
    const path = `${this.app.vault.configDir}/plugins/${this.manifest.id}/${FEEDBACK_FILE}`;
    try {
      await this.app.vault.adapter.append(path, JSON.stringify(record) + '\n');
    } catch (err) {
      console.error('copyedit-ai feedback log write failed', err);
    }
  }

  async acceptSuggestion(id, opts) {
    const idx = this.suggestions.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const sug = this.suggestions[idx];
    const applied = await this.applyToFile(sug);
    if (!applied.ok) {
      const hint = applied.reason === 'span not found'
        ? ' - the text near the span may have changed; reject and re-run on that paragraph for a fresh suggestion'
        : '';
      new obsidian.Notice(`Copyedit AI: could not apply (${applied.reason})${hint}`);
      return;
    }
    await this.logFeedback(sug, 'accept', opts);
    this.suggestions.splice(idx, 1);
    this.refreshPane();
  }

  async rejectSuggestion(id, opts) {
    const idx = this.suggestions.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const sug = this.suggestions[idx];
    await this.logFeedback(sug, 'reject', opts);
    this.suggestions.splice(idx, 1);
    this.refreshPane();
  }

  async revealSuggestion(id) {
    const sug = this.suggestions.find((s) => s.id === id);
    if (!sug || !sug.sourceFile) return;
    const file = this.app.vault.getAbstractFileByPath(sug.sourceFile);
    if (!file) return;
    let leaf = this._findOpenLeafForFile(sug.sourceFile);
    if (leaf) {
      this.app.workspace.revealLeaf(leaf);
    } else {
      leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
    }
    const editor = leaf.view && leaf.view.editor;
    if (!editor) return;
    const text = editor.getValue();
    const hit = fuzzyFindLoose(text, sug.original_text);
    if (!hit) {
      new obsidian.Notice('Copyedit AI: span not found in current file.');
      return;
    }
    const from = editor.offsetToPos(hit.start);
    const to = editor.offsetToPos(hit.end);
    editor.setSelection(from, to);
    editor.scrollIntoView({ from, to }, true);
    if (hit.approximate) {
      new obsidian.Notice(
        'Copyedit AI: approximate location - text near the span has changed.'
      );
    }
  }

  async acceptAll() {
    const ids = this.suggestions
      .filter((s) => this.isCategoryEnabled(s.category))
      .map((s) => s.id);
    for (const id of ids) await this.acceptSuggestion(id, { bulk: true });
  }

  async rejectAll() {
    const visible = this.suggestions.filter((s) => this.isCategoryEnabled(s.category));
    for (const sug of visible) await this.logFeedback(sug, 'reject', { bulk: true });
    this.suggestions = this.suggestions.filter((s) => !this.isCategoryEnabled(s.category));
    this.refreshPane();
  }

  /**
   * Apply a suggestion to its source file. Locates `original_text` via
   * fuzzy whitespace match, replaces with `proposed_replacement`.
   *
   * Prefers the editor API when the file is open in a markdown leaf:
   * `editor.replaceRange` writes through the editor's undo stack so a
   * subsequent Ctrl/Cmd-Z surgically reverts the accept. Falls back to
   * `app.vault.modify` when the file is not open in any leaf - the
   * change still happens but is not in any editor history.
   */
  async applyToFile(sug) {
    if (!sug.sourceFile) return { ok: false, reason: 'no source file' };
    const file = this.app.vault.getAbstractFileByPath(sug.sourceFile);
    if (!file) return { ok: false, reason: 'file not found' };

    const openLeaf = this._findOpenLeafForFile(sug.sourceFile);
    const needle = sug.original_text.trim();
    if (!needle) return { ok: false, reason: 'empty span' };

    if (openLeaf) {
      const editor = openLeaf.view.editor;
      const content = editor.getValue();
      const hit = fuzzyFind(content, needle);
      if (!hit) return { ok: false, reason: 'span not found' };
      const from = editor.offsetToPos(hit.start);
      const to = editor.offsetToPos(hit.end);
      editor.replaceRange(sug.proposed_replacement, from, to);
      return { ok: true, via: 'editor' };
    }

    const content = await this.app.vault.read(file);
    const hit = fuzzyFind(content, needle);
    if (!hit) return { ok: false, reason: 'span not found' };
    const updated = content.slice(0, hit.start)
                  + sug.proposed_replacement
                  + content.slice(hit.end);
    await this.app.vault.modify(file, updated);
    return { ok: true, via: 'vault' };
  }

  /** Return the WorkspaceLeaf currently displaying `path` as a markdown
   * editor, or null. Used by applyToFile to prefer editor-level edits so
   * Ctrl/Cmd-Z works cleanly. */
  _findOpenLeafForFile(path) {
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
      const view = leaf.view;
      const file = view && view.file;
      if (file && file.path === path && view.editor) return leaf;
    }
    return null;
  }

  // --- rules synthesis ------------------------------------------------------

  feedbackPath() {
    return `${this.app.vault.configDir}/plugins/${this.manifest.id}/${FEEDBACK_FILE}`;
  }

  /**
   * Read the feedback JSONL log and return the recent reject records (with
   * a few accepts mixed in for contrast). Capped so a runaway log doesn't
   * bust Gemma's context. Returns parsed records, oldest first.
   */
  async readRecentFeedback(maxRejects, maxAccepts) {
    maxRejects = maxRejects || 80;
    maxAccepts = maxAccepts || 10;
    const path = this.feedbackPath();
    if (!(await this.app.vault.adapter.exists(path))) return [];
    const raw = await this.app.vault.adapter.read(path);
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const all = [];
    for (const line of lines) {
      try { all.push(JSON.parse(line)); } catch (_) {}
    }
    const rejects = all.filter((r) => r.action === 'reject').slice(-maxRejects);
    const accepts = all.filter((r) => r.action === 'accept').slice(-maxAccepts);
    return [...rejects, ...accepts];
  }

  async synthesizeRulesFromFeedback() {
    let records;
    try {
      records = await this.readRecentFeedback();
    } catch (err) {
      new obsidian.Notice('Copyedit AI: could not read feedback log: ' + err.message);
      return;
    }
    if (records.length < 5) {
      new obsidian.Notice(
        `Copyedit AI: only ${records.length} feedback record(s) - need at least 5 for synthesis to be useful.`
      );
      return;
    }
    this.statusBar.setText('Copyedit AI: synthesizing rules...');
    const t0 = Date.now();
    let payload;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.settings.timeoutMs);
      try {
        const r = await fetch(synthesizeUrlFor(this.settings.endpoint), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ feedback: records }),
          signal: controller.signal,
        });
        if (!r.ok) {
          const detail = await r.text().catch(() => '');
          throw new Error(`HTTP ${r.status}${detail ? ': ' + detail : ''}`);
        }
        payload = await r.json();
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      this.statusBar.setText('');
      new obsidian.Notice('Copyedit AI synthesis failed: ' + err.message);
      console.error('copyedit-ai synth failed', err);
      return;
    }
    this.statusBar.setText('');
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    new SynthesizedRulesModal(this.app, this, payload.rules || '', records.length, elapsed).open();
  }
}


class SynthesizedRulesModal extends obsidian.Modal {
  constructor(app, plugin, proposed, recordCount, elapsedSecs) {
    super(app);
    this.plugin = plugin;
    this.proposed = proposed;
    this.recordCount = recordCount;
    this.elapsedSecs = elapsedSecs;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h2', { text: 'Synthesized rules' });
    contentEl.createEl('p', {
      text: `Drafted from ${this.recordCount} recent feedback record(s) in `
          + `${this.elapsedSecs}s. Review and edit before applying.`,
      cls: 'setting-item-description',
    });

    const textarea = contentEl.createEl('textarea', { cls: 'copyedit-ai-modal-textarea' });
    textarea.value = this.proposed;
    textarea.rows = 14;
    this.textarea = textarea;

    const existing = (this.plugin.settings.userRules || '').trim();
    const btnRow = contentEl.createDiv({ cls: 'copyedit-ai-modal-buttons' });

    const replaceBtn = btnRow.createEl('button', { text: 'Replace existing rules', cls: 'mod-cta' });
    replaceBtn.addEventListener('click', () => this.commit(textarea.value, 'replace'));

    const appendBtn = btnRow.createEl('button', { text: 'Append to existing rules' });
    appendBtn.disabled = existing.length === 0;
    appendBtn.addEventListener('click', () => this.commit(textarea.value, 'append'));

    const copyBtn = btnRow.createEl('button', { text: 'Copy to clipboard' });
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(textarea.value);
        new obsidian.Notice('Copyedit AI: rules copied.');
      } catch (_) {}
    });

    const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.close());
  }
  async commit(text, mode) {
    const cleaned = (text || '').trim();
    const existing = (this.plugin.settings.userRules || '').trim();
    let next = cleaned;
    if (mode === 'append' && existing) {
      next = existing + '\n' + cleaned;
    }
    this.plugin.settings.userRules = next;
    await this.plugin.saveSettings();
    new obsidian.Notice(`Copyedit AI: rules ${mode === 'append' ? 'appended' : 'saved'}.`);
    this.close();
  }
  onClose() {
    this.contentEl.empty();
  }
}


class ReviewSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Copyedit AI - Review Edition' });
    new obsidian.Setting(containerEl)
      .setName('Server endpoint')
      .setDesc('URL of the local copyedit-ai shim (POST /edit).')
      .addText((t) => t
        .setPlaceholder(DEFAULT_ENDPOINT)
        .setValue(this.plugin.settings.endpoint)
        .onChange(async (v) => {
          this.plugin.settings.endpoint = v || DEFAULT_ENDPOINT;
          await this.plugin.saveSettings();
        }));
    new obsidian.Setting(containerEl)
      .setName('Timeout (ms)')
      .setDesc('Editor + critic runs in ~25 s; default 90 s is generous.')
      .addText((t) => t
        .setPlaceholder(String(DEFAULT_SETTINGS.timeoutMs))
        .setValue(String(this.plugin.settings.timeoutMs))
        .onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.timeoutMs = Number.isFinite(n) && n > 0
            ? n : DEFAULT_SETTINGS.timeoutMs;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: 'Local server' });
    containerEl.createEl('p', {
      text: 'Optional: let the plugin start and stop the copyedit-ai shim '
          + 'for you (Start/Stop button in the review pane, or the "Start / '
          + 'Stop local server" commands). The server runs only while the '
          + 'plugin manages it - stopping the plugin or quitting Obsidian '
          + 'shuts it down. These paths are machine-specific; leave them '
          + 'alone if you start the server yourself.',
      cls: 'setting-item-description',
    });
    new obsidian.Setting(containerEl)
      .setName('Server Python')
      .setDesc('Path to the Python interpreter (the copyedit-ai venv).')
      .addText((t) => t
        .setPlaceholder(DEFAULT_SERVER_PYTHON)
        .setValue(this.plugin.settings.serverPython)
        .onChange(async (v) => {
          this.plugin.settings.serverPython = v;
          await this.plugin.saveSettings();
        }));
    new obsidian.Setting(containerEl)
      .setName('Server working directory')
      .setDesc('The copyedit-ai repo root (where the copyedit package lives).')
      .addText((t) => t
        .setPlaceholder(DEFAULT_SERVER_CWD)
        .setValue(this.plugin.settings.serverCwd)
        .onChange(async (v) => {
          this.plugin.settings.serverCwd = v;
          await this.plugin.saveSettings();
        }));
    new obsidian.Setting(containerEl)
      .setName('Server module')
      .setDesc('Module run as `python -u -m <module>`.')
      .addText((t) => t
        .setPlaceholder(DEFAULT_SERVER_MODULE)
        .setValue(this.plugin.settings.serverModule)
        .onChange(async (v) => {
          this.plugin.settings.serverModule = v;
          await this.plugin.saveSettings();
        }));
    new obsidian.Setting(containerEl)
      .setName('Server control')
      .setDesc('Start or stop the local server now.')
      .addButton((b) => b
        .setButtonText('Start server')
        .onClick(() => this.plugin.startServer()))
      .addButton((b) => b
        .setButtonText('Stop server')
        .onClick(() => this.plugin.stopServer()));

    containerEl.createEl('h3', { text: 'Categories to show' });
    containerEl.createEl('p', {
      text: 'Suggestions tagged with an unchecked category are hidden '
          + 'from the panel. The shim still generates them; only the '
          + 'display is filtered.',
      cls: 'setting-item-description',
    });
    const catRow = (key, label) => {
      new obsidian.Setting(containerEl).setName(label).addToggle((tg) => tg
        .setValue(this.plugin.settings[key])
        .onChange(async (v) => {
          this.plugin.settings[key] = v;
          await this.plugin.saveSettings();
          this.plugin.refreshPane();
        }));
    };
    catRow('enableMechanics', 'Mechanics');
    catRow('enableClarity', 'Clarity');
    catRow('enableStyle', 'Style');
    catRow('enableTone', 'Tone');

    containerEl.createEl('h3', { text: 'Spelling' });
    new obsidian.Setting(containerEl)
      .setName('Keep my spelling convention')
      .setDesc('Drop suggestions that only switch between British/Canadian '
          + 'and American spelling (colour/color, realise/realize, '
          + 'centre/center). Applied by the shim before the critic; takes '
          + 'effect on the next request. Dash-style swaps (hyphen or -- for '
          + 'an em dash, dash for a comma) are always dropped.')
      .addToggle((tg) => tg
        .setValue(this.plugin.settings.keepSpelling !== false)
        .onChange(async (v) => {
          this.plugin.settings.keepSpelling = v;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: 'User rules' });
    containerEl.createEl('p', {
      text: 'Free-form DROP rules that get appended to the critic prompt '
          + 'on every request. One rule per line is typical. Takes effect '
          + 'immediately; no shim restart needed. Use the "Synthesize '
          + 'rules from feedback log" command to draft these from your '
          + 'Accept / Reject history.',
      cls: 'setting-item-description',
    });
    const rulesArea = containerEl.createEl('textarea', {
      cls: 'copyedit-ai-settings-rules',
    });
    rulesArea.value = this.plugin.settings.userRules || '';
    rulesArea.rows = 8;
    rulesArea.placeholder
      = 'DROP if the edit strips an intensifier (very, really, just) from prose.\n'
      + 'DROP if the edit modernizes period diction (to-morrow, I dare say, ...).';
    rulesArea.addEventListener('change', async () => {
      this.plugin.settings.userRules = rulesArea.value;
      await this.plugin.saveSettings();
    });

    new obsidian.Setting(containerEl)
      .setName('Synthesize from feedback')
      .setDesc('Read the feedback log and ask the local model to draft '
             + 'rules based on what you tend to reject. Opens a review '
             + 'modal; nothing is saved until you confirm.')
      .addButton((b) => b
        .setButtonText('Synthesize now')
        .onClick(() => this.plugin.synthesizeRulesFromFeedback()));

    containerEl.createEl('h3', { text: 'Feedback log' });
    const logPath = `${this.app.vault.configDir}/plugins/${this.plugin.manifest.id}/${FEEDBACK_FILE}`;
    containerEl.createEl('p', {
      text: 'Every Accept / Reject is appended to this file as one JSON '
          + 'line, with your optional note. Portable training data for a '
          + 'personalized filter later.',
      cls: 'setting-item-description',
    });
    const pathEl = containerEl.createEl('p', { cls: 'setting-item-description' });
    pathEl.createEl('code', { text: logPath });
  }
}

module.exports = CopyeditAIReviewPlugin;
