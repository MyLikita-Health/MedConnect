/**
 * MLLP (Minimal Lower Layer Protocol) control bytes — the transport framing
 * HL7 v2 uses over TCP: each message is wrapped in VT (start block) …
 * FS CR (end block + carriage return).
 */
export const MLLP = {
  /** VT 0x0b — start block. */
  START: 0x0b,
  /** FS 0x1c — end block (always followed by CR). */
  END: 0x1c,
  /** CR 0x0d — trailer after the end block. */
  CR: 0x0d,
} as const;
