import { getSettings, saveSection, hasHostPermission, saveNases, newNasId, nasLabel } from './lib/settings.js';
import { TosApi } from './lib/tos-api.js';

const $ = (id) => document.getElementById(id);
const isMac = /Mac/.test(navigator.platform || navigator.userAgent);

if (!isMac) {
  $('links-hint').textContent = $('links-hint').textContent.replace('Cmd+click', 'Ctrl+click');
  $('search-hint').textContent = $('search-hint').textContent.replace('Cmd+F', 'Ctrl+Shift+F');
}

let savedTimer;
function flashSaved() {
  $('saved').textContent = 'Saved';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { $('saved').textContent = ''; }, 1500);
}

// ---- Settings controls ----

async function renderOptions() {
  const s = await getSettings();
  for (const input of document.querySelectorAll('[data-section]')) {
    const v = s[input.dataset.section][input.dataset.key];
    if (input.type === 'checkbox') input.checked = !!v;
    else input.value = v;
  }
}

for (const input of document.querySelectorAll('[data-section]')) {
  input.addEventListener('change', async () => {
    let value;
    if (input.type === 'checkbox') value = input.checked;
    else if (input.type === 'number') {
      value = Math.min(60, Math.max(0.5, Number(input.value) || 1));
      input.value = value;
    } else value = input.value;
    await saveSection(input.dataset.section, { [input.dataset.key]: value });
    flashSaved();
  });
}

// ---- NAS addresses ----

function make(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

function parseOrigin(text) {
  try {
    const origin = new URL(text.trim()).origin;
    if (/^https?:/.test(origin)) return origin;
  } catch (e) { /* fall through */ }
  return null;
}

// Must run directly from a user click to trigger the permission prompt.
async function askForAccess(origin) {
  try { return await chrome.permissions.request({ origins: [origin + '/*'] }); } catch (e) { return false; }
}

// Fetch NAS name and device ID if reachable and signed in.
async function describe(origin) {
  try {
    await chrome.runtime.sendMessage({ type: 'syncRules' });
    const info = await new TosApi(origin).systemInfo();
    return info;
  } catch (e) {
    return null;
  }
}

async function update(fn) {
  const s = await getSettings();
  const nases = s.nases.map((n) => ({ ...n, addresses: [...n.addresses] }));
  fn(nases);
  await saveNases(nases.filter((n) => n.addresses.length));
  renderHosts();
  flashSaved();
}

async function renderHosts() {
  const s = await getSettings();
  const box = $('nases');
  const cards = [];
  for (const [i, nas] of s.nases.entries()) {
    const name = make('input', { type: 'text', value: nas.name || '', placeholder: `Name this NAS (shown as ${nasLabel({ ...nas, name: '' })})`, title: 'Name' });
    name.addEventListener('change', () => update((all) => { all.find((n) => n.id === nas.id).name = name.value.trim(); }));
    const head = make('div', { className: 'nas-head' }, name);
    if (i === 0) head.append(make('span', { className: 'tag', textContent: 'Default' }));
    else head.append(make('button', { textContent: 'Make default', onclick: () => update((all) => { const j = all.findIndex((n) => n.id === nas.id); all.unshift(...all.splice(j, 1)); }) }));
    head.append(make('button', { textContent: 'Remove', title: 'Remove this NAS', onclick: () => update((all) => { all.splice(all.findIndex((n) => n.id === nas.id), 1); }) }));

    const ul = make('ul');
    for (const addr of nas.addresses) {
      const left = make('span', { className: 'addr', textContent: addr });
      const li = make('li', {}, left);
      if (!(await hasHostPermission(addr))) {
        left.append(make('span', { className: 'warn', textContent: '(no access)' }));
        li.append(make('button', { textContent: 'Grant', onclick: async () => { await askForAccess(addr); renderHosts(); } }));
      }
      if (nas.addresses.length > 1) {
        li.append(make('button', { textContent: 'Remove', title: 'Remove this address', onclick: () => update((all) => { const n = all.find((x) => x.id === nas.id); n.addresses = n.addresses.filter((x) => x !== addr); }) }));
      }
      ul.append(li);
    }

    const input = make('input', { type: 'text', placeholder: 'Another address for this NAS, e.g. http://192.168.1.10:5443' });
    const msg = make('div', { className: 'hint' });
    const add = make('button', { textContent: 'Add address' });
    add.onclick = async () => {
      msg.textContent = '';
      const origin = parseOrigin(input.value);
      if (!origin) { msg.textContent = 'Enter a full address, e.g. http://192.168.1.10:5443'; return; }
      const cur = await getSettings();
      const owner = cur.nases.find((n) => n.addresses.includes(origin));
      if (owner) { msg.textContent = owner.id === nas.id ? 'Already added.' : `Already added to ${nasLabel(owner)}.`; return; }
      if (!(await askForAccess(origin))) { msg.textContent = 'Permission was not granted.'; return; }
      await update((all) => { all.find((n) => n.id === nas.id).addresses.push(origin); });
    };
    cards.push(make('div', { className: 'nas' }, head, ul, make('div', { className: 'row' }, input, add), msg));
  }
  box.replaceChildren(...cards);
}

$('add').onclick = async () => {
  $('msg').textContent = '';
  const origin = parseOrigin($('newHost').value);
  if (!origin) { $('msg').textContent = 'Enter a full address, e.g. https://192.168.1.10:5443'; return; }
  const cur = await getSettings();
  const owner = cur.nases.find((n) => n.addresses.includes(origin));
  if (owner) { $('msg').textContent = `Already added to ${nasLabel(owner)}.`; return; }
  if (!(await askForAccess(origin))) { $('msg').textContent = 'Permission was not granted.'; return; }
  $('newHost').value = '';
  // Merge into an existing NAS if device IDs match.
  const info = await describe(origin);
  if (info && info.deviceId) {
    for (const n of cur.nases) {
      // Backfill missing deviceId for entries from older versions.
      const id = n.deviceId || ((await describe(n.addresses[0])) || {}).deviceId;
      if (id === info.deviceId) {
        await update((all) => { const x = all.find((y) => y.id === n.id); x.addresses.push(origin); x.deviceId = id; });
        $('msg').textContent = `That’s ${nasLabel(n)}, so it was added as another address for it.`;
        return;
      }
    }
  }
  await update((all) => {
    all.push({ id: newNasId(), name: (info && info.name) || '', addresses: [origin], deviceId: (info && info.deviceId) || '' });
  });
};

renderOptions();
renderHosts();
getSettings().then((s) => {
  if (!s.hosts.length || new URLSearchParams(location.search).has('welcome')) {
    $('welcome').hidden = false;
    if (!s.hosts.length) $('newHost').focus();
  }
});

// Clear cached popup data (apps, Docker and Overview).
document.getElementById('clear-cache').addEventListener('click', async () => {
  const msg = document.getElementById('cache-msg');
  try {
    await chrome.storage.local.remove(['appCache', 'dockerCache', 'overviewCache']);
    chrome.runtime.sendMessage({ type: 'refreshBadge' }).catch(() => {});
    msg.textContent = 'Cleared';
  } catch (e) {
    msg.textContent = 'Couldn’t clear: ' + (e.message || e);
  }
  setTimeout(() => { msg.textContent = ''; }, 2000);
});
