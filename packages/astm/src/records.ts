/**
 * ASTM E1394 record structure: records are pipe-separated fields, with
 * components separated by ^ within a field.
 */
export type AstmRecordType = 'H' | 'P' | 'O' | 'R' | 'L' | 'C' | 'Q' | 'M' | 'S' | 'U';

export interface AstmRecord {
  type: AstmRecordType;
  /** Fields after the record-type token (0-indexed). */
  fields: string[];
}

export function parseRecord(line: string): AstmRecord {
  const parts = line.split('|');
  const rawType = (parts[0] ?? '').trim();
  const type = (rawType.length === 1 ? rawType : 'U') as AstmRecordType;
  return { type, fields: parts.slice(1) };
}

export function serializeRecord(record: AstmRecord): string {
  return `${record.type}|${record.fields.join('|')}`;
}

export function field(record: AstmRecord, index: number): string | undefined {
  return record.fields[index];
}

/** Split a field into components on `separator` (^ by default). */
export function splitComponent(value: string, separator = '^'): string[] {
  return value.split(separator);
}