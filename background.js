// TOS Companion: background service worker (scripts, header rules, badge and TOS tab actions).

import { getSettings, hasHostPermission } from './lib/settings.js';
import { resolveAddress } from './lib/nas.js';
import { TosApi, NotSignedInError } from './lib/tos-api.js';

// Feature registry for injected scripts.
const FEATURES = {
  terminalCopy: {
    id: 'tos-terminal-copy',
    js: ['features/terminal-copy.js'],
    world: 'MAIN',      // needs page window.term (xterm.js)
    allFrames: true,    // TOS terminal runs in an iframe (/v2/ttyd)
    runAt: 'document_idle'
  },
  terminalLinks: {
    id: 'tos-terminal-links',
    js: ['features/terminal-links.js'],
    world: 'MAIN',
    allFrames: true,
    runAt: 'document_idle'
  },
  terminalSearch: {
    id: 'tos-terminal-search',
    js: ['features/terminal-search.js'],
    world: 'MAIN',
    allFrames: true,
    runAt: 'document_idle'
  }
};

const BADGE_ALARM = 'tos-badge';
// Minimal 404 path on the TOS origin used to host the Docker terminal/logs page.
const DOCKER_TERMINAL_PATH = '/msgcenter/tos-helper-terminal';

// ---- Content scripts ----

// Serialises script registration across concurrent lifecycle events; each script registers independently.
let syncQueue = Promise.resolve();
function syncScripts() {
  syncQueue = syncQueue.then(doSyncScripts, doSyncScripts);
  return syncQueue;
}

async function doSyncScripts() {
  const { hosts, features } = await getSettings();
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts();
    const ids = existing.map((s) => s.id);
    if (ids.length) await chrome.scripting.unregisterContentScripts({ ids });
  } catch (e) {
    console.warn('[TOS Companion] could not clear old scripts:', e);
  }

  const allowed = [];
  for (const h of hosts) if (await hasHostPermission(h)) allowed.push(h);
  await syncHeaderRules(allowed);
  if (!allowed.length) return;

  const scripts = Object.entries(FEATURES)
    .filter(([key]) => features[key])
    .map(([, f]) => ({ ...f, matches: allowed.map((h) => h + '/*'), persistAcrossSessions: true }));
  // Run Docker terminal/logs on the TOS origin so requests stay same-origin and signed in.
  scripts.push(DOCKER_PAGE_SCRIPT(allowed));
  for (const script of scripts) {
    try {
      await chrome.scripting.registerContentScripts([script]);
    } catch (e) {
      console.warn('[TOS Companion] could not register', script.id, e);
    }
  }
}

const DOCKER_PAGE_SCRIPT = (origins) => ({
  id: 'tos-docker-terminal',
  js: ['features/docker-terminal-page.js'],
  // MAIN world: requires window.term on the embedded terminal.
  world: 'MAIN',
  matches: origins.map((h) => h + DOCKER_TERMINAL_PATH + '*'),
  runAt: 'document_end',
  persistAcrossSessions: true
});

// Extension requests omit site cookies; session rules attach TOS cookies and Origin/Referer for allowed origins.
let ruleOrigins = [];

async function cookieHeader(origin) {
  try {
    const cookies = await chrome.cookies.getAll({ url: origin + '/' });
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch (e) {
    return '';
  }
}

async function syncHeaderRules(origins = ruleOrigins) {
  ruleOrigins = origins;
  try {
    const old = await chrome.declarativeNetRequest.getSessionRules();
    const addRules = [];
    for (const [i, origin] of origins.entries()) {
      const requestHeaders = [
        { header: 'Origin', operation: 'set', value: origin },
        { header: 'Referer', operation: 'set', value: origin + '/tos/' }
      ];
      const cookie = await cookieHeader(origin);
      if (cookie) requestHeaders.push({ header: 'Cookie', operation: 'set', value: cookie });
      addRules.push({
        id: i + 1,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders },
        condition: {
          requestDomains: [new URL(origin).hostname],
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: ['xmlhttprequest', 'websocket', 'image', 'other']
        }
      });
    }
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: old.map((r) => r.id),
      addRules
    });
  } catch (e) {
    console.warn('[TOS Companion] header rules not applied:', e);
  }
}

async function allowedOrigins() {
  const { hosts } = await getSettings();
  const allowed = [];
  for (const h of hosts) if (await hasHostPermission(h)) allowed.push(h);
  return allowed;
}

// Refresh header rules and badge when TOS cookies change.
let cookieTimer = null;
chrome.cookies.onChanged.addListener(({ cookie }) => {
  clearTimeout(cookieTimer);
  cookieTimer = setTimeout(async () => {
    const origins = ruleOrigins.length ? ruleOrigins : await allowedOrigins();
    const hit = origins.some((o) => {
      const h = new URL(o).hostname;
      const d = cookie.domain.replace(/^\./, '');
      return h === d || h.endsWith('.' + d);
    });
    if (hit) {
      await syncHeaderRules(origins);
      updateBadge();
    }
  }, 300);
});

// ---- Badge ----

// Default NAS (first with a permitted address) and its active host.
async function primaryNas() {
  const { nases } = await getSettings();
  for (const nas of nases) {
    for (const a of nas.addresses) {
      if (await hasHostPermission(a)) return { nas, host: await resolveAddress(nas) };
    }
  }
  return null;
}

async function getSeen() {
  const { seenNotificationIds = {} } = await chrome.storage.local.get('seenNotificationIds');
  return seenNotificationIds;
}

async function setSeen(host, maxId) {
  const seen = await getSeen();
  seen[host] = Math.max(seen[host] || 0, Number(maxId) || 0);
  await chrome.storage.local.set({ seenNotificationIds: seen });
}

async function updateBadge() {
  const { badge } = await getSettings();
  const allowed = await allowedOrigins();
  if (allowed.length) await syncHeaderRules(allowed);
  const primary = await primaryNas();
  const host = primary && primary.host;
  const key = primary && primary.nas.id;
  if (!badge.enabled || !host) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({ title: 'TOS Companion' });
    return;
  }
  try {
    const list = await new TosApi(host).notifications();
    const maxId = list.reduce((m, n) => Math.max(m, Number(n.id) || 0), 0);
    const seen = await getSeen();
    // First run: mark existing notifications as seen so the badge starts at 0.
    if (seen[key] === undefined) {
      await setSeen(key, maxId);
      seen[key] = maxId;
    }
    const unread = list.filter((n) => Number(n.id) > seen[key]).length;
    await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#ffffff' });
    const text = !unread ? '' : badge.style === 'dot' ? ' ' : (unread > 99 ? '99+' : String(unread));
    await chrome.action.setBadgeText({ text });
    await chrome.action.setTitle({
      title: unread ? `TOS Companion: ${unread} unread notification${unread === 1 ? '' : 's'}` : 'TOS Companion'
    });
  } catch (e) {
    await chrome.action.setBadgeText({ text: '' });
    await chrome.action.setTitle({
      title: e instanceof NotSignedInError ? 'TOS Companion (signed out of TOS)' : 'TOS Companion (TOS not reachable)'
    });
  }
}

async function syncAlarm() {
  const { badge } = await getSettings();
  await chrome.alarms.clear(BADGE_ALARM);
  if (badge.enabled) {
    const period = Math.max(0.5, Number(badge.intervalMin) || 1);
    await chrome.alarms.create(BADGE_ALARM, { delayInMinutes: period, periodInMinutes: period });
  }
  await updateBadge();
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === BADGE_ALARM) updateBadge();
});

// ---- Opening in TOS ----

// Injected into the TOS desktop (MAIN world) to open an app, notification link or settings.
function runInDesktop(kind, arg) {
  return new Promise((resolve) => {
    let tries = 0;
    const timer = setInterval(() => {
      let desktop = null;
      for (const el of document.querySelectorAll('body *')) {
        const vm = el.__vue__;
        if (vm && vm.$data && 'launchAppParams' in vm.$data) { desktop = vm; break; }
      }
      if (!desktop && ++tries < 60) return;
      clearInterval(timer);
      if (!desktop) return resolve(false);
      try {
        if (kind === 'app') desktop.openApp(arg);
        else if (kind === 'jump') desktop.$bus.$emit('messageClick', arg);
        else if (kind === 'notificationSettings') {
          desktop.$store.dispatch('setTabPath', { path: ['Control', 'Notice'], dialogId: 'Control' });
        } else if (kind === 'systemUpdate') {
          desktop.$store.dispatch('setTabPath', { path: ['Control', 'Update'], dialogId: 'Control' });
        }
        resolve(true);
      } catch (e) {
        resolve(false);
      }
    }, 250);
  });
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(done, 20000);
  });
}

async function openInTos(host, kind, arg) {
  const tabs = await chrome.tabs.query({ url: host + '/tos/*' });
  let tab = tabs.find((t) => t.active) || tabs[0];
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    // Navigate to desktop if the tab is still on the sign-in page.
    if (!/#\/desktop/.test(tab.url || '')) {
      const loaded = waitForTabComplete(tab.id);
      await chrome.tabs.update(tab.id, { url: host + '/tos/#/desktop' });
      await loaded;
    }
  } else {
    // Apps can launch directly via URL.
    const url = kind === 'app'
      ? `${host}/tos/#/desktop?launchApp=${encodeURIComponent(arg)}`
      : `${host}/tos/#/desktop`;
    tab = await chrome.tabs.create({ url });
    if (kind === 'app') return;
    await waitForTabComplete(tab.id);
  }
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: 'MAIN',
    func: runInDesktop,
    args: [kind, arg === undefined ? null : arg]
  });
}

const LIVE_TOPICS = ['cpu', 'mem', 'load', 'temp', 'net'];

function msgBusUrl(origin) {
  const { protocol, host } = new URL(origin);
  return `${protocol === 'http:' ? 'ws' : 'wss'}://${host}/msg_bus?token=${encodeURIComponent(btoa(new Date().toUTCString()))}`;
}

// Fallback, injected into an open TOS tab: reads each topic's last published sample.
// TOS only samples while a client is subscribed, so this is current only while the TOS
// desktop is open.
function collectLiveStats() {
  return new Promise((resolve) => {
    const c = document.cookie.split('; ').find((x) => x.startsWith('userName='));
    const user = c ? decodeURIComponent(c.slice('userName='.length)) : '';
    const topics = ['cpu', 'mem', 'load', 'temp', 'net'];
    const out = {};
    let sid = '';
    let ws;
    const finish = (err) => {
      try { ws && ws.close(); } catch (e) { /* ignore */ }
      resolve(err ? { error: err } : out);
    };
    try {
      ws = new WebSocket(`${location.protocol === 'http:' ? 'ws' : 'wss'}://${location.host}/msg_bus?token=${encodeURIComponent(btoa(new Date().toUTCString()))}`);
    } catch (e) {
      return resolve({ error: String(e) });
    }
    const send = (type, data, module = '') =>
      ws.send(JSON.stringify({ type, data, session_id: sid, time: Date.now(), user, module }));
    ws.onopen = () => send(0, '');
    ws.onmessage = (e) => {
      let o;
      try { o = JSON.parse(e.data); } catch (err) { return; }
      if (o.type === 0) {
        if (!o.is_ok) return finish('auth');
        sid = o.session_id;
        send(4, JSON.stringify('tosd/v1/events'), 'tosd/v1/events');
      } else if (o.type === 4) {
        for (const t of topics) send(1, JSON.stringify({ topic: t, action: 'last' }), 'tosd/v1/events');
      } else if (o.type === 1) {
        try {
          const d = JSON.parse(o.data);
          if (topics.includes(d.topic) && d.data) out[d.topic] = d.data.instant;
          if (topics.every((t) => t in out)) finish();
        } catch (err) { /* ignore */ }
      }
    };
    ws.onerror = () => finish('socket');
    setTimeout(() => finish(Object.keys(out).length ? null : 'timeout'), 4000);
  });
}

// Reads stats from any open TOS tab for the NAS; null if none is open.
async function liveStatsFromTab(hosts) {
  const tabs = await chrome.tabs.query({ url: hosts.map((h) => h + '/*') });
  // Prefer active, non-discarded tabs.
  tabs.sort((a, b) => (a.discarded - b.discarded) || (b.active - a.active));
  for (const tab of tabs) {
    if (tab.discarded) continue;
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: collectLiveStats });
      if (res && res.result && !res.result.error) return res.result;
    } catch (e) { /* try next tab */ }
  }
  return null;
}

// Live subscription for the popup's Overview tab. The popup holds a port open while Overview
// is shown; this subscribes to the message bus (TOS samples only while someone is subscribed),
// forwards each push, and unsubscribes when the port closes. The session header rules attach
// the TOS cookies and Origin, so no TOS tab is needed.
const LIVE_FIRST_SAMPLE_MS = 15000;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'liveStats') return;
  let ws = null;
  let sid = '';
  let user = '';
  let closed = false;
  let firstTimer = null;
  const out = {};

  const post = (msg) => { if (!closed) try { port.postMessage(msg); } catch (e) { /* popup gone */ } };
  const send = (type, data, module = '') =>
    ws.send(JSON.stringify({ type, data, session_id: sid, time: Date.now(), user, module }));
  const shutdown = () => {
    clearTimeout(firstTimer);
    if (!ws) return;
    try {
      if (ws.readyState === WebSocket.OPEN && sid) {
        for (const t of LIVE_TOPICS) send(1, JSON.stringify({ topic: t, action: 'unsub' }), 'tosd/v1/events');
      }
      ws.close();
    } catch (e) { /* ignore */ }
    ws = null;
  };
  const fail = (error) => {
    console.warn('[TOS Companion] live stats subscription failed:', error);
    post({ type: 'error', error });
    shutdown();
  };

  port.onDisconnect.addListener(() => { closed = true; shutdown(); });
  port.onMessage.addListener(async (msg) => {
    if (ws || !msg || !msg.host) return;
    const host = msg.host;
    if (!(await hasHostPermission(host))) return fail('permission');
    if (!ruleOrigins.includes(host)) await syncHeaderRules(await allowedOrigins());
    try {
      const c = await chrome.cookies.get({ url: host + '/', name: 'userName' });
      user = c ? decodeURIComponent(c.value) : '';
    } catch (e) { /* ignore */ }
    if (!user) return fail('signedout');
    if (closed) return;
    try {
      ws = new WebSocket(msgBusUrl(host));
    } catch (e) {
      return fail(String(e));
    }
    firstTimer = setTimeout(() => fail('timeout'), LIVE_FIRST_SAMPLE_MS);
    ws.onopen = () => send(0, '');
    ws.onmessage = (e) => {
      let o;
      try { o = JSON.parse(e.data); } catch (err) { return; }
      if (o.type === 0) {
        if (!o.is_ok) return fail('auth');
        sid = o.session_id;
        send(4, JSON.stringify('tosd/v1/events'), 'tosd/v1/events');
      } else if (o.type === 4) {
        for (const t of LIVE_TOPICS) send(1, JSON.stringify({ topic: t, action: 'sub' }), 'tosd/v1/events');
      } else if (o.type === 1) {
        try {
          const d = JSON.parse(o.data);
          if (!LIVE_TOPICS.includes(d.topic) || !d.data || !d.data.instant) return; // e.g. sub acks
          out[d.topic] = d.data.instant;
          clearTimeout(firstTimer);
          post({ type: 'stats', data: { ...out } });
        } catch (err) { /* ignore */ }
      }
    };
    ws.onerror = () => fail('socket');
    ws.onclose = () => { if (ws) fail('closed'); };
  });
});

// mode: 'terminal' | 'logs'
async function openDockerPage(host, container, mode) {
  const q = new URLSearchParams({ id: container.id, name: container.name, mode });
  const tab = await chrome.tabs.create({ url: `${host}${DOCKER_TERMINAL_PATH}?${q}` });
  // Also inject directly in case the registered script missed; the script guards against double runs.
  const current = await chrome.tabs.get(tab.id);
  if (current.status !== 'complete') await waitForTabComplete(tab.id);
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: ['features/docker-terminal-page.js'] });
  } catch (e) {
    console.warn('[TOS Companion] could not open the Docker page:', e);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'openApp': await openInTos(msg.host, 'app', msg.appId); break;
      case 'openJump': await openInTos(msg.host, 'jump', msg.jump); break;
      case 'openNotificationSettings': await openInTos(msg.host, 'notificationSettings'); break;
      case 'openSystemUpdate': await openInTos(msg.host, 'systemUpdate'); break;
      case 'openDockerTerminal': await openDockerPage(msg.host, msg.container, 'terminal'); break;
      case 'openDockerLogs': await openDockerPage(msg.host, msg.container, 'logs'); break;
      case 'markNotificationsSeen': await setSeen(msg.key, msg.maxId); await updateBadge(); break;
      case 'refreshBadge': await updateBadge(); break;
      case 'liveStats': return liveStatsFromTab(msg.hosts || [msg.host]);
      case 'syncRules': await syncHeaderRules(await allowedOrigins()); break;
    }
  })()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});

// ---- Lifecycle ----

async function syncAll() {
  await syncScripts();
  await syncAlarm();
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await syncAll();
  // Open settings on first install or if no NAS is configured.
  if (details.reason === 'install' || (details.reason === 'update' && !(await getSettings()).hosts.length)) {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html?welcome=1') });
  }
});
chrome.runtime.onStartup.addListener(syncAll);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync') syncAll();
});
chrome.permissions.onAdded.addListener(syncAll);
chrome.permissions.onRemoved.addListener(syncAll);
