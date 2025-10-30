import path from "path";
import fs from "fs";
import { randomBytes } from "crypto";
import sharp from "sharp";
import type { Metadata } from "sharp";
import { PDFDocument } from "pdf-lib";
import { Class, ExamSchedule, Paper, Student, User } from "../../types/type";
import { ExamResponse } from "../../types/exam";
import pdf2png from "./pdf2png";
import { ensureScheduleResult, mmToPixels, serialiseScheduleResult } from "./tools";
import { recognizeHeader, LLMRequestError } from "./llm";
import type { Header } from "./schema";

const PADDING = 10;

const createPaperId = () => randomBytes(8).toString("hex");

const MATCH_STAGE = "MATCH";

const normaliseUploadsPath = (rawUrl: string) => {
    if (!rawUrl) {
        return "";
    }

    let url = rawUrl.trim();

    if (!url) {
        return "";
    }

    try {
        const parsed = new URL(url);
        url = parsed.pathname || "";
    } catch (error) {
        // If parsing fails we assume the URL is already relative
    }

    url = url.replace(/^\/+/, "");
    url = url.replace(/^strapi\//, "");

    return url;
};

const logMatchStep = (documentId: string, message: string) => {
    strapi.log.info(`[matching:${documentId}] ${message}`);
};

const isoTimestamp = () => new Date().toISOString();

async function persistScheduleResult(schedule: ExamSchedule) {
    await strapi.documents('api::schedule.schedule').update({
        documentId: schedule.documentId,
        data: {
            result: serialiseScheduleResult(schedule.result),
        },
    });
}

async function markMatchError(
    schedule: ExamSchedule,
    documentId: string,
    message: string,
    error?: unknown,
) {
    const details = error instanceof Error
        ? error.stack || error.message
        : typeof error === "string"
            ? error
            : undefined;

    strapi.log.error(`startMatching(${documentId}): ${message}`, error instanceof Error ? error : undefined);
    schedule.result.error = {
        stage: MATCH_STAGE,
        message,
        details,
        timestamp: isoTimestamp(),
    };
    await persistScheduleResult(schedule);
}

export async function startMatching(documentId: string) {
    let schedule: ExamSchedule | null = null;

    try {
        // 1. 先通过documentId获得schedule
        const scheduleData = await strapi.documents('api::schedule.schedule').findOne({
            documentId,
            populate: ['exam', 'class', 'teacher']
        });

        if (!scheduleData) {
            strapi.log.error(`startMatching(${documentId}): schedule not found`);
            return;
        }

        schedule = scheduleData as unknown as ExamSchedule; // 强制将返回结果转换为ExamSchedule类型
        schedule.result = ensureScheduleResult(schedule.result);

        logMatchStep(documentId, "loaded schedule payload");

        if (schedule.result.progress !== 'MATCH_START') {
            schedule.result.progress = 'MATCH_START';
        }
        schedule.result.error = null;
        await persistScheduleResult(schedule);

        logMatchStep(documentId, "initialised result state");

        // 2. 拿到pdfId (从result属性中获取)
        const pdfUrl = schedule.result.pdfUrl?.trim(); // /uploads/exam_scan_732425fbd9.pdf

        if (!pdfUrl) {
            await markMatchError(schedule, documentId, 'PDF url is missing on the schedule result');
            return;
        }

        // 3. 通过pdfId直接从文件夹中获取pdf文件
        const rootDir = process.cwd();
        const uploadsPath = normaliseUploadsPath(pdfUrl);
        const pdfPath = path.join(rootDir, 'public', uploadsPath);

        logMatchStep(documentId, `resolved PDF url "${pdfUrl}" to ${pdfPath}`);

        // 4. 检查pdf文件是否存在
        if (!fs.existsSync(pdfPath)) {
            await markMatchError(schedule, documentId, `PDF file not found at ${pdfPath}`);
            return;
        }

    logMatchStep(documentId, "loading exam and class metadata");

    // 5. 获得Exam, Class, Teacher数据
    const examData = await strapi.documents('api::exam.exam').findOne({
        documentId: schedule.exam.documentId,
    });
    const classRawData = await strapi.documents('api::class.class').findOne({
        documentId: schedule.class.documentId,
        populate: ['students', 'teacher']
    });
    const teacherData = await strapi.documents('plugin::users-permissions.user').findOne({
        documentId: schedule.teacher.documentId
    });
    const exam = examData as unknown as ExamResponse;
    const classData = classRawData as unknown as Class;
    const teacher = teacherData as unknown as User;


    // 5. 根据Exam的数据分割PDF文件成多份试卷，保存到不同的文件夹
    // 5.1 校验PDF的页数是否等于(学生人数 * 试卷页数)
    const studentCount = classData.students.length;
    const components = Array.isArray(exam.examData?.components) ? exam.examData.components : [];
    const positionedPageIndices = components
        .map((component) => component.position?.pageIndex)
        .filter((pageIndex): pageIndex is number => typeof pageIndex === 'number' && Number.isFinite(pageIndex));

    const pdfBuffer = fs.readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const actualTotalPages = pdfDoc.getPageCount();

    if (studentCount <= 0) {
        await markMatchError(schedule, documentId, 'Unable to determine exam page count because the class has no students.');
        return;
    }

    let pagesPerExam: number | null = null;

    if (positionedPageIndices.length > 0) {
        pagesPerExam = Math.max(...positionedPageIndices) + 1;
    }

    if (!pagesPerExam || actualTotalPages !== studentCount * pagesPerExam) {
        const fallback = actualTotalPages % studentCount === 0
            ? actualTotalPages / studentCount
            : null;

        if (fallback) {
            if (!pagesPerExam) {
                strapi.log.warn(`startMatching(${documentId}): derived pagesPerExam=${fallback} from PDF page count because no component positions were found.`);
            } else {
                strapi.log.warn(`startMatching(${documentId}): overriding pagesPerExam=${pagesPerExam} with ${fallback} because PDF page count (${actualTotalPages}) does not equal studentCount (${studentCount}) * pagesPerExam.`);
            }
            pagesPerExam = fallback;
        }
    }

    if (!pagesPerExam) {
        await markMatchError(schedule, documentId, 'Unable to determine exam page count because no component positions were found and the PDF pages could not be evenly distributed across students.');
        return;
    }

    const totalPages = studentCount * pagesPerExam;
    if (actualTotalPages !== totalPages) {
        const msg = `The number of PDF pages (${actualTotalPages}) does not equal students (${studentCount}) * pagesPerExam (${pagesPerExam}), please check if the PDF file is correct.`;
        await markMatchError(schedule, documentId, msg);
        return;
    }

    logMatchStep(documentId, `detected ${actualTotalPages} pages (${pagesPerExam} per exam for ${studentCount} students)`);

    // 5.2 把PDF转换成图片
    // 创建public/pipeline/{scheduleDocumentId}/all文件夹,保存PDF的所有图片
    const allImagesDir = path.join(rootDir, 'public', 'pipeline', schedule.documentId, 'all');
    if (!fs.existsSync(allImagesDir)) {
        fs.mkdirSync(allImagesDir, { recursive: true });
    }
    logMatchStep(documentId, "converting PDF into page images");
    await pdf2png(pdfPath, allImagesDir);
    logMatchStep(documentId, "PDF conversion complete");

    // 5.3 根据Exam的数据分割PDF文件成多份试卷，保存到不同的文件夹 public/pipeline/{scheduleDocumentId}/{paperId}
    const papers: Paper[] = []; // 保存所有试卷的id, startPage, endPage
    const headerComponent = components.find(com => com.type === "default-header");
    if (!headerComponent) {
        await markMatchError(schedule, documentId, "Unable to locate header component in exam definition.");
        return;
    }
    const headerComponentId = headerComponent.id;
    const headerImagePaths: string[] = [];
    const allImages = fs.readdirSync(allImagesDir).sort((a, b) => {
        const matchA = a.match(/(\d+)/);
        const matchB = b.match(/(\d+)/);
        if (matchA && matchB) {
            return Number(matchA[1]) - Number(matchB[1]);
        }
        return a.localeCompare(b);
    });
    for (let studentIndex = 0; studentIndex < studentCount; studentIndex++) {
        const paperId = createPaperId();
        const paperDir = path.join(rootDir, 'public', 'pipeline', schedule.documentId, paperId);
        if (!fs.existsSync(paperDir)) {
            fs.mkdirSync(paperDir, { recursive: true });
        }
        // 计算页面范围
        const startPage = studentIndex * pagesPerExam;
        const endPage = startPage + pagesPerExam;
        // 根据页面范围，从allImagesDir中获取图片
        const imagesInRange = allImages.slice(startPage, endPage);
        if (imagesInRange.length !== pagesPerExam) {
            await markMatchError(
                schedule,
                documentId,
                `Expected ${pagesPerExam} pages for paper ${paperId} but found ${imagesInRange.length}. Please verify the generated pipeline images.`,
            );
            return;
        }
        // 将图片保存到paperDir中
        imagesInRange.forEach((image, index) => {
            fs.copyFileSync(path.join(allImagesDir, image), path.join(paperDir, `page-${index}.png`));
        });

        // 5.4 更新papers数组,追加一条
        papers.push({ paperId, startPage, endPage, name: '', studentId: '', headerImgUrl: '', studentDocumentId: '' })
        // 5.5 根据Exam的数据，切割题目 public/pipeline/{scheduleDocumentId}/{paperId}/questions
        const questionsDir = path.join(paperDir, 'questions');
        if (!fs.existsSync(questionsDir)) {
            fs.mkdirSync(questionsDir, { recursive: true });
        }

        let firstPageInfo: Metadata | null = null;

        // 循环处理每一页
        for (let pageIndex = 0; pageIndex < pagesPerExam; pageIndex++) {
            const imgPath = path.join(paperDir, `page-${pageIndex}.png`);
            // 加载当前页图片
            const image = sharp(imgPath);
            const imageInfo = await image.metadata();
            if (pageIndex === 0) {
                firstPageInfo = imageInfo;
            }
            // 过滤出当前页面的组件
            const pageComponents = exam.examData.components.filter(com => com.position?.pageIndex === pageIndex);
            console.log(`page-${pageIndex} has ${pageComponents.length} components`)
            // 循环处理每个组件
            for (let compIndex = 0; compIndex < pageComponents.length; compIndex++) {
                const comp = pageComponents[compIndex];
                const rect = comp.position;
                if (!rect) {
                    strapi.log.warn(`startMatching(${documentId}): component ${comp.id} missing position data on page ${pageIndex}`);
                    continue;
                }
                const outputFilePath = path.join(questionsDir, `${comp.id}.png`); // 组件的id作为文件名
                // 将毫米转换为像素
                const left = 0;
                const top = Math.max(mmToPixels(rect.top, imageInfo) - PADDING, 0);
                const width = imageInfo.width!;
                const height = mmToPixels(rect.height, imageInfo) + PADDING * 2;
                // 裁剪图片
                await image.clone().extract({ left, top, width, height }).toFile(outputFilePath);
            }
        }

        const headerImagePath = path.join(questionsDir, `${headerComponentId}.png`);
        if (!fs.existsSync(headerImagePath)) {
            const fallbackSource = path.join(paperDir, 'page-0.png');
            if (!fs.existsSync(fallbackSource)) {
                await markMatchError(schedule, documentId, `Unable to generate header image because ${fallbackSource} is missing.`);
                return;
            }

            try {
                if (!firstPageInfo) {
                    firstPageInfo = await sharp(fallbackSource).metadata();
                }
                const pageWidth = firstPageInfo.width ?? 0;
                const pageHeight = firstPageInfo.height ?? 0;
                const fallbackHeight = Math.max(Math.round(pageHeight * 0.25), 1);

                if (!pageWidth || !pageHeight) {
                    throw new Error(`invalid fallback dimensions (width=${pageWidth}, height=${pageHeight})`);
                }

                await sharp(fallbackSource)
                    .extract({ left: 0, top: 0, width: pageWidth, height: fallbackHeight })
                    .toFile(headerImagePath);

                logMatchStep(documentId, `generated fallback header image at ${headerImagePath}`);
            } catch (fallbackError) {
                await markMatchError(
                    schedule,
                    documentId,
                    `Unable to generate fallback header image for ${headerImagePath}.`,
                    fallbackError,
                );
                return;
            }
        }

        if (!fs.existsSync(headerImagePath)) {
            await markMatchError(schedule, documentId, `Header image was expected at ${headerImagePath} but could not be found even after fallback generation.`);
            return;
        }

        // 把Header添加到数组中
        headerImagePaths.push(headerImagePath)
    }

    // 6. VLM识别姓名和学号
    // 6.1 识别所有header
    console.log(`Start recognizing header... for schedule ${schedule.documentId}`)
    logMatchStep(documentId, `recognising ${headerImagePaths.length} headers with ${process.env.MATCHING_MODEL_NAME ?? "configured model"}`);
    const scheduleId = schedule.documentId;
    const headerResults: Header[] = [];
    const headerFailures: Array<{ index: number; path: string; message: string; details?: string }> = [];

    for (let index = 0; index < headerImagePaths.length; index++) {
        const path = headerImagePaths[index];
        try {
            const header = await recognizeHeader(path, {
                scheduleId,
                headerIndex: index,
                totalHeaders: headerImagePaths.length,
            });
            headerResults.push(header);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown header recognition error';
            const details = error instanceof LLMRequestError ? JSON.stringify(error.meta) : undefined;

            strapi.log.error(
                `startMatching(${documentId}): header recognition failed for ${path}`,
                error instanceof Error ? error : undefined,
            );

            headerFailures.push({ index, path, message, details });

            const placeholder: Header = {
                name: 'Unknown',
                studentId: '',
            };

            headerResults.push(placeholder);

            if (papers[index]) {
                papers[index].headerRecognitionError = {
                    message,
                    details,
                };
            }
        }
    }

    if (headerFailures.length > 0) {
        logMatchStep(
            documentId,
            `header recognition completed with ${headerFailures.length} failure(s); affected papers will remain unmatched until manually resolved`,
        );
    } else {
        logMatchStep(documentId, `header recognition completed for ${headerResults.length} papers`);
    }

    console.log(headerResults)
    console.log(`End recognizing header... for schedule ${schedule.documentId}`)

    // 6.1 更新papers数组,追加name和studentId
    papers.forEach((paper, index) => {
        paper.name = headerResults[index].name;
        paper.studentId = headerResults[index].studentId;
        paper.headerImgUrl = path.join('pipeline', schedule.documentId, paper.paperId, 'questions', `${headerComponentId}.png`)
        if (!paper.name && paper.headerRecognitionError?.message) {
            paper.name = 'Unknown';
        }
    });

    // 7. 和students和papers进行比对和关联
    const students = classData.students;

    // 创建匹配和未匹配记录
    const matchedPairs: { paper: Paper, student: Student }[] = []; // 已经匹配好的对
    const unmatchedPapers: Paper[] = []; // 未匹配到学生的试卷
    const matchedStudentIds = new Set();

    // 精确匹配：遍历试卷查找匹配的学生
    for (const paper of papers) {
        const matchedStudent = students.find(student => student.studentId === paper.studentId);
        if (matchedStudent) {
            // 找到匹配的学生
            matchedPairs.push({
                paper,
                student: matchedStudent
            });
            matchedStudentIds.add(matchedStudent.studentId);
        } else {
            // 未找到匹配的学生
            unmatchedPapers.push(paper);
        }
    }
    // 找出未匹配的学生
    const unmatchedStudents = students.filter(student => !matchedStudentIds.has(student.studentId));
    // 记录匹配和未匹配信息
    logMatchStep(documentId, `matched ${matchedPairs.length} papers, ${unmatchedPapers.length} unmatched papers, ${unmatchedStudents.length} unmatched students`);

    // 8. 更新Schedule的result和papers，添加匹配结果
    const updatedResult = {
        ...schedule.result,
        papers,
        progress: 'MATCH_DONE' as const,
        matchResult: {
            matched: matchedPairs.map(pair => ({
                studentId: pair.student.studentId,
                paperId: pair.paper.paperId,
                headerImgUrl: path.join('pipeline', schedule.documentId, pair.paper.paperId, 'questions', `${headerComponentId}.png`)
            })),
            unmatched: {
                studentIds: unmatchedStudents.map(student => student.studentId),
                papers: unmatchedPapers.map(paper => ({
                    paperId: paper.paperId,
                    headerImgUrl: path.join('pipeline', schedule.documentId, paper.paperId, 'questions', `${headerComponentId}.png`),
                    reason: paper.headerRecognitionError?.message ?? undefined,
                }))
            },
            done: unmatchedPapers.length === 0 && unmatchedStudents.length === 0
        }
    };

    schedule.result = {
        ...updatedResult,
        error: null,
    };

    const requiredMatches = Math.min(2, studentCount);
    if (matchedPairs.length < requiredMatches) {
        const failureSummary = {
            matchedCount: matchedPairs.length,
            requiredMatches,
            studentCount,
            headerFailures: headerFailures.map((failure) => ({
                index: failure.index,
                path: failure.path,
                message: failure.message,
                details: failure.details,
            })),
            unmatchedStudentIds: unmatchedStudents.map((student) => student.studentId),
            unmatchedPaperIds: unmatchedPapers.map((paper) => paper.paperId),
        };

        const failureMessage = `Only ${matchedPairs.length} of ${studentCount} papers matched; at least ${requiredMatches} successful matches are required to continue.`;

        await markMatchError(
            schedule,
            documentId,
            failureMessage,
            new Error(JSON.stringify(failureSummary, null, 2)),
        );

        logMatchStep(
            documentId,
            "matching aborted because the minimum successful match threshold was not met",
        );

        return;
    }

    await persistScheduleResult(schedule);

    logMatchStep(documentId, "matching completed successfully");

        // END: 当前流水线结束，在前端展示结果，前端通过接口开启下一个流水线
    } catch (error) {
        if (schedule) {
            const message = (() => {
                if (error instanceof LLMRequestError) {
                    const meta = error.meta ?? {};
                    const header = typeof meta.header === "string" ? meta.header : undefined;
                    const model = typeof meta.model === "string" ? meta.model : undefined;
                    const parts = [error.message];
                    if (header || model) {
                        const contextParts = [header ? `header ${header}` : null, model ? `via ${model}` : null].filter(Boolean);
                        parts.push(`(${contextParts.join(" ")})`);
                    }
                    return parts.join(" ");
                }
                return error instanceof Error ? error.message : 'Unknown matching error';
            })();

            await markMatchError(
                schedule,
                documentId,
                message,
                error,
            );
        } else {
            strapi.log.error(`startMatching(${documentId}) failed before schedule initialisation`, error);
        }
    }
}
