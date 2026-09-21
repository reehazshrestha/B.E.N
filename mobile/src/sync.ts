// Talking to the desk machine over the local network.
//
// Every call is short-lived and cancellable: a phone that has walked out of wifi
// range must fail in a second or two, not hang the screen. `fetch` has no
// timeout of its own, so each one gets an AbortController.

import { ChatMessage, MobileSettings } from './types';

const TIMEOUT_MS = 4000;

export type SyncState = 'idle' | 'checking' | 'searching' | 'online' | 'offline' | 'unpaired';

async function call(
  settings: MobileSettings,
  path: string,
  init: RequestInit = {},
  timeoutMs = TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`http://${settings.host}:${settings.port}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Ben-Pair': settings.pairingCode,
        ...(init.headers || {})
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

// Is a B.E.N. actually there? Unauthenticated, so this separates "wrong address"
// from "wrong pairing code" instead of reporting one failure for both.
export async function ping(settings: MobileSettings): Promise<boolean> {
  if (!settings.host) return false;
  try {
    const res = await call(settings, '/ping', {}, 2500);
    if (!res.ok) return false;
    const body = await res.json();
    return body?.service === 'ben-sync';
  } catch {
    return false;
  }
}

export interface PullResult {
  history: ChatMessage[];
  profile: { name?: string; facts: string[] };
}

export async function pullHistory(settings: MobileSettings): Promise<PullResult> {
  const res = await call(settings, '/history', {}, 8000);
  if (res.status === 401) throw new Error('unpaired');
  if (!res.ok) throw new Error(`Desktop returned ${res.status}`);
  const body = await res.json();
  return {
    history: Array.isArray(body.history) ? body.history : [],
    profile: body.profile || { facts: [] }
  };
}

export async function pushHistory(
  settings: MobileSettings,
  messages: ChatMessage[]
): Promise<number> {
  if (!messages.length) return 0;
  const res = await call(settings, '/history', {
    method: 'POST',
    body: JSON.stringify({ messages })
  }, 8000);
  if (res.status === 401) throw new Error('unpaired');
  if (!res.ok) throw new Error(`Desktop returned ${res.status}`);
  const body = await res.json();
  return Number(body.added) || 0;
}

// --- Finding the desktop ------------------------------------------------------
//
// Typing an IP address into a phone is a thing people do once and then resent
// forever, and DHCP moves it anyway - this machine's address changed twice in a
// single afternoon of testing. So the phone finds it.
//
// No mDNS plugin: the phone learns its own address from a throwaway WebRTC
// connection, then asks every host on its own /24 whether it is a B.E.N. The
// /ping endpoint exists for exactly this and needs no pairing code, so a scan
// reveals nothing to anyone.

// Measured, and the obvious tuning is wrong. Absent hosts hang rather than
// refusing, so each probe holds a socket for its whole timeout. Going wider to
// finish sooner (64 at 450 ms) made it *fail*: the socket pool filled with dead
// probes and the one live host never got a connection before its own timeout.
// Fewer in flight, each given longer, finds it reliably.
const PROBE_TIMEOUT_MS = 800;
const PROBE_CONCURRENCY = 16;
// Most DHCP pools live here, so it is searched first.
const LIKELY_MAX = 60;

export async function localAddress(): Promise<string | null> {
  try {
    const pc = new RTCPeerConnection({ iceServers: [] });
    pc.createDataChannel('discovery');
    const found = new Set<string>();
    pc.onicecandidate = (e) => {
      const match = e.candidate?.candidate.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
      if (match) found.add(match[1]);
    };
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((r) => setTimeout(r, 1500));
    pc.close();

    // Private ranges only; a public candidate is the router, not us.
    for (const ip of found) {
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return ip;
    }
  } catch {
    // WebRTC blocked, or no network.
  }
  return null;
}

async function isBen(host: string, port: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`http://${host}:${port}/ping`, { signal: controller.signal });
    if (!res.ok) return false;
    return (await res.json())?.service === 'ben-sync';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Returns the address of the first B.E.N. on this subnet, or null.
export async function discover(port: number, onProgress?: (done: number, total: number) => void): Promise<string | null> {
  const self = await localAddress();
  if (!self) return null;

  const prefix = self.split('.').slice(0, 3).join('.');
  const selfLast = Number(self.split('.')[3]);

  let done = 0;
  let winner: string | null = null;

  const sweep = async (from: number, to: number) => {
    const targets: number[] = [];
    for (let i = from; i <= to; i++) if (i !== selfLast) targets.push(i);

    const worker = async () => {
      while (targets.length && !winner) {
        const last = targets.shift();
        if (last === undefined) return;
        const host = `${prefix}.${last}`;
        if (await isBen(host, port)) {
          winner = winner || host;
          return;
        }
        onProgress?.(++done, 254);
      }
    };
    await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker));
  };

  await sweep(1, LIKELY_MAX);
  if (!winner) await sweep(LIKELY_MAX + 1, 254);
  return winner;
}
