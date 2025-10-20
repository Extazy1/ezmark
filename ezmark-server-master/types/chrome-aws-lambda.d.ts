declare module "chrome-aws-lambda" {
  import type { LaunchOptions, Viewport } from "puppeteer";

  interface ChromeAwsLambda {
    args?: string[];
    defaultViewport?: Viewport | null;
    executablePath(): Promise<string | null>;
    headless?: LaunchOptions["headless"];
    env?: LaunchOptions["env"];
  }

  const chromium: ChromeAwsLambda;
  export default chromium;
}
