// TOS Companion: Docker container terminal and logs page (same-origin on TOS).
// Embeds TOS ttyd (/v2/ttyd) to run docker exec/logs; Container Manager's own
// WebSocket splits multi-byte UTF-8 across text frames and disconnects.
(function () {
  'use strict';
  if (window.__tosHelperDockerTerm) return;
  window.__tosHelperDockerTerm = true;

  const params = new URLSearchParams(location.search);
  const id = params.get('id') || '';
  const name = params.get('name') || id;
  const mode = params.get('mode') === 'logs' ? 'logs' : 'terminal';
  // Restrict container ID to hex to prevent shell injection.
  if (!/^[0-9a-f]{6,64}$/i.test(id)) {
    document.body.textContent = 'TOS Companion: missing or invalid container id.';
    return;
  }

  document.title = `${name} · ${mode === 'logs' ? 'logs' : 'terminal'}`;
  const style = document.createElement('style');
  style.textContent = `
    html, body { height: 100%; margin: 0; background: #000; color: #ddd; font: 13px system-ui, -apple-system, sans-serif; }
    body { display: flex; flex-direction: column; }
    #th-header { display: flex; align-items: center; gap: 10px; padding: 6px 12px; background: #2b2d31; border-bottom: 1px solid #3a3d43; }
    #th-header .name { font-weight: 600; color: #fff; }
    #th-header .host { color: #9aa0a6; }
    #th-header .status { margin-left: auto; color: #9aa0a6; }
    #th-header .status.bad { color: #f28b82; }
    #th-header button { padding: 3px 10px; border-radius: 5px; border: 1px solid #4a4d55; background: #3a3d44; color: #fff; cursor: pointer; font: inherit; }
    #th-frame { flex: 1; min-height: 0; border: 0; width: 100%; background: #000; }
  `;
  const header = document.createElement('div');
  header.id = 'th-header';
  const nameEl = Object.assign(document.createElement('span'), { className: 'name', textContent: mode === 'logs' ? `${name} logs` : name });
  const hostEl = Object.assign(document.createElement('span'), { className: 'host', textContent: location.host });
  const statusEl = Object.assign(document.createElement('span'), { className: 'status', textContent: 'Connecting…' });
  const restartBtn = Object.assign(document.createElement('button'), { textContent: 'Reconnect', title: mode === 'logs' ? 'Reload the logs' : 'Open a fresh shell in the container' });
  header.append(nameEl, hostEl, statusEl, restartBtn);
  const frame = document.createElement('iframe');
  frame.id = 'th-frame';
  document.head.appendChild(style);
  document.body.replaceChildren(header, frame);

  function setStatus(text, bad) {
    statusEl.textContent = text;
    statusEl.className = 'status' + (bad ? ' bad' : '');
  }

  // Terminal prefers bash over sh; logs follow the last 500 lines. Both exit on completion.
  const command = mode === 'logs'
    ? ` clear; docker logs -f --tail 500 ${id}; exit\r`
    : ` clear; docker exec -it -e LANG=C.UTF-8 -e TERM=xterm-256color ${id} sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'; exit\r`;

  function start() {
    setStatus('Connecting…');
    frame.src = '/v2/ttyd?' + Date.now();
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      let term = null;
      try { term = frame.contentWindow && frame.contentWindow.term; } catch (e) { /* not loaded yet */ }
      const core = term && term._core && term._core._coreService;
      // Wait for the shell prompt before sending the command.
      let ready = false;
      if (core && term.buffer && term.buffer.active) {
        const b = term.buffer.active;
        for (let i = 0; i < b.length && !ready; i++) {
          const line = b.getLine(i);
          if (line && line.translateToString(true).trim()) ready = true;
        }
      }
      if (ready) {
        clearInterval(timer);
        core.triggerDataEvent(command, true);
        setStatus('');
        term.focus();
      } else if (tries > 60) {
        clearInterval(timer);
        setStatus('Couldn’t open the TOS terminal. Are you signed in to TOS?', true);
      }
    }, 250);
  }

  restartBtn.addEventListener('click', start);
  start();
})();
