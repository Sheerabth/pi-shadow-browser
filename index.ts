/**
 * Pi extension: Pi navigates websites itself, step by step.
 *
 * No decision models, no micro-loops, no keys. Pi is the agent loop; this
 * package is its hands: search, open, observe-with-actions, act, back,
 * forward — on one persistent session in its own Camoufox browser
 * (separate agent identity; never touches your Chrome).
 *
 * Install as a Pi package (`pi install <this-dir>`) or load directly:
 * `pi --extension ./index.ts`.
 *
 * Registers: browser_search, browser_open, browser_navigate, browser_act,
 * browser_press, browser_screenshot, browser_click_at, browser_tabs,
 * browser_tab_switch, browser_tab_close, browser_downloads,
 * browser_find, browser_search_page, browser_wait, browser_back,
 * browser_forward, browser_close — plus /browser-config,
 * /browser-open, /browser-reset and /browser-shutdown.
 *
 * Settings (highest precedence first):
 *   1. tool arguments (`headless` where offered)
 *   2. Pi settings `shadowBrowser` section (`~/.pi/agent/settings.json`):
 *      `{ "shadowBrowser": { "headless": true, "profileDir": "…", "locale": "…" } }`
 *   3. built-in defaults
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import type { JsonValue } from "@earendil-works/pi-ai";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  act,
  AbortError,
  back,
  clickAt,
  closeSession,
  configureSession,
  downloads,
  find,
  forward,
  hasSession,
  loadConfig,
  daemonStatus,
  navigate,
  open,
  openBlankTab,
  press,
  profileLockInfo,
  read,
  redacted,
  resetSession,
  runWithSignal,
  screenshot,
  shutdownDaemon,
  search,
  searchMany,
  searchPage,
  tabClose,
  tabList,
  tabSwitch,
  videoSeek,
  videoTranscript,
  wait,
} from "./src/index.js";import type { ChromeConfig } from "./src/index.js";

/**
 * Map the Pi settings `shadowBrowser` section to config overrides.
 * Pure — tested without Pi. Unknown/mistyped fields are ignored.
 */
export function shadowBrowserOverrides(settings: unknown): Partial<ChromeConfig> {
  const section =
    typeof settings === "object" && settings !== null
      ? (settings as { shadowBrowser?: unknown }).shadowBrowser
      : undefined;
  if (typeof section !== "object" || section === null) return {};
  const get = (k: string) => (section as Record<string, unknown>)[k];
  const out: Partial<ChromeConfig> = {};
  if (typeof get("profileDir") === "string") out.profileDir = get("profileDir") as string;
  if (typeof get("headless") === "boolean") out.headless = get("headless") as boolean;
  if (typeof get("locale") === "string") out.locale = get("locale") as string;
  if (typeof get("timezone") === "string") out.timezone = get("timezone") as string;
  if (typeof get("proxy") === "string") out.proxy = get("proxy") as string;
  return out;
}

function textResult(text: string, details: unknown, structured?: unknown) {
  let structuredContent: JsonValue | undefined;
  if (structured !== undefined) {
    try {
      structuredContent = JSON.parse(JSON.stringify(structured)) as JsonValue;
    } catch {
      structuredContent = undefined;
    }
  }
  return {
    content: [{ type: "text" as const, text }],
    details,
    ...(structuredContent !== undefined ? { structuredContent } : {}),
  };
}

function failed(tool: string, err: unknown, details: unknown) {
  // User-cancelled (Escape) is not an error — the op was stopped on purpose.
  if (err instanceof AbortError) return textResult(`${tool} aborted.`, details);
  return {
    ...textResult(`${tool} failed: ${err instanceof Error ? err.message : String(err)}`, details),
    isError: true,
  };
}

/** Render an observed page the way Pi navigates by: text + action ids. */
function renderPage(page: { url: unknown; title: unknown; text: unknown; actions: { id: string; label: string; kind: string }[] }): string {
  const lines = [`URL: ${String(page.url)}`, `Title: ${String(page.title)}`, ""];
  if (typeof page.text === "string" && page.text) lines.push(page.text.slice(0, 3000), "");
  lines.push("Actions (pass the id to browser_act):");
  for (const a of page.actions) lines.push(`  ${a.id}: [${a.kind}] ${a.label}`);
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  // Route the harness AbortSignal (Escape) into every tool: the call rejects
  // at once, drops the wedged session, and frees the mutex for the next call.
  // Generic over the definition so params inference flows exactly as with
  // pi.registerTool directly.
  function abortable<TParams extends TSchema, TDetails>(
    def: ToolDefinition<TParams, TDetails>,
  ): ToolDefinition<TParams, TDetails> {
    const inner = def.execute;
    const execute = (
      toolCallId: string,
      params: Static<TParams>,
      signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
      ctx: ExtensionToolContext,
    ): Promise<AgentToolResult<TDetails>> =>
      runWithSignal(signal, () => inner(toolCallId, params, signal, onUpdate, ctx));
    return { ...def, execute };
  }
  function registerTool<TParams extends TSchema, TDetails>(def: ToolDefinition<TParams, TDetails>): void {
    pi.registerTool(abortable(def));
  }
  // Close the browser session when the Pi session ends (no orphan windows).
  pi.on("session_shutdown", async () => {
    await closeSession().catch(() => undefined);
  });
  // Settings are read lazily per call: ExtensionAPI methods like
  // getSettings() cannot run during extension loading, only after startup.
  const settingsOverrides = (): Partial<ChromeConfig> => {
    try {
      return shadowBrowserOverrides(pi.getSettings());
    } catch {
      return {};
    }
  };
  // In-memory overrides from /browser-config: apply instantly (no /reload),
  // merged on top of settings. Engine keys (profileDir/headless/proxy)
  // additionally close the live session so the next op rebinds engines.
  let runtimeOverrides: Partial<ChromeConfig> = {};
  // Explicit headless source of truth (settings.json /browser-config /
  // per-call param). Everything forwarded to the session uses this —
  // never the filled launch default — so background one-shots can't
  // rebind (kill) a live headed window. Refreshed by sessionOpts().
  let lastExplicitHeadless: boolean | undefined;
  const sessionOpts = () => {
    // headless is sticky-explicit only: the built-in default (true) must
    // never reach the session, or every bare tool call would read it as
    // "headless wanted" and kill a live headed window (the flash-blank
    // cycle). Only settings.json /browser-config / per-call params rebind.
    const explicit = { ...settingsOverrides(), ...runtimeOverrides };
    lastExplicitHeadless = explicit.headless;
    const opts = loadConfig(explicit);
    configureSession({
      profileDir: opts.profileDir,
      headless: explicit.headless,
      locale: opts.locale,
      timezone: opts.timezone,
      proxy: opts.proxy,
    });
    return opts;
  };

  registerTool({
    name: "browser_search",
    label: "Search the web",
    description:
      "Search the web through the agent browser (Camoufox) and get " +
      "structured title+url+snippet results. No keys, fast. Follow with browser_open to read a result. " +
      "If a search comes back empty, retry the exact query ONCE; if still empty, stop for a while " +
      "(hammering triggers walls) — never silently switch engines.",
    promptGuidelines: [
      "Prefer browser_search for public-web questions; it needs no login.",
      "Use the navigate/act tools instead when the task needs logins, forms, or judging pages mid-task.",
    ],
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Search query (ignored when queries is set)." })),
      queries: Type.Optional(Type.Array(Type.String(), { description: "Fan-out: several queries, merged URL-deduped. Errors surface per query." })),
      engine: Type.Optional(Type.Union(
        [Type.Literal("google"), Type.Literal("bing"),
         Type.Literal("youtube"), Type.Literal("reddit"), Type.Literal("github")],
        { description: "Search engine. Default google." },
      )),
      maxResults: Type.Optional(Type.Number({ description: "How many results. Default 5, max 50 (large counts are slow)." })),
      depth: Type.Optional(Type.Number({ description: "Inline full content for the top N results. Default 0 (titles only)." })),
    }),
    outputSchema: Type.Object({
      query: Type.Optional(Type.String()),
      queries: Type.Optional(Type.Array(Type.String())),
      results: Type.Array(Type.Object({
        title: Type.String(),
        url: Type.String(),
        engine: Type.String(),
        snippet: Type.Optional(Type.String()),
        content: Type.Optional(Type.String()),
      })),
      errors: Type.Optional(Type.Array(Type.Object({ query: Type.String(), error: Type.String() }))),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const cfg = sessionOpts();
        const base = {
          engine: (params.engine ?? "google") as "google",
          maxResults: Math.min(params.maxResults ?? 5, 50),
          depth: Math.min(params.depth ?? 0, 5),
          headless: lastExplicitHeadless,
          profileDir: cfg.profileDir,
          proxy: cfg.proxy,
        };
        if (params.queries && params.queries.length > 0) {
          const { results, errors } = await searchMany(params.queries.slice(0, 10), base);
          const lines = results.map((r, i) =>
            `${i + 1}. ${r.title}\n   ${r.url}` +
            (r.snippet ? `\n   ${r.snippet.slice(0, 200)}` : "") +
            (r.content ? `\n   --- content ---\n${r.content.slice(0, 1500)}` : ""),
          );
          for (const e of errors) lines.push(`(query failed: ${e.query} — ${e.error.slice(0, 120)})`);
          return textResult(
            lines.length > 0 ? lines.join("\n") : "No results found.",
            { queries: params.queries, results, errors },
            { queries: params.queries, results, errors },
          );
        }
        if (!params.query) {
          return failed("browser_search", "Pass query or queries.", { queries: params.queries, results: [] });
        }
        const results = await search(params.query, base);
        const lines = results.map((r, i) =>
          `${i + 1}. ${r.title}\n   ${r.url}` +
          (r.snippet ? `\n   ${r.snippet.slice(0, 200)}` : "") +
          (r.content ? `\n   --- content ---\n${r.content.slice(0, 1500)}` : ""),
        );
        return textResult(
          lines.length > 0 ? lines.join("\n") : "No results found.",
          { query: params.query, results },
          { query: params.query, results },
        );
      } catch (err) {
        return failed("browser_search", err, { query: params.query, results: [] });
      }
    },
  });

  registerTool({
    name: "browser_open",
    label: "Open a page",
    description:
      "Open one URL in the shared browser session and read its visible text, like following a search " +
      "result by hand. Logged-in state applies. No keys.",
    promptGuidelines: [
      "Use browser_open to read a browser_search result in full.",
      "Use browser_navigate + browser_act when the page needs interaction (clicks, forms).",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to open and read." }),
    }),
    outputSchema: Type.Object({
      url: Type.String(),
      title: Type.String(),
      text: Type.String(),
      author: Type.Optional(Type.String()),
      published: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, params) => {
      try {
        // Explicit headless only (see sessionOpts): a filled default here
        // would rebind-kill a live headed window on every open.
        const page = await open(params.url, { ...sessionOpts(), headless: lastExplicitHeadless });
        const structured: Record<string, unknown> = { url: page.url, title: page.title, text: page.text };
        for (const k of ["author", "published", "description"] as const) {
          const v = (page as unknown as Record<string, unknown>)[k];
          if (typeof v === "string" && v) structured[k] = v;
        }
        return textResult(`Title: ${page.title}\nURL: ${page.url}\n\n${page.text.slice(0, 4000)}`, page, structured);
      } catch (err) {
        return failed("browser_open", err, { url: params.url });
      }
    },
  });

  registerTool({
    name: "browser_navigate",
    label: "Go to URL in session",
    description:
      "Navigate the shared browser session to a URL and observe: visible text plus the action ids " +
      "browser_act can use. Starts the session on first use. Clean up after yourself: close tabs " +
      "you opened (browser_tab_close) and close the session (browser_close) when the task is done, " +
      "unless the user is watching in a headed window they summoned.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to navigate to." }),
      headless: Type.Optional(Type.Boolean({ description: "Headless mode. Default true (agent runs unseen); pass false for a visible window. Applies when starting the shared browser; first starter wins." })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const base = sessionOpts();
        const cfg = loadConfig({ ...base });
        const page = await navigate(params.url, {
          // Explicit flip only: undefined leaves a live headed window alone.
          headless: params.headless,
          profileDir: cfg.profileDir,
          locale: cfg.locale,
          timezone: cfg.timezone,
          proxy: cfg.proxy,
        });
        return textResult(renderPage(page), page);
      } catch (err) {
        return failed("browser_navigate", err, { url: params.url });
      }
    },
  });

  registerTool({
    name: "browser_act",
    label: "Click or type in session",
    description:
      "Act on an observed action id in the shared session (click a link/button, type into a field, " +
      "scroll, wait), then re-observe. Get ids from browser_navigate output or a prior act.",
    promptGuidelines: [
      "Pass text only for fill actions (fields); clicks need just the id.",
      "After acting, read the fresh observation before choosing the next action.",
    ],
    parameters: Type.Object({
      actionId: Type.String({ description: "Action id, e.g. e3, scroll_down, wait." }),
      text: Type.Optional(Type.String({ description: "Text to type (fill actions only)." })),
      files: Type.Optional(Type.Array(Type.String(), { description: "Local file paths (upload actions only)." })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        sessionOpts();
        const page = await act(params.actionId, params.text, params.files);
        return textResult(renderPage(page), page);
      } catch (err) {
        return failed("browser_act", err, { actionId: params.actionId });
      }
    },
  });

  registerTool({
    name: "browser_press",
    label: "Press a key in session",
    description:
      "Press a keyboard key (Escape, Enter, Tab, ArrowDown, …) on the focused element in the shared " +
      "session, then re-observe. For dismissing dialogs and keyboard-driven controls.",
    parameters: Type.Object({
      key: Type.String({ description: "Key name, e.g. Escape, Enter, Tab, ArrowDown, a." }),
    }),
    execute: async (_toolCallId, params) => {
      try {
        sessionOpts();
        const page = await press(params.key);
        return textResult(renderPage(page), page);
      } catch (err) {
        return failed("browser_press", err, { key: params.key });
      }
    },
  });

  registerTool({
    name: "browser_screenshot",
    label: "Screenshot session page",
    description:
      "Capture a JPEG screenshot of the current session page for vision — use when the DOM " +
      "observation is empty or ambiguous (canvas apps, maps, visual layout). Pass fullPage for long pages.",
    parameters: Type.Object({
      fullPage: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page. Default false (viewport)." })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        sessionOpts();
        const shot = await screenshot(params.fullPage ?? false);
        return {
          content: [{ type: "image" as const, data: shot.data, mimeType: shot.mimeType }],
          details: { mimeType: shot.mimeType, bytes: shot.data.length },
        };
      } catch (err) {
        return failed("browser_screenshot", err, {});
      }
    },
  });

  registerTool({
    name: "browser_back",
    label: "Go back in session",
    description: "Go back one history entry in the shared session and re-observe.",
    parameters: Type.Object({}),
    execute: async () => {
      try {
        sessionOpts();
        const page = await back();
        return textResult(renderPage(page), page);
      } catch (err) {
        return failed("browser_back", err, {});
      }
    },
  });

  registerTool({
    name: "browser_forward",
    label: "Go forward in session",
    description: "Go forward one history entry in the shared session and re-observe.",
    parameters: Type.Object({}),
    execute: async () => {
      try {
        sessionOpts();
        const page = await forward();
        return textResult(renderPage(page), page);
      } catch (err) {
        return failed("browser_forward", err, {});
      }
    },
  });

  registerTool({
    name: "browser_close",
    label: "Close browser session",
    description:
      "Close the shared browser session and release the profile. The next navigation reopens it. " +
      "Call this when your browsing task is done and the user isn't watching — leaves no windows behind.",
    parameters: Type.Object({}),
    execute: async () => {
      await closeSession();
      return textResult("Browser session closed.", { open: hasSession() });
    },
  });

  registerTool({
    name: "browser_click_at",
    label: "Click at coordinates",
    description:
      "Click at page CSS-pixel coordinates (x, y) in the shared session, then re-observe. " +
      "Vision-grounded fallback: screenshot first — coordinates match the screenshot 1:1 — then click " +
      "what the DOM cannot see (canvas apps, maps, custom widgets).",
    parameters: Type.Object({
      x: Type.Number({ description: "Horizontal CSS pixel in the current viewport." }),
      y: Type.Number({ description: "Vertical CSS pixel in the current viewport." }),
    }),
    execute: async (_toolCallId, params) => {
      try {
        sessionOpts();
        const page = await clickAt(params.x, params.y);
        return textResult(renderPage(page), page);
      } catch (err) {
        return failed("browser_click_at", err, { x: params.x, y: params.y });
      }
    },
  });

  registerTool({
    name: "browser_tabs",
    label: "List session tabs",
    description: "List open tabs (index/url/title) in the shared session for browser_tab_switch.",
    parameters: Type.Object({}),
    execute: async () => {
      try {
        sessionOpts();
        const tabs = await tabList();
        const lines = tabs.map((t) => `${t.index}: ${t.title || "(no title)"}\n   ${t.url}`);
        return textResult(lines.length > 0 ? lines.join("\n") : "No tabs open.", { tabs });
      } catch (err) {
        return failed("browser_tabs", err, { tabs: [] });
      }
    },
  });

  registerTool({
    name: "browser_tab_switch",
    label: "Switch session tab",
    description: "Switch the operated tab in the shared session (see browser_tabs), then re-observe.",
    parameters: Type.Object({
      index: Type.Number({ description: "Tab index from browser_tabs." }),
    }),
    execute: async (_toolCallId, params) => {
      try {
        sessionOpts();
        const page = await tabSwitch(params.index);
        return textResult(renderPage(page), page);
      } catch (err) {
        return failed("browser_tab_switch", err, { index: params.index });
      }
    },
  });

  registerTool({
    name: "browser_downloads",
    label: "List session downloads",
    description: "List files downloaded in this session (name, saved path, source url).",
    parameters: Type.Object({}),
    execute: async () => {
      try {
        sessionOpts();
        const files = await downloads();
        const lines = files.map((f) => `${f.name}\n   ${f.path}`);
        return textResult(lines.length > 0 ? lines.join("\n") : "No downloads yet.", { files });
      } catch (err) {
        return failed("browser_downloads", err, { files: [] });
      }
    },
  });

  registerTool({
    name: "browser_find",
    label: "Find text in session",
    description: "Scroll the first visible match of the given text into view in the shared session, then re-observe.",
    parameters: Type.Object({
      text: Type.String({ description: "Text to find (case-insensitive)." }),
    }),
    execute: async (_toolCallId, params) => {
      try {
        sessionOpts();
        const page = await find(params.text);
        return textResult(renderPage(page), page);
      } catch (err) {
        return failed("browser_find", err, { text: params.text });
      }
    },
  });

  registerTool({
    name: "browser_search_page",
    label: "Search page text",
    description:
      "Regex/text search over the session page's visible text with surrounding context. No navigation. " +
      "Use to locate content without scrolling the page.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Text or regex pattern." }),
      regex: Type.Optional(Type.Boolean({ description: "Treat pattern as regex. Default false (literal)." })),
      caseSensitive: Type.Optional(Type.Boolean({ description: "Case-sensitive match. Default false." })),
      contextChars: Type.Optional(Type.Number({ description: "Context characters around each hit. Default 100." })),
      maxResults: Type.Optional(Type.Number({ description: "Max hits. Default 10." })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        sessionOpts();
        const out = await searchPage(params.pattern, {
          regex: params.regex,
          caseSensitive: params.caseSensitive,
          contextChars: params.contextChars,
          maxResults: params.maxResults,
        });
        if ("error" in out) return failed("browser_search_page", out.error, { pattern: params.pattern });
        const lines = out.map((h) => `- ${h.text}\n  …${h.context}…`);
        return textResult(lines.length > 0 ? lines.join("\n") : "No matches on this page.", { pattern: params.pattern, hits: out });
      } catch (err) {
        return failed("browser_search_page", err, { pattern: params.pattern });
      }
    },
  });

  registerTool({
    name: "browser_wait",
    label: "Wait in session",
    description: "Wait a fixed number of seconds (max 30, for loading content), then re-observe. One wait, then act — never chain waits or shell-sleep in a loop to poll a page; use browser_read to check freshness.",
    parameters: Type.Object({
      seconds: Type.Number({ description: "Seconds to wait, 0–30." }),
    }),
    execute: async (_toolCallId, params) => {
      try {
        sessionOpts();
        const page = await wait(params.seconds);
        return textResult(renderPage(page), page);
      } catch (err) {
        return failed("browser_wait", err, { seconds: params.seconds });
      }
    },
  });

  registerTool({
    name: "browser_tab_close",
    label: "Close session tab",
    description: "Close one tab by index (see browser_tabs); never the last — browser_close ends the session.",
    parameters: Type.Object({
      index: Type.Number({ description: "Tab index from browser_tabs." }),
    }),
    execute: async (_toolCallId, params) => {
      try {
        sessionOpts();
        const page = await tabClose(params.index);
        return textResult(renderPage(page), page);
      } catch (err) {
        return failed("browser_tab_close", err, { index: params.index });
      }
    },
  });

  registerTool({
    name: "browser_read",
    label: "Re-read session page",
    description:
      "Re-observe the current session page without navigating, acting, or waiting. " +
      "Use when the page may have changed by itself (live updates, timers) or to check " +
      "freshness without losing form or app state to a reload. " +
      "Check once after acting — do not poll it in a loop; pair one browser_wait with one read.",
    parameters: Type.Object({}),
    execute: async () => {
      try {
        sessionOpts();
        const page = await read();
        return textResult(renderPage(page), page);
      } catch (err) {
        return failed("browser_read", err, {});
      }
    },
  });

  registerTool({
    name: "browser_video_transcript",
    label: "Get video transcript",
    description:
      "Read a YouTube video's Show transcript panel as timestamped text — " +
      "the fastest way to understand a video without watching it. No keys, " +
      "uses the logged-in session, works on age/login-gated videos. Fails " +
      "clearly when the video has no transcript panel.",
    parameters: Type.Object({
      url: Type.String({ description: "YouTube watch/share/shorts URL." }),
    }),
    outputSchema: Type.Object({
      videoId: Type.String(),
      title: Type.String(),
      lang: Type.String(),
      autoGenerated: Type.Boolean(),
      segments: Type.Array(Type.Object({ start: Type.Number(), dur: Type.Number(), text: Type.String() })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const t = await videoTranscript(params.url);
        const stamp = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
        const lines = t.segments.map((s) => `[${stamp(s.start)}] ${s.text}`);
        const body = lines.join("\n");
        return textResult(
          `${t.title || "Untitled"} (${t.lang}${t.autoGenerated ? ", auto-generated" : ""}, ${t.segments.length} lines)\n\n` +
            (body.length > 6000 ? body.slice(0, 6000) + "\n[…truncated]" : body),
          { videoId: t.videoId, segments: t.segments },
          { videoId: t.videoId, title: t.title, lang: t.lang, autoGenerated: t.autoGenerated, segments: t.segments },
        );
      } catch (err) {
        return failed("browser_video_transcript", err, { url: params.url });
      }
    },
  });

  registerTool({
    name: "browser_video_seek",
    label: "Seek session video",
    description:
      "Seek the session page's video to N seconds and screenshot the frame — " +
      "look at a specific moment. Navigate to a watch page first. Returns the " +
      "frame image plus player state.",
    parameters: Type.Object({
      seconds: Type.Number({ description: "Timestamp to seek to, in seconds." }),
    }),
    execute: async (_toolCallId, params) => {
      try {
        sessionOpts();
        await videoSeek(params.seconds);
        const shot = await screenshot();
        return {
          content: [
            { type: "image" as const, data: shot.data, mimeType: shot.mimeType },
            { type: "text" as const, text: `Seeked to ${params.seconds}s.` },
          ],
          details: { seconds: params.seconds },
        };
      } catch (err) {
        return failed("browser_video_seek", err, { seconds: params.seconds });
      }
    },
  });

  /** Settable shadowBrowser keys (personal settings only). */
  const CONFIG_KEYS = ["profileDir", "headless", "locale", "timezone", "proxy"] as const;
  type ConfigKey = (typeof CONFIG_KEYS)[number];
  const isConfigKey = (k: string): k is ConfigKey =>
    (CONFIG_KEYS as readonly string[]).includes(k);

  function settingsFilePath(): string {
    return join(homedir(), ".pi", "agent", "settings.json");
  }

  function readSettingsFile(): { data: Record<string, unknown>; file: string } {
    const file = settingsFilePath();
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (typeof parsed !== "object" || parsed === null) throw new Error("not a JSON object");
      return { data: parsed as Record<string, unknown>, file };
    } catch (err) {
      // Missing settings.json means "no settings yet" — start from {} so
      // /browser-config works on a fresh install. Anything else surfaces.
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { data: {}, file };
      throw new Error(`Cannot read settings at ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Set (or with value undefined, clear) one shadowBrowser key. Returns the file written. */
  function writeShadowBrowserKey(key: ConfigKey, value: string | boolean | undefined): string {
    const { data, file } = readSettingsFile();
    const raw = data.shadowBrowser;
    const section: Record<string, unknown> =
      typeof raw === "object" && raw !== null ? { ...(raw as Record<string, unknown>) } : {};
    if (value === undefined) delete section[key];
    else section[key] = value;
    if (Object.keys(section).length === 0) delete data.shadowBrowser;
    else data.shadowBrowser = section;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    } catch (err) {
      throw new Error(`Cannot write settings at ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return file;
  }

  /** Drop the whole shadowBrowser section. Returns the file written. */
  function clearShadowBrowserSection(): string {
    const { data, file } = readSettingsFile();
    delete data.shadowBrowser;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    } catch (err) {
      throw new Error(`Cannot write settings at ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return file;
  }

  const ENGINE_KEYS: ReadonlySet<ConfigKey> = new Set(["profileDir", "headless", "proxy"]);
  /** Apply a config change immediately: in-memory override + engine rebind
   *  for engine keys (next op opens on the new engine, no /reload). */
  async function applyConfigChange(key: ConfigKey | "*", value: string | boolean | undefined): Promise<void> {
    if (key === "*") {
      runtimeOverrides = {};
    } else if (value === undefined) {
      delete runtimeOverrides[key];
    } else {
      (runtimeOverrides as Record<string, unknown>)[key] = value;
    }
    sessionOpts();
    if (key === "*" || ENGINE_KEYS.has(key as ConfigKey)) {
      if (hasSession()) await closeSession().catch(() => undefined);
    }
  }

  pi.registerCommand("browser-config", {
    description: "Show or change the shadow-browser configuration (settings.json shadowBrowser section).",
    getArgumentCompletions: (prefix) => {
      const words = prefix.trimStart().split(/\s+/);
      if (words.length <= 1) {
        const p = words[0] ?? "";
        const hit = [...CONFIG_KEYS, "reset"].filter((c) => c.startsWith(p));
        return hit.length > 0 ? hit.map((c) => ({ value: `${c} `, label: c })) : null;
      }
      if (words[0] === "headless" && words.length === 2) {
        return ["true", "false"].filter((v) => v.startsWith(words[1])).map((value) => ({ value, label: value }));
      }
      return null;
    },
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        try {
          const cfg = sessionOpts();
        const lock = profileLockInfo(cfg.profileDir);
        const summary = {
          ...redacted(cfg),
          session: hasSession() ? "open" : "closed",
          lock: !lock.locked ? "free" : lock.stale ? "stale (clears on next use)" : "in use by another session",
        };
        const text = Object.entries(summary)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n");
        ctx.ui.notify(`shadow-browser config (tool args > shadowBrowser settings > defaults):\n${text}`, "info");
      } catch (err) {
        ctx.ui.notify(`/browser-config failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        return;
      }
        return;
      }
      const [key, ...rest] = parts;
      if (key === "reset") {
        if (rest.length === 0) {
          try {
            const file = clearShadowBrowserSection();
            await applyConfigChange("*", undefined);
            ctx.ui.notify(`Cleared shadowBrowser section (${file}). Next browser use opens on defaults.`, "info");
          } catch (err) {
            ctx.ui.notify(`/browser-config failed: ${err instanceof Error ? err.message : String(err)}`, "error");
          }
          return;
        }
        if (rest.length === 1 && isConfigKey(rest[0])) {
          try {
            const file = writeShadowBrowserKey(rest[0], undefined);
            await applyConfigChange(rest[0], undefined);
            ctx.ui.notify(`Cleared ${rest[0]} (${file}). Applies immediately.`, "info");
          } catch (err) {
            ctx.ui.notify(`/browser-config failed: ${err instanceof Error ? err.message : String(err)}`, "error");
          }
          return;
        }
        ctx.ui.notify(`Usage: /browser-config reset [${CONFIG_KEYS.join(" | ")}]`, "warning");
        return;
      }
      if (!isConfigKey(key)) {
        ctx.ui.notify(
          `Unknown setting ${JSON.stringify(key)} — known: ${CONFIG_KEYS.join(", ")}, reset. Usage: /browser-config [key value | reset [key]]`,
          "warning",
        );
        return;
      }
      if (rest.length === 0) {
        const value = (redacted(sessionOpts()) as Record<string, unknown>)[key];
        ctx.ui.notify(`${key}: ${String(value)}`, "info");
        return;
      }
      let value: string | boolean;
      if (key === "headless") {
        const norm = rest.join(" ").toLowerCase();
        if (norm === "true" || norm === "1") value = true;
        else if (norm === "false" || norm === "0") value = false;
        else {
          ctx.ui.notify(`headless wants true or false, got ${JSON.stringify(rest.join(" "))}.`, "warning");
          return;
        }
      } else {
        value = rest.join(" ");
      }
      try {
        const file = writeShadowBrowserKey(key, value);
        await applyConfigChange(key, value);
        ctx.ui.notify(`Set ${key} = ${typeof value === "string" ? value : String(value)} (${file}). Applies immediately.`, "info");
      } catch (err) {
        ctx.ui.notify(`/browser-config failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("browser-open", {
    description: "Open a blank tab in this session's window for manual use (log in by hand). Focused for you.",
    handler: async (_args, ctx) => {
      try {
        // Operates on THIS session's window: focuses the existing blank tab
        // or opens one blank tab in-window (never duplicates, never another
        // agent's window). A headless daemon is invisible by definition —
        // the session restarts it visible instead of opening unseen tabs.
        const before = daemonStatus(sessionOpts().profileDir);
        await openBlankTab({ ...sessionOpts(), headless: false });
        if (before && before.headless) ctx.ui.notify("Shared browser was headless (invisible) — restarted it visible.", "info");
        ctx.ui.notify("Blank tab opened and focused - log in as needed.", "info");
      } catch (err) {
        ctx.ui.notify(`/browser-open failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("browser-shutdown", {
    description: "Stop the shared browser daemon (all agent sessions lose their browser).",
    handler: async (_args, ctx) => {
      try {
        const stopped = await shutdownDaemon(sessionOpts().profileDir);
        ctx.ui.notify(stopped ? "Browser daemon stopped. Next navigation relaunches it." : "No browser daemon was running.", "info");
      } catch (err) {
        ctx.ui.notify(`/browser-shutdown failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("browser-reset", {
    description: "Close everything, stop the shared browser, wipe the agent home. Next navigation relaunches fresh.",
    handler: async (_args, ctx) => {
      try {
        const root = await resetSession({ profileDir: sessionOpts().profileDir });
        ctx.ui.notify(`Agent session closed and profile wiped (${root}). Next navigation starts fresh.`, "info");
      } catch (err) {
        ctx.ui.notify(`/browser-reset failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}
