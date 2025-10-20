import puppeteer from "puppeteer";
import type { LaunchOptions } from "puppeteer";
import { computeExecutablePath, detectBrowserPlatform, install } from "@puppeteer/browsers";
import fs from "fs";
import path from "path";
import os from "os";

const trimTrailingSlashes = (value: string) => value.replace(/\/+$/, "");

const resolveEnvBaseUrl = () => {
  const candidates = [
    process.env.PDF_RENDER_BASE_URL,
    process.env.RENDER_BASE_URL,
    process.env.FRONTEND_BASE_URL,
    process.env.PUBLIC_FRONTEND_URL,
    process.env.CLIENT_BASE_URL,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return trimTrailingSlashes(candidate.trim());
    }
  }

  return undefined;
};

const resolveRenderBaseUrl = (ctx: any) => {
  const fromEnv = resolveEnvBaseUrl();
  if (fromEnv) {
    return fromEnv;
  }

  const forwardedHost =
    ctx.request?.header?.["x-forwarded-host"] ?? ctx.request?.header?.host;
  const forwardedProto =
    ctx.request?.header?.["x-forwarded-proto"]?.split(",")[0]?.trim();

  if (forwardedHost) {
    const protocol =
      forwardedProto || (ctx.request?.secure ? "https" : "http") || "http";
    return trimTrailingSlashes(`${protocol}://${forwardedHost}`);
  }

  return trimTrailingSlashes(
    process.env.NODE_ENV === "development"
      ? "http://localhost:3000"
      : "http://127.0.0.1"
  );
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

const ensureExecutablePath = async (): Promise<string> => {
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
        process.env.PUPPETEER_CACHE_DIR ||
        path.join(os.homedir(), ".cache", "puppeteer");

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

const resolveLaunchOptions = async (): Promise<LaunchOptions> => {
  const baseOptions: LaunchOptions = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--ignore-certificate-errors",
    ],
  };

  const executablePath = await ensureExecutablePath();
  baseOptions.executablePath = executablePath;

  return baseOptions;
};

const MARGIN_X = 0;
const MARGIN_Y = 0;

export default {
  // 获取PDF列表
  async find(ctx) {
    // 处理列表请求的逻辑
    if (!ctx.params.id) {
      return ctx.send({
        data: {
          message: "DocumentID is required",
        },
      });
    }

    const renderBaseUrl = resolveRenderBaseUrl(ctx);

    try {
      // 从参数中获取documentId
      const documentId = ctx.params.id;
      const URL = `${renderBaseUrl}/render/${documentId}`;
      // 从请求头获取JWT
      const JWT = ctx.request.header.authorization;

      // 确保目录存在
      const pdfDir = path.resolve("./public/pdf");
      if (!fs.existsSync(pdfDir)) {
        fs.mkdirSync(pdfDir, { recursive: true });
      }

      // 使用puppeteer生成pdf
      const pdfFileName = `Exam-${documentId}.pdf`;
      const pdfPath = path.join(pdfDir, pdfFileName);

      console.log(`开始生成pdf文件 ${documentId}，使用地址 ${URL}`);
      let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;

      try {
        const launchOptions = await resolveLaunchOptions();
        browser = await puppeteer.launch(launchOptions);
        console.log(`浏览器启动成功 ${documentId}`);
        const page = await browser.newPage();
        console.log(`页面启动成功 ${documentId}`);

        if (JWT) {
          await page.setExtraHTTPHeaders({
            Authorization: JWT,
          });
        }

        console.log(`开始进入网页 ${URL}`);
        await page.goto(URL, { waitUntil: "networkidle2", timeout: 60000 });
        console.log(`进入网页成功 ${documentId}`);
        await page.pdf({ path: pdfPath, format: "A4" });
        console.log(`pdf生成成功 ${documentId}`);
      } finally {
        if (browser) {
          await browser.close();
          console.log(`浏览器关闭 ${documentId}`);
        }
      }

      // 检查文件是否生成成功
      if (!fs.existsSync(pdfPath)) {
        return ctx.badRequest("PDF generation failed");
      }

      // 返回文件URL（相对路径，由Strapi的静态文件中间件处理）
      return ctx.send({
        data: {
          url: `${
            process.env.NODE_ENV === "development"
              ? "http://localhost:1337"
              : trimTrailingSlashes(
                  process.env.PUBLIC_URL ??
                    process.env.STRAPI_PUBLIC_URL ??
                    "https://47.82.94.221/strapi"
                )
          }/pdf/${pdfFileName}`,
        },
      });
    } catch (error) {
      strapi.log.error("PDF generation failed", error);
      return ctx.badRequest("PDF generation failed");
    }
  },
};
