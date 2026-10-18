/**
 * Configuration: profile location, headless mode, locale/timezone/proxy.
 *
 * Pi decides and acts through tools, so there are no model keys here —
 * deciding happens in Pi's own model call, acting needs no credentials.
 * Precedence: explicit sources only — tool args > shadowBrowser settings
 * > defaults. No env, no .env.
 */


export interface ChromeConfig {
  profileDir?: string;
  headless?: boolean;
  locale?: string;
  timezone?: string;
  proxy?: string;
}

/** Resolve the full typed config. Headless by default (agents don't watch);
 *  headed only when asked (manual login via /browser-open, or headless:false). */
export function loadConfig(overrides: Partial<ChromeConfig> = {}): ChromeConfig {
  return {
    profileDir: overrides.profileDir,
    headless: overrides.headless ?? true,
    locale: overrides.locale,
    timezone: overrides.timezone,
    proxy: overrides.proxy,
  };
}

/** Log-safe summary for status reporting. */
export function redacted(config: ChromeConfig): Record<string, unknown> {
  return {
    profileDir: config.profileDir ?? "/tmp/agent-chrome",
    headless: config.headless ?? true,
    locale: config.locale ?? "default",
    timezone: config.timezone ?? "default",
    proxy: config.proxy ? "set" : "unset",
  };
}
