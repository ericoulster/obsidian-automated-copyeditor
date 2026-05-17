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

const VIEW_TYPE = 'copyedit-ai-review-pane';
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8765/edit';
const DEFAULT_SETTINGS = {
  endpoint: DEFAULT_ENDPOINT,
  timeoutMs: 90000,
};


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

    const sugs = this.plugin.suggestions;
    const counts = header.createDiv({ cls: 'copyedit-ai-counts' });
    counts.setText(
      sugs.length === 0
        ? 'No pending suggestions. Run "Suggest edits on selection" from the command palette.'
        : `${sugs.length} pending suggestion${sugs.length === 1 ? '' : 's'}`
    );

    if (sugs.length > 0) {
      const actions = header.createDiv({ cls: 'copyedit-ai-bulk' });
      const acceptAll = actions.createEl('button', { text: 'Accept all' });
      acceptAll.addEventListener('click', () => this.plugin.acceptAll());
      const rejectAll = actions.createEl('button', { text: 'Reject all' });
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
      new obsidian.Notice('Copyedit AI error: ' + err.message);
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
        body: JSON.stringify({ passage }),
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

  // --- accept / reject ------------------------------------------------------

  async acceptSuggestion(id) {
    const idx = this.suggestions.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const sug = this.suggestions[idx];
    const applied = await this.applyToFile(sug);
    if (!applied.ok) {
      new obsidian.Notice(`Copyedit AI: could not apply (${applied.reason})`);
      return;
    }
    this.suggestions.splice(idx, 1);
    this.refreshPane();
  }

  rejectSuggestion(id) {
    const idx = this.suggestions.findIndex((s) => s.id === id);
    if (idx === -1) return;
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
    const hit = fuzzyFind(text, sug.original_text.trim());
    if (!hit) {
      new obsidian.Notice('Copyedit AI: span not found in current file.');
      return;
    }
    const from = editor.offsetToPos(hit.start);
    const to = editor.offsetToPos(hit.end);
    editor.setSelection(from, to);
    editor.scrollIntoView({ from, to }, true);
  }

  async acceptAll() {
    const ids = this.suggestions.map((s) => s.id);
    for (const id of ids) await this.acceptSuggestion(id);
  }

  rejectAll() {
    this.suggestions = [];
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
  }
}

module.exports = CopyeditAIReviewPlugin;
