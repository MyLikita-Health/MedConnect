/**
 * Inbound MLLP server (workstream B1a). Listens for HL7 v2 peers over TCP
 * (optionally TLS-terminated), runs one `MllpSession` per connection — decode
 * → `onMessage` → application ACK — mirroring how `AstmGateway` owns the
 * ASTM listener while the session layer stays transport-agnostic.
 */
import net from 'node:net';
import tls from 'node:tls';
import { MllpSession, type MllpSessionOptions } from './mllp-session.js';

export interface MllpTlsCredentials {
  key: string;
  cert: string;
}

export interface MllpServerOptions {
  host?: string;
  /** TCP port; 0 picks an ephemeral port (tests). */
  port: number;
  /** PEM key + cert: when present the listener is TLS-terminated. */
  tls?: MllpTlsCredentials;
  /** Handle one decoded message per connection (see MllpSessionOptions). */
  onMessage: MllpSessionOptions['onMessage'];
  onSessionError?: (error: Error) => void;
}

export class MllpServer {
  private server?: net.Server;
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly opts: MllpServerOptions) {}

  async start(): Promise<{ port: number }> {
    const server = this.opts.tls
      ? tls.createServer({ key: this.opts.tls.key, cert: this.opts.tls.cert }, (socket) => this.handleConnection(socket))
      : net.createServer((socket) => this.handleConnection(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, this.opts.host ?? '0.0.0.0', () => resolve());
    });
    return { port: (server.address() as net.AddressInfo).port };
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private handleConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    const session = new MllpSession(socket, {
      onMessage: this.opts.onMessage,
      onError: this.opts.onSessionError,
    });
    session.start();
  }
}
