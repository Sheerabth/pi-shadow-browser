# pi-shadow-browser — handoff

Pi extension + TypeScript package: an AI agent browses the web through
Camoufox (anti-detect Firefox). Stack: `camoufox-js` + `playwright-core`,
TypeBox schemas, no API keys anywhere.

## Current architecture

No daemon, no CDP, no windows. Every process owns its Camoufox browser,
launched by `src/launcher.ts`:

- The profile-lock holder runs the **canonical persistent profile**
  (`<root>/camoufox-profile`) — logins survive restarts.
- Everyone else runs an **ephemeral scratch browser** hydrated from the
  shared session snapshot (`<root>/state.json`, 0600): no lock contention,
  no profile corruption, no copies of encrypted files. Logins roam one way
  (persistent → ephemeral) via Playwright storageState (decrypted JSON).
- The holder exports state every 60s + on close; subagents import at launch.
- Authenticated proxies allowed (per-process browsers, no shared-config
  restriction). Fingerprint options are Camoufox defaults (no pinning yet —
  see follow-ups).

Each agent owns its TABS (tab-ownership replaces window isolation — Firefox
has no CDP windowIds): nobody lists, switches to, or closes another agent's
tabs. `src/session.ts` is a per-process session over one adapter: lazy
launch, serialized ops through a mutex with a 150s deadline, clean close
(releases the lock / removes scratch). An engine switch (root/proxy/headless)
closes the session window and relaunches. `/browser-open` relaunches a
headless browser as headed (an invisible window serves no manual use).

- `src/launcher.ts` — `launchAgentBrowser({root, headless, proxy, locale})`:
  try profile lock (non-blocking) → persistent `Camoufox({user_data_dir})`
  + state export timer; on lock contention → ephemeral `Camoufox({})` +
  `newContext({storageState})`. Both muted: autoplay-blocking
  `firefox_user_prefs` + an `addInitScript` media muter on the context.
  Returns `{ctx, browser|null, mode, cleanup, statePath}`.
- `src/browserAdapter.ts` — `AgentBrowserAdapter`: observe/fresh/act/press/
  screenshot/videoSeek/clickAt/tabList/tabSwitch/tabClose/findText/
  searchPageText/back/forward/goto/close/closeTabWithUrl + `withTab`,
  `evaluate`, `tabUrls`/`tabUrlsInWindow`, `currentUrl`, `downloadList`,
  `openBlankTab`. Owns its tabs (adopt the single unclaimed birth tab via
  `window.__piShadowClaimed`, else open new). `close()` runs cleanup
  (exports state + releases lock in main mode). Iframe-aware snapshots with
  freshness guards (same as before). No `page.pdf` (unsupported on Firefox —
  `browser_pdf` tool removed). `connect` wrapped in a 30s race.
- `src/session.ts` — `navigate`, `read`, `act`, `back`, `forward`, `press`,
  `clickAt`, `screenshot`, `downloads`, `tabList`, `tabSwitch`, `tabClose`,
  `find`, `searchPage`, `wait`, `videoSeek`, `closeSession`,
  `resetSession` (closes session, wipes agent home), `hasSession`,
  `runInTab` (throwaway tab in-session; no leaked blanks), `openBlankTab`
  (idempotent; relaunches headed when asked), `configureSession`,
  `daemonStatus`/`shutdownDaemon`/`isDaemonAlive` (session-backed shims
  keeping the extension UX unchanged). Dead sessions revive once, then
  errors surface loudly.
- `src/profile.ts` — `agentRoot`, `ensureAgentRoot` (0700),
  `wipeProfileCopy`, `profileLockInfo`, `isProfileInUse` (matches Chromium
  `--user-data-dir` AND Firefox `-profile` cmdlines, whitespace/NUL split,
  fail-closed), `clearStaleLock`, `acquireProfileLock` (blocking, stale-owner
  aware; try-acquire with 1ms timeout = main-or-ephemeral decision).
- `src/config.ts` — `ChromeConfig`: `profileDir`, `headless` (default true),
  `locale`, `timezone`, `proxy`. Sources: tool args > `shadowBrowser`
  settings (`~/.pi/agent/settings.json`) > built-ins. No env vars, no `.env`
  (deliberate). `redacted()` for safe display.
- `src/search.ts` — `search`/`searchMany` (engines: google, bing, youtube,
  reddit, github; default google; one engine per call, no silent fallback),
  `open` (page as markdown), `detectWall` (sorry/consent/home/blocked),
  `unwrapUrl`, `looksRedirect`, `isJunkResult`, `cleanMarkdown`,
  `registerEngine`. Rate-limited (4s between searches).
- `src/video.ts` — transcript extraction from the watch page's own
  "Show transcript" panel (`OPEN_TRANSCRIPT_JS`/`READ_TRANSCRIPT_JS`,
  both old + view-model DOM). `videoIdFromUrl`, `parseTimestamp`,
  `segmentsFromPage`. No keys, no API clients.
- `src/simple.ts` — `SimpleBrowser` for scripts/manual driving on the adapter.
- `src/types.ts` — `PageSnapshot`, `PageAction`.
- `src/index.ts` — public exports. `dist/` is gitignored and rebuilt, never
  stale.
- `vendor/` — `snapshot.js` (DOM reader, skips password/file/hidden inputs —
  the model can never see password fields), `shadow-supplement.js`,
  `markdown.js`. Both verified working under Firefox.
- `index.ts` — 20 `browser_*` tools (no `browser_pdf`)
  + 4 commands: `/browser-config`, `/browser-open`, `/browser-shutdown`
  (stops the session browser), `/browser-reset` (closes session, wipes agent
  home).
- Uploads sandboxed to cwd+tmp. No secrets in code, logs, or tool output.

## Target state (the goal)

1. **One persistent identity.** Main Pi process holds the canonical profile;
   logins happen by hand in `/browser-open` and persist across restarts with
   zero transfer machinery. Subagents/sessions hydrate from the snapshot.
2. **`/browser-open` is idempotent**: focuses the existing blank/birth tab
   when there is one, else opens exactly one blank tab and focuses it.
   Repeated opens never duplicate, never touch another agent's tabs.
3. **Cold open in seconds, never minutes.** Launch, tab open, and first
   observe are each bounded; every failure names its cause. No orphans
   accumulate (cleanup closes browser + lock + scratch).
4. **Search works where the network allows.** Verified: Google serves full
   results to headless Camoufox where it sorry-walled Chromium on the same
   IP. Walls still surface, never masked. Site engines unaffected.
5. **Config is code + settings only.** No env vars. Failures are loud and
   specific; no silent fallbacks, no swallowed errors, no dead code.

## Follow-ups (known, not yet done)

- Fingerprint pinning: save Camoufox `launchOptions()` to a fingerprint file
  on first launch and reuse it, so restarts present a stable device (matters
  for login longevity). Currently defaults per launch.
- Ephemeral sessions never write back: logins done in a subagent stay there.
  One-way roam is deliberate; revisit if multi-writer is ever needed.
- Retired: `src/daemon.ts`, `src/camoufoxRunner.mjs`, `src/chromeLogin.ts`,
  Chromium CDP window isolation, `browser_pdf`, `chromeBinary` config.

## Working agreements

- Verify with `npx tsc --noEmit`, a live browser run, then `rm -rf dist &&
  npm run build`. No unit tests by policy — real runs are the suite.
- Keep diffs surgical; one concern per change; don't refactor past the task.
