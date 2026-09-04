/**
 * Update state directory (plan G3 / §4.3 edge packaging).
 *
 * Applying an update means *restarting the hub process*, and a process
 * cannot safely replace the code it is running — so version state lives in a
 * small state directory that both the running hub (via UpdateAgent) and its
 * supervisor process read/write:
 *
 *   current.json      the release the supervisor is running right now
 *   desired.json      a staged release the agent wants applied (agent → sup)
 *   last-good.json    the most recent release that passed the health gate
 *   history.jsonl     append-only event log (staged/applied/rolled_back/failed)
 *   supervisor.json   supervisor heartbeat {pid, lastSeenAt} (sup → agent)
 *
 * The API reports state by reading these files; the supervisor acts on them;
 * the history survives restarts and needs no database. This matches how the
 * edge install is packaged (state dir on the facility disk) and keeps update
 * management out of the clinical message store.
 */
import { mkdir, readFile, rename, writeFile, appendFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface ReleaseSpec {
  id: string;
  version: string;
  /** Env bundle for the release (payload kind): HUB_VERSION et al. */
  payload?: { env?: Record<string, string> };
}

export interface CurrentState {
  release: ReleaseSpec;
  appliedAt: string;
  /** False while the supervisor is health-gating a freshly applied release. */
  healthy: boolean;
}

export interface DesiredState {
  /** update = newer release; rollback = back to an earlier good release. */
  kind: 'update' | 'rollback';
  release: ReleaseSpec;
  stagedAt: string;
  by?: string;
}

export interface PreviousState {
  /** The release that was running before the latest swap (rollback target). */
  release: ReleaseSpec;
  recordedAt: string;
}

export type HistoryEvent = 'staged' | 'applied' | 'rolled_back' | 'failed' | 'rejected';

export interface HistoryEntry {
  at: string;
  event: HistoryEvent;
  releaseId?: string;
  version?: string;
  reason?: string;
  by?: string;
}

const CURRENT = 'current.json';
const DESIRED = 'desired.json';
const LAST_GOOD = 'last-good.json';
const PREVIOUS = 'previous.json';
const HISTORY = 'history.jsonl';
const SUPERVISOR = 'supervisor.json';

function fileFor(stateDir: string, name: string): string {
  return join(stateDir, name);
}

export class UpdateStateDir {
  constructor(public readonly dir: string) {}

  async ensure(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private async readJson<T>(name: string): Promise<T | undefined> {
    try {
      const raw = await readFile(fileFor(this.dir, name), 'utf8');
      return JSON.parse(raw) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  private async writeJson(name: string, value: unknown): Promise<void> {
    await this.ensure();
    const tmp = fileFor(this.dir, `${name}.tmp`);
    await writeFile(tmp, JSON.stringify(value, null, 2));
    await rename(tmp, fileFor(this.dir, name));
  }

  // --- current / last-good / desired ---------------------------------------

  readCurrent(): Promise<CurrentState | undefined> {
    return this.readJson<CurrentState>(CURRENT);
  }

  readLastGood(): Promise<CurrentState | undefined> {
    return this.readJson<CurrentState>(LAST_GOOD);
  }

  readDesired(): Promise<DesiredState | undefined> {
    return this.readJson<DesiredState>(DESIRED);
  }

  writeCurrent(state: CurrentState): Promise<void> {
    return this.writeJson(CURRENT, state);
  }

  writeLastGood(state: CurrentState): Promise<void> {
    return this.writeJson(LAST_GOOD, state);
  }

  writeDesired(desired: DesiredState): Promise<void> {
    return this.writeJson(DESIRED, desired);
  }

  async clearDesired(): Promise<void> {
    try {
      await readFile(fileFor(this.dir, DESIRED));
      await rename(fileFor(this.dir, DESIRED), fileFor(this.dir, `${DESIRED}.applied-${Date.now()}`));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  /** Replaces desired.json with the given state (used by rollback). */
  async stageDesired(desired: DesiredState): Promise<void> {
    await this.writeDesired(desired);
  }

  readPrevious(): Promise<PreviousState | undefined> {
    return this.readJson<PreviousState>(PREVIOUS);
  }

  writePrevious(state: PreviousState): Promise<void> {
    return this.writeJson(PREVIOUS, state);
  }

  // --- history --------------------------------------------------------------

  async appendHistory(entry: HistoryEntry): Promise<void> {
    await this.ensure();
    await appendFile(fileFor(this.dir, HISTORY), `${JSON.stringify(entry)}\n`, 'utf8');
  }

  async readHistory(limit = 100): Promise<HistoryEntry[]> {
    let raw = '';
    try {
      raw = await readFile(fileFor(this.dir, HISTORY), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const entries = raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as HistoryEntry);
    return entries.slice(-limit).reverse(); // newest first
  }

  // --- supervisor heartbeat --------------------------------------------------

  async touchSupervisor(pid: number): Promise<void> {
    await this.writeJson(SUPERVISOR, { pid, lastSeenAt: new Date().toISOString() });
  }

  readSupervisor(): Promise<{ pid: number; lastSeenAt: string } | undefined> {
    return this.readJson<{ pid: number; lastSeenAt: string }>(SUPERVISOR);
  }

  /** True when a supervisor process has heartbeated recently (stale = gone). */
  async supervisorAlive(maxAgeMs = 15_000): Promise<boolean> {
    const sup = await this.readSupervisor();
    if (!sup) return false;
    return Date.now() - Date.parse(sup.lastSeenAt) < maxAgeMs;
  }

  /** File listing, mostly for tests/debugging. */
  async files(): Promise<string[]> {
    return readdir(this.dir);
  }
}
