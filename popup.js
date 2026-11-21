// TOS Companion popup: Overview, Apps, Notifications and Docker tabs.
import { getSettings, hasHostPermission, nasLabel } from './lib/settings.js';
import { resolveAddress } from './lib/nas.js';
import { TosApi, NotSignedInError } from './lib/tos-api.js';

const $ = (sel, root = document) => root.querySelector(sel);

const ICONS = {
  play: '<path fill="currentColor" d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11-6.86a1 1 0 0 0 0-1.72l-11-6.86A1 1 0 0 0 8 5.14Z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',
  restart: '<path fill="currentColor" d="M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7Z"/>',
  terminal: '<path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 2v12h16V6H4Zm2.3 2.3L10 12l-3.7 3.7-1.4-1.4L7.2 12 4.9 9.7l1.4-1.4ZM11 15h6v2h-6v-2Z"/>',
  close: '<path fill="currentColor" d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3 1.4 1.4Z" transform="translate(1.4 0)"/>',
  refresh: '<path fill="currentColor" d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35Z"/>',
  logs: '<path fill="currentColor" d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm8 1.5V8h4.5L14 3.5ZM7 11v2h10v-2H7Zm0 4v2h10v-2H7Zm0-8v2h5V7H7Z"/>',
  open: '<path fill="currentColor" d="M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42L17.59 5H14V3ZM5 5h6v2H5v12h12v-6h2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/>'
};

function icon(name, size = 16) {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${ICONS[name]}</svg>`;
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

function iconButton(name, title, onClick, extraClass = '') {
  return el('button', { class: 'icon-btn ' + extraClass, title, 'aria-label': title, html: icon(name), onclick: onClick });
}

let toastTimer;
function toast(message, isError = false) {
  let t = $('.toast');
  if (!t) { t = el('div', { class: 'toast' }); document.body.append(t); }
  t.textContent = message;
  t.classList.toggle('error', isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
}

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

// Seconds elapsed -> "3 days ago"; under a minute is "just now" unless withSeconds.
function agoText(sec, withSeconds = false) {
  sec = Math.max(0, Math.floor(sec));
  if (withSeconds && sec < 5) return 'just now';
  if (withSeconds && sec < 60) return `${sec} seconds ago`;
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [u, n] of units) {
    const v = Math.floor(sec / n);
    if (v >= 1) return `${v} ${u}${v === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

// "2026-11-18 00:00:38" -> "3 days ago"
function relativeTime(s) {
  const d = new Date(String(s).replace(' ', 'T'));
  if (isNaN(d)) return s || '';
  return agoText((Date.now() - d.getTime()) / 1000);
}

// ---- State ----

const state = {
  settings: null,
  nas: null, // selected NAS
  key: null, // NAS id (cache key)
  host: null, // active address
  api: null,
  tab: null,
  loaded: {}
};

function stateMessage(panel, text, action) {
  panel.replaceChildren(el('div', { class: 'state' }, el('div', {}, text), action || null));
}

function loading(panel) {
  stateMessage(panel, 'Loading…');
}

// Hide all tab panels and show the sign-in prompt.
function showSignedOut() {
  if (state.signedOut) return;
  state.signedOut = true;
  stopOverviewTimer();
  $('#tabs').style.visibility = 'hidden'; // preserve layout for the settings button
  for (const s of document.querySelectorAll('[data-panel]')) { s.hidden = true; s.replaceChildren(); }
  const panel = $('#panel-empty');
  panel.hidden = false;
  stateMessage(panel, 'You’re signed out of TOS.',
    el('button', { class: 'btn primary', onclick: () => { chrome.tabs.create({ url: state.host + '/tos/' }); window.close(); } }, 'Sign in to TOS'));
}

function cachedError(e) {
  if (e instanceof NotSignedInError) showSignedOut();
  else toast(e.message || String(e), true);
}

function handleError(panel, e, retry) {
  if (e instanceof NotSignedInError) {
    showSignedOut();
  } else {
    stateMessage(panel, String(e.message || e),
      el('button', { class: 'btn', onclick: retry }, 'Try again'));
    panel.querySelector('.state > div').classList.add('error');
  }
}

// ---- Apps ----

// Cache app lists and data-URL icons per NAS; refresh icons weekly or when new.
const ICON_MAX_AGE = 7 * 24 * 3600 * 1000;

async function loadAppCache() {
  const { appCache = {} } = await chrome.storage.local.get('appCache');
  return appCache[state.key] || { apps: [], icons: {} };
}

async function saveAppCache(entry) {
  const { appCache = {} } = await chrome.storage.local.get('appCache');
  appCache[state.key] = entry;
  await chrome.storage.local.set({ appCache });
}

function drawApps(panel, apps, icons) {
  const grid = el('div', { class: 'app-grid' });
  for (const app of apps) {
    const cached = icons[app.icon];
    const img = cached && cached.data
      ? el('img', { src: cached.data, alt: '' })
      : el('div', { class: 'ph' }, app.name.charAt(0));
    grid.append(el('button', {
      class: 'app',
      title: 'Open ' + app.name,
      onclick: async () => {
        await send({ type: 'openApp', host: state.host, appId: app.id });
        window.close();
      }
    }, img, el('span', {}, app.name)));
  }
  panel.replaceChildren(grid);
}

async function renderApps() {
  const panel = $('#panel-apps');
  const cache = await loadAppCache();
  if (cache.apps.length) drawApps(panel, cache.apps, cache.icons);
  else loading(panel);
  try {
    const apps = await state.api.apps();
    if (!apps.length) return stateMessage(panel, 'No apps found.');
    const icons = { ...cache.icons };
    const now = Date.now();
    const stale = apps.filter((a) => a.icon && (!icons[a.icon] || now - icons[a.icon].ts > ICON_MAX_AGE));
    // Render fresh list immediately, then fill in fetched icons.
    drawApps(panel, apps, icons);
    if (stale.length) {
      await Promise.all(stale.map(async (a) => {
        try {
          icons[a.icon] = { data: await state.api.imageDataUrl(a.icon), ts: now };
        } catch (e) {
          // Keep stale icon if present; otherwise retry in an hour.
          if (!icons[a.icon]) icons[a.icon] = { data: null, ts: now - ICON_MAX_AGE + 3600 * 1000 };
        }
      }));
      drawApps(panel, apps, icons);
    }
    // Prune icons for removed apps.
    const keep = new Set(apps.map((a) => a.icon));
    for (const k of Object.keys(icons)) if (!keep.has(k)) delete icons[k];
    await saveAppCache({ apps, icons });
  } catch (e) {
    if (!cache.apps.length) handleError(panel, e, renderApps);
    else cachedError(e);
  }
}

// ---- Notifications ----

async function seenId() {
  const { seenNotificationIds = {} } = await chrome.storage.local.get('seenNotificationIds');
  return seenNotificationIds[state.key];
}

// Red badge for unread count; grey for total when none are unread.
function setTabCount(unread, total) {
  const c = $('#notif-count');
  const n = unread || total || 0;
  c.hidden = !n;
  c.classList.toggle('muted', !unread);
  c.textContent = n > 99 ? '99+' : String(n);
  c.title = unread ? `${unread} new` : `${total} notification${total === 1 ? '' : 's'}`;
}

async function renderNotifications({ markSeen = true } = {}) {
  const panel = $('#panel-notifications');
  if (!panel.childElementCount) loading(panel);
  try {
    const list = await state.api.notifications();
    const seen = await seenId();
    const maxId = list.reduce((m, n) => Math.max(m, Number(n.id) || 0), 0);
    const unreadIds = new Set(seen === undefined ? [] : list.filter((n) => Number(n.id) > seen).map((n) => n.id));
    setTabCount(unreadIds.size, list.length);

    if (!list.length) {
      stateMessage(panel, 'No notifications.');
    } else {
      const toolbar = el('div', { class: 'toolbar' },
        el('span', {}, `${list.length} notification${list.length === 1 ? '' : 's'}`),
        el('div', { class: 'actions' },
          el('button', { class: 'btn link', onclick: () => { send({ type: 'openNotificationSettings', host: state.host }); window.close(); } }, 'Settings'),
          dismissAllButton()));
      const items = list.map((n) => notificationItem(n, unreadIds.has(n.id)));
      panel.replaceChildren(toolbar, ...items);
    }

    if (markSeen && maxId) {
      await send({ type: 'markNotificationsSeen', key: state.key, maxId });
      // Keep unread highlights but clear the unread count.
      setTabCount(0, list.length);
    }
  } catch (e) {
    handleError(panel, e, () => renderNotifications());
  }
}

function dismissAllButton() {
  let armed = false;
  const b = el('button', { class: 'btn link' }, 'Dismiss all');
  b.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      b.textContent = 'Click again to dismiss all';
      setTimeout(() => { armed = false; b.textContent = 'Dismiss all'; }, 3000);
      return;
    }
    try {
      await state.api.dismissAllNotifications();
      setTabCount(0, 0);
      await renderNotifications();
      send({ type: 'refreshBadge' });
    } catch (e) {
      toast(e.message || String(e), true);
    }
  });
  return b;
}

function notificationItem(n, unread) {
  const item = el('div', { class: 'notif' + (unread ? ' unread' : '') },
    el('span', { class: 'dot ' + n.level }),
    el('div', { class: 'title' }, n.title || 'Notification'),
    iconButton('close', 'Dismiss', async () => {
      item.style.opacity = '.4';
      try {
        await state.api.dismissNotification(n.id);
        item.remove();
        send({ type: 'refreshBadge' });
        if (!$('#panel-notifications .notif')) renderNotifications();
        else {
          const label = $('#panel-notifications .toolbar > span');
          const left = document.querySelectorAll('#panel-notifications .notif').length;
          if (label) label.textContent = `${left} notification${left === 1 ? '' : 's'}`;
          setTabCount(0, left);
        }
      } catch (e) {
        item.style.opacity = '';
        toast(e.message || String(e), true);
      }
    }),
    el('div', { class: 'detail' }, n.detail || ''),
    el('div', { class: 'meta' },
      el('span', { title: n.time }, relativeTime(n.time)),
      n.jump ? el('button', {
        class: 'btn link',
        onclick: async () => {
          await send({ type: 'openJump', host: state.host, jump: n.jump });
          window.close();
        }
      }, 'View details') : el('span')));
  return item;
}

// ---- Docker ----

function containerStatusClass(state) {
  const s = String(state).toLowerCase();
  if (s === 'running') return 'running';
  if (s === 'restarting') return 'restarting';
  if (/error|dead|interrupt/.test(s)) return 'error';
  return '';
}

function projectStatusClass(p, containers) {
  if (String(p.status).toLowerCase() !== 'running') return '';
  const kids = containers.filter((c) => c.project === p.name);
  if (kids.length && kids.some((c) => containerStatusClass(c.state) !== 'running')) return 'partial';
  return 'running';
}

async function runAction(row, fn, doneMessage) {
  row.classList.add('busy');
  try {
    await fn();
    toast(doneMessage);
    // Brief delay for Docker to update state.
    setTimeout(renderDocker, 1200);
  } catch (e) {
    row.classList.remove('busy');
    toast(e.message || String(e), true);
  }
}

function hostOf() {
  return new URL(state.host).hostname;
}

function projectRow(p, containers) {
  const running = String(p.status).toLowerCase() === 'running';
  const row = el('div', { class: 'row' });
  row.append(
    el('span', { class: 'status ' + projectStatusClass(p, containers), title: p.statusDesc || p.status }),
    el('div', { class: 'info' },
      el('div', { class: 'name', title: p.path }, p.name),
      el('div', { class: 'sub' }, `Project · ${p.statusDesc || p.status || 'unknown'}`)),
    el('div', { class: 'btns' },
      running
        ? [
            iconButton('restart', 'Restart project', () => runAction(row, () => state.api.projectAction(p.name, 'restart'), `Restarting ${p.name}`)),
            iconButton('stop', 'Stop project', () => runAction(row, () => state.api.projectAction(p.name, 'stop'), `Stopping ${p.name}`), 'danger')
          ]
        : iconButton('play', 'Start project', () => runAction(row, () => state.api.projectAction(p.name, 'run'), `Starting ${p.name}`))));
  return row;
}

function containerRow(c, child) {
  const running = containerStatusClass(c.state) === 'running';
  const row = el('div', { class: 'row' + (child ? ' child' : '') });
  const sub = el('div', { class: 'sub' }, running ? c.uptime : (c.state || c.uptime || ''));
  if (running && c.ports.length) {
    for (const port of c.ports.slice(0, 3)) {
      const proto = /^(443|8443|5443|9443)$/.test(port) ? 'https' : 'http';
      sub.append(' · ', el('a', {
        href: `${proto}://${hostOf()}:${port}`,
        title: `Open port ${port}`,
        onclick: (e) => { e.preventDefault(); chrome.tabs.create({ url: e.currentTarget.href }); window.close(); }
      }, ':' + port));
    }
  }
  row.append(
    el('span', { class: 'status ' + containerStatusClass(c.state), title: c.state }),
    el('div', { class: 'info' },
      el('div', { class: 'name', title: c.image }, c.name),
      sub),
    el('div', { class: 'btns' },
      running
        ? [
            iconButton('terminal', 'Open terminal', async () => {
              await send({ type: 'openDockerTerminal', host: state.host, container: { id: c.id, name: c.name } });
              window.close();
            }),
            logsButton(c),
            iconButton('restart', 'Restart container', () => runAction(row, () => state.api.containerAction(c, 'restart'), `Restarting ${c.name}`)),
            iconButton('stop', 'Stop container', () => runAction(row, () => state.api.containerAction(c, 'stop'), `Stopping ${c.name}`), 'danger')
          ]
        : [
            logsButton(c),
            iconButton('play', 'Start container', () => runAction(row, () => state.api.containerAction(c, 'start'), `Starting ${c.name}`))
          ]));
  return row;
}

function logsButton(c) {
  return iconButton('logs', 'View logs', async () => {
    await send({ type: 'openDockerLogs', host: state.host, container: { id: c.id, name: c.name } });
    window.close();
  });
}

// Cache Docker state per NAS for instant display; refreshed on each open.
async function loadDockerCache() {
  const { dockerCache = {} } = await chrome.storage.local.get('dockerCache');
  return dockerCache[state.key] || null;
}

async function saveDockerCache(projects, containers) {
  const { dockerCache = {} } = await chrome.storage.local.get('dockerCache');
  dockerCache[state.key] = { projects, containers, ts: Date.now() };
  await chrome.storage.local.set({ dockerCache });
}

function drawDocker(panel, projects, containers, updating) {
  const runningCount = containers.filter((c) => containerStatusClass(c.state) === 'running').length;
  const refreshBtn = iconButton('refresh', updating ? 'Updating…' : 'Refresh', renderDocker);
  if (updating) refreshBtn.querySelector('svg').classList.add('spin');
  const toolbar = el('div', { class: 'toolbar' },
    el('span', {}, `${runningCount} of ${containers.length} containers running`),
    el('div', { class: 'actions' },
      el('button', { class: 'btn link', onclick: async () => { await send({ type: 'openApp', host: state.host, appId: 'docker' }); window.close(); } }, 'Container Manager'),
      refreshBtn));

  const nodes = [toolbar];
  const names = new Set(projects.map((p) => p.name));
  if (projects.length) {
    nodes.push(el('div', { class: 'group-title' }, 'Projects'));
    for (const p of [...projects].sort((a, b) => a.name.localeCompare(b.name))) {
      nodes.push(projectRow(p, containers));
      for (const c of containers.filter((c) => c.project === p.name).sort((a, b) => a.name.localeCompare(b.name))) {
        nodes.push(containerRow(c, true));
      }
    }
  }
  const loose = containers.filter((c) => !c.project || !names.has(c.project));
  if (loose.length) {
    nodes.push(el('div', { class: 'group-title' }, projects.length ? 'Other containers' : 'Containers'));
    for (const c of [...loose].sort((a, b) => a.name.localeCompare(b.name))) nodes.push(containerRow(c, false));
  }
  if (!projects.length && !containers.length) nodes.push(el('p', { class: 'empty' }, 'No projects or containers.'));
  const scroll = panel.parentElement ? panel.parentElement.scrollTop : 0;
  panel.replaceChildren(...nodes);
  if (panel.parentElement) panel.parentElement.scrollTop = scroll;
}

let dockerSeq = 0;
async function renderDocker() {
  const panel = $('#panel-docker');
  const seq = ++dockerSeq;
  const cache = await loadDockerCache();
  if (panel.querySelector('.row')) {
    // Spin refresh icon while updating visible rows.
    const icon = panel.querySelector('.toolbar .icon-btn svg');
    if (icon) icon.classList.add('spin');
  } else if (cache) {
    drawDocker(panel, cache.projects, cache.containers, true);
  } else {
    loading(panel);
  }
  try {
    const [projects, containers] = await Promise.all([state.api.projects(), state.api.containers()]);
    if (seq !== dockerSeq) return; // superseded by a newer refresh
    drawDocker(panel, projects, containers, false);
    await saveDockerCache(projects, containers);
  } catch (e) {
    if (seq !== dockerSeq) return;
    if (cache) {
      drawDocker(panel, cache.projects, cache.containers, false);
      cachedError(e);
    } else {
      handleError(panel, e, renderDocker);
    }
  }
}

// ---- Overview ----

function fmtUptime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} day${d === 1 ? '' : 's'}, ${h} hr`;
  if (h) return `${h} hr ${m} min`;
  return `${m} min`;
}

function fmtRate(bytes) {
  const n = Number(bytes);
  if (!isFinite(n)) return '–';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function fmtBytes(v) {
  const n = Number(v);
  if (!isFinite(n)) return String(v);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let x = n, i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x >= 100 || i === 0 ? Math.round(x) : x.toFixed(1)} ${units[i]}`;
}

function fmtTemp(v) {
  const n = parseFloat(v);
  return isFinite(n) ? `${Math.round(n)} °C` : '–';
}

function fmtPct(v) {
  const n = parseFloat(v);
  return isFinite(n) ? `${n < 10 ? n.toFixed(1) : Math.round(n)}%` : '–';
}

function bar(pct) {
  const n = Math.min(100, Math.max(0, parseFloat(pct) || 0));
  const b = el('div', { class: 'bar' + (n >= 90 ? ' high' : n >= 75 ? ' mid' : '') });
  b.append(el('span', { style: `width:${n}%` }));
  return b;
}

function statRow(label, value, extra) {
  return el('div', { class: 'stat' }, el('span', { class: 'label' }, label), el('span', { class: 'value' }, value), extra || null);
}

function card(title, ...rows) {
  return el('div', { class: 'card' }, el('div', { class: 'group-title' }, title), ...rows);
}

const LIVE_ONLY = 'Open TOS for this';

// Stats older than this are hidden: at least 15 s, or three polling intervals.
function staleAfterMs() {
  const sec = Math.max(1, Number(state.settings.popup.statsIntervalSec) || 5);
  return Math.max(15, sec * 3) * 1000;
}

let staleTimer = null;

function updatedText(ts) {
  const s = agoText((Date.now() - ts) / 1000, true);
  return 'Updated ' + s;
}

// Keeps the relative "Updated …" label current between redraws.
let updatedTicker = null;
function startUpdatedTicker() {
  if (updatedTicker) return;
  updatedTicker = setInterval(() => {
    const u = document.querySelector('#panel-overview .updated');
    if (u && u.dataset.ts) u.textContent = updatedText(Number(u.dataset.ts));
  }, 1000);
}

function drawOverview(panel, data) {
  const now = Date.now();
  const maxAge = staleAfterMs();
  const isFresh = (ts) => !!ts && now - ts < maxAge;
  const live = isFresh(data.liveTs) ? data.live : null;
  const usage = (isFresh(data.usageTs) && data.usage) || {};
  const { info = {}, volumes = [] } = data;
  const L = live || {};
  const load = L.load, cpu = L.cpu, mem = L.mem, temp = L.temp;
  const net = Array.isArray(L.net) ? (L.net.find((n) => n.if === 'all') || L.net[0]) : L.net;
  const dash = () => el('span', { class: 'muted' }, '–');

  const cpuPct = cpu && cpu.cpud != null ? cpu.cpud : usage.cpu;
  const memPct = mem && mem.mem != null ? mem.mem : usage.mem;
  let memText = fmtPct(memPct);
  if (mem && mem.memUsed && mem.memTotal) memText += ` · ${fmtBytes(mem.memUsed)} of ${fmtBytes(mem.memTotal)}`;
  else if (usage.memTotal) memText += ` of ${usage.memTotal}`;

  const versionValue = [info.version || '–'];
  if (data.updateVersion && data.updateVersion !== info.version) {
    versionValue.push(' ', el('button', {
      class: 'btn link',
      title: `TOS ${data.updateVersion} available`,
      onclick: async () => {
        await send({ type: 'openSystemUpdate', host: state.host });
        window.close();
      }
    }, '(update)'));
  }

  const nodes = [
    card('Device',
      statRow('Name', info.name || '–'),
      statRow('Model', info.model || '–'),
      statRow('TOS version', versionValue),
      statRow('Uptime', info.uptime ? fmtUptime(info.uptime + (data.ts ? (Date.now() - data.ts) / 1000 : 0)) : '–')),
    card('Resources',
      statRow('Load', load ? `${load.one} · ${load.five} · ${load.fifteen}` : dash(), load && load.pro != null ? bar(load.pro) : null),
      statRow('CPU', cpuPct != null ? fmtPct(cpuPct) : dash(), cpuPct != null ? bar(cpuPct) : null),
      statRow('Memory', memPct != null ? memText : dash(), memPct != null ? bar(memPct) : null)),
    card('Network',
      statRow('Upload', net ? fmtRate(net.up) : dash()),
      statRow('Download', net ? fmtRate(net.down) : dash()))
  ];

  const vols = volumes.map((v) => el('div', { class: 'stat vol' },
    el('span', { class: 'label' }, v.name),
    el('span', { class: 'value' },
      el('span', { class: 'health ' + (v.healthy ? 'ok' : 'bad') }, v.health || '–'),
      ` · ${v.used || '–'} of ${v.total || '–'} (${fmtPct(v.usage)})`),
    bar(v.usage)));
  nodes.push(card('Volumes', ...(vols.length ? vols : [el('p', { class: 'empty small' }, 'No volumes.')])));

  const hw = [
    statRow('Device temperature', temp ? fmtTemp(temp.sys) : dash()),
    statRow('CPU temperature', temp ? fmtTemp(temp.cpu != null ? temp.cpu : load && load.cputemp) : dash())
  ];
  if (temp && Array.isArray(temp.disk) && temp.disk.length) {
    for (const d of [...temp.disk].sort((a, b) => String(a.device).localeCompare(String(b.device), undefined, { numeric: true }))) hw.push(statRow(`${d.device || 'Disk'} temperature`, fmtTemp(d.value)));
  } else {
    hw.push(statRow('Disk temperature', dash()));
  }
  hw.push(statRow('Fan speed', temp && temp.fan != null ? `${temp.fan} RPM` : dash()));
  nodes.push(card('Hardware', ...hw));

  // Hold the note while the subscription waits for its first sample (~5 s).
  if (!live && !(liveSub && liveSub.status === 'connecting')) {
    nodes.push(el('div', { class: 'note' },
      el('span', {}, 'Couldn’t get live stats from TOS. Load, network, temperatures and fan speed show while a TOS tab is open.'),
      el('button', { class: 'btn link', onclick: () => { chrome.tabs.create({ url: state.host + '/tos/', active: false }); setTimeout(refreshOverview, 4000); } }, 'Open TOS')));
  }

  const lastTs = Math.max(data.liveTs || 0, data.usageTs || 0);
  if (lastTs) {
    const d = new Date(lastTs);
    nodes.push(el('div', { class: 'updated', title: d.toLocaleString(), 'data-ts': String(lastTs) }, updatedText(lastTs)));
  }

  const scroll = panel.parentElement ? panel.parentElement.scrollTop : 0;
  panel.replaceChildren(...nodes);
  if (panel.parentElement) panel.parentElement.scrollTop = scroll;

  // Redraw when the oldest shown values go stale, in case polling has stalled.
  clearTimeout(staleTimer);
  const shown = [live && data.liveTs, usage.cpu != null && data.usageTs].filter(Boolean);
  if (shown.length) {
    const wait = Math.min(...shown) + maxAge - now;
    staleTimer = setTimeout(() => {
      if (state.tab === 'overview' && overviewData) drawOverview(panel, overviewData);
    }, Math.max(0, wait) + 50);
  }
}

async function loadOverviewCache() {
  const { overviewCache = {} } = await chrome.storage.local.get('overviewCache');
  return overviewCache[state.key] || null;
}

async function saveOverviewCache(data) {
  const { overviewCache = {} } = await chrome.storage.local.get('overviewCache');
  overviewCache[state.key] = data;
  await chrome.storage.local.set({ overviewCache });
}

const UPDATE_MAX_AGE = 6 * 3600 * 1000;

let overviewData = null;
let overviewTimer = null;
let overviewBusy = false;
let updateChecking = false;

// Live subscription held open (via the background) while Overview is shown.
// status: 'connecting' until the first sample, then 'ok', or 'failed'.
let liveSub = null;

function startLiveSub() {
  if (liveSub) return;
  const sub = { port: chrome.runtime.connect({ name: 'liveStats' }), sample: null, ts: 0, status: 'connecting' };
  liveSub = sub;
  sub.port.onMessage.addListener((msg) => {
    if (liveSub !== sub) return;
    if (msg.type === 'stats') {
      const first = sub.status !== 'ok';
      sub.sample = msg.data;
      sub.ts = Date.now();
      sub.status = 'ok';
      // Show the first sample straight away rather than waiting for the next tick.
      if (first && overviewData && overviewData.info && !overviewBusy) {
        overviewData = { ...overviewData, live: sub.sample, liveTs: sub.ts };
        if (state.tab === 'overview') drawOverview($('#panel-overview'), overviewData);
      }
    } else if (msg.type === 'error') {
      sub.status = 'failed';
      if (overviewData && state.tab === 'overview') drawOverview($('#panel-overview'), overviewData);
    }
  });
  sub.port.onDisconnect.addListener(() => { if (liveSub === sub) sub.status = 'failed'; });
  sub.port.postMessage({ host: state.host });
}

function stopLiveSub() {
  if (!liveSub) return;
  try { liveSub.port.disconnect(); } catch (e) { /* ignore */ }
  liveSub = null;
}

// Latest live stats as { live, ts }: the subscription's newest sample, else an open TOS tab.
async function fetchLive() {
  if (liveSub && liveSub.sample && Date.now() - liveSub.ts < staleAfterMs()) {
    return { live: liveSub.sample, ts: liveSub.ts };
  }
  try {
    const res = await send({ type: 'liveStats', hosts: state.nas.addresses });
    return res && res.ok && res.result ? { live: res.result, ts: Date.now() } : { live: null };
  } catch (e) {
    return { live: null };
  }
}

// Poll live stats frequently; fetch slower REST endpoints less often.
async function refreshOverview(full = false) {
  if (overviewBusy) return;
  overviewBusy = true;
  const panel = $('#panel-overview');
  try {
    if (full || !overviewData || !overviewData.fresh) {
      const [info, volumes, { live, ts: liveTs }] = await Promise.all([state.api.systemInfo(), state.api.volumes(), fetchLive()]);
      const prev = overviewData || {};
      const verChanged = prev.updateForVersion && info.version && prev.updateForVersion !== info.version;
      overviewData = {
        ...prev,
        info,
        volumes,
        // Keep the last good sample until it goes stale.
        ...(live ? { live, liveTs } : {}),
        ...(verChanged ? { updateVersion: null, updateCheckedAt: 0 } : {}),
        ts: Date.now(),
        fresh: true
      };
      if (state.tab === 'overview') drawOverview(panel, overviewData);
      // Cache update check for 6 hours so slow endpoint doesn't delay rendering.
      if (!updateChecking && (!overviewData.updateCheckedAt || Date.now() - overviewData.updateCheckedAt > UPDATE_MAX_AGE || overviewData.updateForVersion !== (info.version || ''))) {
        updateChecking = true;
        const key = state.key;
        const api = state.api;
        const currentVer = info.version || '';
        api.checkUpdate().then((updateVersion) => {
          if (state.key !== key || !overviewData) return;
          overviewData = { ...overviewData, updateVersion, updateCheckedAt: Date.now(), updateForVersion: currentVer };
          if (state.tab === 'overview') drawOverview(panel, overviewData);
          saveOverviewCache({ ...overviewData, fresh: false });
        }).catch(() => {}).finally(() => { updateChecking = false; });
      }
      // REST CPU/memory fallback (~3 s) when live stats are unavailable.
      if (!live) {
        state.api.hardwareUsage().then((usage) => {
          overviewData = { ...overviewData, usage, usageTs: Date.now() };
          if (state.tab === 'overview') drawOverview(panel, overviewData);
          saveOverviewCache({ ...overviewData, fresh: false });
        }).catch(() => {});
      }
    } else {
      const { live, ts: liveTs } = await fetchLive();
      if (live) overviewData = { ...overviewData, live, liveTs };
      if (!live) {
        const usage = await state.api.hardwareUsage().catch(() => null);
        if (usage) overviewData = { ...overviewData, usage, usageTs: Date.now() };
      }
      if (state.tab === 'overview') drawOverview(panel, overviewData);
    }
    await saveOverviewCache({ ...overviewData, fresh: false });
  } catch (e) {
    if (!overviewData || !overviewData.info) handleError(panel, e, () => refreshOverview(true));
    else cachedError(e);
  } finally {
    overviewBusy = false;
  }
}

async function renderOverview() {
  const panel = $('#panel-overview');
  const cache = await loadOverviewCache();
  if (cache && !overviewData) {
    overviewData = cache;
    drawOverview(panel, cache);
  } else if (!overviewData) {
    loading(panel);
  }
  if (state.tab === 'overview') startLiveSub();
  await refreshOverview(true);
  startOverviewTimer();
}

// Stats are polled only while the Overview tab is shown.
function startOverviewTimer() {
  clearInterval(overviewTimer);
  if (state.tab !== 'overview' || state.signedOut) return stopOverviewTimer();
  startLiveSub();
  startUpdatedTicker();
  const sec = Math.max(1, Number(state.settings.popup.statsIntervalSec) || 5);
  overviewTimer = setInterval(() => {
    if (state.tab === 'overview') refreshOverview();
    else stopOverviewTimer();
  }, sec * 1000);
}

function stopOverviewTimer() {
  clearInterval(overviewTimer);
  overviewTimer = null;
  clearInterval(updatedTicker);
  updatedTicker = null;
  stopLiveSub();
}

// ---- Tabs ----

const RENDER = { overview: renderOverview, apps: renderApps, notifications: renderNotifications, docker: renderDocker };

function visibleTabs() {
  const p = state.settings.popup;
  return [
    'overview', // always shown
    p.showApps && 'apps',
    p.showNotifications && 'notifications',
    p.showDocker && 'docker'
  ].filter(Boolean);
}

async function selectTab(name) {
  if (state.signedOut) return;
  state.tab = name;
  if (name !== 'overview') stopOverviewTimer();
  for (const b of document.querySelectorAll('#tabs button')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === name));
  }
  for (const s of document.querySelectorAll('[data-panel]')) s.hidden = s.dataset.panel !== name;
  try { await chrome.storage.local.set({ lastPopupTab: name }); } catch (e) { /* ignore */ }
  if (!state.loaded[name]) {
    state.loaded[name] = true;
    await RENDER[name]();
  } else if (name === 'notifications') {
    renderNotifications();
  } else if (name === 'overview') {
    startOverviewTimer();
    refreshOverview();
  }
}

// NAS devices with at least one permitted address.
async function usableNases() {
  const out = [];
  for (const nas of state.settings.nases) {
    for (const a of nas.addresses) if (await hasHostPermission(a)) { out.push(nas); break; }
  }
  return out;
}

async function useNas(nas) {
  state.nas = nas;
  state.key = nas.id;
  state.host = await resolveAddress(nas);
  state.api = new TosApi(state.host);
}

async function init() {
  state.settings = await getSettings();
  $('#open-settings').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });

  const nases = await usableNases();
  const tabs = visibleTabs();
  for (const b of document.querySelectorAll('#tabs button')) {
    b.hidden = !tabs.includes(b.dataset.tab);
    b.addEventListener('click', () => selectTab(b.dataset.tab));
  }

  if (!nases.length) {
    $('#tabs').hidden = true;
    const panel = $('#panel-empty');
    panel.hidden = false;
    stateMessage(panel, 'Add your TOS address in settings to get started.',
      el('button', { class: 'btn primary', onclick: () => { chrome.runtime.openOptionsPage(); window.close(); } }, 'Open settings'));
    return;
  }

  const { lastPopupNas } = await chrome.storage.local.get('lastPopupNas');
  // Ensure TOS cookie rules are active before API requests.
  await send({ type: 'syncRules' }).catch(() => {});
  await useNas(nases.find((n) => n.id === lastPopupNas) || nases[0]);

  if (nases.length > 1) {
    const sel = $('#host-select');
    for (const n of nases) sel.append(el('option', { value: n.id, selected: n.id === state.key }, nasLabel(n)));
    $('#host-row').hidden = false;
    sel.addEventListener('change', async () => {
      stopOverviewTimer(); // drop the old NAS's subscription
      await useNas(nases.find((n) => n.id === sel.value));
      state.loaded = {};
      state.signedOut = false;
      $('#tabs').style.visibility = '';
      $('#panel-empty').hidden = true;
      overviewData = null;
      updateChecking = false;
      for (const s of document.querySelectorAll('[data-panel]')) s.replaceChildren();
      await chrome.storage.local.set({ lastPopupNas: state.key });
      selectTab(state.tab);
    });
  }

  if (!tabs.length) {
    $('#panel-empty').hidden = false;
    return;
  }

  // Populate notification count badge upfront.
  if (tabs.includes('notifications')) {
    state.api.notifications().then(async (list) => {
      const seen = await seenId();
      if (state.tab === 'notifications') return;
      setTabCount(seen === undefined ? 0 : list.filter((n) => Number(n.id) > seen).length, list.length);
    }).catch(() => {});
  }

  const { lastPopupTab } = await chrome.storage.local.get('lastPopupTab');
  const pref = state.settings.popup.defaultTab;
  const first = pref !== 'last' && tabs.includes(pref) ? pref
    : tabs.includes(lastPopupTab) ? lastPopupTab
    : tabs[0];
  selectTab(first);
}

init();
