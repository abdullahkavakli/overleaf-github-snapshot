// Minimal Socket.IO 0.9 / Engine.IO 0.x protocol client.
//
// Why hand-rolled: Overleaf still serves the legacy Socket.IO 0.9 protocol
// (its server is pinned to socket.io@0.9 — Workshop's package.json
// confirms it via `github:overleaf/socket.io-client#0.9.17-overleaf-5`).
// Bundling that fork into a Vite/MV3 build is fragile because it predates
// ES modules and has Node-only fallbacks. Reimplementing the small subset
// we need is cleaner.
//
// Wire format reference: Engine.IO 0.x specification
// (https://github.com/socketio/socket.io-protocol/tree/v1). Briefly:
//
//   1. GET /socket.io/1/?t=<ms> → "<sid>:<heartbeatTimeout>:<closeTimeout>:<transports>"
//   2. WS upgrade to /socket.io/1/websocket/<sid>?<optional-query>
//   3. Frames are "<type>::[<endpoint>][:<data>]" where type is:
//        0 disconnect, 1 connect, 2 heartbeat, 3 message,
//        4 json,       5 event,   6 ack,       7 error,    8 noop
//      For event frames, data is JSON {"name":"...","args":[...]} optionally
//      preceded by a numeric ack id: "5:<ackId>+::{...}".
//
// This file is AGPL-3.0. The Engine.IO 0.x spec is public; this code does
// not derive from Workshop's source.

export type SocketIo09Event = {
  name: string;
  args: unknown[];
  ackId?: number;
};

export type SocketIo09Options = {
  baseUrl: string; // e.g. "https://www.overleaf.com"
  // Extra query params appended to the polling-handshake GET.
  handshakeQuery?: Record<string, string>;
  // Extra query params appended to the websocket URL.
  websocketQuery?: Record<string, string>;
  // ms; how long to wait for the handshake response.
  handshakeTimeoutMs?: number;
  // ms; how long to wait between connecting and the server's "1::" connect-ack.
  connectAckTimeoutMs?: number;
};

export type SocketIo09Listener = (event: SocketIo09Event) => void;

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
const DEFAULT_CONNECT_ACK_TIMEOUT_MS = 10_000;

export class SocketIo09Error extends Error {
  constructor(public stage: string, message: string) {
    super(`[${stage}] ${message}`);
    this.name = 'SocketIo09Error';
  }
}

export class SocketIo09Client {
  private ws: WebSocket | null = null;
  private listeners = new Set<SocketIo09Listener>();
  private connected = false;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private nextAckId = 1;
  private pendingAcks = new Map<number, (args: unknown[]) => void>();
  private connectPromise: Promise<void> | null = null;
  private disconnectHandlers: Array<(reason: string) => void> = [];

  constructor(private readonly opts: SocketIo09Options) {}

  on(listener: SocketIo09Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onDisconnect(handler: (reason: string) => void): void {
    this.disconnectHandlers.push(handler);
  }

  isOpen(): boolean {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  // Connect performs both handshake and WS upgrade. Resolves once the
  // server sends its "1::" connect-ack.
  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = (async () => {
      const sid = await this.handshake();
      await this.openWebSocket(sid);
    })().catch((e) => {
      this.connectPromise = null;
      throw e;
    });
    return this.connectPromise;
  }

  disconnect(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send('0::');
      } catch {
        // ignore
      }
      try {
        this.ws.close(1000);
      } catch {
        // ignore
      }
    }
    this.ws = null;
    this.connected = false;
  }

  // Fire-and-forget event emit. For request/response semantics, use
  // emitWithAck which appends an Engine.IO ack id.
  emit(name: string, ...args: unknown[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new SocketIo09Error('emit', 'socket is not open');
    }
    const payload = JSON.stringify({ name, args });
    this.ws.send(`5:::${payload}`);
  }

  emitWithAck<T = unknown[]>(
    name: string,
    args: unknown[],
    timeoutMs = 10_000,
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new SocketIo09Error('emit', 'socket is not open'));
    }
    const ackId = this.nextAckId++;
    const payload = JSON.stringify({ name, args });
    const frame = `5:${ackId}+::${payload}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(ackId);
        reject(
          new SocketIo09Error('emitWithAck', `no ack for "${name}" within ${timeoutMs}ms`),
        );
      }, timeoutMs);
      this.pendingAcks.set(ackId, (responseArgs) => {
        clearTimeout(timer);
        // Socket.IO 0.9 ack convention: the server-side handler is invoked
        // as `cb(err, ...data)`. The callback wire payload is therefore
        // [err, ...data]. We resolve callers with just `data` and treat
        // any truthy err as a rejection. (Confirmed against Overleaf
        // Workshop's promisified emit — they do the same thing.)
        const [err, ...data] = responseArgs;
        if (err !== null && err !== undefined) {
          let detail: string;
          try {
            detail = typeof err === 'string' ? err : JSON.stringify(err);
          } catch {
            detail = String(err);
          }
          reject(
            new SocketIo09Error(
              'emitWithAck',
              `server returned error for "${name}": ${detail}`,
            ),
          );
          return;
        }
        resolve(data as T);
      });
      try {
        this.ws!.send(frame);
      } catch (e) {
        clearTimeout(timer);
        this.pendingAcks.delete(ackId);
        reject(new SocketIo09Error('emitWithAck', e instanceof Error ? e.message : String(e)));
      }
    });
  }

  // ────────────────────────── private ──────────────────────────

  private async handshake(): Promise<string> {
    const params = new URLSearchParams({ t: String(Date.now()) });
    for (const [k, v] of Object.entries(this.opts.handshakeQuery ?? {})) {
      params.set(k, v);
    }
    const url = `${this.opts.baseUrl}/socket.io/1/?${params.toString()}`;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    );
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal,
        headers: { Accept: 'text/plain, */*' },
      });
    } catch (e) {
      throw new SocketIo09Error(
        'handshake',
        `polling handshake failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (response.status === 401) {
      throw new SocketIo09Error('handshake', 'not signed in to Overleaf (HTTP 401)');
    }
    if (response.status === 403) {
      throw new SocketIo09Error('handshake', 'Overleaf refused the handshake (HTTP 403)');
    }
    if (!response.ok) {
      throw new SocketIo09Error('handshake', `HTTP ${response.status}`);
    }
    const text = await response.text();
    // "<sid>:<heartbeatTimeout>:<closeTimeout>:<transports>"
    const parts = text.split(':');
    if (parts.length < 4 || !parts[0]) {
      throw new SocketIo09Error(
        'handshake',
        `unexpected handshake payload: ${text.substring(0, 80)}`,
      );
    }
    const sid = parts[0];
    const transports = parts[3].split(',');
    if (!transports.includes('websocket')) {
      throw new SocketIo09Error(
        'handshake',
        `server does not advertise websocket transport (got "${parts[3]}")`,
      );
    }
    return sid;
  }

  private openWebSocket(sid: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsBase = this.opts.baseUrl.replace(/^http/, 'ws');
      const wsParams = new URLSearchParams();
      for (const [k, v] of Object.entries(this.opts.websocketQuery ?? {})) {
        wsParams.set(k, v);
      }
      const queryStr = wsParams.toString();
      const url = `${wsBase}/socket.io/1/websocket/${encodeURIComponent(sid)}${queryStr ? `?${queryStr}` : ''}`;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        reject(
          new SocketIo09Error(
            'websocket',
            `WebSocket construction failed: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
        return;
      }
      this.ws = ws;

      const ackTimer = setTimeout(
        () => {
          reject(new SocketIo09Error('websocket', 'no connect-ack from server'));
          try {
            ws.close();
          } catch {
            // ignore
          }
        },
        this.opts.connectAckTimeoutMs ?? DEFAULT_CONNECT_ACK_TIMEOUT_MS,
      );

      ws.addEventListener('open', () => {
        // wait for "1::"
      });
      ws.addEventListener('message', (ev) => {
        const data = typeof ev.data === 'string' ? ev.data : '';
        if (!data) return;
        if (!this.connected) {
          if (data === '1::') {
            clearTimeout(ackTimer);
            this.connected = true;
            this.startHeartbeat();
            resolve();
            return;
          }
          if (data.startsWith('7:')) {
            clearTimeout(ackTimer);
            reject(new SocketIo09Error('websocket', `server error: ${data}`));
            return;
          }
        }
        this.handleFrame(data);
      });
      ws.addEventListener('error', () => {
        clearTimeout(ackTimer);
        if (!this.connected) {
          reject(new SocketIo09Error('websocket', 'WebSocket error before connect-ack'));
        }
      });
      ws.addEventListener('close', (ev) => {
        clearTimeout(ackTimer);
        const reason = `WebSocket closed: ${ev.code} ${ev.reason || ''}`.trim();
        if (!this.connected) {
          reject(new SocketIo09Error('websocket', reason));
        }
        this.connected = false;
        if (this.heartbeatInterval) {
          clearInterval(this.heartbeatInterval);
          this.heartbeatInterval = null;
        }
        for (const h of this.disconnectHandlers) {
          try {
            h(reason);
          } catch {
            // ignore
          }
        }
      });
    });
  }

  private startHeartbeat(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    // Engine.IO 0.x expects the client to echo "2::" heartbeats. Server
    // typically advertises a 60s heartbeat timeout; respond every 20s to
    // stay well inside the window.
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send('2::');
        } catch {
          // ignore
        }
      }
    }, 20_000);
  }

  private handleFrame(data: string): void {
    // Frame format: <type>:<id?>[+]:<endpoint?>:<data?>
    if (data === '2::') return; // heartbeat from server, no echo needed
    if (data === '8::' || data === '8:::') return; // noop
    if (data.startsWith('0::')) {
      this.connected = false;
      return;
    }
    if (data.startsWith('5:')) {
      this.handleEventFrame(data);
      return;
    }
    if (data.startsWith('6:')) {
      this.handleAckFrame(data);
      return;
    }
    // 3 (message) / 4 (json message) / 7 (error) — we don't currently
    // emit events for those because Overleaf uses type 5 exclusively.
  }

  private handleEventFrame(data: string): void {
    // "5:<id?>[+]::<json>"
    const head = data.slice(2);
    const colonIdx = head.indexOf(':');
    if (colonIdx < 0) return;
    const idPart = head.slice(0, colonIdx);
    // Skip the second ":<endpoint>:" segment
    const rest = head.slice(colonIdx + 1);
    const colonIdx2 = rest.indexOf(':');
    if (colonIdx2 < 0) return;
    const payload = rest.slice(colonIdx2 + 1);
    let parsed: { name?: unknown; args?: unknown };
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (typeof parsed.name !== 'string') return;
    const args = Array.isArray(parsed.args) ? parsed.args : [];
    const ackId =
      idPart.endsWith('+') && /^\d+\+$/.test(idPart) ? parseInt(idPart, 10) : undefined;
    const event: SocketIo09Event = { name: parsed.name, args, ackId };
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // ignore
      }
    }
  }

  private handleAckFrame(data: string): void {
    // "6:::<id>[+<json>]"
    const head = data.slice(2);
    const colonIdx = head.indexOf(':');
    if (colonIdx < 0) return;
    const after = head.slice(colonIdx + 1);
    const colonIdx2 = after.indexOf(':');
    if (colonIdx2 < 0) return;
    const tail = after.slice(colonIdx2 + 1);
    const plusIdx = tail.indexOf('+');
    let ackIdStr: string;
    let payloadJson: string | null = null;
    if (plusIdx >= 0) {
      ackIdStr = tail.slice(0, plusIdx);
      payloadJson = tail.slice(plusIdx + 1);
    } else {
      ackIdStr = tail;
    }
    const ackId = parseInt(ackIdStr, 10);
    if (!Number.isFinite(ackId)) return;
    const handler = this.pendingAcks.get(ackId);
    if (!handler) return;
    this.pendingAcks.delete(ackId);
    let args: unknown[] = [];
    if (payloadJson) {
      try {
        const parsed = JSON.parse(payloadJson);
        if (Array.isArray(parsed)) args = parsed;
      } catch {
        // ignore
      }
    }
    handler(args);
  }
}
