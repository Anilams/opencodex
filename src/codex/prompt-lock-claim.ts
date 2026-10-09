import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownEvidence, ownerState, safeNamespace, type OwnerDeps, type OwnerEvidence } from "./prompt-lock-owner";

export interface ClaimRecord extends OwnerEvidence { ticket: number }
export class UnsafeLockNamespace extends Error {
  constructor(readonly path: string) { super(`Unsafe lock state at ${path}; deliberate removal is required.`); }
}
/** Publish owner evidence together with choosing=0; an empty reservation is never published. */
export function withLockClaim<T>(
  path: string, token: string, deps: OwnerDeps, run: () => T,
  initialized?: () => void,
): { ok: true; value: T } | { ok: false } {
  const directory = `${path}.claims`;
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (!safeNamespace(directory, "directory", deps)) throw new UnsafeLockNamespace(directory);
  const ownName = `${process.pid}-${token}.claim`, ownPath = join(directory, ownName);
  const temporary = `${path}.claim-init-${token}`;
  let published = false;
  const evidence = ownEvidence(deps);
  const peers = (): Array<{ name: string; ticket: number }> => {
    if (!safeNamespace(directory, "directory", deps)) throw new UnsafeLockNamespace(directory);
    const result: Array<{ name: string; ticket: number }> = [];
    for (const name of readdirSync(directory)) {
      if (name === ownName) continue;
      const peerPath = join(directory, name);
      if (!/^([1-9][0-9]*)-[0-9a-f]{16}\.claim$/.test(name)
        || !safeNamespace(peerPath, "file", deps, true)) throw new UnsafeLockNamespace(peerPath);
      let peer: ClaimRecord | null;
      try { peer = JSON.parse(readFileSync(peerPath, "utf8")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new UnsafeLockNamespace(peerPath);
      }
      const state = ownerState(peer, deps);
      if (state === "unsafe") throw new UnsafeLockNamespace(peerPath);
      if (state === "dead") { unlinkSync(peerPath); continue; }
      const ticket = peer?.ticket;
      if (typeof ticket !== "number" || !Number.isSafeInteger(ticket) || ticket < 0) throw new UnsafeLockNamespace(peerPath);
      result.push({ name, ticket });
    }
    return result;
  };
  try {
    writeFileSync(temporary, JSON.stringify({ ...evidence, ticket: 0 }), { mode: 0o600, flag: "wx" });
    linkSync(temporary, ownPath);
    published = true;
    unlinkSync(temporary);
    initialized?.();
    let ticket = 1;
    for (const peer of peers()) ticket = Math.max(ticket, peer.ticket + 1);
    if (!Number.isSafeInteger(ticket)) return { ok: false };
    writeFileSync(temporary, JSON.stringify({ ...evidence, ticket }), { mode: 0o600, flag: "wx" });
    if (!safeNamespace(ownPath, "file", deps)) throw new UnsafeLockNamespace(ownPath);
    renameSync(temporary, ownPath);
    for (const peer of peers()) {
      if (peer.ticket === 0 || peer.ticket < ticket || (peer.ticket === ticket && peer.name < ownName)) return { ok: false };
    }
    if (!safeNamespace(path, "file", deps, true)) throw new UnsafeLockNamespace(path);
    return { ok: true, value: run() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: false };
    throw error;
  } finally {
    try { unlinkSync(temporary); } catch { /* Our unique initialization file. */ }
    if (published && safeNamespace(directory, "directory", deps) && safeNamespace(ownPath, "file", deps)) {
      try { unlinkSync(ownPath); } catch { /* Our unique reservation. */ }
      try { rmdirSync(directory); } catch { /* A peer still owns a reservation. */ }
    }
  }
}
