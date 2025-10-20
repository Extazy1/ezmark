import fs from "fs";
import path from "path";
import type { ExamResponse } from "../../../../types/exam";
import { generateExamPdf } from "../../../utils/pdf-generator";

const trimTrailingSlashes = (value: string) => value.replace(/\/+$/, "");

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
