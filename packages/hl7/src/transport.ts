/**
 * Minimal duplex stream contract so the MLLP layer stays decoupled from
 * `net.Socket` (works with TCP sockets, TLS sockets, mock streams, ...) —
 * mirrors `@integration-hub/astm`'s transport seam.
 */
export interface DuplexLike {
  write(data: Uint8Array | string): boolean;
  end(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
}
