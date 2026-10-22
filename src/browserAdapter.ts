/**
 * Camoufox backend behind the agent's Browser interface.
 *
 * The agent loop only uses 4 methods: observe / fresh / act / close.
 * Implemented on Camoufox (anti-detect Firefox) over ONE shared persistent
 * context owned by the camoufox daemon, while reusing the vendored
 * upstream snapshot.js verbatim — no fork of the DOM reader.
 *
 * No OS windows here (Firefox has no CDP windowIds): each agent owns its
 * tabs (tab-ownership) in the shared context and never touches another
 * agent's tabs. Unsupported on Firefox and dropped: page.pdf (browser_pdf).
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Download, ElementHandle, Frame, Page } from "playwright-core";

import { agentRoot } from "./profile.js";
import { launchAgentBrowser } from "./launcher.js";
import type { PageAction, PageSnapshot } from "./types.js";

export class StalePage extends Error {
  constructor(message = "Page changed since this decision. Observe again.") {
    super(message);
    this.name = "StalePage";
  }
}

const SNAPSHOT_JS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "snapshot.js"),
  "utf8",
);
const SHADOW_JS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "shadow-supplement.js"),
  "utf8",
);

/** Canonical JSON: sorted keys, matching Python's json.dumps(sort_keys=True). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

function fingerprint(state: PageSnapshot): string {
  const content = { url: state.url, text: state.text, actions: state.actions, scroll: state.scroll };
  return createHash("sha256").update(stableStringify(content)).digest("hex");
}

export interface FrameSnap {
  url: string;
  snap: PageSnapshot;
}

const MAX_ACTIONS = 250;
const MAX_FRAMES = 12;

/**
 * Merge per-frame snapshots into one indexed action space. Pure (tested).
 * Node ids collide across frames (separate windows), so guards are keyed
 * `frame:node` and every action carries its `frame` index + host label.
 */
export function mergeFrameSnapshots(main: PageSnapshot, frames: FrameSnap[]): PageSnapshot {
  const hostOf = (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  };
  const take = (snap: PageSnapshot, frame: number, host: string | null): PageAction[] =>
    snap.actions
      .filter((a) => a.kind !== "scroll" && a.kind !== "wait")
      .map((a) => ({
        ...a,
        frame,
        label: host ? `${a.label} [in ${host}]` : a.label,
      }));
  let actions = take(main, 0, null);
  for (let i = 0; i < frames.length; i++) {
    actions = actions.concat(take(frames[i].snap, i + 1, hostOf(frames[i].url)));
  }
  const omitted = Math.max(0, actions.length - MAX_ACTIONS);
  actions = actions.slice(0, MAX_ACTIONS);
  actions.forEach((a, i) => {
    a.id = `e${i + 1}`;
  });
  actions.push({ id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 });
  actions.push({ id: "scroll_up", kind: "scroll", label: "Scroll up", delta: -560 });
  actions.push({ id: "wait", kind: "wait", label: "Wait for the page to update" });

  const guards: Record<string, unknown> = {};
  const guardSrc = (snap: PageSnapshot, frame: number) => {
    for (const [node, guard] of Object.entries((snap.guards ?? {}) as Record<string, unknown>)) {
      guards[`${frame}:${node}`] = guard;
    }
  };
  guardSrc(main, 0);
  frames.forEach((f, i) => guardSrc(f.snap, i + 1));

  let text = main.text || "";
  for (const f of frames) {
    const t = (f.snap.text || "").trim();
    if (t) text += `\n--- frame ${f.url} ---\n${t.slice(0, 500)}`;
  }
  return {
    url: main.url,
    title: main.title,
    text: text.slice(0, 6000),
    scroll: main.scroll,
    actions,
    marker: main.marker,
    page_key: main.page_key,
    guards,
    frameUrls: frames.map((f) => f.url),
    omitted_actions: (main.omitted_actions ?? 0) + omitted,
  };
}

/** Match text in a capped worker: pathological patterns die by timeout,
 *  never by hanging the tab or this process. Plain data in and out. */
function matchInWorker(
  text: string,
  pattern: string,
  opts: { regex?: boolean; caseSensitive?: boolean; contextChars?: number; maxResults?: number },
  timeoutMs = 5000,
): Promise<{ text: string; context: string }[] | { error: string }> {
  const workerCode = [
    "const { parentPort, workerData } = require('node:worker_threads');",
    "const { text, source, flags, ctxN, maxN } = workerData;",
    "let out;",
    "try {",
    "  const re = new RegExp(source, flags);",
    "  out = [];",
    "  let m; re.lastIndex = 0;",
    "  while (out.length < maxN && (m = re.exec(text)) !== null) {",
    "    if (m[0].length === 0) { re.lastIndex++; continue; }",
    "    const s = Math.max(0, m.index - ctxN);",
    "    out.push({ text: m[0].slice(0, 200),",
    "      context: text.slice(s, m.index + m[0].length + ctxN).replace(/\\s+/g, ' ').trim().slice(0, 500) });",
    "    if (re.lastIndex === m.index) re.lastIndex++;",
    "  }",
    "} catch (e) { out = { error: 'invalid pattern' }; }",
    "parentPort.postMessage(out);",
  ].join("\n");
  const flags = opts.caseSensitive ? "g" : "gi";
  const source = opts.regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new Promise((resolvePromise) => {
    let done = false;
    const finish = (v: { text: string; context: string }[] | { error: string }) => {
      if (done) return;
      done = true;
      resolvePromise(v);
    };
    let worker: Worker;
    try {
      worker = new Worker(workerCode, {
        eval: true,
        workerData: { text, source, flags, ctxN: opts.contextChars ?? 100, maxN: opts.maxResults ?? 10 },
      });
    } catch {
      finish({ error: "matcher unavailable" });
      return;
    }
    const timer = setTimeout(() => {
      void worker.terminate().catch(() => undefined);
      finish({ error: "pattern timed out" });
    }, timeoutMs);
    worker.on("message", (v) => {
      clearTimeout(timer);
      void worker.terminate().catch(() => undefined);
      finish(v as { text: string; context: string }[] | { error: string });
    });
    worker.on("error", () => {
      clearTimeout(timer);
      finish({ error: "matcher failed" });
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Split a proxy URL into Playwright's {server, username, password} shape. */
function parseProxy(raw: string): { server: string; username?: string; password?: string } {
  try {
    const u = new URL(raw);
    const out: { server: string; username?: string; password?: string } = {
      server: `${u.protocol}//${u.host}`,
    };
    if (u.username) out.username = decodeURIComponent(u.username);
    if (u.password) out.password = decodeURIComponent(u.password);
    return out;
  } catch {
    return { server: raw };
  }
}

export const BIRTH_URLS = new Set([
  "about:blank",
  "chrome://newtab/",
  "chrome://new-tab-page/",
  "chrome-search://local-ntp/local-ntp.html",
]);

/** In-page flag marking a birth tab already owned by an agent window.
 *  Prevents two sequential AgentBrowserAdapter.create() calls from
 *  adopting the same initial birth window. */
const CLAIM_JS = "window.__piShadowClaimed === true";
const CLAIM_SET_JS = "window.__piShadowClaimed = true";
/** Same-process guard: targetIds claimed as birth windows by a concurrent
 *  create() in this process (CDP + page-flag checks race across processes). */
/** Same-process guard: birth tabs claimed by a concurrent create() in
 *  this process (page-flag checks race across processes). */
const claimedBirthTabs = new Set<Page>();

export interface LaunchOpts {
  /** Engine home: the shared browser lives here (one engine per path).
   *  The first starter's headless/proxy config wins; later mismatches
   *  fail loudly (below) so traffic never goes somewhere unconfigured. */
  userDataDir?: string;
  headless?: boolean;
  proxy?: string;
  locale?: string;
  timezone?: string;
  userAgent?: string;
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
  permissions?: string[];
}

export class AgentBrowserAdapter {
  private closed = false;
  /** Frames from the last observe, aligned with action `frame` indices. */
  private frames: Frame[] = [];
  /** The session's main tab. Survives tab switches; never closed by cleanup. */
  private mainPage: Page | null = null;
  private downloads: { name: string; path: string; url: string }[] = [];
  private failedRequests: { url: string; status: number }[] = [];
  private diagnosed = new Set<Page>();
  /** This agent's tabs in the shared context. Every op is scoped to pages
   *  in this set — never another agent's tabs. */
  private owned = new Set<Page>();
  private downloadListener: ((download: Download) => void) | null = null;
  /** Release hook from the launcher (exports snapshot + releases the
   *  profile lock in main mode, closes the scratch browser in ephemeral). */
  private cleanup: (() => Promise<void>) | null = null;

  private constructor(
    private ctx: BrowserContext,
    private page: Page,
  ) {}

  static async create(url: string, opts: LaunchOpts = {}): Promise<AgentBrowserAdapter> {
    // Every process owns its Camoufox: the profile-lock holder runs the
    // canonical PERSISTENT profile (logins survive restarts); everyone
    // else runs an EPHEMERAL scratch browser hydrated from the shared
    // session snapshot (no lock contention, no profile corruption).
    // Never launch into another process's profile dir.
    const root = agentRoot(opts.userDataDir);
    const { ctx, cleanup } = await launchAgentBrowser({
      root,
      headless: opts.headless ?? true,
      proxy: opts.proxy ? parseProxy(opts.proxy) : undefined,
      locale: opts.locale,
    });
    const seed = ctx.pages()[0] ?? (await ctx.newPage());
    const adapter = new AgentBrowserAdapter(ctx, seed);
    adapter.cleanup = cleanup;
    // Never browser.close(): the daemon server outlives every agent.
    // Dropping our handle disconnects; the server keeps running.
    await adapter.claimTab();
    adapter.watchDownloads(join(root, "downloads"));
    // Listeners before first navigation: early console errors and
    // failed responses would otherwise fire before anyone listens.
    adapter.watchDiagnostics();
    if (url && !BIRTH_URLS.has(url)) {
      await adapter.page.goto(url);
      await adapter.page.waitForLoadState("domcontentloaded");
    } else if (url) {
      // Birth URL: stay on the owned blank tab (no extra navigation).
      try {
        if (!BIRTH_URLS.has(adapter.page.url())) await adapter.page.goto("about:blank");
      } catch {
        // Best-effort.
      }
    }
    return adapter;
  }

  /** Claim this adapter's tabs in the shared context.
   *  Cold start: adopt the daemon's single unclaimed birth tab so no extra
   *  unused birth tab is left behind. Otherwise open a brand-new tab and
   *  operate on tabs this adapter opened. Never another agent's tabs. */
  private async claimTab(): Promise<void> {
    const pages = this.ctx.pages();
    // Adoptable: exactly one page on the engine, a birth URL, unclaimed by
    // another agent. First agent takes it; everyone after opens own tabs.
    if (pages.length === 1) {
      const p = pages[0];
      let birth = false;
      try {
        birth = BIRTH_URLS.has(p.url());
      } catch {
        // Dead tab — fall through to opening our own.
      }
      let claimed = true;
      try {
        claimed = (await p.evaluate(CLAIM_JS)) === true;
      } catch {
        claimed = true;
      }
      if (claimedBirthTabs.has(p)) claimed = true;
      if (birth && !claimed) {
        this.page = p;
        this.mainPage = p;
        this.owned.add(p);
        try {
          await p.evaluate(CLAIM_SET_JS);
        } catch {
          // Best-effort.
        }
        claimedBirthTabs.add(p);
        await this.focusTab();
        return;
      }
    }
    const tab = await this.ctx.newPage();
    this.page = tab;
    this.mainPage = tab;
    this.owned.add(tab);
    await this.focusTab();
  }

  /** Tabs owned by THIS adapter (adopted + opened here). Prunes dead pages.
   *  Tab-ownership is the isolation boundary: no windowIds on Firefox. */
  private ownedPages(): Page[] {
    const out: Page[] = [];
    for (const p of [...this.owned]) {
      try {
        if (!p.isClosed()) out.push(p);
        else this.owned.delete(p);
      } catch {
        this.owned.delete(p);
      }
    }
    try {
      if (this.page && !this.page.isClosed() && !out.includes(this.page)) out.push(this.page);
    } catch {
      // Dead operated page — skip.
    }
    return out;
  }

  /** Open a tab owned by this adapter. */
  private async newTab(url = "about:blank"): Promise<Page> {
    const p = await this.ctx.newPage();
    if (url && url !== "about:blank") {
      try {
        await p.goto(url);
        try {
          await p.evaluate("(() => { document.querySelectorAll('video,audio').forEach((el) => { try { el.muted = true; el.volume = 0; } catch {} }); })()");
        } catch {
          // Best-effort.
        }
      } catch {
        // Best-effort (caller navigates anyway).
      }
    }
    this.owned.add(p);
    return p;
  }

  /** Focus this tab (best-effort; headless has no front). */
  private async focusTab(): Promise<void> {
    try {
      await this.page.bringToFront();
    } catch {
      // Best-effort.
    }
  }

  /** /browser-open on THIS session's window: focus an existing blank/birth
   *  tab when one exists, else open one blank tab in-window and focus it.
   *  Never duplicates blanks, never touches another agent's window. */
  async openBlankTab(): Promise<string> {
    const pages = this.ownedPages();
    // Current operated tab already blank → just focus, no duplicate.
    try {
      if (BIRTH_URLS.has(this.page.url())) {
        await this.focusTab();
        return this.page.url();
      }
    } catch {
      // Dead page — fall through to window scan.
    }
    for (const p of pages) {
      if (p === this.page) continue;
      try {
        if (BIRTH_URLS.has(p.url())) {
          this.page = p;
          this.watchDiagnostics();
          await this.focusTab();
          return p.url();
        }
      } catch {
        // Skip dead tabs.
      }
    }
    const tab = await this.newTab("about:blank");
    this.page = tab;
    if (!this.mainPage || this.mainPage.isClosed()) this.mainPage = tab;
    this.watchDiagnostics();
    await this.focusTab();
    return tab.url();
  }

  async observe(screenshot = false): Promise<PageSnapshot> {
    // Diagnostics accumulate between observes; each observe reports + resets.
    const failedRequests = this.failedRequests;
    this.failedRequests = [];
    // Main frame, with retries across navigations.
    let main: PageSnapshot | null = null;
    for (let i = 0; i < 10; i++) {
      try {
        main = (await this.page.evaluate(SNAPSHOT_JS)) as PageSnapshot | null;
      } catch {
        main = null;
      }
      if (main !== null) break;
      await sleep(50);
    }
    if (main === null) throw new StalePage("Document is navigating");
    // JS-rendered pages often have no text at domcontentloaded. One bounded
    // re-read when thin — costs nothing on server-rendered pages.
    // (Runs before the supplement so a replaced snapshot loses nothing.)
    if (main.text.trim().length < 200) {
      await sleep(1200);
      try {
        const second = (await this.page.evaluate(SNAPSHOT_JS)) as PageSnapshot | null;
        if (second !== null && second.text.trim().length > main.text.trim().length) main = second;
      } catch {
        // Keep the first snapshot.
      }
    }
    await this.addShadowActions(this.page.mainFrame(), main);
    // Child frames, best-effort each (detached/navigating frames skip).
    // Playwright evaluates inside frames even cross-origin. Capped: ad-heavy
    // pages can host dozens of tracking frames; beyond MAX_FRAMES we skip.
    const frames: Frame[] = [this.page.mainFrame()];
    const snaps: FrameSnap[] = [];
    let traversed = 0;
    for (const f of this.page.frames()) {
      if (f === this.page.mainFrame()) continue;
      if (traversed >= MAX_FRAMES) break;
      traversed++;
      try {
        const snap = (await f.evaluate(SNAPSHOT_JS)) as PageSnapshot | null;
        if (snap === null) continue;
        await this.addShadowActions(f, snap);
        if (snap.actions.length === 0 && (snap.text || "").trim().length === 0) continue;
        frames.push(f);
        snaps.push({ url: f.url(), snap });
      } catch {
        // Detached or navigating — skip.
      }
    }
    this.frames = frames;
    const info = mergeFrameSnapshots(main, snaps);
    info.fingerprint = fingerprint(info);
    info.failedRequests = failedRequests;
    if (screenshot) {
      try {
        const raw = await this.page.screenshot({ type: "jpeg", quality: 72 });
        info.screenshot = raw.toString("base64");
      } catch {
        // Screenshots are best-effort.
      }
    }
    return info;
  }

  private frameOf(action: PageAction): Frame | undefined {
    return this.frames[action.frame ?? 0];
  }

  /**
   * Supplement snapshot with open-shadow-DOM controls. Runs in the frame
   * after snapshot.js (needs its __jevFast cache), appends actions + guards.
   * Retries once after a settle: script failures are transient (teardown
   * races), never deterministic — an empty first pass proves nothing.
   */
  private async addShadowActions(
    frame: Frame,
    snap: PageSnapshot,
  ): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await sleep(300);
      let extra: PageAction[];
      try {
        extra = (await frame.evaluate(SHADOW_JS)) as PageAction[];
      } catch (err) {
        if (process.env.PI_SHADOW_DEBUG) {
          console.log(`[shadow] evaluate failed: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);
        }
        continue;
      }
      if (!extra || extra.length === 0) continue;
      // Drop anything snapshot.js already registered (same node) — the
      // supplement only adds what snapshot.js cannot see or skips.
      const snapNodes = new Set((snap.actions ?? []).map((a) => (a as PageAction).node));
      const novel = extra.filter((a) => typeof a.node === "number" && !snapNodes.has(a.node));
      if (novel.length === 0) return;
      const nodes = novel.map((a) => a.node).filter((n): n is number => typeof n === "number");
      let fetched: Record<string, unknown> = {};
      try {
        fetched = (await frame.evaluate(
          `(() => { const c = window.__jevFast; const g = {};` +
            ` for (const n of ${JSON.stringify(nodes)}) g[n] = c.guard(c.nodes.get(n)); return g; })()`,
        )) as Record<string, unknown>;
      } catch {
        continue;
      }
      for (const a of novel) snap.actions.push(a);
      snap.guards = { ...(snap.guards as Record<string, unknown>), ...fetched };
      return;
    }
  }

  async fresh(page: PageSnapshot, action?: PageAction): Promise<boolean> {
    try {
      // Any action bound to an observed node validates that node (+page key).
      // Precise and immune to unrelated page churn; the marker path below is
      // only for nodeless actions (scroll/wait).
      if (action && typeof action.node === "number") {
        const frame = this.frameOf(action);
        if (!frame) return false;
        // NB: Playwright evaluates strings as expressions (never invoking
        // arrow functions with args), so the node id is embedded, not passed.
        const current = (await frame.evaluate(
          `(() => { const c = window.__jevFast; const node = ${action.node};
            return c ? [c.pageKey(), c.guard(c.nodes.get(node))] : null; })()`,
        )) as unknown;
        const key = `${action.frame ?? 0}:${action.node}`;
        const guards = page.guards as Record<string, unknown>;
        return JSON.stringify(current) === JSON.stringify([page.page_key, guards[key]]);
      }
      const current = (await this.page.evaluate(SNAPSHOT_JS)) as PageSnapshot | null;
      if (current === null) return false;
      if (JSON.stringify(current.marker) !== JSON.stringify(page.marker)) return false;
      // frameUrls holds child frames only (main is index 0, implicit) —
      // compare against live child frames the same way, or every scroll
      // and wait permanently reports stale (found live).
      const main = this.page.mainFrame();
      const liveUrls = this.page.frames().flatMap((f) => {
        if (f === main) return [];
        try {
          return [f.url()];
        } catch {
          return [""];
        }
      });
      return JSON.stringify(liveUrls) === JSON.stringify(page.frameUrls ?? []);
    } catch {
      return false;
    }
  }

  async act(action: PageAction, page: PageSnapshot, text?: string, files?: string[]): Promise<{ executed: string }> {
    if (!(await this.fresh(page, action))) {
      throw new StalePage("Page changed since this decision. Observe again.");
    }
    const kind = action.kind;
    if (kind === "wait") {
      await sleep(100);
      return { executed: action.id };
    }
    if (kind === "upload") {
      // Browser-use parity: set files directly on the observed node — but
      // sandboxed (their FileSystem rule): paths must stay inside the
      // working directory or the OS temp dir, never escape it silently.
      if (!files || files.length === 0) throw new Error("upload needs files=[...] — pass local file paths.");
      const roots = [process.cwd(), tmpdir()].map((d) => resolve(d));
      for (const f of files) {
        const abs = resolve(f);
        if (!roots.some((r) => abs === r || abs.startsWith(r + "/"))) {
          throw new Error(`Refusing to upload ${JSON.stringify(f)}: outside working directory and temp dir.`);
        }
      }
      if (typeof action.node !== "number") throw new Error("Invalid observed node");
      const frame = this.frameOf(action);
      if (!frame) throw new StalePage("Target frame is gone. Observe again.");
      // evaluateHandle CAN return DOM elements (only string arrows take no args).
      const el = await frame.evaluateHandle(
        `(() => window.__jevFast.nodes.get(${action.node}))()`,
      );
      try {
        const element = el.asElement() as ElementHandle | null;
        if (!element) throw new Error("Upload target is gone. Observe again.");
        await element.setInputFiles(files);
      } finally {
        await el.dispose().catch(() => undefined);
      }
      return { executed: action.id };
    }
    if (kind === "scroll") {
      const delta = typeof action.delta === "number" ? action.delta : 560;
      try {
        await this.page.mouse.wheel(0, delta);
      } catch {
        await this.page.evaluate((d: number) => window.scrollBy(0, d), delta);
      }
      return { executed: action.id };
    }
    if (typeof action.node !== "number") throw new Error("Invalid observed node");
    const frame = this.frameOf(action);
    if (!frame) throw new StalePage("Target frame is gone. Observe again.");
    const frameIndex = action.frame ?? 0;

    // Resolve + validate target inside its own frame (occlusion, disabled,
    // coverage). Returns in-frame center coords or null — model output never
    // becomes selectors. The action travels via window (real fn arg), since
    // string arrows take no args.
    await frame.evaluate((a) => {
      (window as unknown as Record<string, unknown>).__jevAction = a;
    }, { ...action });
    const target = (await frame.evaluate(
      `(() => {
        const action = window.__jevAction;
        const e = window.__jevFast?.nodes.get(action.node);
        if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
            !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
        if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
        try { e.scrollIntoView({ block: 'center' }); } catch (err) {}
        const r = e.getBoundingClientRect(), x = r.x+r.width/2, y = r.y+r.height/2;
        if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight) return null;
        // elementFromPoint retargets shadow content to its host — accept both.
        const pt = document.elementFromPoint(x, y);
        const root = e.getRootNode();
        const inShadow = root instanceof ShadowRoot;
        const hit = pt && (e.contains(pt) ||
          (inShadow && root.host && (pt === root.host || root.host.contains(pt))));
        if (!hit) return null;
        if (action.kind==='select') {
          if (e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===action.value &&
              !o.disabled && !o.closest('optgroup[disabled]'))) return null;
          e.value = action.value;
          e.dispatchEvent(new Event('input',{bubbles:true}));
          e.dispatchEvent(new Event('change',{bubbles:true}));
        }
        return {x, y};
      })()`,
    )) as { x: number; y: number } | null;

    if (target === null) {
      if (kind === "select") throw new Error("Dropdown execution was not confirmed; inspect before retrying.");
      throw new StalePage("Target changed or is covered. Observe again.");
    }
    if (kind === "select") return { executed: action.id };

    // Translate in-frame coords to page coords for child frames, verifying
    // the iframe itself isn't covered by page-level content.
    let pageX = target.x;
    let pageY = target.y;
    if (frameIndex !== 0) {
      const handle = await frame.frameElement().catch(() => null);
      const box = handle ? await handle.boundingBox().catch(() => null) : null;
      if (!box) throw new StalePage("Target frame moved. Observe again.");
      pageX = box.x + target.x;
      pageY = box.y + target.y;
      const covering = (await this.page.evaluate(
        `(() => { let el = document.elementFromPoint(${pageX}, ${pageY});` +
          ` while (el && el.tagName !== 'IFRAME' && el.tagName !== 'FRAME') el = el.parentElement;` +
          ` return el ? el.tagName : null; })()`,
      )) as string | null;
      if (covering === null) throw new StalePage("Target is covered by page content. Observe again.");
    }

    await this.page.mouse.click(pageX, pageY);
    await this.muteMedia();
    if (kind === "fill") {
      if (text === undefined) throw new Error("fill needs text");
      await this.page.keyboard.press(process.platform === "darwin" ? "Meta+a" : "Control+a");
      await this.page.keyboard.type(text);
      // Combobox settle (ported from jev-ultrafast): after typing, wait for
      // autocomplete suggestions to visibly render before the next observe.
      await this.settleAfterFill(frame, action);
    }
    return { executed: action.id };
  }

  /** Wait for post-type suggestions (combobox) or a paint (else). Never fails. */
  private async settleAfterFill(frame: Frame, action: PageAction): Promise<void> {
    try {
      await frame.evaluate(
        `(() => { const node = ${action.node}; return new Promise((resolve) => {` +
          ` const field = window.__jevFast?.nodes.get(node);` +
          ` const isCombo = field?.getAttribute && field.getAttribute('role') === 'combobox';` +
          ` const limit = isCombo ? 800 : 50; const t0 = Date.now(); let frames = 0;` +
          ` const step = () => {` +
          ` if (Date.now() - t0 >= limit) return resolve(false);` +
          ` let visible = true;` +
          ` if (isCombo) {` +
          ` const ids = ((field.getAttribute('aria-controls') || field.getAttribute('aria-owns') || '').split(/\\s+/).filter(Boolean));` +
          ` const roots = ids.length ? ids.map((id) => document.getElementById(id)).filter(Boolean) : [document];` +
          ` visible = roots.flatMap((root) => [...root.querySelectorAll('[role="option"]')]).some((e) => {` +
          ` try { const r = e.getBoundingClientRect();` +
          ` return r.width && r.height && r.bottom > 0 && r.top < innerHeight &&` +
          ` e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });` +
          ` } catch (err) { return false; } });` +
          ` }` +
          ` if (visible && ++frames >= 2) return resolve(true);` +
          ` requestAnimationFrame(step); };` +
          ` requestAnimationFrame(step); }); })()`,
      );
    } catch {
      // Settle is best-effort; the act already succeeded.
    }
  }

  /** Run a code-owned read script in the page. Internal use (e.g. result
   *  extraction): model output must never reach this — pass it through act(). */
  async evaluate<T>(expression: string): Promise<T> {
    return (await this.page.evaluate(expression)) as T;
  }

  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key);
  }

  async screenshot(fullPage = false): Promise<{ data: string; mimeType: string }> {
    const raw = await this.page.screenshot({ type: "jpeg", quality: 72, fullPage });
    return { data: raw.toString("base64"), mimeType: "image/jpeg" };
  }

  /** Drive the page's <video>: seek, play, report state. Time is data. */
  async videoSeek(seconds: number): Promise<{ currentTime: number; duration: number; paused: boolean }> {
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Seek needs seconds >= 0.");
    const found = await this.page.evaluate(
      `(() => { const v = document.querySelector('video'); if (!v) return false;` +
        ` try { v.currentTime = ${seconds}; } catch (e) {}` +
        ` try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (e) {}` +
        ` return true; })()`,
    );
    if (!found) throw new Error("No video element on this page — navigate to a watch page first.");
    await sleep(800);
    await this.muteMedia();
    const state = await this.page.evaluate(
      `(() => { const v = document.querySelector('video');` +
        ` return v ? { currentTime: v.currentTime, duration: v.duration || 0, paused: v.paused } : null; })()`,
    );
    if (!state) throw new Error("Video element vanished.");
    return state as { currentTime: number; duration: number; paused: boolean };
  }

  currentUrl(): string {
    return this.page.url();
  }

  /** Capture failed requests for breakage diagnosis. Reset per observe.
   *  NOTE: console-error capture was tried and removed — this Chromium
   *  build does not deliver CDP console events (verified: load-time throws,
   *  explicit console.error, post-load evaluates all silent). Network
   *  responses arrive fine, so failures surface here instead. */
  private watchDiagnostics(): void {
    if (this.diagnosed.has(this.page)) return;
    this.diagnosed.add(this.page);
    this.page.on("response", (res) => {
      try {
        const st = res.status();
        if (st >= 400) {
          this.failedRequests.push({ url: res.url().slice(0, 200), status: st });
          if (this.failedRequests.length > 20) this.failedRequests.shift();
        }
      } catch {
        // Listener must never throw.
      }
    });
  }

  /** Track downloads: save into the profile dir, remember name/path/url.
   *  Only records downloads triggered by pages in this adapter's window;
   *  the listener is removed on close() so the shared contexts[0] never
   *  accumulates dead listeners. */
  private watchDownloads(dir: string): void {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Best-effort (saveAs will surface real failures).
    }
    this.downloadListener = (download: Download) => {
      void (async () => {
        try {
          // Attribute to this adapter only: ignore other agents' downloads
          // on the shared context.
          const src = download.page();
          try {
            if (src && !this.owned.has(src)) return;
          } catch {
            // Attribute-check failed — record anyway rather than lose it.
          }
          const safe = download.suggestedFilename().replace(/[^\w.\-]+/g, "_").slice(0, 120) || "download";
          const path = join(dir, `${Date.now()}-${safe}`);
          await download.saveAs(path);
          this.downloads.push({ name: download.suggestedFilename(), path, url: download.url() });
        } catch {
          // Best-effort.
        }
      })();
    };
    this.ctx.on("download", this.downloadListener);
  }

  downloadList(): { name: string; path: string; url: string }[] {
    return [...this.downloads];
  }

  /** Coordinate click in page CSS pixels (vision-grounded fallback). */
  async clickAt(x: number, y: number): Promise<void> {
    await this.page.mouse.click(x, y);
  }

  /** Silence every media element on the operated page. Cheap, best-effort;
   *  called after any op that can start playback (goto, click, seek).
   *  The init script (launcher) mutes at document-start; this re-mutes
   *  players that unmute themselves on navigation or user gesture. */
  private async muteMedia(): Promise<void> {
    try {
      await this.page.evaluate(
        "(() => { document.querySelectorAll('video,audio').forEach((el) => { try { el.muted = true; el.volume = 0; } catch {} }); })()",
      );
    } catch {
      // Best-effort (dead page, navigating).
    }
  }

  /** Operated tabs: index + url + title for tabs in THIS window only. */
  async tabList(): Promise<{ index: number; url: string; title: string }[]> {
    const out: { index: number; url: string; title: string }[] = [];
    const pages = this.ownedPages();
    for (let i = 0; i < pages.length; i++) {
      let url = "";
      let title = "";
      try {
        url = pages[i].url();
      } catch {
        // Skip dead tabs.
      }
      try {
        title = await pages[i].title();
      } catch {
        // Title is best-effort.
      }
      out.push({ index: i, url, title });
    }
    return out;
  }

  /** Switch the operated page (this window only). Next observe/act uses it. */
  async switchTo(index: number): Promise<void> {
    const pages = this.ownedPages();
    if (!Number.isInteger(index) || index < 0 || index >= pages.length) {
      throw new Error(`No tab ${index} — see browser_tabs for the list.`);
    }
    this.page = pages[index];
    try {
      await this.page.bringToFront();
    } catch {
      // Best-effort (headless has no front).
    }
    this.watchDiagnostics();
  }

  /** Close one tab in this window (never the last — use close() instead). */
  async closeTab(index: number): Promise<void> {
    const pages = this.ownedPages();
    if (!Number.isInteger(index) || index < 0 || index >= pages.length) {
      throw new Error(`No tab ${index} — see browser_tabs for the list.`);
    }
    if (pages.length <= 1) {
      throw new Error("Only one tab open — use browser_close to end the session instead.");
    }
    const target = pages[index];
    await target.close().catch(() => undefined);
    if (target === this.page || this.page.isClosed()) {
      const rest = this.ownedPages();
      if (rest.length > 0) {
        this.page = rest[0];
        try {
          await this.page.bringToFront();
        } catch {
          // Best-effort.
        }
      }
    }
  }

  /** Scroll the first visible match into view. Ported from find_text. */
  async findText(text: string): Promise<boolean> {
    if (!text) return false;
    const found = await this.page.evaluate(
      `(() => { const want = ${JSON.stringify(text.toLowerCase())};` +
        ` const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);` +
        ` let node;` +
        ` while ((node = walker.nextNode())) {` +
        ` const t = (node.textContent || '').toLowerCase();` +
        ` if (t.includes(want)) { const el = node.parentElement; if (!el) continue;` +
        ` const r = el.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) continue;` +
        ` try { el.scrollIntoView({ block: 'center' }); } catch (e) {}` +
        ` return true; } } return false; })()`,
    );
    return found === true;
  }

  /** Regex/text search over visible text with context. No navigation. */
  async searchPageText(
    pattern: string,
    opts: { regex?: boolean; caseSensitive?: boolean; contextChars?: number; maxResults?: number } = {},
  ): Promise<{ text: string; context: string }[] | { error: string }> {
    // Matching runs in Node, never in the page: a hostile pattern can only
    // burn a capped worker, never the tab (ReDoS-proof by timeout).
    let text: string;
    try {
      text = await this.page.evaluate(
        "(() => (document.body ? document.body.innerText : '').slice(0, 300000))()",
      );
    } catch {
      return { error: "could not read page text" };
    }
    if (typeof text !== "string") return { error: "could not read page text" };
    return matchInWorker(text, pattern, opts);
  }
  /**
   * Run fn with a throwaway tab as the operated page, then restore.
   * One-shots (search/open) share the session browser instead of launching
   * a second instance — Chromium forbids two on one profile dir, and a
   * second launch would queue on the file lock, not run in parallel.
   * fn must use adapter methods directly (never session fns — deadlock).
   */
  async withTab<R>(url: string, fn: (b: AgentBrowserAdapter) => Promise<R>): Promise<R> {
    const prev = this.page;
    // Throwaway tab is owned by THIS adapter (keeps mainPage at about:blank
    // so closing the throwaway never closes the agent's last tab).
    for (let i = 0; i < 3; i++) {
      const tab = await this.newTab("about:blank");
      this.page = tab;
      this.watchDiagnostics();
      try {
        await tab.goto(url);
        await tab.waitForLoadState("domcontentloaded");
        const out = await fn(this);
        this.page = prev;
        await tab.close().catch(() => undefined);
        return out;
      } catch (err) {
        this.page = prev;
        await tab.close().catch(() => undefined);
        if (i === 2) throw err;
        await sleep(500);
      }
    }
    throw new Error("Unreachable");
  }
  /** URLs of tabs owned by THIS adapter. Sync best-effort (prunes closed
   *  pages). Prefer over tabUrlsInWindow() when an await is affordable. */
  tabUrls(): string[] {
    return this.ownedPages().map((p) => {
      try {
        return p.url();
      } catch {
        return "";
      }
    });
  }

  /** Async owned-tab URLs. Prefer over tabUrls() when an await is affordable. */
  async tabUrlsInWindow(): Promise<string[]> {
    return this.tabUrls();
  }

  /** Close one tab by exact URL among THIS adapter's tabs (popup cleanup).
   *  Never touches the operated or main tab. Returns true when closed. */
  async closeTabWithUrl(url: string): Promise<boolean> {
    if (!url) return false;
    for (const p of this.ownedPages()) {
      if (p === this.page || p === this.mainPage) continue;
      let u = "";
      try {
        u = p.url();
      } catch {
        continue;
      }
      if (u === url) {
        try {
          await p.close();
        } catch {
          // Best-effort.
        }
        return true;
      }
    }
    return false;
  }

  async back(): Promise<void> {
    await this.page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
  }

  async forward(): Promise<void> {
    await this.page.goForward({ waitUntil: "domcontentloaded" }).catch(() => undefined);
  }

  async goto(url: string): Promise<void> {
    // Retry loop: Playwright's Firefox frame tree can race a navigation
    // commit (transient internal error) — a fresh attempt always recovers.
    let lastErr: unknown = null;
    for (let i = 0; i < 3; i++) {
      try {
        await this.page.goto(url);
        await this.page.waitForLoadState("domcontentloaded");
        await this.muteMedia();
        return;
      } catch (err) {
        lastErr = err;
        await sleep(500);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`Navigation to ${url} failed repeatedly.`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Owned browser: closing it affects only this process. Main mode also
    // exports the session snapshot + releases the profile lock (cleanup).
    try {
      if (this.downloadListener) this.ctx.off("download", this.downloadListener);
    } catch {
      // Best-effort.
    }
    this.downloadListener = null;
    try {
      await this.cleanup?.();
    } catch {
      // Best-effort.
    }
    this.cleanup = null;
    this.mainPage = null;
    this.owned.clear();
  }
}
