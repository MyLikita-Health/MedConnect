/**
 * Update agent (plan G3 "signed update packages", M2 installer/update item).
 *
 * Runs inside the hub process. It is deliberately *not* responsible for
 * restarting anything: it verifies signed release manifests against the
 * configured update public key and stages them in the state directory
 * (desired.json); the supervisor process — which owns the hub's lifecycle —
 * observes the staged release, swaps the running version, health-gates it,
 * and auto-rolls-back on failure. That boundary is what makes updates safe:
 * the running process can never be asked to replace its own code.
 *
 * Sources are outbound-only (an https URL the facility configures, or a
 * local path/update dir for air-gapped installs) — the hub never opens an
 * inbound update port (PRD §42).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HUB_PLATFORM, HUB_VERSION } from '@integration-hub/shared';
import {
  compareSemver,
  isNewerVersion,
  updateManifestSchema,
  verifyManifestSignature,
  type UpdateManifest,
  type UpdateRelease,
} from './manifest.js';
import { UpdateStateDir, type CurrentState, type DesiredState, type ReleaseSpec } from './state.js';

export interface UpdateAgentOptions {
  /** State directory shared with the supervisor (HUB_STATE_DIR). */
  stateDir: string;
  /**
   * Where signed manifests are published: http(s) URL, a .json file path, or
   * a directory containing manifest.json. Unset disables the agent.
   */
  source?: string;
  /** PEM public key that must verify every manifest (UPDATE_PUBLIC_KEY). */
  publicKeyPem?: string;
  /** Running version when no state file exists yet (defaults to HUB_VERSION). */
  currentVersion?: string;
}

export interface UpdateCheckResult {
  checkedAt: string;
  available: boolean;
  manifest?: UpdateManifest;
  reason?: string;
}

export interface UpdateStatus {
  enabled: boolean;
  source?: string;
  supervisor: { alive: boolean; pid?: number; lastSeenAt?: string };
  running: ReleaseSpec;
  current?: CurrentState;
  desired?: DesiredState;
  /** Release replaced by the latest swap (preferred rollback target). */
  previous?: import('./state.js').PreviousState;
  lastGood?: CurrentState;
  history: import('./state.js').HistoryEntry[];
  lastCheck?: UpdateCheckResult;
}

export interface StageResult {
  staged: boolean;
  release?: ReleaseSpec;
  reason?: string;
}

export class UpdateAgent {
  private readonly state: UpdateStateDir;
  private lastCheck?: UpdateCheckResult;

  constructor(private readonly opts: UpdateAgentOptions) {
    this.state = new UpdateStateDir(opts.stateDir);
  }

  get enabled(): boolean {
    return Boolean(this.opts.source && this.opts.publicKeyPem);
  }

  get currentCodeVersion(): string {
    return this.opts.currentVersion ?? HUB_VERSION;
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  async status(): Promise<UpdateStatus> {
    const [current, desired, lastGood, previous, history, supervisor] = await Promise.all([
      this.state.readCurrent(),
      this.state.readDesired(),
      this.state.readLastGood(),
      this.state.readPrevious(),
      this.state.readHistory(50),
      this.state.readSupervisor(),
    ]);
    const supervisorAlive = supervisor ? Date.now() - Date.parse(supervisor.lastSeenAt) < 15_000 : false;
    const running = current?.release ?? defaultRelease(this.currentCodeVersion);
    return {
      enabled: this.enabled,
      source: this.enabled ? this.opts.source : undefined,
      supervisor: { alive: supervisorAlive, pid: supervisor?.pid, lastSeenAt: supervisor?.lastSeenAt },
      running,
      current,
      desired,
      previous,
      lastGood,
      history,
      lastCheck: this.lastCheck,
    };
  }

  // -------------------------------------------------------------------------
  // Check: fetch + verify + policy
  // -------------------------------------------------------------------------

  /**
   * Fetches the signed manifest from the configured source and verifies it:
   * signature, platform, version range vs the running release. Never mutates
   * state (the result is cached for apply()). Rejects are appended to the
   * state history so a tampered/out-of-range update is traceable.
   */
  async check(): Promise<UpdateCheckResult> {
    if (!this.enabled) {
      return this.recordCheck({ available: false, reason: 'update agent disabled (no source/public key)' });
    }
    let manifest: UpdateManifest;
    try {
      manifest = await this.loadManifest();
    } catch (err) {
      const reason = `cannot reach update source: ${(err as Error).message}`;
      await this.state.appendHistory({ at: now(), event: 'rejected', reason });
      return this.recordCheck({ available: false, reason });
    }
    try {
      verifyManifestSignature(manifest, this.opts.publicKeyPem!);
    } catch (err) {
      const reason = (err as Error).message;
      await this.state.appendHistory({ at: now(), event: 'rejected', releaseId: manifest.release.id, version: manifest.release.version, reason });
      return this.recordCheck({ available: false, reason });
    }
    const policy = this.applyPolicy(manifest.release);
    if (policy) {
      await this.state.appendHistory({
        at: now(),
        event: 'rejected',
        releaseId: manifest.release.id,
        version: manifest.release.version,
        reason: policy,
      });
      return this.recordCheck({ available: false, manifest, reason: policy });
    }
    return this.recordCheck({ available: true, manifest });
  }

  /** Version-range/platform policy against the running release. */
  private applyPolicy(release: UpdateRelease): string | undefined {
    const running = this.currentCodeVersion;
    if (release.platform !== 'any' && release.platform !== HUB_PLATFORM) {
      return `release targets ${release.platform}, this hub runs ${HUB_PLATFORM}`;
    }
    if (!isNewerVersion(release.version, running)) {
      return `release ${release.version} is not newer than running ${running}`;
    }
    if (compareSemver(running, release.minHubVersion) < 0) {
      return `release requires hub >= ${release.minHubVersion} (running ${running})`;
    }
    if (release.maxHubVersion && compareSemver(running, release.maxHubVersion) >= 0) {
      return `release requires hub < ${release.maxHubVersion} (running ${running})`;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Apply / rollback (stage into desired.json for the supervisor)
  // -------------------------------------------------------------------------

  /**
   * Stages the newest release at the source for the supervisor to apply.
   * Always re-checks (fresh fetch + signature + policy) — the staged release
   * must be the one at the source *now*, never a stale cached check.
   */
  async apply(by?: string): Promise<StageResult> {
    if (!this.enabled) return { staged: false, reason: 'update agent disabled' };
    await this.check();
    const manifest = this.lastCheck?.manifest;
    if (!this.lastCheck?.available || !manifest) {
      return { staged: false, reason: this.lastCheck?.reason ?? 'no verified release available' };
    }
    const running = await this.runningRelease();
    if (!isNewerVersion(manifest.release.version, running.version)) {
      return { staged: false, reason: `release ${manifest.release.version} is not newer than running ${running.version}` };
    }
    const release = specFromManifest(manifest);
    await this.state.writeDesired({ kind: 'update', release, stagedAt: now(), by });
    await this.state.appendHistory({ at: now(), event: 'staged', releaseId: release.id, version: release.version, by });
    return { staged: true, release };
  }

  /**
   * Stages a rollback. Target selection: the release the supervisor replaced
   * (previous.json — lets you undo a successful update), else the
   * last-known-good release. No version-range policy applies — rolling back
   * may go to an older version by design.
   */
  async rollback(by?: string): Promise<StageResult> {
    if (!this.enabled) return { staged: false, reason: 'update agent disabled' };
    const running = await this.runningRelease();
    const [previous, lastGood] = await Promise.all([this.state.readPrevious(), this.state.readLastGood()]);
    let target = previous?.release.version !== running.version ? previous?.release : undefined;
    if (!target && lastGood?.release.version !== running.version) target = lastGood?.release;
    if (!previous && !lastGood) return { staged: false, reason: 'no earlier release recorded (nothing to roll back to)' };
    if (!target) {
      const already = lastGood?.release.version === running.version || previous?.release.version === running.version;
      return {
        staged: false,
        reason: already ? `already running the previously-applied release ${running.version}` : 'no usable rollback target recorded',
      };
    }
    await this.state.writeDesired({ kind: 'rollback', release: target, stagedAt: now(), by });
    await this.state.appendHistory({
      at: now(),
      event: 'staged',
      releaseId: target.id,
      version: target.version,
      reason: 'manual rollback',
      by,
    });
    return { staged: true, release: target };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** The release this hub is actually running (state file wins, else code). */
  async runningRelease(): Promise<ReleaseSpec> {
    const current = await this.state.readCurrent();
    return current?.release ?? defaultRelease(this.currentCodeVersion);
  }

  private recordCheck(result: Omit<UpdateCheckResult, 'checkedAt'>): UpdateCheckResult {
    this.lastCheck = { ...result, checkedAt: now() };
    return this.lastCheck;
  }

  private async loadManifest(): Promise<UpdateManifest> {
    const source = this.opts.source!;
    let raw: string;
    if (/^https?:\/\//.test(source)) {
      const res = await fetch(source);
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${source}`);
      raw = await res.text();
    } else {
      const path = source.endsWith('.json') ? source : join(source, 'manifest.json');
      raw = await readFile(path, 'utf8');
    }
    return updateManifestSchema.parse(JSON.parse(raw));
  }
}

function defaultRelease(version: string): ReleaseSpec {
  return { id: `hub-${version}`, version, payload: { env: { HUB_VERSION: version } } };
}

export function specFromManifest(manifest: UpdateManifest): ReleaseSpec {
  return {
    id: manifest.release.id,
    version: manifest.release.version,
    payload: manifest.release.payload,
  };
}

function now(): string {
  return new Date().toISOString();
}
