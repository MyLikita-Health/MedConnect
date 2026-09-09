/**
 * Device registry (PRD §11 Device Management, §32 Device Health). In-memory
 * for the scaffold; devices seen on the wire are auto-registered, and the
 * gateway updates connection state.
 */
export type DeviceState = 'connected' | 'disconnected' | 'unknown';
export type DeviceProtocol = 'ASTM' | 'HL7' | 'FHIR' | 'DICOM';
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
  /**
   * Certified DeviceProfile id (A4 AdapterRegistry seam, PRD §39–40): when
   * set, incoming ASTM from this device is canonicalized with the profile's
   * record layout and code mappings instead of the generic reference layout.
   */
  profileId?: string;
  state: DeviceState;
  lastSeen?: string;
  autoRegistered?: boolean;
  createdAt: string;
  /**
   * Cloud tenancy stamps (H1 write-through, plan §5.2): the org + facility the
   * device belongs to. Set on a cloud-mode hub; absent on a single-tenant edge.
   */
  orgId?: string;
  facilityId?: string;
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
  /** Bind this device to a DeviceProfile (validated against the profile store). */
  profileId?: string;
  /** H1 cloud tenancy stamps (cloud write-through); absent on an edge. */
  orgId?: string;
  facilityId?: string;
}

export interface DeviceStats {
  total: number;
  connected: number;
  offline: number;
}

export class DeviceRegistry {
  readonly kind = 'memory' as const;
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
      profileId: input.profileId,
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

  stats(): DeviceStats {
    let connected = 0;
    let offline = 0;
    for (const d of this.devices.values()) {
      if (d.state === 'connected') connected++;
      else if (d.state === 'disconnected') offline++;
    }
    return { total: this.devices.size, connected, offline };
  }

  remove(id: string): boolean {
    return this.devices.delete(id);
  }
}

export function slugify(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || `device-${Date.now()}`;
}