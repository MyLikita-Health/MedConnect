/**
 * Device registry (PRD §11 Device Management, §32 Device Health). In-memory
 * for the scaffold; devices seen on the wire are auto-registered, and the
 * gateway updates connection state.
 */
export type DeviceState = 'connected' | 'disconnected' | 'unknown';
export type DeviceProtocol = 'ASTM' | 'HL7' | 'FHIR';
export type DeviceTransport = 'tcp' | 'serial' | 'api';

export interface DeviceRecord {
  id: string;
  name: string;
  manufacturer?: string;
  model?: string;
  protocol: DeviceProtocol;
  transport: DeviceTransport;
  host?: string;
  port?: number;
  state: DeviceState;
  lastSeen?: string;
  autoRegistered?: boolean;
  createdAt: string;
}

export interface RegisterDeviceInput {
  id?: string;
  name: string;
  manufacturer?: string;
  model?: string;
  protocol?: DeviceProtocol;
  transport?: DeviceTransport;
  host?: string;
  port?: number;
}

export class DeviceRegistry {
  private readonly devices = new Map<string, DeviceRecord>();

  register(input: RegisterDeviceInput): DeviceRecord {
    const id = input.id ?? slugify(input.name);
    const record: DeviceRecord = {
      id,
      name: input.name,
      manufacturer: input.manufacturer,
      model: input.model,
      protocol: input.protocol ?? 'ASTM',
      transport: input.transport ?? 'tcp',
      host: input.host,
      port: input.port,
      state: 'unknown',
      createdAt: new Date().toISOString(),
    };
    this.devices.set(id, record);
    return record;
  }

  /** Register (or update) a device discovered on the wire, e.g. via the H record. */
  upsertFromConnection(input: {
    id: string;
    name?: string;
    protocol?: DeviceProtocol;
    transport?: DeviceTransport;
    state: DeviceState;
  }): DeviceRecord {
    const now = new Date().toISOString();
    const existing = this.devices.get(input.id);
    if (existing) {
      existing.state = input.state ?? existing.state;
      existing.lastSeen = now;
      return existing;
    }
    const record: DeviceRecord = {
      id: input.id,
      name: input.name ?? input.id,
      protocol: input.protocol ?? 'ASTM',
      transport: input.transport ?? 'tcp',
      state: input.state,
      lastSeen: now,
      autoRegistered: true,
      createdAt: now,
    };
    this.devices.set(record.id, record);
    return record;
  }

  get(id: string): DeviceRecord | undefined {
    return this.devices.get(id);
  }

  list(): DeviceRecord[] {
    return [...this.devices.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  stats(): { total: number; connected: number; offline: number } {
    let connected = 0;
    let offline = 0;
    for (const d of this.devices.values()) {
      if (d.state === 'connected') connected++;
      else if (d.state === 'disconnected') offline++;
    }
    return { total: this.devices.size, connected, offline };
  }
}

function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || `device-${Date.now()}`;
}