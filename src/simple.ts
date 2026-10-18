/**
 * Manual browsing: observe the page, pick an action id, act. No keys,
 * no model calls — the caller (Pi, a human, a script) decides everything.
 * Execution uses the same {@link AgentBrowserAdapter} as the session,
 * so freshness + occlusion checks are identical.
 */

import { AgentBrowserAdapter } from "./browserAdapter.js";
import type { LaunchOpts } from "./browserAdapter.js";
import type { PageAction, PageSnapshot } from "./types.js";

const KIND_OP: Record<string, string> = { click: "CLICK", fill: "TYPE_TEXT", select: "SELECT", upload: "UPLOAD" };

/** Render an observed page as compact text for a decider (LLM or human). */
export function formatPage(page: PageSnapshot): string {
  const lines = [`URL: ${page.url}`, `Title: ${page.title}`];
  if (page.text) lines.push("", page.text.slice(0, 2000));
  lines.push("", "Actions:");
  for (const action of page.actions) {
    const op = KIND_OP[action.kind] ?? action.id.toUpperCase();
    lines.push(`  ${action.id}: [${op}] ${action.label}`);
  }
  if (page.omitted_actions) lines.push(`  ... +${page.omitted_actions} more (scroll to reveal)`);
  return lines.join("\n");
}

/**
 * Camoufox browser on the persistent agent profile (or an ephemeral
 * scratch browser when another process holds the profile). No keys,
 * no model calls — log in once and the session persists across runs.
 *
 * ```ts
 * const browser = await SimpleBrowser.create(url);
 * try {
 *   console.log(formatPage(await browser.observe()));
 *   await browser.step("e3");
 * } finally {
 *   await browser.close();
 * }
 * // or: await using browser = await SimpleBrowser.create(url);
 * ```
 */
export class SimpleBrowser {
  private page: PageSnapshot | null = null;

  private constructor(private browser: AgentBrowserAdapter) {}

  static async create(url: string, opts: LaunchOpts = {}): Promise<SimpleBrowser> {
    return new SimpleBrowser(await AgentBrowserAdapter.create(url, opts));
  }

  async observe(screenshot = false): Promise<PageSnapshot> {
    this.page = await this.browser.observe(screenshot);
    return this.page;
  }

  /** Execute one observed action id (e.g. 'e3', 'scroll_down', 'wait'). */
  async act(actionId: string, text?: string, files?: string[]): Promise<{ executed: string }> {
    if (!this.page) throw new Error("Observe before acting.");
    const action: PageAction | undefined = this.page.actions.find((a) => a.id === actionId);
    if (!action) throw new Error(`Unknown action id ${JSON.stringify(actionId)} — observe again for fresh ids.`);
    if (action.kind === "fill" && text === undefined) {
      throw new Error("That field needs text — pass text='...'.");
    }
    if (action.kind === "upload" && !files?.length) {
      throw new Error("That input needs files=[...] — pass local file paths.");
    }
    return this.browser.act(action, this.page, text, files);
  }

  /** Act, then re-observe. Returns the fresh page. */
  async step(actionId: string, text?: string, files?: string[]): Promise<PageSnapshot> {
    await this.act(actionId, text, files);
    return this.observe();
  }

  async press(key: string): Promise<void> {
    await this.browser.press(key);
  }

  async screenshot(fullPage = false): Promise<{ data: string; mimeType: string }> {
    return this.browser.screenshot(fullPage);
  }

  /** Run a code-owned read script (see AgentBrowserAdapter.evaluate). */
  async evaluate<T>(expression: string): Promise<T> {
    return this.browser.evaluate<T>(expression);
  }

  currentUrl(): string {
    return this.browser.currentUrl();
  }

  tabUrls(): string[] {
    return this.browser.tabUrls();
  }

  async back(): Promise<void> {
    await this.browser.back();
  }

  async forward(): Promise<void> {
    await this.browser.forward();
  }

  async goto(url: string): Promise<void> {
    await this.browser.goto(url);
  }

  async close(): Promise<void> {
    await this.browser.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
