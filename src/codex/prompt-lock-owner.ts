import { lstatSync, readFileSync, type Stats } from "node:fs";
import { resolveTrustedWindowsPowerShellExe } from "../lib/windows-elevation";
import { hostname } from "node:os";

export interface HostIdentity { hostname: string; machine: string }
export interface OwnerEvidence { pid: number; host?: HostIdentity; processStart?: string }
export interface OwnerDeps {
  isProcessAlive: (pid: number) => boolean | undefined;
  hostIdentity: () => HostIdentity | undefined;
  processStart: (pid: number) => string | undefined;
  lstat: (path: string) => Stats;
  uid: () => number | undefined;
  platform: NodeJS.Platform;
}

function command(args: string[], timeoutMs: number): string | undefined {
  try {
    const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    const value = result.stdout.toString().trim();
    return result.exitCode === 0 && value ? value : undefined;
  } catch { return undefined; }
}
/** One lazy identity cache per process; unavailable results are cached too. */
export function createOwnerIdentity({
  platform = process.platform, runCommand = command,
  powerShellExe = resolveTrustedWindowsPowerShellExe,
}: {
  platform?: NodeJS.Platform;
  runCommand?: (args: string[], timeoutMs: number) => string | undefined;
  powerShellExe?: () => string;
} = {}): Pick<OwnerDeps, "hostIdentity" | "processStart"> {
  let cachedHost: HostIdentity | undefined;
  let hostRead = false;
  function hostIdentity(): HostIdentity | undefined {
    if (hostRead) return cachedHost;
    hostRead = true;
    let machine: string | undefined;
    try {
      if (platform === "linux") machine = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      else if (platform === "darwin") machine = runCommand(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"], 1_000);
      else if (platform === "win32") machine = runCommand([powerShellExe(), "-NoProfile", "-NonInteractive", "-Command", "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid"], 1_000);
      if (machine) cachedHost = { hostname: hostname(), machine };
    } catch { /* Missing identity means no automatic takeover. */ }
    return cachedHost;
  }
  function probeProcessStart(pid: number): string | undefined {
    try {
      if (platform === "linux") {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      }
      if (platform === "darwin") return runCommand(["/bin/ps", "-p", String(pid), "-o", "lstart="], 1_000);
      if (platform === "win32") return runCommand([powerShellExe(), "-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], 1_000);
    } catch { /* Unknown start identity never proves death. */ }
    return undefined;
  }
  let ownStartRead = false;
  let cachedOwnStart: string | undefined;
  function processStart(pid: number): string | undefined {
    if (pid !== process.pid) return probeProcessStart(pid);
    if (!ownStartRead) { ownStartRead = true; cachedOwnStart = probeProcessStart(pid); }
    return cachedOwnStart;
  }
  return { hostIdentity, processStart };
}
const identity = createOwnerIdentity();
export const ownerDefaults: OwnerDeps = {
  isProcessAlive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ESRCH" ? false : code === "EPERM" ? true : undefined;
    }
  },
  ...identity, lstat: lstatSync,
  uid: () => process.getuid?.(), platform: process.platform,
};
export function ownEvidence(deps: OwnerDeps): OwnerEvidence {
  let host: HostIdentity | undefined, start: string | undefined;
  try { host = deps.hostIdentity(); } catch { /* hostless */ }
  try { start = deps.processStart(process.pid); } catch { /* unknown */ }
  return { pid: process.pid, ...(host ? { host } : {}), ...(start ? { processStart: start } : {}) };
}
export function ownerState(record: OwnerEvidence | null, deps: OwnerDeps): "dead" | "live" | "unsafe" {
  let host: HostIdentity | undefined;
  try { host = deps.hostIdentity(); } catch { return "unsafe"; }
  if (!host || !record?.host || !record.processStart || !Number.isSafeInteger(record.pid) || record.pid <= 0
    || host.hostname !== record.host.hostname || host.machine !== record.host.machine) return "unsafe";
  try {
    // Probe another PID's start only when liveness permits a takeover decision.
    if (deps.isProcessAlive(record.pid) !== false) return "live";
    const start = deps.processStart(record.pid);
    // A reused PID is not permission to remove another process's record.
    if (start !== undefined && start !== record.processStart) return "live";
    return deps.isProcessAlive(record.pid) === false ? "dead" : "live";
  } catch { return "live"; }
}
export function safeNamespace(path: string, kind: "file" | "directory", deps: OwnerDeps, missing = false): boolean {
  try {
    const stat = deps.lstat(path), uid = deps.uid();
    return !stat.isSymbolicLink() && (kind === "file" ? stat.isFile() : stat.isDirectory())
      && (deps.platform === "win32" || (uid !== undefined && stat.uid === uid));
  } catch (error) { return missing && (error as NodeJS.ErrnoException).code === "ENOENT"; }
}
