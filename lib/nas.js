// TOS Companion: select the best active address for a NAS.
import { hasHostPermission } from './settings.js';
import { TosApi } from './tos-api.js';

// Probes the last working address first, then the rest in parallel.
// Prefers signed-in > reachable (signed-out) > first permitted address.
export async function resolveAddress(nas) {
  if (!nas) return null;
  const addrs = [];
  for (const a of nas.addresses) if (await hasHostPermission(a)) addrs.push(a);
  if (addrs.length <= 1) return addrs[0] || null;

  const { lastAddress = {} } = await chrome.storage.local.get('lastAddress');
  const last = addrs.includes(lastAddress[nas.id]) ? lastAddress[nas.id] : null;
  const remember = async (a) => {
    if (a !== lastAddress[nas.id]) {
      lastAddress[nas.id] = a;
      await chrome.storage.local.set({ lastAddress });
    }
    return a;
  };
  const lastResult = last ? await new TosApi(last).probe(1500) : null;
  if (lastResult === 'ok') return last;

  const rest = addrs.filter((a) => a !== last);
  const results = await Promise.all(rest.map((a) => new TosApi(a).probe()));
  const pick = (want) => rest.find((a, i) => results[i] === want);
  const chosen = pick('ok') || (lastResult === 'signedout' && last) || pick('signedout') || last || addrs[0];
  return remember(chosen);
}
