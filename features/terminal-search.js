// TOS Companion: terminal scrollback search (MAIN world, ttyd/xterm.js).
// Cmd+F (Ctrl+Shift+F) opens; Enter/Shift+Enter navigates; Esc closes.
(function () {
  'use strict';
  if (window.__tosHelperSearch) return;
  window.__tosHelperSearch = true;

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  let term = null;
  let bar = null;
  let input, countEl, caseBtn;
  let matches = [];
  let current = -1;
  let caseSensitive = false;
  let timer = null;
  let lastQuery = null;

  function findTerm() {
    if (window.term && window.term.buffer) return window.term;
    for (const k of Object.keys(window)) {
      try {
        const v = window[k];
        if (v && v.buffer && v.buffer.active && v.parser) return v;
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  // ---- Searching ----

  function collectMatches(query) {
    const buf = term.buffer.active;
    const cols = term.cols;
    const found = [];
    if (!query) return found;
    const needle = caseSensitive ? query : query.toLowerCase();
    let row = 0;
    while (row < buf.length) {
      // Join soft-wrapped rows into a logical line.
      const start = row;
      let text = '';
      do {
        const line = buf.getLine(row);
        const next = buf.getLine(row + 1);
        const last = !(next && next.isWrapped);
        text += line ? line.translateToString(last) : '';
        row++;
        if (last) break;
      } while (row < buf.length);
      const hay = caseSensitive ? text : text.toLowerCase();
      let i = hay.indexOf(needle);
      while (i !== -1) {
        found.push({ row: start + Math.floor(i / cols), col: i % cols, len: needle.length });
        i = hay.indexOf(needle, i + Math.max(1, needle.length));
      }
    }
    return found;
  }

  function show(index) {
    if (!matches.length) {
      current = -1;
      term.clearSelection();
      updateCount();
      return;
    }
    current = (index + matches.length) % matches.length;
    const m = matches[current];
    term.select(m.col, m.row, m.len);
    const top = term.buffer.active.viewportY;
    if (m.row < top || m.row >= top + term.rows) {
      term.scrollToLine(Math.max(0, m.row - Math.floor(term.rows / 2)));
    }
    updateCount();
  }

  function run() {
    lastQuery = input.value;
    matches = collectMatches(input.value);
    // Start from the most recent match.
    show(matches.length - 1);
  }

  function updateCount() {
    if (!input.value) countEl.textContent = '';
    else if (!matches.length) countEl.textContent = 'No results';
    else countEl.textContent = `${current + 1} of ${matches.length}`;
    bar.classList.toggle('none', !!input.value && !matches.length);
  }

  // ---- UI ----

  function button(label, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
    b.addEventListener('click', onClick);
    return b;
  }

  function buildBar() {
    const style = document.createElement('style');
    style.textContent = `
      #tos-helper-search { position: fixed; top: 8px; right: 16px; z-index: 2147483647;
        display: flex; align-items: center; gap: 4px; padding: 4px 6px; border-radius: 8px;
        background: #2b2d31; border: 1px solid #4a4d55; box-shadow: 0 4px 16px rgba(0,0,0,.4);
        font: 12px system-ui, -apple-system, sans-serif; color: #e6e6e6; }
      #tos-helper-search[hidden] { display: none; }
      #tos-helper-search input { width: 200px; padding: 4px 6px; border-radius: 5px; outline: none;
        border: 1px solid #4a4d55; background: #1e1f22; color: #fff; font: inherit; }
      #tos-helper-search input:focus { border-color: #3b82f6; }
      #tos-helper-search.none input { border-color: #dc2626; }
      #tos-helper-search .count { min-width: 64px; text-align: center; color: #a1a1aa; }
      #tos-helper-search button { min-width: 24px; height: 24px; padding: 0 6px; border: 0; border-radius: 5px;
        background: transparent; color: #e6e6e6; font: inherit; cursor: pointer; }
      #tos-helper-search button:hover { background: #3a3d44; }
      #tos-helper-search button.on { background: #3b82f6; color: #fff; }
    `;
    document.head.appendChild(style);

    bar = document.createElement('div');
    bar.id = 'tos-helper-search';
    bar.hidden = true;
    input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Search terminal';
    input.spellcheck = false;
    countEl = document.createElement('span');
    countEl.className = 'count';
    caseBtn = button('Aa', 'Match case', () => {
      caseSensitive = !caseSensitive;
      caseBtn.classList.toggle('on', caseSensitive);
      run();
    });
    const up = button('↑', 'Older match (Enter)', () => show(current - 1));
    const down = button('↓', 'Newer match (Shift+Enter)', () => show(current + 1));
    const close = button('✕', 'Close (Esc)', hide);
    bar.append(input, countEl, caseBtn, up, down, close);
    document.body.appendChild(bar);

    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(run, 120);
    });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(timer);
        if (input.value !== lastQuery) run();
        else show(current + (e.shiftKey ? 1 : -1));
      } else if (e.key === 'Escape') {
        e.preventDefault();
        hide();
      }
    });
  }

  function open() {
    if (!bar) buildBar();
    bar.hidden = false;
    const sel = term.hasSelection() ? term.getSelection() : '';
    if (sel && !sel.includes('\n') && sel.length < 200) input.value = sel;
    input.focus();
    input.select();
    if (input.value) run();
  }

  function hide() {
    if (!bar) return;
    bar.hidden = true;
    matches = [];
    current = -1;
    lastQuery = null;
    if (term) {
      term.clearSelection();
      term.focus();
    }
  }

  function isOpenShortcut(e) {
    const k = (e.key || '').toLowerCase();
    return isMac ? (e.metaKey && !e.ctrlKey && !e.altKey && k === 'f')
                 : (e.ctrlKey && e.shiftKey && !e.altKey && k === 'f');
  }

  window.addEventListener('keydown', (e) => {
    if (!term || !isOpenShortcut(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    open();
  }, true);

  function watch(t) {
    if (!t || t.__tosHelperSearch) return;
    t.__tosHelperSearch = true;
    term = t;
    console.log('[TOS Companion] terminal search enabled (' + (isMac ? 'Cmd+F' : 'Ctrl+Shift+F') + ')');
  }

  setInterval(() => {
    if (document.querySelector('.xterm')) watch(findTerm());
  }, 1000);
})();
