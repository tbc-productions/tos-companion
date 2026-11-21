// TOS Companion: shared settings for background, popup and options.

export const DEFAULTS = {
  // [{ id, name, addresses: [origin, ...] }]; the first entry is the default NAS.
  nases: null,
  // Legacy flat address list retained for migration.
  hosts: [],
  features: {
    terminalCopy: true,
    terminalLinks: true,
    terminalSearch: true
  },
  popup: {
    showApps: true,
    showNotifications: true,
    showDocker: true,
    defaultTab: 'last' // 'last' | 'overview' | 'apps' | 'notifications' | 'docker'
  },
  badge: {
    enabled: true,
    style: 'count', // 'count' | 'dot'
    intervalMin: 1
  }
};

export async function getSettings() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  const nases = Array.isArray(s.nases) ? s.nases
    // Migrate legacy addresses; key by origin to preserve caches and read state.
    : (Array.isArray(s.hosts) ? s.hosts : []).map((h) => ({ id: h, name: '', addresses: [h] }));
  return {
    nases,
    // Deduplicated origins across all NAS devices.
    hosts: [...new Set(nases.flatMap((n) => n.addresses))],
    features: { ...DEFAULTS.features, ...s.features },
    popup: { ...DEFAULTS.popup, ...s.popup },
    badge: { ...DEFAULTS.badge, ...s.badge }
  };
}

// Merge a partial update into a settings section.
export async function saveSection(section, patch) {
  const cur = await getSettings();
  await chrome.storage.sync.set({ [section]: { ...cur[section], ...patch } });
}

export async function hasHostPermission(origin) {
  try {
    return await chrome.permissions.contains({ origins: [origin + '/*'] });
  } catch (e) {
    return false;
  }
}

export async function saveNases(nases) {
  await chrome.storage.sync.set({ nases });
}

export function newNasId() {
  return 'nas-' + Math.random().toString(36).slice(2, 10);
}

// Display name for a NAS, falling back to its first host.
export function nasLabel(nas) {
  if (nas.name) return nas.name;
  try { return new URL(nas.addresses[0]).host; } catch (e) { return 'NAS'; }
}
