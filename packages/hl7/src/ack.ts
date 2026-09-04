/**
 * HL7 v2 application acknowledgment (workstream B1). MLLP delivers bytes; the
 * *application* then answers each received message with an MSH^ACK that:
 *
 *   - swaps MSH-3/4 and MSH-5/6 (the ACK comes from the original receiver),
 *   - sets MSH-9 to ACK and MSH-10 to a fresh control id,
 *   - carries an MSA segment: MSA-1 = AA (accept) / AE (error) / AR (reject),
 *     MSA-2 = the original message's control id (MSH-10), MSA-3 = free text.
 *
 * Delimiters and MSH-11/12 (processing id, version) are echoed from the
 * original message so the ACK is always parseable by the sender. Errors never
 * vanish: an AE/AR is the outbound counterpart of a HELD/FAILED outcome and
 * must carry a reason (surfaced later in the message timeline/attempts).
 */
import { randomBytes } from 'node:crypto';
import {
  escapeText,
  firstSegment,
  MSH_SLOTS,
  parseMessage,
  serializeMessage,
  type Hl7Message,
} from './message.js';

export type AckStatus = 'AA' | 'AE' | 'AR';

export interface AckOptions {
  /** MSA-1: AA (accepted) by default, AE (application error) or AR (reject). */
  status?: AckStatus;
  /** MSA-3 free text; defaults per status. Escaped for the wire. */
  text?: string;
  /** MSH-7 override; defaults to now (YYYYMMDDHHMMSS). */
  timestamp?: string;
  /** MSH-10 override; defaults to a generated id. */
  controlId?: string;
  /** MSH-3 override; defaults to the original receiving application. */
  sendingApp?: string;
  /** MSH-4 override; defaults to the original receiving facility. */
  sendingFacility?: string;
  /**
   * MSH-9 message type: 'ACK' unless overridden (enhanced-mode ACKs echo the
   * original trigger, e.g. 'ACK^ORU^R01').
   */
  messageType?: string;
}

export const DEFAULT_ACK_TEXT: Record<AckStatus, string> = {
  AA: 'Message accepted',
  AE: 'Application error',
  AR: 'Message rejected',
};

/**
 * Build an MSH^ACK for a received message (raw wire text or already parsed).
 * Throws when the original has no MSH — there is nothing sane to acknowledge.
 */
export function buildAck(original: string | Hl7Message, opts: AckOptions = {}): string {
  const inbound = typeof original === 'string' ? parseMessage(original) : original;
  const msh = firstSegment(inbound, 'MSH');
  if (!msh) throw new Error('cannot build an ACK: the original message has no MSH segment');

  const f = msh.fields;
  const enc = inbound.encoding;
  const status = opts.status ?? 'AA';
  const text = opts.text ?? DEFAULT_ACK_TEXT[status];

  // The ACK reverses roles: its sender is the original receiver (falling back
  // to the original sender when the receiver was unnamed), and its receiver is
  // the original sender.
  const sendingApp = opts.sendingApp ?? (f[MSH_SLOTS.receivingApp] || f[MSH_SLOTS.sendingApp] || '');
  const sendingFacility = opts.sendingFacility ?? (f[MSH_SLOTS.receivingFacility] || f[MSH_SLOTS.sendingFacility] || '');

  const ack: Hl7Message = {
    encoding: enc,
    segments: [
      {
        id: 'MSH',
        fields: [
          `${enc.component}${enc.repetition}${enc.escape}${enc.subcomponent}`,
          sendingApp,
          sendingFacility,
          f[MSH_SLOTS.sendingApp] ?? '',
          f[MSH_SLOTS.sendingFacility] ?? '',
          opts.timestamp ?? formatTimestamp(new Date()),
          '', // MSH-8 security
          opts.messageType ?? 'ACK',
          opts.controlId ?? generateControlId(),
          f[MSH_SLOTS.processingId] || 'P',
          f[MSH_SLOTS.version] || '2.5.1',
        ],
      },
      {
        id: 'MSA',
        fields: [status, f[MSH_SLOTS.controlId] ?? '', escapeText(text, enc)],
      },
    ],
  };
  return serializeMessage(ack);
}

function generateControlId(): string {
  return randomBytes(4).toString('hex').toUpperCase();
}

function formatTimestamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
