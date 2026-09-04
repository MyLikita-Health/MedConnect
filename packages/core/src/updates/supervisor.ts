/**
 * Hub supervisor (plan §4.3 edge packaging, workstream G2/G3; M2 installer +
 * remote update gate item).
 *
 * Owns the hub process lifecycle so the running hub never has to replace
 * itself: this process spawns the hub as a child, watches it, restarts it on
 * crash, and — when the in-hub UpdateAgent stages a signed release in
 * desired.json — swaps the running version, health-gates the new boot, and
 * auto-rolls-back to the last-known-good release if the gate fails.
 *
 * State lives in the shared state directory (state.ts):
 *   current.json   what we are running (healthy:false while gating)
 *   last-good.json most recent release that passed the gate
 *   desired.json   staged by the agent (update or rollback)
 *   history.jsonl  applied / rolled_back / failed events
 *   supervisor.json heartbeat so the hub's /updates/status can report us
 *
 * A process crash is handled the same way as a failed update boot: restart
 * the current release; crashes beyond maxRestarts within a window escalate
 * to the previously-good release (rollback). This is the same mechanism the
 * OS service wrapper (systemd/launchd) would drive in production.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { HUB_VERSION } from '@integration-hub/shared';
import { UpdateStateDir, type DesiredState, type ReleaseSpec } from './state.js';

export interface SupervisorOptions {
  /** Shared state directory (HUB_STATE_DIR). */
  stateDir: string;
  /** argv for the hub process, e.g. [process.execPath, '/app/cli.ts']. */
  command: string[];
  /** Base env for the child (ports/host/auth/…). Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Running version when no state file exists yet (default HUB_VERSION). */
  defaultVersion?: string;
  /** Health URL the child must answer ok on (skip gate when unset). */
  healthUrl?: string;
  /** When set, the gate additionally requires health.version to equal this. */
  healthTargetVersion?: string;
  /** desired.json poll + heartbeat interval. */
  pollMs?: number;
  /** Budget for a boot to pass the health gate. */
  bootTimeoutMs?: number;
  /** Per health probe timeout. */
  healthTimeoutMs?: number;
  /** Crash restarts tolerated (per release) before rollback/escalation. */
  maxRestarts?: number;
  /**
   * HTTPS health probes: verify the hub certificate chain. Set false for
   * self-signed on-prem certs (the hub's own CA is typically not in the
   * supervisor's trust store).
   */
  healthRejectUnauthorized?: boolean;
  log?: (line: string) => void;
}

interface RunningChild {
  proc: ChildProcess;
  release: ReleaseSpec;
  /** How the child was started — 'boot' | 'apply' | 'rollback' | 'restart'. */
  mode: 'boot' | 'apply' | 'rollback' | 'restart';
  startedAtMs: number;
}

export class HubSupervisor {
  private readonly state: UpdateStateDir;
  private readonly log: (line: string) => void;
  private child?: RunningChild;
  private stopping = false;
  private swapping = false;
  /** Crash timestamps within the window; reaching maxRestarts escalates. */
  private crashTimes: number[] = [];
  /** Release that ran before the current one (crash-loop rollback target). */
  private fallback?: ReleaseSpec;
  private timer?: NodeJS.Timeout;
  /** Serializes boots: a restart can never overlap a still-running gate. */
  private bootQueue: Promise<boolean> = Promise.resolve(true);
  private readonly stopped: Promise<void>;
  private resolveStopped!: () => void;
  private pollMs: number;
  private bootTimeoutMs: number;
  private healthTimeoutMs: number;
  private maxRestarts: number;
  private readonly bin: string;
  private readonly args: string[];

  constructor(private readonly opts: SupervisorOptions) {
    this.stopped = new Promise<void>((resolve) => {
      this.resolveStopped = resolve;
    });
    this.state = new UpdateStateDir(opts.stateDir);
    this.log = opts.log ?? (() => undefined);
    this.pollMs = opts.pollMs ?? 500;
    this.bootTimeoutMs = opts.bootTimeoutMs ?? 20_000;
    this.healthTimeoutMs = opts.healthTimeoutMs ?? 2_000;
    this.maxRestarts = opts.maxRestarts ?? 5;
    const [bin, ...args] = opts.command;
    if (!bin) throw new Error('supervisor requires a command (e.g. [node, cli.ts])');
    this.bin = bin;
    this.args = args;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    await this.state.ensure();
    const desired = await this.state.readDesired();
    const current = await this.state.readCurrent();
    // If an update was staged while we were down (supervisor restart), apply it.
    const release = desired?.release ?? current?.release ?? this.defaultRelease();
    const mode = desired?.kind === 'rollback' ? 'rollback' : desired ? 'apply' : 'boot';
    this.log(`[supervisor] starting hub ${release.version}${desired ? ' (staged release from previous run)' : ''}`);
    // Retry the initial boot with backoff like any crash; give up past maxRestarts.
    for (let attempt = 0; ; attempt++) {
      if (await this.enqueueBoot(release, mode)) break;
      if (attempt >= this.maxRestarts) {
        throw new Error(`hub ${release.version} failed to boot after ${attempt + 1} attempts — check the logs above`);
      }
      this.log(`[supervisor] boot attempt ${attempt + 1} failed — retrying in ${500 * 2 ** attempt}ms`);
      await sleep(500 * 2 ** attempt);
    }
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.timer.unref?.();
    await this.tick(); // heartbeats immediately
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.killChild();
    this.resolveStopped();
  }

  /** start() + resolves when stop() is called (used by supervisor-cli). */
  async manage(): Promise<void> {
    await this.start();
    await this.stopped;
  }

  get running(): ReleaseSpec | undefined {
    return this.child?.release;
  }

  /** The supervised hub process (observability + tests). */
  get childProcess(): ChildProcess | undefined {
    return this.child?.proc;
  }

  // -------------------------------------------------------------------------
  // Poll loop
  // -------------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (this.stopping || this.swapping || !this.child) return;
    await this.state.touchSupervisor(process.pid);
    const desired = await this.state.readDesired();
    if (!desired) return;
    const current = await this.state.readCurrent();
    if (current?.release.version === desired.release.version && current.healthy) {
      // Already there (agent re-staged the running release) — ack and move on.
      await this.state.clearDesired();
      return;
    }
    await this.applyDesired(desired);
  }

  // -------------------------------------------------------------------------
  // Applying a staged release (update or rollback)
  // -------------------------------------------------------------------------

  private async applyDesired(desired: DesiredState): Promise<void> {
    if (!this.child) return;
    this.swapping = true;
    const previous = await this.state.readCurrent();
    // If the newly-running release crash-loops, fall back to the one it replaced.
    this.fallback = previous?.release;
    const mode = desired.kind === 'rollback' ? 'rollback' : 'apply';
    this.log(`[supervisor] applying ${mode} → ${desired.release.version}`);
    // Mark current as unhealthy/in-transition so the API reports accurately.
    await this.state.writeCurrent({ release: desired.release, appliedAt: now(), healthy: false });
    await this.killChild();
    const ok = await this.enqueueBoot(desired.release, mode);
    this.swapping = false;
    if (ok) {
      // Gate passed (boot already recorded current + last-known-good).
      await this.state.appendHistory({
        at: now(),
        event: desired.kind === 'rollback' ? 'rolled_back' : 'applied',
        releaseId: desired.release.id,
        version: desired.release.version,
        reason: desired.kind === 'rollback' ? 'manual rollback' : undefined,
        by: desired.by,
      });
      this.log(`[supervisor] ${mode} complete — running ${desired.release.version}`);
    } else {
      await this.state.appendHistory({
        at: now(),
        event: 'failed',
        releaseId: desired.release.id,
        version: desired.release.version,
        reason: 'health gate failed after boot',
      });
      this.log(`[supervisor] ${desired.release.version} failed the health gate — rolling back`);
      if (previous && previous.release.version !== desired.release.version) {
        await this.state.writeCurrent({ release: previous.release, appliedAt: now(), healthy: false });
        await this.enqueueBoot(previous.release, 'rollback');
        await this.state.appendHistory({
          at: now(),
          event: 'rolled_back',
          releaseId: previous.release.id,
          version: previous.release.version,
          reason: 'auto-rollback after failed health gate',
        });
      } else {
        this.log('[supervisor] no previous release to roll back to — hub is down');
        await this.state.writeCurrent({ release: desired.release, appliedAt: now(), healthy: false });
      }
    }
    // Remember what we replaced so a later manual rollback can return to it
    // (last-good now points at the current release after a successful gate).
    const runningNow = (await this.state.readCurrent())?.release.version;
    if (previous && previous.release.version !== runningNow) {
      await this.state.writePrevious({ release: previous.release, recordedAt: now() });
    }
    await this.state.clearDesired();
  }

  // -------------------------------------------------------------------------
  // Boot + health gate
  // -------------------------------------------------------------------------

  /**
   * Serializes boots through a chain so overlapping spawn/gate cycles (a
   * restart scheduled from an exit handler racing the previous boot's health
   * gate) cannot interleave and reap each other's children.
   */
  private enqueueBoot(release: ReleaseSpec, mode: RunningChild['mode']): Promise<boolean> {
    const run = this.bootQueue.then(() => this.boot(release, mode));
    this.bootQueue = run.then(
      () => true,
      () => true,
    );
    return run;
  }

  /**
   * Stops any child, spawns `release`, and health-gates the boot. Returns
   * true when the child is up and healthy. On failure the child is killed.
   * Call through enqueueBoot (never directly) to keep boots serialized.
   */
  private async boot(release: ReleaseSpec, mode: RunningChild['mode']): Promise<boolean> {
    await this.killChild();
    this.log(`[supervisor] spawning hub ${release.version} (${mode})`);
    const env: NodeJS.ProcessEnv = {
      ...(this.opts.env ?? process.env),
      HUB_VERSION: release.version,
      ...(release.payload?.env ?? {}),
    };
    const proc = spawn(this.bin, this.args, {
      env,
      stdio: 'inherit',
      shell: false,
    });
    const child: RunningChild = { proc, release, mode, startedAtMs: Date.now() };
    this.child = child;
    this.attachExitHandler(child);

    const healthy = this.opts.healthUrl ? await this.gateHealth(release) : true;
    if (!healthy) {
      // Only reap the process this boot spawned — a newer child may have
      // taken over (its own gate) and must not be killed by a stale failure.
      if (this.child?.proc === proc) await this.killChild();
      return false;
    }
    // Any boot that passes the gate is current AND last-known-good.
    const state = { release, appliedAt: now(), healthy: true };
    await this.state.writeCurrent(state);
    await this.state.writeLastGood(state);
    this.log(`[supervisor] hub ${release.version} is up`);
    return true;
  }

  private async gateHealth(release: ReleaseSpec): Promise<boolean> {
    const deadline = Date.now() + this.bootTimeoutMs;
    let lastError = 'no health probe configured';
    while (Date.now() < deadline) {
      const child = this.child;
      if (!child || child.proc.exitCode !== null) {
        const code = child?.proc.exitCode;
        lastError = code === null || code === undefined ? 'process not running' : `process exited with code ${code}`;
        break;
      }
      try {
        const ok = await this.probeHealth();
        if (ok) return true;
        lastError = 'health check not ok yet';
      } catch (err) {
        lastError = (err as Error).message;
      }
      await sleep(200);
    }
    this.log(`[supervisor] health gate failed for ${release.version}: ${lastError}`);
    return false;
  }

  private async probeHealth(): Promise<boolean> {
    const body = await probeJson(this.opts.healthUrl!, this.healthTimeoutMs, this.opts.healthRejectUnauthorized !== false);
    if (!body || body.status !== 'ok') return false;
    const want = this.opts.healthTargetVersion;
    return !want || body.version === want;
  }

  // -------------------------------------------------------------------------
  // Crash watchdog
  // -------------------------------------------------------------------------

  /** Reacts when `child` exits; ignores exits of replaced children. */
  private attachExitHandler(child: RunningChild): void {
    child.proc.once('exit', (code) => {
      const running = child.release;
      // A newer child has taken over (swap in progress) — nothing to do here.
      if (this.stopping || this.swapping || this.child !== child) return;
      this.child = undefined;
      this.log(`[supervisor] hub exited unexpectedly (code ${code}) pid=${child.proc.pid}`);
      // Windowed crash counting: a child that ran stably first clears the
      // window (so a one-off crash after a long healthy run restarts, while
      // a boot-then-die loop escalates). maxRestarts crashes → escalate.
      const nowMs = Date.now();
      if (nowMs - child.startedAtMs >= STABLE_RUN_MS) this.crashTimes = [];
      this.crashTimes = [...this.crashTimes, nowMs].filter((t) => nowMs - t < CRASH_WINDOW_MS);
      if (this.crashTimes.length >= this.maxRestarts) {
        this.log(`[supervisor] crash loop (${this.crashTimes.length} crashes) — escalating`);
        void this.escalate(running);
        return;
      }
      const delay = 200;
      setTimeout(() => {
        if (this.stopping || this.swapping || this.child) return;
        if (running) void this.enqueueBoot(running, 'restart');
      }, delay);
    });
  }

  /**
   * After a crash loop, roll the hub back to the release that ran before the
   * broken one (set when the broken release was applied). If the broken
   * release is the only one we know, give up and leave the hub down rather
   * than loop forever.
   */
  private async escalate(broken?: ReleaseSpec): Promise<void> {
    this.crashTimes = [];
    const target = this.fallback && this.fallback.version !== broken?.version ? this.fallback : undefined;
    if (!target) {
      this.log(`[supervisor] no earlier release to roll back to (broken: ${broken?.version ?? 'none'}) — leaving hub down`);
      await this.state.appendHistory({
        at: now(),
        event: 'failed',
        releaseId: broken?.id,
        version: broken?.version,
        reason: 'crash loop with no rollback target',
      });
      return;
    }
    this.log(`[supervisor] rolling back to previously-good ${target.version}`);
    await this.state.writeCurrent({ release: target, appliedAt: now(), healthy: false });
    const ok = await this.enqueueBoot(target, 'rollback');
    await this.state.appendHistory({
      at: now(),
      event: ok ? 'rolled_back' : 'failed',
      releaseId: target.id,
      version: target.version,
      reason: ok ? 'auto-rollback after crash loop' : 'crash loop rollback also failed',
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private defaultRelease(): ReleaseSpec {
    const version = this.opts.defaultVersion ?? HUB_VERSION;
    return { id: `hub-${version}`, version, payload: { env: { HUB_VERSION: version } } };
  }

  private async killChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    const proc = child.proc;
    if (proc.exitCode !== null) return; // already gone
    proc.kill('SIGTERM');
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    const t = setTimeout(() => proc.kill('SIGKILL'), 5_000);
    try {
      await exited;
    } finally {
      clearTimeout(t);
    }
  }
}

/** Crashes within this window count toward maxRestarts (escalation). */
const CRASH_WINDOW_MS = 60_000;
/** A child alive this long counts as a stable run (clears the crash window). */
const STABLE_RUN_MS = 10_000;

/**
 * GET a URL and parse JSON, honoring TLS verification policy. Uses node:https
 * directly for https URLs so rejectUnauthorized can be set per-probe (global
 * fetch has no per-request TLS knob). Throws on HTTP/JSON/TLS failure.
 */
async function probeJson(url: string, timeoutMs: number, rejectUnauthorized: boolean): Promise<{ status?: string; version?: string } | undefined> {
  const u = new URL(url);
  if (u.protocol === 'https:') {
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        u,
        { rejectUnauthorized, timeout: timeoutMs, headers: { accept: 'application/json' } },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (raw += c));
          res.on('end', () => {
            try {
              if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
              } else {
                resolve(JSON.parse(raw) as { status?: string; version?: string });
              }
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('probe timed out')));
      req.on('error', reject);
      req.end();
    });
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as { status?: string; version?: string };
  } finally {
    clearTimeout(t);
  }
}

function now(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
