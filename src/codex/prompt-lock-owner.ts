import { lstatSync, readFileSync, type Stats } from "node:fs";
import { resolveTrustedWindowsPowerShellExe } from "../lib/windows-elevation";
import { hardenSecretDir } from "../lib/windows-secret-acl";
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
  hardenDirectory: (path: string) => boolean;
}

function command(args: string[]): string | undefined {
  try {
    const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe", timeout: 1_000 });
    const value = result.stdout.toString().trim();
    return result.exitCode === 0 && value ? value : undefined;
  } catch { return undefined; }
}
let cachedHost: HostIdentity | undefined;
let hostRead = false;
function hostIdentity(): HostIdentity | undefined {
  if (hostRead) return cachedHost;
  hostRead = true;
  let machine: string | undefined;
  try {
    if (process.platform === "linux") machine = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    else if (process.platform === "darwin") machine = command(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"]);
    else if (process.platform === "win32") machine = command([resolveTrustedWindowsPowerShellExe(), "-NoProfile", "-NonInteractive", "-Command", "(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Cryptography').MachineGuid"]);
    if (machine) cachedHost = { hostname: hostname(), machine };
  } catch { /* Missing identity means no automatic takeover. */ }
  return cachedHost;
}
function probeProcessStart(pid: number): string | undefined {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    }
    if (process.platform === "darwin") return command(["/bin/ps", "-p", String(pid), "-o", "lstart="]);
    if (process.platform === "win32") return command([resolveTrustedWindowsPowerShellExe(), "-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`]);
  } catch { /* Unknown start identity never proves death. */ }
  return undefined;
}
let ownStartRead = false;
let cachedOwnStart: string | undefined;
function processStart(pid: number): string | undefined {
  if (pid !== process.pid) return probeProcessStart(pid);
  if (!ownStartRead) { cachedOwnStart = probeProcessStart(pid); ownStartRead = true; }
  return cachedOwnStart;
}
export const ownerDefaults: OwnerDeps = {
  isProcessAlive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ESRCH" ? false : code === "EPERM" ? true : undefined;
    }
  },
  hostIdentity, processStart, lstat: lstatSync,
  uid: () => process.getuid?.(), platform: process.platform,
  hardenDirectory(path) {
    try { return hardenSecretDir(path, { required: true }).ok; } catch { return false; }
  },
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
