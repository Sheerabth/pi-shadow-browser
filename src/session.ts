/**
 * One persistent browser session per process.
 *
 * Pi navigates step by step across many tool calls; launching a browser per
 * call (~2s each) would be absurd. The session opens lazily
 * on first use, serializes concurrent operations (tool calls in one message
 * run in parallel; Playwright must not interleave acts), and closes on
 * `closeSession()` — or stays warm until the process ends.
 *
 * Options on the first call win; later calls reuse the open session.
 * Each process gets its own context on the shared daemon, so concurrent
 * agents coexist — per-process ops still serialize here for safety.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { AgentBrowserAdapter } from "./browserAdapter.js";
import type { LaunchOpts } from "./browserAdapter.js";
import { agentRoot, wipeProfileCopy } from "./profile.js";
import type { PageSnapshot } from "./types.js";

export interface SessionOpts extends Omit<LaunchOpts, "userDataDir"> {
  profileDir?: string;
}
// NOTE: per-call opts merge over configureSession() defaults. When the
// effective engine (profileDir/proxy/headless) differs from the live
// session, the old session window closes and a new one binds to the new
// engine — no /browser-reset needed for config switches.

let session: AgentBrowserAdapter | null = null;
let inFlight: Promise<void> = Promise.resolve();

/** Thrown when the harness cancels the call (Escape). Never retried: the
 *  wedged op may still land in the background, so retrying could double-act. */
export class AbortError extends Error {
  override name = "AbortError";
}

/** AbortSignal of the in-flight tool call, set per call by the extension.
 *  Escape rejects the call at once, drops the wedged session, and releases
 *  the mutex — the next call starts fresh instead of queueing behind a corpse. */
const callSignal = new AsyncLocalStorage<AbortSignal | undefined>();

/** Run fn with the harness AbortSignal attached (extension entry only). */
export function runWithSignal<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  return callSignal.run(signal, fn);
}

/** Rejects when signal aborts (already-aborted rejects at once). */
function abortRace(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(new AbortError("Browser operation aborted."));
      return;
    }
    signal.addEventListener("abort", () => reject(new AbortError("Browser operation aborted.")), { once: true });
  });
}

/** In-memory session defaults (set via configureSession, e.g. from Pi
 *  settings + /browser-config). Merged under per-call opts in
 *  ensureSession, so lazy creation on ANY tool uses the active config. */
let defaultOpts: SessionOpts = {};
/** Engine the live session is bound to (resolved profileDir + proxy +
 *  headless + browser binary). A change closes the old session window
 *  and rebinds. */
let activeRoot: string | null = null;
let activeProxy: string | undefined = undefined;
let activeHeadless: boolean | undefined = undefined;

/** Drop all engine bindings (session is gone — next call rebinds fresh). */
function clearBindings(): void {
  activeRoot = null;
  activeProxy = undefined;
  activeHeadless = undefined;
}

/** Set/merge the session-wide defaults. Next ensureSession uses them. */
export function configureSession(opts: SessionOpts): void {
  defaultOpts = { ...defaultOpts, ...opts };
}

/** Effective opts for a call: per-call opts win over session defaults. */
function mergedOpts(opts: SessionOpts = {}): SessionOpts {
  return { ...defaultOpts, ...opts };
}

/** Run fn exclusively (no two adapter operations interleave).
 *  On crashed-browser errors, drop the dead session and run once more
 *  against a fresh relaunch before giving up.
 *  Every operation also gets a hard deadline: on timeout the mutex
 *  releases and the session is dropped, so one wedged call can never
 *  starve later ones. (A timeout means unknown browser state — relaunch
 *  is the only safe answer.) */
const OP_DEADLINE_MS = 150_000;
async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const runOnce = async (): Promise<T> => {
    const prev = inFlight;
    let release!: () => void;
    inFlight = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending: Promise<never>[] = [
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Browser operation timed out after 150s")), OP_DEADLINE_MS);
        }),
      ];
      const sig = callSignal.getStore();
      if (sig) pending.push(abortRace(sig));
      return await Promise.race([fn(), ...pending]);
    } finally {
      if (timer) clearTimeout(timer);
      release();
    }
  };
  try {
    return await runOnce();
  } catch (err) {
    // User cancelled (Escape): drop the session WITHOUT awaiting its close
    // (the point is to return at once) and never retry — the wedged op may
    // still land in the background, so a retry could double-act.
    if (err instanceof AbortError) {
      try {
        void session?.close().catch(() => undefined);
      } catch {
        // Best-effort.
      }
      session = null;
      clearBindings();
      throw err;
    }
    // Timeout: unknown browser state, and the wedged op might still land
    // later — so drop the session but do NOT retry (no double-acts).
    if (err instanceof Error && err.message.includes("timed out after")) {
      try {
        await Promise.race([session?.close(), new Promise((r) => setTimeout(r, 20000))]);
      } catch {
        // Best-effort.
      }
      session = null;
      clearBindings();
      throw err;
    }
    if (await reviveIfDead(err)) return runOnce();
    throw err;
  }
}

async function ensureSession(url?: string, opts: SessionOpts = {}): Promise<AgentBrowserAdapter> {
  const m = mergedOpts(opts);
  // Engine rebinding: only an EXPLICITLY requested engine key (per-call
  // opts first, else session defaults) that differs from the live session
  // rebinds. A call with no engine keys reuses the live session as-is —
  // so tabList()/read() with no args never yank the session off the engine
  // an earlier call configured (Test A: openBlankTab(profileDir) then
  // bare tabList()).
  const wantRoot = opts.profileDir ?? defaultOpts.profileDir;
  const wantProxy = opts.proxy ?? defaultOpts.proxy;
  const wantHeadless = opts.headless ?? defaultOpts.headless;
  if (session && activeRoot !== null) {
    const rebind =
      (wantRoot !== undefined && wantRoot !== activeRoot) ||
      (wantProxy !== undefined && wantProxy !== (activeProxy ?? undefined)) ||
      (wantHeadless !== undefined && wantHeadless !== activeHeadless);
    if (rebind) {
      try {
        await session.close();
      } catch {
        // Best-effort.
      }
      session = null;
    }
  }
  if (!session) {
    const root = m.profileDir ?? agentRoot();
    session = await AgentBrowserAdapter.create(url ?? "about:blank", {
      userDataDir: m.profileDir,
      headless: m.headless,
      proxy: m.proxy,
      locale: m.locale,
      timezone: m.timezone,
      userAgent: m.userAgent,
      geolocation: m.geolocation,
      permissions: m.permissions,
    });
    activeRoot = root;
    activeProxy = m.proxy ?? undefined;
    // Normalized: daemon default is headless (true), so undefined === true.
    activeHeadless = m.headless ?? true;
  } else if (url) {
    // navigate() on a session whose main tab is still an untouched
    // about:blank reuses that tab (adapter.goto navigates the operated
    // page) — no extra blank tab is left behind.
    await session.goto(url);
  }
  return session;
}

/** /browser-open on THIS session's tabs: ensures the session (relaunching
 *  a headless browser as headed — an invisible window serves no manual
 *  use), then focuses or opens one blank tab. Idempotent: never duplicates
 *  blanks, never touches another agent's tabs. */
export async function openBlankTab(opts: SessionOpts = {}): Promise<string> {
  return exclusive(async () => {
    const m = mergedOpts({ headless: false, ...opts });
    const headless = m.headless ?? false;
    if (!headless && activeHeadless === true && session) {
      // Headless browser can't show a manual tab: close and relaunch headed.
      try {
        await session.close();
      } catch {
        // Best-effort.
      }
      session = null;
      clearBindings();
    }
    const browser = await ensureSession(undefined, { ...m, headless });
    return browser.openBlankTab();
  });
}

/** Browser state for UI decisions, or null when none is running.
 *  Never throws. Keeps the /browser-open + /browser-config UX unchanged. */
export function daemonStatus(_root?: string): { running: boolean; headless: boolean } | null {
  if (!session) return null;
  return { running: true, headless: activeHeadless ?? true };
}

/** No-op kept for API shape: with no daemon there is nothing shared to
 *  stop. Use browser_close (closeSession) to end this session's browser. */
export function isDaemonAlive(_info?: unknown): boolean {
  return session !== null;
}

/** Stop this session's browser if one is running. Returns true when
 *  something stopped. (No shared daemon exists anymore.) */
export async function shutdownDaemon(_root?: string): Promise<boolean> {
  if (!session) return false;
  await closeSession().catch(() => undefined);
  return true;
}

/** Drop a dead session (crashed browser) so the next call relaunches. */
async function reviveIfDead(err: unknown): Promise<boolean> {
  const msg = err instanceof Error ? err.message : String(err);
  if (/closed|crashed|terminated|browser has been closed|Target closed|Connection closed|Protocol error|ECONNREFUSED|WebSocket|disconnected/i.test(msg)) {
    try {
      await session?.close();
    } catch {
      // Best-effort.
    }
    session = null;
    clearBindings();
    return true;
  }
  return false;
}

/** Navigate the session (opening it on first use) and observe. */
export async function navigate(url: string, opts: SessionOpts = {}, screenshot = false): Promise<PageSnapshot> {
  return exclusive(async () => (await ensureSession(url, opts)).observe(screenshot));
}

/** Re-observe the current page without navigating. */
export async function read(screenshot = false): Promise<PageSnapshot> {
  return exclusive(async () => (await ensureSession()).observe(screenshot));
}

/** Act on an observed action id, then re-observe. */
export async function act(actionId: string, text?: string, files?: string[]): Promise<PageSnapshot> {
  return exclusive(async () => {
    const browser = await ensureSession();
    // One internal retry: pages still settling (images shifting layout)
    // fail freshness spuriously. Safe — StalePage throws before anything
    // executes, so the retry cannot double-act. (Same shape as upstream's
    // tick-level recovery, one layer down.)
    for (let attempt = 0; attempt < 2; attempt++) {
      const page = await browser.observe();
      const action = page.actions.find((a) => a.id === actionId);
      if (!action) throw new Error(`Unknown action id ${JSON.stringify(actionId)} — read again for fresh ids.`);
      if (action.kind === "fill" && text === undefined) {
        throw new Error("That field needs text — pass text='...'.");
      }
      if (action.kind === "upload" && !files?.length) {
        throw new Error("That input needs files=[...] — pass local file paths.");
      }
      try {
        await browser.act(action, page, text, files);
        return browser.observe();
      } catch (err) {
        if (attempt === 0 && err instanceof Error && err.name === "StalePage") continue;
        throw err;
      }
    }
    throw new Error("Unreachable");
  });
}

export async function back(): Promise<PageSnapshot> {
  return exclusive(async () => {
    const browser = await ensureSession();
    await browser.back();
    return browser.observe();
  });
}

export async function forward(): Promise<PageSnapshot> {
  return exclusive(async () => {
    const browser = await ensureSession();
    await browser.forward();
    return browser.observe();
  });
}

/** Coordinate click in page CSS pixels (vision-grounded fallback). */
export async function clickAt(x: number, y: number): Promise<PageSnapshot> {
  return exclusive(async () => {
    const browser = await ensureSession();
    await browser.clickAt(x, y);
    return browser.observe();
  });
}

/** Files downloaded in this session (name/path/source url). */
export async function downloads(): Promise<{ name: string; path: string; url: string }[]> {
  return exclusive(async () => (await ensureSession()).downloadList());
}

/** List open tabs (index/url/title) for operated switching. */
export async function tabList(): Promise<{ index: number; url: string; title: string }[]> {
  return exclusive(async () => (await ensureSession()).tabList());
}

/** Switch the operated tab, then re-observe. */
export async function tabSwitch(index: number): Promise<PageSnapshot> {
  return exclusive(async () => {
    const browser = await ensureSession();
    await browser.switchTo(index);
    return browser.observe();
  });
}

/** Close one tab (never the last), then re-observe. */
export async function tabClose(index: number): Promise<PageSnapshot> {
  return exclusive(async () => {
    const browser = await ensureSession();
    await browser.closeTab(index);
    return browser.observe();
  });
}

/** Scroll the first visible match into view, then re-observe. */
export async function find(text: string): Promise<PageSnapshot> {
  return exclusive(async () => {
    const browser = await ensureSession();
    const found = await browser.findText(text);
    if (!found) throw new Error(`Text not found on this page: ${JSON.stringify(text.slice(0, 80))}`);
    return browser.observe();
  });
}

/** Regex/text search over visible text with context. No navigation. */
export async function searchPage(
  pattern: string,
  opts: { regex?: boolean; caseSensitive?: boolean; contextChars?: number; maxResults?: number } = {},
): Promise<{ text: string; context: string }[] | { error: string }> {
  return exclusive(async () => (await ensureSession()).searchPageText(pattern, opts));
}

/** Fixed wait (capped at 30s, like upstream), then re-observe. The wait
 *  itself honours call abort; the re-observe goes through the mutex. */
export async function wait(seconds: number): Promise<PageSnapshot> {
  const ms = Math.min(Math.max(seconds, 0), 30) * 1000;
  const sig = callSignal.getStore();
  if (sig) await Promise.race([new Promise((r) => setTimeout(r, ms)), abortRace(sig)]);
  else await new Promise((r) => setTimeout(r, ms));
  return exclusive(async () => (await ensureSession()).observe());
}

/** Press a key (Escape, Enter, Tab, arrows…) on the focused element. */
export async function press(key: string): Promise<PageSnapshot> {
  return exclusive(async () => {
    const browser = await ensureSession();
    await browser.press(key);
    return browser.observe();
  });
}

/** Seek the session video, then re-observe. */
export async function videoSeek(seconds: number): Promise<PageSnapshot> {
  return exclusive(async () => {
    const browser = await ensureSession();
    await browser.videoSeek(seconds);
    return browser.observe();
  });
}

/** Screenshot the current page (viewport, or fullPage for long/maps pages). */
export async function screenshot(fullPage = false): Promise<{ data: string; mimeType: string }> {
  return exclusive(async () => (await ensureSession()).screenshot(fullPage));
}

export async function closeSession(): Promise<void> {
  await exclusive(async () => {
    if (session) {
      await session.close();
      session = null;
    }
    clearBindings();
  });
}

/** Reset everything: close the session and wipe the agent home (profile,
 *  session snapshot, downloads). Loud and explicit, user-invoked only.
 *  Returns the wiped dir; next navigation relaunches fresh (re-login
 *  required). */
export async function resetSession(opts: { profileDir?: string } = {}): Promise<string> {
  return exclusive(async () => {
    if (session) {
      await session.close();
      session = null;
    }
    clearBindings();
    const root = opts.profileDir ?? agentRoot();
    return wipeProfileCopy(root);
  });
}

/** True while a session is open (for status reporting). */
export function hasSession(): boolean {
  return session !== null;
}

/**
 * Run fn with a throwaway tab in the session's own browser (creating the
 * session if needed). One-shots share the session browser, never the tab.
 * fn must use the adapter directly, never session fns (reentrancy deadlock).
 */
export async function runInTab<T>(
  url: string,
  fn: (b: AgentBrowserAdapter) => Promise<T>,
  opts: SessionOpts = {},
): Promise<T> {
  return exclusive(async () => {
    const browser = await ensureSession(undefined, opts);
    return browser.withTab(url, fn);
  });
}
