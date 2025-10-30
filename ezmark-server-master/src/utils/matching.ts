import path from "path";
import fs from "fs";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { Class, ExamSchedule, Paper, Student, User } from "../../types/type";
import { ExamResponse } from "../../types/exam";
import pdf2png from "./pdf2png";
import { ensureScheduleResult, mmToPixels, serialiseScheduleResult } from "./tools";
import { recognizeHeader, LLMRequestError } from "./llm";

const PADDING = 10;

const MATCH_STAGE = "MATCH";

const createPaperId = (index: number) => `student-${index + 1}`;

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

const toPosixPath = (...segments: string[]) => path.posix.join(...segments);

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
    const pipelineDir = path.join(rootDir, 'public', 'pipeline', schedule.documentId);
    if (fs.existsSync(pipelineDir)) {
        fs.rmSync(pipelineDir, { recursive: true, force: true });
    }
    fs.mkdirSync(pipelineDir, { recursive: true });

    logMatchStep(documentId, "converting PDF into page images");
    await pdf2png(pdfPath, pipelineDir);
    logMatchStep(documentId, "PDF conversion complete");

    const pageImages = fs.readdirSync(pipelineDir)
        .filter((file) => /^page-\d+\.png$/i.test(file))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    if (pageImages.length !== actualTotalPages) {
        await markMatchError(schedule, documentId, `Expected ${actualTotalPages} page images but found ${pageImages.length}.`);
        return;
    }

    const papers: Paper[] = [];
    const headerComponent = components.find(com => com.type === "default-header");
    const headerComponentId = headerComponent?.id ?? null;
    const headerTasks: { diskPath: string; paperIndex: number }[] = [];

    for (let studentIndex = 0; studentIndex < studentCount; studentIndex++) {
        const paperId = createPaperId(studentIndex);
        const paperDir = path.join(pipelineDir, paperId);
        fs.mkdirSync(paperDir, { recursive: true });

        const startPage = studentIndex * pagesPerExam;
        const endPage = startPage + pagesPerExam;

        for (let pageOffset = 0; pageOffset < pagesPerExam; pageOffset++) {
            const globalPageIndex = startPage + pageOffset;
            const pageFileName = pageImages[globalPageIndex];
            if (!pageFileName) {
                await markMatchError(schedule, documentId, `Missing page image for index ${globalPageIndex}.`);
                return;
            }

            const sourceImagePath = path.join(pipelineDir, pageFileName);
            const targetImagePath = path.join(paperDir, `page-${pageOffset}.png`);
            fs.copyFileSync(sourceImagePath, targetImagePath);
        }

        const questionsDir = path.join(paperDir, 'questions');
        fs.mkdirSync(questionsDir, { recursive: true });

        const questionImageMap: Record<string, string> = {};
        let headerDiskPath: string | null = null;
        let headerRelativePath: string | null = null;

        for (let pageOffset = 0; pageOffset < pagesPerExam; pageOffset++) {
            const imgPath = path.join(paperDir, `page-${pageOffset}.png`);
            const image = sharp(imgPath);
            const imageInfo = await image.metadata();

            const pageComponents = components
                .filter(com => com.position?.pageIndex === pageOffset)
                .sort((a, b) => {
                    const posA = a.position ?? { top: 0, left: 0 };
                    const posB = b.position ?? { top: 0, left: 0 };
                    if (posA.top !== posB.top) {
                        return posA.top - posB.top;
                    }
                    return posA.left - posB.left;
                });

            for (let compIndex = 0; compIndex < pageComponents.length; compIndex++) {
                const comp = pageComponents[compIndex];
                const rect = comp.position;

                if (!rect || !imageInfo.width || !imageInfo.height) {
                    continue;
                }

                const widthMm = Number(rect.width);
                const heightMm = Number(rect.height);
                if (!Number.isFinite(widthMm) || !Number.isFinite(heightMm) || widthMm <= 0 || heightMm <= 0) {
                    continue;
                }

                const leftMm = Number(rect.left ?? 0);
                const topMm = Number(rect.top ?? 0);

                const left = Math.max(mmToPixels(leftMm, imageInfo, "x") - PADDING, 0);
                const top = Math.max(mmToPixels(topMm, imageInfo, "y") - PADDING, 0);
                const widthPx = mmToPixels(widthMm, imageInfo, "x") + PADDING * 2;
                const heightPx = mmToPixels(heightMm, imageInfo, "y") + PADDING * 2;

                const maxWidth = imageInfo.width ?? 0;
                const maxHeight = imageInfo.height ?? 0;
                const extractWidth = Math.min(widthPx, Math.max(maxWidth - left, 0));
                const extractHeight = Math.min(heightPx, Math.max(maxHeight - top, 0));

                if (extractWidth <= 0 || extractHeight <= 0) {
                    continue;
                }

                const outputFileName = `page${pageOffset}_${compIndex}.png`;
                const outputFilePath = path.join(questionsDir, outputFileName);

                await image.clone().extract({
                    left,
                    top,
                    width: extractWidth,
                    height: extractHeight,
                }).toFile(outputFilePath);

                const relativePath = toPosixPath('pipeline', schedule.documentId, paperId, 'questions', outputFileName);
                questionImageMap[comp.id] = relativePath;

                if (comp.id === headerComponentId) {
                    headerDiskPath = outputFilePath;
                    headerRelativePath = relativePath;
                }
            }
        }

        if (!headerDiskPath || !headerRelativePath) {
            const fallbackHeaderPath = path.join(paperDir, 'page-0.png');
            if (!fs.existsSync(fallbackHeaderPath)) {
                await markMatchError(schedule, documentId, 'Unable to locate header image for one of the papers. Please ensure the exam definition contains a header component with valid positioning data.');
                return;
            }

            headerDiskPath = fallbackHeaderPath;
            headerRelativePath = toPosixPath('pipeline', schedule.documentId, paperId, 'page-0.png');

            if (!headerComponentId) {
                strapi.log.warn(`startMatching(${documentId}): header component missing from exam definition, defaulting to full first page for header recognition.`);
            } else {
                strapi.log.warn(`startMatching(${documentId}): header crop missing on disk for component ${headerComponentId}, defaulting to full first page.`);
            }
        }

        const paperIndex = papers.length;
        headerTasks.push({ diskPath: headerDiskPath, paperIndex });

        papers.push({
            paperId,
            startPage,
            endPage,
            name: '',
            studentId: '',
            headerImgUrl: headerRelativePath,
            studentDocumentId: '',
            questionImageMap,
        });
    }

    // 6. VLM识别姓名和学号
    // 6.1 识别所有header
    console.log(`Start recognizing header... for schedule ${schedule.documentId}`)
    logMatchStep(documentId, `recognising ${headerTasks.length} headers with ${process.env.MATCHING_MODEL_NAME ?? "configured model"}`);
    const scheduleId = schedule.documentId;
    const headerResults = await Promise.all(headerTasks.map(async ({ diskPath, paperIndex }, index) => {
        try {
            const header = await recognizeHeader(diskPath, {
                scheduleId,
                headerIndex: index,
                totalHeaders: headerTasks.length,
            });
            return { header, paperIndex };
        } catch (error) {
            strapi.log.error(`startMatching(${documentId}): header recognition failed for ${diskPath}`, error instanceof Error ? error : undefined);
            throw error;
        }
    }));
    logMatchStep(documentId, `header recognition completed for ${headerResults.length} papers`);
    console.log(headerResults)
    console.log(`End recognizing header... for schedule ${schedule.documentId}`)

    // 6.1 更新papers数组,追加name和studentId
    headerResults.forEach(({ header, paperIndex }) => {
        const paper = papers[paperIndex];
        paper.name = header.name;
        paper.studentId = header.studentId;
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
                headerImgUrl: pair.paper.headerImgUrl,
            })),
            unmatched: {
                studentIds: unmatchedStudents.map(student => student.studentId),
                papers: unmatchedPapers.map(paper => ({
                    paperId: paper.paperId,
                    headerImgUrl: paper.headerImgUrl,
                }))
            },
            done: unmatchedPapers.length === 0 && unmatchedStudents.length === 0
        }
    };

        schedule.result = {
            ...updatedResult,
            error: null,
        };

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
