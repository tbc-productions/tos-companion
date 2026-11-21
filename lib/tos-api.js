// TOS Companion: TOS 7 web API client (authenticated via TOS cookies and X-Csrf-Token).

export class NotSignedInError extends Error {
  constructor() {
    super('Not signed in to TOS');
    this.name = 'NotSignedInError';
  }
}

// Display names for built-in apps that return translation keys.
const APP_NAMES = {
  Control: 'Control Panel',
  terminal: 'Terminal',
  Market: 'App Center',
  filemanage: 'File Manager',
  StorageManager: 'Storage Manager',
  Backup: 'Backup',
  Dgconsole: 'Technical Support',
  security_scanning: 'Security Advisor',
  jellyfin: 'Jellyfin',
  docker: 'Container Manager'
};

// "general_settings,general_settings" -> "General settings"
export function humanise(key) {
  if (!key) return '';
  const last = String(key).split(',').pop().trim();
  const words = last.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function isTranslationKey(name) {
  return /^[a-z0-9_]+(,[a-z0-9_]+)+$/i.test(name || '') || /^[a-z0-9]+_[a-z0-9_]+$/.test(name || '');
}

export class TosApi {
  constructor(host) {
    this.host = host.replace(/\/+$/, '');
  }

  async csrf() {
    const c = await chrome.cookies.get({ url: this.host + '/', name: 'X-Csrf-Token' });
    return c ? decodeURIComponent(c.value) : '';
  }

  async request(path, { method = 'GET', form, json, signal } = {}) {
    const headers = { Accept: 'application/json, text/plain, */*' };
    const token = await this.csrf();
    if (token) headers['X-Csrf-Token'] = token;
    let body;
    if (form) {
      body = new FormData();
      for (const [k, v] of Object.entries(form)) body.append(k, v);
    } else if (json) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    let res;
    try {
      res = await fetch(this.host + path, { method, headers, body, credentials: 'include', cache: 'no-store', signal });
    } catch (e) {
      throw new Error(`Can't reach ${new URL(this.host).host}`);
    }
    if (res.status === 401 || res.status === 403) throw new NotSignedInError();
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (e) {
      throw new Error(`Unexpected response from TOS (${res.status})`);
    }
    // Container Manager proxy returns is_login:false even on success; require code !== true.
    if (data && data.is_login === false && data.code !== true) throw new NotSignedInError();
    if (!res.ok || (data && data.code === false)) {
      throw new Error((data && (data.msg || data.code_msg)) || `TOS error ${res.status}`);
    }
    return data ? data.data : null;
  }

  // Probe reachability and session: 'ok' | 'signedout' | 'unreachable'.
  async probe(ms = 2500) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      await this.request('/msgcenter/list', { signal: ctl.signal });
      return 'ok';
    } catch (e) {
      return e instanceof NotSignedInError ? 'signedout' : 'unreachable';
    } finally {
      clearTimeout(timer);
    }
  }

  url(path) {
    return this.host + path;
  }

  // ---- Apps ----

  async apps() {
    const [desktop, installed] = await Promise.all([
      this.request('/v2/desktop/list?AllApplication'),
      this.request('/v2/app/list').catch(() => null)
    ]);
    const inst = (installed && installed.install_list) || {};
    return (desktop || [])
      // Exclude launcher-only button and headless background services.
      .filter((a) => a.id && a.id !== 'allApp' && a.path)
      // TOS keeps uninstalled apps in the desktop list; like its own launcher, drop
      // embedded (iframe) apps missing from the installed list. Built-ins aren't listed there.
      .filter((a) => !installed || inst[a.id] || a.type !== 'iframe')
      .map((a) => {
        let name = (inst[a.id] && inst[a.id].name) || APP_NAMES[a.id] || a.name;
        if (isTranslationKey(name)) name = humanise(name);
        const icon = String(a.icon || (inst[a.id] && inst[a.id].icon) || '');
        return { id: a.id, name, icon: icon ? this.url(icon.startsWith('/') ? icon : '/' + icon) : '' };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Fetch an image as a data URL for icon caching.
  async imageDataUrl(url) {
    const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !/^image\//.test(type)) throw new Error('Icon not available');
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  // ---- Overview ----

  // Device name, model, TOS version and uptime (seconds).
  async systemInfo() {
    const list = await this.request('/v2/system/board/system');
    const pick = (key) => {
      const row = (list || []).find((r) => JSON.stringify(r.label || '').includes(key));
      return row ? row.value : '';
    };
    return {
      name: pick('Device_Name_title'),
      deviceId: pick('device_id'),
      model: pick('model'),
      version: pick('TOSversion'),
      uptime: Number(pick('startTime')) || 0
    };
  }

  // Available TOS update version, or null if up to date.
  async checkUpdate() {
    const d = await this.request('/v2/update/check');
    if (d && d.path && d.hash && d.version) return String(d.version);
    return null;
  }

  // Volumes: name, health, used / free / total.
  async volumes() {
    const list = await this.request('/v2/system/board/storage');
    return (list || []).map((v) => {
      const rows = v.prototype || [];
      const head = rows[0] || {};
      const val = (key) => {
        const r = rows.find((x) => JSON.stringify(x.label || '').includes(key));
        return r ? r.value : '';
      };
      const num = String(head.label || '').match(/#\s*(\d+)/);
      const health = head.value || {};
      return {
        name: num ? `Volume ${num[1]}` : humanise(String(head.label || 'Volume')),
        health: humanise(Array.isArray(health.label) ? health.label.join(',') : health.label || ''),
        healthy: !health.font_color || /88bf14|green/i.test(health.font_color),
        used: val('used_capacity'),
        free: val('free_space'),
        total: val('totalspace'),
        usage: parseFloat((v.usage && v.usage.usage) || '0') || 0
      };
    }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }

  // CPU and memory usage (%); slow (~3 s TOS sample).
  async hardwareUsage() {
    const list = await this.request('/v2/system/board/hardware');
    const cpu = (list || []).find((r) => /cpu/i.test(r.label));
    const mem = (list || []).find((r) => !/cpu/i.test(r.label));
    return {
      cpu: cpu ? parseFloat(cpu.usage) : null,
      mem: mem ? parseFloat(mem.usage) : null,
      memTotal: mem ? mem.label : ''
    };
  }

  // ---- Notifications ----

  async notifications() {
    const list = await this.request('/msgcenter/list');
    return (list || []).map((n) => ({
      id: n.id,
      level: n.level || 'info',
      title: humanise(n.type_name || n.type),
      detail: n.detail || humanise(n.snip),
      time: n.time,
      jump: n.jump && n.jump.path ? n.jump : null
    }));
  }

  dismissNotification(id) {
    return this.request('/msgcenter/delete/' + encodeURIComponent(id), { method: 'DELETE' });
  }

  dismissAllNotifications() {
    return this.request('/msgcenter/delete_all', { method: 'DELETE' });
  }

  // ---- Docker ----

  async projects() {
    const list = await this.request('/v2/proxy/docker/compose/list');
    return (list || []).map((p) => ({
      name: p.Name,
      status: p.Status || '',
      statusDesc: p.StatusDesc || '',
      path: p.EnyPath || ''
    }));
  }

  async containers() {
    const list = await this.request('/v2/proxy/docker/getcontainerlist', { method: 'POST' });
    return (list || []).map((c) => {
      let status = c.statusStruct;
      if (typeof status === 'string') {
        try { status = JSON.parse(status); } catch (e) { status = {}; }
      }
      let config = c.config;
      if (typeof config === 'string') {
        try { config = JSON.parse(config); } catch (e) { config = []; }
      }
      const ports = [];
      const ns = config && config[0] && config[0].NetworkSettings;
      if (ns && ns.Ports) {
        for (const binds of Object.values(ns.Ports)) {
          if (Array.isArray(binds)) {
            for (const b of binds) if (b && b.HostPort && !ports.includes(b.HostPort)) ports.push(b.HostPort);
          }
        }
      }
      return {
        id: c.id,
        name: c.container_name,
        image: c.name,
        project: c.composeProject || '',
        state: (status && status.status) || '',
        uptime: c.status || '',
        ports
      };
    });
  }

  // action: 'run' | 'stop' | 'restart'
  projectAction(name, action) {
    return this.request('/v2/proxy/docker/compose/' + action, { method: 'POST', form: { name } });
  }

  // action: 'start' | 'stop' | 'restart'
  containerAction(container, action) {
    const type = { stop: 1, start: 2, restart: 3 }[action];
    return this.request('/v2/proxy/docker/containerevent', {
      method: 'POST',
      form: { name: container.name, type: String(type), id: container.id }
    });
  }

  async terminalSocketUrl(containerId) {
    const u = new URL(this.host);
    const proto = u.protocol === 'http:' ? 'ws' : 'wss';
    const token = await this.csrf();
    return `${proto}://${u.host}/v2/proxy/docker/tty/ws?id=${encodeURIComponent(containerId)}&X-Csrf-Token=${encodeURIComponent(token)}`;
  }
}
