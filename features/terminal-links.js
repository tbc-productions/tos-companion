// TOS Companion: clickable terminal URLs (MAIN world, ttyd/xterm.js).
// Opens URLs on Cmd/Ctrl+click, including wrapped links and mouse-tracking apps.
(function () {
  'use strict';
  if (window.__tosHelperLinks) return;
  window.__tosHelperLinks = true;

  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const URL_RE = /\bhttps?:\/\/[^\s"'<>`─-╿]+/g;

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

  function modifierHeld(e) {
    return isMac ? e.metaKey : e.ctrlKey;
  }

  // Trim trailing punctuation and unbalanced closing brackets.
  function trimUrl(url) {
    let u = url.replace(/[.,;:!?'"]+$/, '');
    for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      while (u.endsWith(close) && u.split(open).length < u.split(close).length) u = u.slice(0, -1);
    }
    return u.replace(/[.,;:!?'"]+$/, '');
  }

  // Map mouse event to a buffer cell.
  function cellAt(term, e) {
    const screen = term.element && term.element.querySelector('.xterm-screen');
    if (!screen) return null;
    const r = screen.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (x < 0 || y < 0 || x > r.width || y > r.height) return null;
    const col = Math.floor(x / (r.width / term.cols));
    const row = Math.floor(y / (r.height / term.rows));
    return { col, row: term.buffer.active.viewportY + row };
  }

  // Find the URL at a buffer cell, joining soft-wrapped lines.
  function urlAt(term, cell) {
    const buf = term.buffer.active;
    let start = cell.row;
    while (start > 0 && buf.getLine(start) && buf.getLine(start).isWrapped) start--;
    let end = cell.row;
    while (buf.getLine(end + 1) && buf.getLine(end + 1).isWrapped) end++;
    let text = '';
    for (let i = start; i <= end; i++) {
      const line = buf.getLine(i);
      if (!line) break;
      text += line.translateToString(i === end);
    }
    const offset = (cell.row - start) * term.cols + cell.col;
    URL_RE.lastIndex = 0;
    let m;
    while ((m = URL_RE.exec(text))) {
      const url = trimUrl(m[0]);
      if (offset >= m.index && offset < m.index + url.length) return url;
    }
    return null;
  }

  function attach(term) {
    if (!term || !term.element || term.__tosHelperLinks) return;
    term.__tosHelperLinks = true;
    const el = term.element;
    let swallowUp = false;

    // Capture on window to run before xterm and mouse-tracking apps.
    window.addEventListener('mousedown', (e) => {
      swallowUp = false;
      if (e.button !== 0 || !modifierHeld(e) || !el.contains(e.target)) return;
      const cell = cellAt(term, e);
      const url = cell && urlAt(term, cell);
      if (!url) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      swallowUp = true;
      window.open(url, '_blank', 'noopener,noreferrer');
    }, true);

    // Suppress remaining click events so apps and ttyd's link handler don't also fire.
    window.addEventListener('mouseup', (e) => {
      if (!swallowUp) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
    window.addEventListener('click', (e) => {
      if (!swallowUp) return;
      swallowUp = false;
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);

    // Show pointer cursor over URLs while modifier is held.
    let hovering = false;
    window.addEventListener('mousemove', (e) => {
      let over = false;
      if (modifierHeld(e) && el.contains(e.target)) {
        const cell = cellAt(term, e);
        over = !!(cell && urlAt(term, cell));
      }
      if (over !== hovering) {
        hovering = over;
        el.style.cursor = over ? 'pointer' : '';
        const screen = el.querySelector('.xterm-screen');
        if (screen) screen.style.cursor = over ? 'pointer' : '';
      }
    }, true);

    console.log('[TOS Companion] terminal links enabled (' + (isMac ? 'Cmd' : 'Ctrl') + '+click)');
  }

  // Poll for xterm instances (ttyd recreates them on reconnect).
  setInterval(() => {
    if (document.querySelector('.xterm')) attach(findTerm());
  }, 1000);
})();
