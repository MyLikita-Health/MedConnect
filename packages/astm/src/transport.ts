/**
 * Minimal duplex stream contract so the protocol layer stays decoupled from
 * `net.Socket` (works with TCP sockets, serial ports, mock streams, ...).
 */
export interface DuplexLike {
  write(data: Uint8Array | string): boolean;
  end(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
}