import puppeteer from "puppeteer";
import type { LaunchOptions } from "puppeteer";
import { computeExecutablePath, detectBrowserPlatform, install } from "@puppeteer/browsers";
import fs from "fs";
import os from "os";
import path from "path";

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

export const resolvePdfLaunchOptions = async (): Promise<LaunchOptions> => {
  const baseOptions: LaunchOptions = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--ignore-certificate-errors",
    ],
  };

  const executablePath = await ensureChromeExecutable();
  baseOptions.executablePath = executablePath;

  return baseOptions;
};

export const warmupChrome = async () => {
  const start = Date.now();
  try {
    const executable = await ensureChromeExecutable();
    const duration = Date.now() - start;
    strapi.log.info(
      `Chrome executable ready for PDF exports at ${executable} (prepared in ${duration}ms)`
    );
  } catch (error) {
    strapi.log.error("Failed to prepare Chrome executable during bootstrap", error);
  }
};
