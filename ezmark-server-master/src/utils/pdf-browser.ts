import puppeteer from "puppeteer";
import type { LaunchOptions } from "puppeteer";
import { computeExecutablePath, detectBrowserPlatform, install } from "@puppeteer/browsers";
import fs from "fs";
import os from "os";
import path from "path";

type ChromeAwsLambdaModule = {
  executablePath: () => Promise<string | null>;
  args?: string[];
  headless?: LaunchOptions["headless"];
  defaultViewport?: LaunchOptions["defaultViewport"];
  env?: LaunchOptions["env"];
} | null;

const chromeArgs = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--ignore-certificate-errors",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

const chromeAwsLambdaModule: { instance: ChromeAwsLambdaModule | undefined } = {
  instance: undefined,
};

const loadChromeAwsLambda = (): ChromeAwsLambdaModule => {
  if (chromeAwsLambdaModule.instance !== undefined) {
    return chromeAwsLambdaModule.instance;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const required = require("chrome-aws-lambda");
    const resolved = required?.default ?? required;
    if (resolved && typeof resolved.executablePath === "function") {
      chromeAwsLambdaModule.instance = resolved as ChromeAwsLambdaModule;
    } else {
      chromeAwsLambdaModule.instance = null;
    }
  } catch (error) {
    strapi.log.debug(
      "chrome-aws-lambda is not available; falling back to Puppeteer's bundled Chrome",
      error
    );
    chromeAwsLambdaModule.instance = null;
  }

  return chromeAwsLambdaModule.instance;
};

interface ChromeLaunchStrategy {
  executablePath: string;
  headless?: LaunchOptions["headless"];
  args?: string[];
  defaultViewport?: LaunchOptions["defaultViewport"];
  env?: LaunchOptions["env"];
}

const cachedStrategy: { promise: Promise<ChromeLaunchStrategy> | null } = {
  promise: null,
};

const cachedExecutablePath: { promise: Promise<string> | null } = {
  promise: null,
};

const extractBuildId = (executablePath?: string) => {
  if (!executablePath) {
    return undefined;
  }

  const match = executablePath.match(/-(\d+\.\d+\.\d+\.\d+)/);
  return match?.[1];
};

export const ensureChromeExecutable = async (): Promise<string> => {
  if (!cachedExecutablePath.promise) {
    cachedExecutablePath.promise = (async () => {
      const candidatePaths = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        process.env.CHROMIUM_EXECUTABLE_PATH,
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
      ];

      for (const candidate of candidatePaths) {
        if (candidate && fs.existsSync(candidate)) {
          strapi.log.debug(`Using configured Chrome executable: ${candidate}`);
          return candidate;
        }
      }

      const bundledPath = puppeteer.executablePath();
      if (bundledPath && fs.existsSync(bundledPath)) {
        strapi.log.debug(`Using Puppeteer's bundled Chrome at ${bundledPath}`);
        return bundledPath;
      }

      const cacheDir =
        process.env.PUPPETEER_CACHE_DIR || path.join(os.homedir(), ".cache", "puppeteer");

      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }

      const platform = detectBrowserPlatform();
      if (!platform) {
        throw new Error("Unsupported platform for Puppeteer Chrome download");
      }

      const buildId =
        process.env.PUPPETEER_BROWSER_REVISION ||
        process.env.PUPPETEER_BUILD_ID ||
        extractBuildId(bundledPath) ||
        "stable";

      const expectedPath = computeExecutablePath({
        browser: "chrome",
        cacheDir,
        platform,
        buildId,
      });

      if (!fs.existsSync(expectedPath)) {
        strapi.log.info(
          `Chrome executable missing; downloading build ${buildId} to ${expectedPath}`
        );
        await install({
          browser: "chrome",
          cacheDir,
          platform,
          buildId,
        });
      }

      if (!fs.existsSync(expectedPath)) {
        throw new Error(
          `Chrome executable was not found after installation. Expected at ${expectedPath}`
        );
      }

      strapi.log.debug(`Using freshly installed Chrome at ${expectedPath}`);
      return expectedPath;
    })().catch((error) => {
      cachedExecutablePath.promise = null;
      throw error;
    });
  }

  return cachedExecutablePath.promise;
};

const computeChromeLaunchStrategy = async (): Promise<ChromeLaunchStrategy> => {
  const chromeAwsLambda = loadChromeAwsLambda();
  if (chromeAwsLambda) {
    try {
      const executablePath = await chromeAwsLambda.executablePath();
      if (executablePath) {
        strapi.log.debug(
          `Using chrome-aws-lambda binary at ${executablePath} for PDF generation`
        );
        return {
          executablePath,
          headless: chromeAwsLambda.headless ?? true,
          args: chromeAwsLambda.args,
          defaultViewport: chromeAwsLambda.defaultViewport,
          env: chromeAwsLambda.env,
        };
      }
      strapi.log.warn(
        "chrome-aws-lambda did not provide an executable path; falling back to Puppeteer defaults"
      );
    } catch (error) {
      strapi.log.warn(
        "Failed to resolve chrome-aws-lambda executable, falling back to Puppeteer's Chrome",
        error
      );
    }
  }

  const executablePath = await ensureChromeExecutable();
  return {
    executablePath,
    headless: true,
  };
};

export const resolvePdfLaunchOptions = async (): Promise<LaunchOptions> => {
  if (!cachedStrategy.promise) {
    cachedStrategy.promise = computeChromeLaunchStrategy().catch((error) => {
      cachedStrategy.promise = null;
      throw error;
    });
  }

  const strategy = await cachedStrategy.promise;
  const args = Array.from(
    new Set([...(strategy.args ?? []), ...chromeArgs])
  );

  const options: LaunchOptions = {
    headless: strategy.headless ?? true,
    args,
    executablePath: strategy.executablePath,
  };

  if (strategy.defaultViewport) {
    options.defaultViewport = strategy.defaultViewport;
  }

  if (strategy.env) {
    options.env = strategy.env;
  }

  return options;
};

export const warmupChrome = async () => {
  const start = Date.now();
  try {
    const strategy = await resolvePdfLaunchOptions();
    const duration = Date.now() - start;
    strapi.log.info(
      `Chrome executable ready for PDF exports at ${strategy.executablePath} (prepared in ${duration}ms)`
    );
  } catch (error) {
    strapi.log.error("Failed to prepare Chrome executable during bootstrap", error);
  }
};
