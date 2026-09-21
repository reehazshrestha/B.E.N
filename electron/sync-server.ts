// LAN sync for the phone.
//
// A small HTTP server bound to the local network so the Android app can pull the
// conversation history off the desk machine and push back whatever was said on
// the phone. It is off until the user turns it on, and every request that reads
// or writes anything carries a pairing code — this serves a transcript of
// everything the user has ever said to B.E.N., and an open port on a cafe wifi
// would hand that to the room.
//
// Deliberately not mDNS/Bonjour: that is another dependency and another thing to
// fail silently. The desktop shows its address and code, the phone is told once,
// and it remembers.

import http from 'http';
import os from 'os';
import fs from 'fs';
import crypto from 'crypto';

export interface SyncServerOptions {
  memoryPath: string;
  port: number;
  // Restored from disk, so a phone paired last week is still paired. A fresh
  // code is minted (and handed back through onPairingCode) when there is none.
  pairingCode?: string;
  onPairingCode?: (code: string) => void;
  onLog?: (line: string) => void;
  // The renderer keeps its own copy of history and saves it whole, so anything
  // written to the file behind its back is overwritten by its next save. Phone
  // messages have to be handed to it, not just persisted.
  onMessagesReceived?: (messages: any[]) => void;
}

export interface SyncStatus {
  running: boolean;
  port: number;
  pairingCode: string;
  addresses: string[];
  lastSyncAt: number | null;
  lastPeer: string | null;
  error?: string;
}

// Every IPv4 address the phone could plausibly reach us on.
export function lanAddresses(): string[] {
  const out: string[] = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

function newPairingCode(): string {
  // Six digits. Long enough that guessing it over a coffee-shop network is not
  // worth anyone's afternoon, short enough to read off a screen and type.
  return String(crypto.randomInt(100000, 1000000));
}

export class SyncServer {
  private server: http.Server | null = null;
  private options: SyncServerOptions;
  private pairingCode: string;
  private lastSyncAt: number | null = null;
  private lastPeer: string | null = null;
  private lastError: string | undefined;

  constructor(options: SyncServerOptions) {
    this.options = options;
    const saved = (options.pairingCode || '').trim();
    this.pairingCode = /^\d{6}$/.test(saved) ? saved : newPairingCode();
    if (this.pairingCode !== saved) options.onPairingCode?.(this.pairingCode);
  }

  getStatus(): SyncStatus {
    return {
      running: !!this.server?.listening,
      port: this.options.port,
      pairingCode: this.pairingCode,
      addresses: lanAddresses(),
      lastSyncAt: this.lastSyncAt,
      lastPeer: this.lastPeer,
      error: this.lastError
    };
  }

  regeneratePairingCode(): string {
    this.pairingCode = newPairingCode();
    this.options.onPairingCode?.(this.pairingCode);
    return this.pairingCode;
  }

  private log(line: string) {
    console.log(`[Sync] ${line}`);
    this.options.onLog?.(line);
  }

  private readMemory(): any {
    try {
      if (fs.existsSync(this.options.memoryPath)) {
        return JSON.parse(fs.readFileSync(this.options.memoryPath, 'utf8'));
      }
    } catch (err: any) {
      this.log(`could not read memory: ${err.message}`);
    }
    return { profile: { facts: [] }, projects: [], tasks: [], history: [], notes: [], sessions: [] };
  }

  private writeMemory(data: any) {
    fs.writeFileSync(this.options.memoryPath, JSON.stringify(data, null, 2), 'utf8');
  }

  async start(attempt = 0): Promise<SyncStatus> {
    if (this.server?.listening) return this.getStatus();
    this.lastError = undefined;

    // A previous copy of the app that has not finished exiting still holds the
    // port for a moment. Without this the new instance reports "not running"
    // while the old one answers on the port with a different pairing code,
    // which looks like the phone being rejected for no reason.
    const MAX_ATTEMPTS = 4;

    return new Promise((resolve) => {
      const server = http.createServer((req, res) => this.handle(req, res));

      server.on('error', (err: any) => {
        this.server = null;

        if (err.code === 'EADDRINUSE' && attempt < MAX_ATTEMPTS) {
          this.log(`port ${this.options.port} busy, retrying (${attempt + 1}/${MAX_ATTEMPTS})`);
          setTimeout(() => this.start(attempt + 1).then(resolve), 700);
          return;
        }

        this.lastError =
          err.code === 'EADDRINUSE'
            ? `Port ${this.options.port} is still held by another copy of B.E.N. Quit it and switch this back on.`
            : err.message;
        this.log(`failed to start: ${this.lastError}`);
        resolve(this.getStatus());
      });

      // 0.0.0.0 on purpose: the phone is a different machine.
      server.listen(this.options.port, '0.0.0.0', () => {
        this.server = server;
        this.log(`listening on ${lanAddresses().join(', ')}:${this.options.port}`);
        resolve(this.getStatus());
      });
    });
  }

  async stop(): Promise<SyncStatus> {
    const server = this.server;
    this.server = null;
    if (!server) return this.getStatus();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.log('stopped');
    return this.getStatus();
  }

  private send(res: http.ServerResponse, status: number, body: unknown) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      // The phone app is served from the device, so it is a cross-origin caller.
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Ben-Pair',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    res.end(payload);
  }

  private authorised(req: http.IncomingMessage): boolean {
    const supplied = String(req.headers['x-ben-pair'] || '');
    if (supplied.length !== this.pairingCode.length) return false;
    // Constant time, so the port cannot be used as an oracle to read the code
    // back one digit at a time.
    return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(this.pairingCode));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const peer = req.socket.remoteAddress || 'unknown';
    const url = new URL(req.url || '/', `http://localhost:${this.options.port}`);

    if (req.method === 'OPTIONS') return this.send(res, 204, {});

    // Unauthenticated on purpose, and says nothing about the user: this is how
    // the phone confirms it is pointed at a B.E.N. and not at someone's printer.
    if (url.pathname === '/ping') {
      return this.send(res, 200, { ok: true, service: 'ben-sync', version: 1 });
    }

    if (!this.authorised(req)) {
      this.log(`rejected ${req.method} ${url.pathname} from ${peer}: bad pairing code`);
      return this.send(res, 401, { error: 'Bad or missing pairing code.' });
    }

    try {
      if (req.method === 'GET' && url.pathname === '/history') {
        const since = Number(url.searchParams.get('since') || 0);
        const memory = this.readMemory();
        const history = (memory.history || []).filter(
          (m: any) => !since || (m.syncedAt || 0) > since
        );
        this.lastSyncAt = Date.now();
        this.lastPeer = peer;
        this.log(`served ${history.length} messages to ${peer}`);
        return this.send(res, 200, {
          history,
          profile: memory.profile || { facts: [] },
          serverTime: Date.now()
        });
      }

      if (req.method === 'POST' && url.pathname === '/history') {
        const body = await this.readBody(req);
        const incoming = Array.isArray(body?.messages) ? body.messages : [];
        if (!incoming.length) return this.send(res, 200, { added: 0 });

        const memory = this.readMemory();
        const existing = new Set((memory.history || []).map((m: any) => m.id));
        const now = Date.now();
        const added = incoming
          .filter((m: any) => m && m.id && !existing.has(m.id))
          .map((m: any) => ({
            id: String(m.id),
            sender: m.sender === 'user' ? 'user' : m.sender === 'system' ? 'system' : 'jarvis',
            text: String(m.text || '').slice(0, 4000),
            timestamp: String(m.timestamp || ''),
            origin: 'phone',
            syncedAt: now
          }));

        memory.history = [...(memory.history || []), ...added].slice(-500);
        this.writeMemory(memory);
        this.lastSyncAt = now;
        this.lastPeer = peer;
        this.log(`accepted ${added.length} messages from ${peer}`);
        if (added.length) this.options.onMessagesReceived?.(added);
        return this.send(res, 200, { added: added.length, total: memory.history.length });
      }
    } catch (err: any) {
      this.log(`error handling ${url.pathname}: ${err.message}`);
      return this.send(res, 500, { error: err.message });
    }

    return this.send(res, 404, { error: 'Not found' });
  }

  private readBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let raw = '';
      let tooBig = false;
      req.on('data', (chunk) => {
        raw += chunk;
        // A phone is syncing a conversation, not uploading a disk image.
        if (raw.length > 2 * 1024 * 1024) {
          tooBig = true;
          req.destroy();
        }
      });
      req.on('end', () => {
        if (tooBig) return reject(new Error('Payload too large.'));
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch (err) {
          reject(new Error('Body was not valid JSON.'));
        }
      });
      req.on('error', reject);
    });
  }
}
