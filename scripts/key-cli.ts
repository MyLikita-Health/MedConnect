#!/usr/bin/env tsx
/**
 * `hub-key` — operator CLI for API-key lifecycle (key-rotation ergonomics).
 * Talks to a running hub's REST API over the keys:manage surface:
 *
 *   HUB_URL=http://127.0.0.1:3000 HUB_API_KEY=ihk_… npx tsx scripts/key-cli.ts list
 *
 * Subcommands (add --url <base> and --key <secret> to any, or set HUB_URL /
 * HUB_API_KEY):
 *
 *   list
 *       Table of keys: status (active/disabled/expired), expiry, last use.
 *       Secrets are never shown — only the display prefix.
 *
 *   create --name "LIS interface v2" --role engineer [--days 90 | --expires <ISO>] [--id <slug>]
 *       Creates a key. The plaintext secret is printed EXACTLY ONCE (the API
 *       only ever stores the hash) — copy it before the command exits.
 *
 *   rename <id> --name "new label"
 *       Renames a key without touching its secret.
 *
 *   disable <id> | enable <id>
 *       Disables/enables without deleting — the record + audit trail survive.
 *
 *   expiry <id> --days 90 | --expires <ISO> | --never
 *       Sets, extends or clears the expiry date (--never = no expiry).
 *
 *   rotate <id>
 *       Re-issues the secret (old one is revoked immediately). Prints the new
 *       secret once, and WARNs when the outgoing secret was never used since
 *       it was issued — so a lost/never-delivered secret can't be rotated
 *       silently.
 *
 *   delete <id>
 *       Permanently deletes a key (refused for the key you are using).
 */
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string', short: 'u' },
    key: { type: 'string', short: 'k' },
    name: { type: 'string' },
    role: { type: 'string' },
    id: { type: 'string' },
    days: { type: 'string' },
    expires: { type: 'string' },
    never: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});

const BASE = values.url ?? process.env.HUB_URL ?? 'http://127.0.0.1:3000';
const API_KEY = values.key ?? process.env.HUB_API_KEY ?? '';

interface KeyJson {
  id: string;
  name: string;
  role: string;
  prefix: string;
  enabled: boolean;
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
  secretIssuedAt?: string;
}

async function call(path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: unknown }> {
  if (!API_KEY) throw new Error('no API key — pass --key <secret> or set HUB_API_KEY');
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const parsed = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const detail = parsed && typeof parsed === 'object' && 'error' in parsed ? String((parsed as { error: unknown }).error) : res.statusText;
    throw new Error(`${method} ${path} → ${res.status}: ${detail}`);
  }
  return { status: res.status, body: parsed };
}

function fmtDate(iso?: string): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return d.getTime() < Date.now() ? `${d.toLocaleString()} (expired)` : d.toLocaleString();
}

function statusOf(k: KeyJson): string {
  if (!k.enabled) return 'disabled';
  if (k.expiresAt && Date.parse(k.expiresAt) <= Date.now()) return 'expired';
  return 'active';
}

function neverSeen(k: KeyJson): boolean {
  if (!k.lastUsedAt) return true;
  const issued = k.secretIssuedAt ?? k.createdAt;
  return new Date(k.lastUsedAt).getTime() < new Date(issued).getTime();
}

function expiresFromFlags(): string | undefined {
  if (values.days !== undefined) {
    const days = Number(values.days);
    if (!Number.isFinite(days) || days <= 0) throw new Error('--days must be a positive number');
    return new Date(Date.now() + days * 86400000).toISOString();
  }
  if (values.expires !== undefined) {
    const t = Date.parse(values.expires);
    if (Number.isNaN(t)) throw new Error(`cannot parse --expires "${values.expires}" — use ISO e.g. 2027-01-01 or 2027-01-01T00:00:00Z`);
    return new Date(t).toISOString();
  }
  return undefined;
}

function pad(s: string, n: number): string {
  return (s + ' '.repeat(n)).slice(0, n);
}

async function main(): Promise<void> {
  const cmd = positionals[0];
  const id = positionals[1];
  switch (cmd) {
    case 'list': {
      const { body } = await call('/api/v1/keys');
      const keys = body as KeyJson[];
      if (values.json) {
        console.log(JSON.stringify(keys, null, 2));
        return;
      }
      if (keys.length === 0) {
        console.log('no keys');
        return;
      }
      console.log(pad('KEY', 22) + pad('NAME', 28) + pad('ROLE', 10) + pad('STATUS', 10) + pad('EXPIRES', 24) + 'LAST USED');
      for (const k of keys) {
        console.log(
          pad(k.id, 22) + pad(k.name.slice(0, 27), 28) + pad(k.role, 10) + pad(statusOf(k), 10) +
          pad(fmtDate(k.expiresAt), 24) +
          (neverSeen(k) ? 'never used ⚠' : (k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : '—')),
        );
      }
      console.log(`\n${keys.length} key(s) — prefix shown for identification only; secrets are never listed.`);
      return;
    }
    case 'create': {
      const name = values.name;
      const role = values.role;
      if (!name) throw new Error('create needs --name');
      if (!role || !['admin', 'engineer', 'operator', 'viewer'].includes(role)) {
        throw new Error('create needs --role admin|engineer|operator|viewer');
      }
      const { body } = await call('/api/v1/keys', 'POST', { name, role, id: values.id, expiresAt: expiresFromFlags() });
      const { key, secret } = body as { key: KeyJson; secret: string };
      console.log(`created ${key.id} (${key.role})`);
      if (key.expiresAt) console.log(`expires ${fmtDate(key.expiresAt)}`);
      console.log('SECRET (shown exactly once — copy now):');
      console.log(secret);
      return;
    }
    case 'rename': {
      if (!id) throw new Error('rename needs <id>');
      if (!values.name) throw new Error('rename needs --name');
      const { body } = await call(`/api/v1/keys/${encodeURIComponent(id)}`, 'PATCH', { name: values.name });
      const key = body as KeyJson;
      console.log(`renamed ${key.id} → "${key.name}"`);
      return;
    }
    case 'disable':
    case 'enable': {
      if (!id) throw new Error(`${cmd} needs <id>`);
      const { body } = await call(`/api/v1/keys/${encodeURIComponent(id)}`, 'PATCH', { enabled: cmd === 'enable' });
      const key = body as KeyJson;
      console.log(`${key.id} is now ${key.enabled ? 'enabled' : 'disabled'}`);
      return;
    }
    case 'expiry': {
      if (!id) throw new Error('expiry needs <id>');
      if (values.never) {
        const { body } = await call(`/api/v1/keys/${encodeURIComponent(id)}`, 'PATCH', { expiresAt: null });
        console.log(`${(body as KeyJson).id} expiry cleared (never expires)`);
        return;
      }
      const expiresAt = expiresFromFlags();
      if (!expiresAt) throw new Error('expiry needs --days N, --expires <ISO>, or --never');
      const { body } = await call(`/api/v1/keys/${encodeURIComponent(id)}`, 'PATCH', { expiresAt });
      console.log(`${(body as KeyJson).id} expires ${fmtDate(expiresAt)}`);
      return;
    }
    case 'rotate': {
      if (!id) throw new Error('rotate needs <id>');
      const { body } = await call(`/api/v1/keys/${encodeURIComponent(id)}/rotate`, 'POST');
      const { key, secret, warning } = body as { key: KeyJson; secret: string; warning?: string };
      console.log(`rotated ${key.id} — the previous secret is revoked`);
      if (warning) console.log(`WARNING: ${warning}`);
      console.log('SECRET (shown exactly once — copy now):');
      console.log(secret);
      return;
    }
    case 'delete': {
      if (!id) throw new Error('delete needs <id>');
      await call(`/api/v1/keys/${encodeURIComponent(id)}`, 'DELETE');
      console.log(`deleted ${id}`);
      return;
    }
    default:
      throw new Error(
        `unknown subcommand ${cmd ?? '(none)'} — expected list | create | rename | disable | enable | expiry | rotate | delete (see the header comment for usage)`,
      );
  }
}

main().catch((err) => {
  console.error(`hub-key: ${(err as Error).message}`);
  process.exit(1);
});
