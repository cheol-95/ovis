/**
 * Whether each catalog agent is on this PC, and which version: its executable found the way
 * /api/agents finds it, then asked for its version with the catalog's own flag, under a time limit.
 * A version is kept for as long as the executable file is the same one (path, size, modification
 * time): an install or an update shows on the next read, and an unchanged executable is never asked
 * twice. Nothing here installs, updates or signs in.
 */
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { meetsMinVersion, parseVersion, type AgentCatalogEntry, type AgentInstallState, type CatalogPlatform } from "../shared/agent-catalog.ts";
import { loginPathProbe, loginShell, type LoginPathProbe } from "./shell-agent.ts";

/** How long one `--version` may run before it is killed and reported as timed out. */
export const VERSION_TIMEOUT_MS = 5_000;
/** At most this much of what a version flag prints is read: a version is one short line. */
const VERSION_OUTPUT_BYTES = 4096;
/** Version flags run at once at most: a first read of the whole catalog starts one process per agent. */
const PARALLEL_RUNS = 4;
/** How long a timed-out read stands before it is tried again: it may have been a slow first start (an npm shim's cold cache). */
export const TIMEOUT_KEPT_MS = 60_000;

/** Where a catalog binary is on this PC, as an absolute path, or null. */
export type Locate = (binary: string) => Promise<string | null>;

/** How long the login shell's PATH is kept before a lookup that misses reads it again. */
export const LOGIN_PATH_KEPT_MS = 60_000;

const isExecutableFile = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch { return false; }
};

/**
 * Finds a catalog binary on this server's PATH, then on the PATH its user's login shell sets.
 * Installers put agents in ~/.local/bin and the like, which a login shell adds and a server run as
 * a service often lacks: without the second look, an agent an install just put there reads as not
 * installed. The login shell runs only for a binary the service PATH misses, at most once per
 * LOGIN_PATH_KEPT_MS, shared by every lookup meanwhile; only absolute executable files count.
 */
export function catalogLocator(options: { probe: LoginPathProbe | null; servicePath?: () => string; now?: () => number; signal?: AbortSignal }): Locate {
  const servicePath = options.servicePath ?? (() => process.env["PATH"] ?? "");
  const now = options.now ?? Date.now;
  const signal = options.signal ?? new AbortController().signal;
  let kept: { path: string | null; at: number } | null = null;
  let reading: Promise<string | null> | null = null;
  const loginPath = (probe: LoginPathProbe): Promise<string | null> => {
    if (kept !== null && now() - kept.at < LOGIN_PATH_KEPT_MS) return Promise.resolve(kept.path);
    reading ??= probe(signal)
      .then((result) => result.path, () => null)
      .then((path) => { kept = { path, at: now() }; return path; })
      .finally(() => { reading = null; });
    return reading;
  };
  return async (binary) => {
    const own = Bun.which(binary, { PATH: servicePath() });
    if (own !== null || options.probe === null) return own;
    const path = await loginPath(options.probe);
    const found = path === null ? null : Bun.which(binary, { PATH: path });
    return found !== null && isAbsolute(found) && isExecutableFile(found) ? found : null;
  };
}

/** The login-shell PATH probe of the real entrypoints: none on Windows, nor where the user has no login shell. */
export function defaultLoginProbe(platform: string = process.platform): LoginPathProbe | null {
  if (platform === "win32") return null;
  const shell = loginShell();
  return shell === null ? null : loginPathProbe({ shell });
}

export interface VersionRun {
  /** what the process printed, stdout then stderr, at most VERSION_OUTPUT_BYTES of each */
  output: string;
  exitCode: number | null;
  timedOut: boolean;
}
export type RunVersion = (executable: string, args: readonly string[], timeoutMs: number) => Promise<VersionRun>;

async function readBounded(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < VERSION_OUTPUT_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    // the rest is not wanted: a process that keeps printing must not hold this read open
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, VERSION_OUTPUT_BYTES));
}

/** Runs `executable args` with no input and this server's environment, killed at `timeoutMs`. */
export const runVersion: RunVersion = async (executable, args, timeoutMs) => {
  const child = Bun.spawn([executable, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: timeoutMs, killSignal: "SIGKILL" });
  const [stdout, stderr, exitCode] = await Promise.all([readBounded(child.stdout), readBounded(child.stderr), child.exited]);
  return { output: `${stdout}\n${stderr}`, exitCode, timedOut: child.signalCode === "SIGKILL" };
};

interface Kept {
  /** the executable file as it was when its version was read */
  fingerprint: string;
  version: string | null;
  error: AgentInstallState["version_error"];
  /** when a timed-out read is tried again; null: kept while the file is the same */
  retryAt: number | null;
}

const fingerprintOf = (executable: string): string | null => {
  try {
    const stat = statSync(executable);
    return stat.isFile() ? `${executable}\0${stat.size}\0${stat.mtimeMs}` : null;
  } catch {
    return null;
  }
};

export class AgentDetector {
  readonly #locate: Locate;
  readonly #run: RunVersion;
  readonly #timeoutMs: number;
  /** by executable path: the version read from the file the fingerprint names */
  readonly #kept = new Map<string, Kept>();
  /** by fingerprint: a version read in progress, shared by every caller meanwhile */
  readonly #running = new Map<string, Promise<Kept>>();
  #active = 0;
  readonly #waiting: (() => void)[] = [];

  readonly #now: () => number;
  readonly #home: string;
  readonly #env: Record<string, string | undefined>;

  constructor(options: { locate: Locate; run?: RunVersion; timeoutMs?: number; now?: () => number; home?: string; env?: Record<string, string | undefined> }) {
    this.#locate = options.locate;
    this.#run = options.run ?? runVersion;
    this.#timeoutMs = options.timeoutMs ?? VERSION_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
    this.#home = options.home ?? homedir();
    this.#env = options.env ?? process.env;
  }

  /** `binary` in one of the installer's folders (detect.install_dirs), as an executable file, or null. */
  #inInstallDirs(binary: string, dirs: readonly string[], platform: CatalogPlatform): string | null {
    const names = platform === "windows" ? [`${binary}.exe`, `${binary}.cmd`, binary] : [binary];
    for (const dir of dirs) {
      const variable = /^%([A-Z_]+)%\//.exec(dir);
      const base = dir.startsWith("~/") ? join(this.#home, dir.slice(2)) : variable !== null ? (this.#env[variable[1]!] ? join(this.#env[variable[1]!]!, dir.slice(variable[0].length)) : null) : null;
      if (base === null) continue;
      for (const name of names) if (isExecutableFile(join(base, name))) return join(base, name);
    }
    return null;
  }

  async #slot<T>(work: () => Promise<T>): Promise<T> {
    if (this.#active >= PARALLEL_RUNS) await new Promise<void>((resolve) => this.#waiting.push(resolve));
    this.#active++;
    try {
      return await work();
    } finally {
      this.#active--;
      this.#waiting.shift()?.();
    }
  }

  async #version(executable: string, fingerprint: string, args: readonly string[]): Promise<Kept> {
    const kept = this.#kept.get(executable);
    if (kept?.fingerprint === fingerprint && (kept.retryAt === null || this.#now() < kept.retryAt)) return kept;
    const running = this.#running.get(fingerprint);
    if (running) return running;
    const read = this.#slot(async (): Promise<Kept> => {
      try {
        const run = await this.#run(executable, args, this.#timeoutMs);
        if (run.timedOut) return { fingerprint, version: null, error: "timeout", retryAt: this.#now() + TIMEOUT_KEPT_MS };
        const version = parseVersion(run.output);
        return { fingerprint, version, error: version === null ? "unreadable" : null, retryAt: null };
      } catch {
        return { fingerprint, version: null, error: "failed", retryAt: null };
      }
    }).then((result) => {
      this.#kept.set(executable, result);
      return result;
    }).finally(() => this.#running.delete(fingerprint));
    this.#running.set(fingerprint, read);
    return read;
  }

  /**
   * Whether `entry` is on this PC: the first of its binaries found, and that one's version. Where
   * another program has the binary's name (detect.unreliable_on), nothing is looked up or run.
   */
  async state(entry: AgentCatalogEntry, platform: CatalogPlatform | null): Promise<AgentInstallState> {
    if (platform !== null && entry.detect.unreliable_on?.[platform] !== undefined) {
      return { installed: null, binary: null, on_path: null, version: null, version_error: null, meets_min_version: null };
    }
    for (const binary of entry.detect.binaries) {
      const onPath = await this.#locate(binary);
      const executable = onPath ?? (platform === null ? null : this.#inInstallDirs(binary, entry.detect.install_dirs?.[platform] ?? [], platform));
      if (executable === null) continue;
      const fingerprint = fingerprintOf(executable);
      if (fingerprint === null) continue;
      const { version, error } = await this.#version(executable, fingerprint, entry.detect.version_args);
      return {
        installed: true,
        binary,
        on_path: onPath !== null,
        version,
        version_error: error,
        meets_min_version: entry.min_version === null || version === null ? null : meetsMinVersion(version, entry.min_version.version),
      };
    }
    return { installed: false, binary: null, on_path: null, version: null, version_error: null, meets_min_version: null };
  }
}
