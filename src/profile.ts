/**
 * Agent profile manager: a persistent throwaway dir for the agent browser.
 *
 * The agent runs its OWN browser identity (separate from the user's Chrome):
 * log in once inside the agent browser and the session persists here across
 * runs. Nothing is ever copied from — or written to — the real profile.
 *
 * Two invariants:
 * - Only one browser per profile dir (file lock + in-process mutex pair).
 * - The dir stays private to the user (0700).
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function agentRoot(override?: string): string {
  return override ?? "/tmp/agent-chrome";
}

/** Create the agent root with private permissions (idempotent). */
export function ensureAgentRoot(root?: string): string {
  const dir = root ?? agentRoot();
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best-effort (non-POSIX filesystems).
  }
  return dir;
}

export function wipeProfileCopy(root?: string): string {
  const dir = root ?? agentRoot();
  rmSync(dir, { recursive: true, force: true });
  return dir;
}

/** Lock state in plain words. Never throws — diagnostics only.
 *  `stale` means no live browser behind the lock (safe to clear). */
export function profileLockInfo(root?: string): { locked: boolean; stale: boolean } {
  const dir = `${root ?? agentRoot()}.lock`;
  try {
    readFileSync(join(dir, "pid"), "utf8");
  } catch {
    return { locked: false, stale: false };
  }
  const r = root ?? agentRoot();
  return { locked: true, stale: !isProfileInUse(r) };
}

/** True when a live browser process is actually using this profile dir.
 *  Matches Chromium (--user-data-dir=<dir>) and Firefox
 *  (-profile <dir>) command lines, token-split on whitespace AND NULs
 *  (wrappers and sandboxes space-join argv), skipping self and parent —
 *  so /tmp/pr never matches /tmp/pr-other. Fail-closed: if we cannot
 *  tell (no /proc, no pgrep), assume in use. */
export function isProfileInUse(root?: string): boolean {
  const dir = root ?? agentRoot();
  const viaProc = isProfileInUseProc(dir);
  if (viaProc !== null) return viaProc;
  let pgrepRan = false;
  for (const pat of [`user-data-dir=${dir}`, `-profile ${dir}`]) {
    try {
      const out = execFileSync("pgrep", ["-af", pat], { encoding: "utf8" });
      pgrepRan = true;
      const me = new Set([String(process.pid), String(process.ppid)]);
      for (const line of out.split("\n").filter(Boolean)) {
        const pid = line.split(" ")[0];
        if (me.has(pid)) continue;
        if (!/(chrome|firefox|camoufox)/i.test(line)) continue;
        return true;
      }
    } catch (err) {
      // Exit status 1 = no match for this pattern (informative, not fatal).
      if ((err as { status?: unknown })?.status === 1) pgrepRan = true;
    }
  }
  // Fail closed only when pgrep itself is unavailable; a clean no-match
  // means free.
  return !pgrepRan;
}

function isProfileInUseProc(dir: string): boolean | null {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return null;
  }
  try {
    const me = new Set([process.pid, process.ppid]);
    for (const e of entries) {
      if (!/^\d+$/.test(e)) continue;
      const pid = Number(e);
      if (me.has(pid)) continue;
      let tokens: string[];
      try {
        tokens = readFileSync(`/proc/${pid}/cmdline`, "utf8").split(/[\s\0]+/);
      } catch {
        continue;
      }
      if (!/(chrome|firefox|camoufox)/i.test(tokens.join(" "))) continue;
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        // Chromium: --user-data-dir=<dir>[/…] — old agent used <dir>/browser.
        if (t === `--user-data-dir=${dir}` || t === `--user-data-dir=${join(dir, "browser")}`) return true;
        // Firefox: -profile <dir> (Camoufox passes the profile dir here).
        if ((t === "-profile" || t === "--profile") && (tokens[i + 1] === dir || (tokens[i + 1] ?? "").startsWith(dir + "/"))) return true;
      }
    }
    return false;
  } catch {
    return null;
  }
}

/** Remove the lock only when it is safe: never while a live browser uses
 *  the profile, and never yank a lock a fresh launcher just made (owner
 *  alive + young lock = browser may still be spawning, keep waiting).
 *  A provably dead owner with no browser behind it clears at once. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tryClearStaleLock(lockDir: string, maxAgeMs: number): boolean {
  try {
    const root = lockDir.endsWith(".lock") ? lockDir.slice(0, -".lock".length) : lockDir;
    if (isProfileInUse(root)) return false;
    let owner: "dead" | "alive" | "unknown" = "unknown";
    try {
      const pid = Number(readFileSync(join(lockDir, "pid"), "utf8").trim());
      owner = Number.isFinite(pid) && pidAlive(pid) ? "alive" : "dead";
    } catch {
      owner = "unknown";
    }
    if (owner === "dead") {
      rmSync(lockDir, { recursive: true, force: true });
      return true;
    }
    const mtime = statSync(join(lockDir, "pid")).mtimeMs;
    if (Date.now() - mtime < maxAgeMs) return false;
    rmSync(lockDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Remove a stale lock file (no live browser behind it). Returns true when
 *  anything was removed. Explicit user intent only — never called silently. */
export function clearStaleLock(root?: string): boolean {
  const dir = `${root ?? agentRoot()}.lock`;
  try {
    readFileSync(join(dir, "pid"), "utf8");
  } catch {
    return false;
  }
  return tryClearStaleLock(dir, 120_000);
}

/** Cross-process lock: two Chromium instances on one profile dir corrupt it.
 *  Atomic mkdir + stale-owner detection. Pair with the in-process mutex. */
export async function acquireProfileLock(root?: string, timeoutMs = 120_000): Promise<() => void> {
  const dir = `${root ?? agentRoot()}.lock`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "pid"), String(process.pid));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        rmSync(dir, { recursive: true, force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      // Dead owner, orphaned browserless lock, or live contender still
      // launching: only a lock with no live browser behind it AND older
      // than our whole patience window may go. Otherwise keep waiting.
      if (tryClearStaleLock(dir, timeoutMs)) continue;
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for profile lock ${dir}; another agent run may be active.`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}
