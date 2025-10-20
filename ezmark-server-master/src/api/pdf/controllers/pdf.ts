import fs from "fs";
import path from "path";
import type { ExamResponse } from "../../../../types/exam";
import { generateExamPdf } from "../../../utils/pdf-generator";

const trimTrailingSlashes = (value: string) => value.replace(/\/+$/, "");

const firstHeaderValue = (value?: string) => {
  if (!value) {
    return undefined;
  }

  return value
    .split(",")
    .map((segment) => segment.trim())
    .find((segment) => segment.length > 0);
};

const normalizePrefix = (value?: string) => {
  const first = firstHeaderValue(value);

  if (!first) {
    return "";
  }

  const sanitized = first
    .replace(/\s+/g, "")
    .replace(/\/+$/, "")
    .replace(/^\/+/, "");

  if (!sanitized) {
    return "";
  }

  return `/${sanitized}`;
};

const joinUrl = (base: string, pathname: string) => {
  const normalizedBase = trimTrailingSlashes(base);
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;

  if (!normalizedBase) {
    return normalizedPath;
  }

  return `${normalizedBase}${normalizedPath}`;
};

const resolvePublicBaseUrl = (ctx: any): string | undefined => {
  const envCandidate = [
    process.env.PDF_PUBLIC_URL,
    process.env.STRAPI_PDF_PUBLIC_URL,
    process.env.PUBLIC_URL,
    process.env.STRAPI_PUBLIC_URL,
    strapi?.config?.get?.("server.url"),
  ]
    .map((candidate) =>
      typeof candidate === "string" ? candidate.trim() : undefined
    )
    .find((candidate) => candidate);

  if (envCandidate) {
    return trimTrailingSlashes(envCandidate);
  }

  const forwardedProto = firstHeaderValue(ctx.get?.("x-forwarded-proto"));
  const forwardedHost = firstHeaderValue(ctx.get?.("x-forwarded-host"));
  const forwardedPrefix = normalizePrefix(ctx.get?.("x-forwarded-prefix"));

  const proto = forwardedProto || ctx.protocol;
  const host = forwardedHost || ctx.host;

  if (host) {
    const origin = trimTrailingSlashes(`${proto}://${host}`);
    if (forwardedPrefix) {
      return trimTrailingSlashes(`${origin}${forwardedPrefix}`);
    }
    return origin;
  }

  if (forwardedPrefix) {
    return trimTrailingSlashes(forwardedPrefix);
  }

  return undefined;
};

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

    try {
      // 从参数中获取documentId
      const documentId = ctx.params.id;
      const examData = await strapi
        .documents("api::exam.exam")
        .findOne({
          documentId,
        });

      if (!examData) {
        return ctx.notFound("Exam not found");
      }

      const exam = examData as unknown as ExamResponse;

      // 确保目录存在
      const pdfDir = path.resolve("./public/pdf");
      if (!fs.existsSync(pdfDir)) {
        fs.mkdirSync(pdfDir, { recursive: true });
      }

      // 生成 PDF 文件
      const pdfFileName = `Exam-${documentId}.pdf`;
      const pdfPath = path.join(pdfDir, pdfFileName);

      console.log(`开始生成pdf文件 ${documentId}`);
      await generateExamPdf(exam, pdfPath);
      console.log(`pdf生成成功 ${documentId}`);

      // 检查文件是否生成成功
      if (!fs.existsSync(pdfPath)) {
        return ctx.badRequest("PDF generation failed");
      }

      const pdfRelativePath = `/pdf/${pdfFileName}`;
      const publicBaseUrl = resolvePublicBaseUrl(ctx);
      const forwardedPrefix = normalizePrefix(ctx.get?.("x-forwarded-prefix"));

      const pdfUrl = publicBaseUrl
        ? joinUrl(publicBaseUrl, pdfRelativePath)
        : forwardedPrefix
        ? joinUrl(forwardedPrefix, pdfRelativePath)
        : pdfRelativePath;

      // 返回文件URL（相对或绝对路径，由客户端负责处理前缀）
      return ctx.send({
        data: {
          url: pdfUrl,
        },
      });
    } catch (error) {
      strapi.log.error("PDF generation failed", error);
      return ctx.badRequest("PDF generation failed");
    }
  },
};
