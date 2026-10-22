/** pi-shadow-browser: Pi browses with its own stealth-browser profile. Search, open, navigate. */

export { AgentBrowserAdapter, StalePage, mergeFrameSnapshots } from "./browserAdapter.js";
export type { FrameSnap, LaunchOpts } from "./browserAdapter.js";
export { loadConfig, redacted } from "./config.js";
export { sharedStatePath } from "./launcher.js";
export type { ChromeConfig } from "./config.js";
export { ensureAgentRoot, agentRoot, wipeProfileCopy, profileLockInfo, isProfileInUse, clearStaleLock } from "./profile.js";
export { shutdownDaemon, isDaemonAlive, daemonStatus } from "./session.js";
export { SimpleBrowser, formatPage } from "./simple.js";
export { search, searchMany, open, detectWall, unwrapUrl, isJunkResult, looksRedirect, cleanMarkdown, registerEngine } from "./search.js";
export type { SearchEngine, SearchResult, OpenedPage, BrowserOpts, EngineDef } from "./search.js";
export { navigate, read, act, back, forward, press, screenshot, clickAt, downloads, tabList, tabSwitch, tabClose, find, searchPage, wait, videoSeek, videoTranscript, closeSession, resetSession, hasSession, openBlankTab, configureSession, runWithSignal, AbortError } from "./session.js";

export { videoIdFromUrl } from "./video.js";
export type { VideoTranscript, TranscriptSegment } from "./video.js";
export type { SessionOpts } from "./session.js";
export type { PageAction, PageSnapshot } from "./types.js";
