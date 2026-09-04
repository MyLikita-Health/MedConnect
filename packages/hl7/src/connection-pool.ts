/**
 * Outbound MLLP connection manager (workstream B3.3 refinement). MLLP peers
 * (LIS/HIS) expect persistent connections, while the dispatcher treats
 * delivery as stateless; this pool bridges the two:
 *
 *   - one held-open connection per (host, port), reused across deliveries,
 *   - sends on one connection are serialized (MLLP peers do not reliably
 *     support pipelining — the pool chains them in order),
 *   - a connection that closes or errors is dropped; the next send
 *     reconnects transparently,
 *   - idle connections are closed after `idleMs` (default 30 s) so the hub
 *     does not hold sockets open forever.
 *
 * The pool owns the socket lifecycle: callers send and receive the raw ACK;
 * `close()` tears everything down (hub shutdown).
 */
import net from 'node:net';
import { once } from 'node:events';
import { MllpClient } from './mllp-client.js';

export interface MllpConnectionPoolOptions {
  /** Keep idle connections open this long (ms) before closing them. */
  idleMs?: number;
  /** Per-send ACK timeout (ms), forwarded to MllpClient. */
  timeoutMs?: number;
  debug?: (line: string) => void;
}

interface PooledConnection {
  socket: net.Socket;
  client: MllpClient;
  /** Serialized send queue for this connection (never rejects). */
  chain: Promise<void>;
  idleTimer?: NodeJS.Timeout;
  dead: boolean;
}

export class MllpConnectionPool {
  private readonly connections = new Map<string, PooledConnection>();
  private readonly idleMs: number;
  private readonly timeoutMs: number;
  private readonly debug?: (line: string) => void;

  constructor(opts: MllpConnectionPoolOptions = {}) {
    this.idleMs = opts.idleMs ?? 30_000;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.debug = opts.debug;
  }

  /**
   * Send one MLLP-wrapped payload, reusing a held-open connection when
   * possible. A transport-level failure (peer closed mid-send, connect
   * refused, timeout) drops the connection and retries ONCE with a fresh one
   * — the reconnect guarantee. Application rejections (AE/AR) are NOT pool
   * concerns: the caller parses the ACK and decides.
   */
  async send(destination: { host: string; port: number }, payload: string): Promise<string> {
    const key = `${destination.host}:${destination.port}`;
    try {
      const conn = await this.getConnection(key, destination);
      return await this.enqueue(conn, payload);
    } catch (err) {
      this.drop(key);
      const conn = await this.connect(key, destination);
      return await this.enqueue(conn, payload);
    }
  }

  private async getConnection(key: string, destination: { host: string; port: number }): Promise<PooledConnection> {
    const existing = this.connections.get(key);
    if (existing && !existing.dead) return existing;
    return this.connect(key, destination);
  }

  private drop(key: string): void {
    const conn = this.connections.get(key);
    if (conn) {
      conn.dead = true;
      if (conn.idleTimer) clearTimeout(conn.idleTimer);
      conn.socket.destroy();
      this.connections.delete(key);
    }
  }

  /** Close every held connection (hub shutdown). */
  async close(): Promise<void> {
    for (const conn of this.connections.values()) {
      conn.dead = true;
      if (conn.idleTimer) clearTimeout(conn.idleTimer);
      conn.socket.destroy();
    }
    this.connections.clear();
  }

  private async connect(key: string, destination: { host: string; port: number }): Promise<PooledConnection> {
    const socket = net.createConnection({ host: destination.host, port: destination.port });
    // Connect timeout — clear the listener once connected so it never fires
    // while awaiting a slow ACK (MllpClient owns that deadline).
    const timer = setTimeout(() => socket.destroy(new Error(`MLLP connect timed out to ${destination.host}:${destination.port}`)), this.timeoutMs);
    try {
      await once(socket, 'connect');
    } catch (err) {
      clearTimeout(timer);
      throw err instanceof Error ? err : new Error(String(err));
    }
    clearTimeout(timer);

    const client = new MllpClient(socket, { timeoutMs: this.timeoutMs, debug: this.debug });
    const conn: PooledConnection = { socket, client, chain: Promise.resolve(), dead: false };
    const markDead = () => {
      if (conn.dead) return;
      conn.dead = true;
      if (this.connections.get(key) === conn) this.connections.delete(key);
    };
    socket.on('close', markDead);
    // A listener is mandatory: a socket error with no listener crashes the
    // process. The error is also surfaced for diagnostics.
    socket.on('error', (err) => {
      this.debug?.(`[mllp-pool] ${destination.host}:${destination.port} socket error: ${err.message}`);
      markDead();
    });
    this.connections.set(key, conn);
    return conn;
  }

  private enqueue(conn: PooledConnection, payload: string): Promise<string> {
    if (conn.idleTimer) {
      clearTimeout(conn.idleTimer);
      conn.idleTimer = undefined;
    }
    const run = conn.chain.then(() => conn.client.send(payload));
    // A failed send must not poison the serialized queue for later sends.
    conn.chain = run.then(() => undefined, () => undefined);
    return run.finally(() => this.scheduleIdle(conn));
  }

  private scheduleIdle(conn: PooledConnection): void {
    if (conn.dead) return;
    conn.idleTimer = setTimeout(() => {
      if (conn.dead) return;
      this.debug?.(`[mllp-pool] closing idle connection`);
      conn.dead = true;
      conn.socket.end();
      conn.socket.destroy();
    }, this.idleMs);
    conn.idleTimer.unref?.(); // never keep the process alive on an idle timer
  }
}