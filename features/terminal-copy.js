// TOS Companion: terminal copy (MAIN world, ttyd/xterm.js).
// Handles OSC 52 clipboard writes and enables macOS Option+drag selection.
(function () {
  'use strict';
  if (window.__tosHelperCopy) return;
  window.__tosHelperCopy = true;

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

  function copyText(text, term) {
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) { /* ignore */ }
      ta.remove();
      term.focus();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(fallback);
    } else {
      fallback();
    }
  }

  function patch(term) {
    if (!term || term.__tosHelperPatched) return;
    term.__tosHelperPatched = true;

    try {
      if (term.setOption) term.setOption('macOptionClickForcesSelection', true);
      else term.options.macOptionClickForcesSelection = true;
    } catch (e) { /* ignore */ }

    if (term.parser && term.parser.registerOscHandler) {
      // OSC 52 payload: "<target>;<base64>"
      term.parser.registerOscHandler(52, (data) => {
        const b64 = data.slice(data.indexOf(';') + 1);
        if (!b64 || b64 === '?') return true; // ignore clipboard read requests
        try {
          const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
          copyText(new TextDecoder().decode(bytes), term);
        } catch (e) { /* ignore invalid payload */ }
        return true;
      });
    }
    console.log('[TOS Companion] terminal copy enabled');
  }

  // Poll for xterm instances (ttyd recreates them on reconnect).
  setInterval(() => {
    if (document.querySelector('.xterm')) patch(findTerm());
  }, 1000);
})();
