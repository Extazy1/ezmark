declare module "@puppeteer/browsers" {
  export type BrowserIdentifier =
    | "chrome"
    | "chrome-headless-shell"
    | "chromium"
    | "firefox";

  export type BrowserPlatform = string;

  export interface BrowserLaunchConfig {
    browser: BrowserIdentifier;
    cacheDir: string;
    buildId: string;
    platform: BrowserPlatform;
  }

  export function detectBrowserPlatform(): BrowserPlatform | undefined;

  export function computeExecutablePath(
    options: BrowserLaunchConfig
  ): string;

  export function install(options: BrowserLaunchConfig): Promise<void>;
}
