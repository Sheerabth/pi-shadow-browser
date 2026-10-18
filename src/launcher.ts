/**
 * Camoufox launcher: every process owns its browser.
 *
 * The profile-lock holder runs the canonical PERSISTENT profile
 * (<root>/camoufox-profile) — logins survive restarts. Everyone else runs
 * an EPHEMERAL scratch browser hydrated from the shared session snapshot
 * (<root>/state.json, 0600): no lock contention, no profile corruption,
 * logins roam one way (persistent → ephemeral).
 *
 * No daemon, no rendezvous, no CDP. A dead process leaves nothing behind
 * except its lock (stale-cleared) and scratch dir (best-effort removed).
 */

import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Camoufox } from "camoufox-js";
import type { Browser, BrowserContext } from "playwright-core";
import { acquireProfileLock, agentRoot, ensureAgentRoot } from "./profile.js";

export interface ProxyOpts {
  server: string;
  username?: string;
  password?: string;
}

export interface LaunchResult {
  ctx: BrowserContext;
  /** Set in ephemeral mode (owned browser); null in persistent mode. */
  browser: Browser | null;
  mode: "main" | "ephemeral";
  /** Release lock / remove scratch / close browser. Idempotent-ish. */
  cleanup: () => Promise<void>;
  statePath: string;
}

export function sharedStatePath(root?: string): string {
  return join(root ?? agentRoot(), "state.json");
}

function stateImport(root: string): { storageState: string } | Record<string, never> {
  const p = sharedStatePath(root);
  try {
    if (existsSync(p)) return { storageState: p };
  } catch {
    // Best-effort.
  }
  return {};
}

async function exportState(ctx: BrowserContext, statePath: string): Promise<void> {
  try {
    await ctx.storageState({ path: statePath });
    try {
      chmodSync(statePath, 0o600);
    } catch {
      // Best-effort.
    }
  } catch {
    // Best-effort (context closing races export).
  }
}

export async function launchAgentBrowser(opts: {
  root?: string;
  headless?: boolean;
  proxy?: ProxyOpts;
  locale?: string;
}): Promise<LaunchResult> {
  const root = ensureAgentRoot(opts.root);
  const statePath = sharedStatePath(root);
  const headless = opts.headless ?? true;
  const base: Record<string, unknown> = { headless };
  if (opts.proxy) base.proxy = opts.proxy;
  if (opts.locale) base.locale = opts.locale;

  // Main mode: canonical persistent profile. Non-blocking lock: only one
  // holder; losers fall through to ephemeral (never wait on another agent).
  try {
    const release = await acquireProfileLock(root, 1);
    const dir = join(root, "camoufox-profile");
    const ctx = (await Camoufox({ user_data_dir: dir, ...base })) as unknown as BrowserContext;
    await exportState(ctx, statePath);
    const timer = setInterval(() => void exportState(ctx, statePath), 60_000);
    const maybeUnref = timer as unknown as { unref?: () => void };
    if (typeof maybeUnref.unref === "function") maybeUnref.unref();
    let cleaned = false;
    return {
      ctx,
      browser: null,
      mode: "main",
      statePath,
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(timer);
        await exportState(ctx, statePath);
        try {
          await ctx.close();
        } catch {
          // Best-effort.
        }
        release();
      },
    };
  } catch {
    // Locked (or lock race) — ephemeral, never touch the canonical dir.
  }
  const browser = (await Camoufox({ ...base })) as unknown as Browser;
  const ctx = await browser.newContext(stateImport(root));
  return {
    ctx,
    browser,
    mode: "ephemeral",
    statePath,
    cleanup: async () => {
      try {
        await ctx.close();
      } catch {
        // Best-effort.
      }
      try {
        await browser.close();
      } catch {
        // Best-effort (ephemeral profile is the browser's own temp dir).
      }
    },
  };
}
