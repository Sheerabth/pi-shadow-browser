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

const MUTED_PREFS: Record<string, unknown> = {
  // Agent browser is never watched: silent by default. The user heard
  // YouTube autoplay during a transcript task — never again.
  "media.volume_scale": "0.0",
  "media.autoplay.default": 5,
  "media.autoplay.blocking_policy": 2,
  "media.autoplay.allow-extension-background-pages": false,
  "media.autoplay.block-event.enabled": true,
  "media.block-autoplay-until-in-foreground": true,
};

/** Mute every <video>/<audio> at document-start + as they appear.
 *  addInitScript on the context: survives navigations, SPAs, late
 *  players. videoSeek() explicitly unmutes? No — it plays muted; the
 *  frame screenshot is what matters, never the sound. */
const MUTE_INIT_SCRIPT = `(() => {
  const mute = (el) => { try { el.muted = true; el.volume = 0; } catch {} };
  const sweep = (root) => {
    try { (root.querySelectorAll?.('video,audio') ?? []).forEach(mute); } catch {}
  };
  sweep(document);
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n instanceof HTMLMediaElement) mute(n);
      else if (n instanceof Element) sweep(n);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
})();`;

async function muteContext(ctx: BrowserContext): Promise<void> {
  try {
    await ctx.addInitScript({ content: MUTE_INIT_SCRIPT });
  } catch {
    // Best-effort (older Playwright without addInitScript on context).
  }
  // Belt-and-braces for the already-open pages.
  for (const p of ctx.pages()) {
    try {
      await p.evaluate(`(() => { document.querySelectorAll('video,audio').forEach((el) => { try { el.muted = true; el.volume = 0; } catch {} }); })()`);
    } catch {
      // Best-effort.
    }
  }
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
  const base: Record<string, unknown> = { headless, firefox_user_prefs: { ...MUTED_PREFS } };
  if (opts.proxy) base.proxy = opts.proxy;
  if (opts.locale) base.locale = opts.locale;

  // Main mode: canonical persistent profile. Non-blocking lock: only one
  // holder; losers fall through to ephemeral (never wait on another agent).
  try {
    const release = await acquireProfileLock(root, 1);
    const dir = join(root, "camoufox-profile");
    const ctx = (await Camoufox({ user_data_dir: dir, ...base })) as unknown as BrowserContext;
    await muteContext(ctx);
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
  await muteContext(ctx);
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
