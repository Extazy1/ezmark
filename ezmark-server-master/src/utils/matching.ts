import path from "path";
import { Class, ExamSchedule, Paper, Student, User } from "../../types/type";
import fs from 'fs';
import { ExamResponse } from "../../types/exam";
import { PDFDocument } from "pdf-lib";
import pdf2png from "./pdf2png";
import sharp from "sharp";
import { ensureScheduleResult, mmToPixels, serialiseScheduleResult } from "./tools";
import { recognizeHeader } from "./llm";

const PADDING = 10;

// 启动一个异步任务，专门处理流水线
let nanoidGenerator: (() => string) | null = null;

async function getNanoid() {
    if (!nanoidGenerator) {
        const { nanoid } = await import('nanoid');
        nanoidGenerator = nanoid;
    }
    return nanoidGenerator;
}

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
        if (positionedPageIndices.length === 0) {
            await markMatchError(schedule, documentId, 'Unable to determine exam page count because no component positions were found.');
            return;
        }
    const pagesPerExam = Math.max(...positionedPageIndices) + 1;
    const totalPages = studentCount * pagesPerExam;
    const pdfBuffer = fs.readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const actualTotalPages = pdfDoc.getPageCount();
        if (actualTotalPages !== totalPages) {
            const msg = `The number of PDF pages does not equal (number of students * number of exam pages), please check if the PDF file is correct`;
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
    const papers: Paper[] = [] // 保存所有试卷的id, startPage, endPage
        const headerComponent = components.find(com => com.type === 'default-header');
        if (!headerComponent) {
            await markMatchError(schedule, documentId, 'Unable to locate header component in exam definition.');
            return;
        }
    const headerComponentId = headerComponent.id;
    const headerImagePaths = []
    const nanoid = await getNanoid();
    for (let i = 0; i < studentCount; i++) {
        const paperId = nanoid()
        const paperDir = path.join(rootDir, 'public', 'pipeline', schedule.documentId, paperId);
        if (!fs.existsSync(paperDir)) {
            fs.mkdirSync(paperDir, { recursive: true });
        }
        // 计算页面范围
        const startPage = i * pagesPerExam;
        const endPage = startPage + pagesPerExam;
        // 根据页面范围，从allImagesDir中获取图片
        const images = fs.readdirSync(allImagesDir);
        const imagesInRange = images.slice(startPage, endPage);
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

        // 循环处理每一页
        for (let i = 0; i < pagesPerExam; i++) {
            const imgPath = path.join(paperDir, `page-${i}.png`);
            // 加载当前页图片
            const image = sharp(imgPath);
            const imageInfo = await image.metadata();
            // 过滤出当前页面的组件
            const pageComponents = exam.examData.components.filter(com => com.position?.pageIndex === i);
            console.log(`page-${i} has ${pageComponents.length} components`)
            // 循环处理每个组件
            for (let compIndex = 0; compIndex < pageComponents.length; compIndex++) {
                const comp = pageComponents[compIndex];
                const rect = comp.position;
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

        // 把Header添加到数组中
        headerImagePaths.push(path.join(questionsDir, `${headerComponentId}.png`))
    }

    // 6. VLM识别姓名和学号
    // 6.1 识别所有header
    console.log(`Start recognizing header... for schedule ${schedule.documentId}`)
    logMatchStep(documentId, `recognising ${headerImagePaths.length} headers with ${process.env.MATCHING_MODEL_NAME ?? "configured model"}`);
    const headerResults = await Promise.all(headerImagePaths.map(async (path) => {
        try {
            const header = await recognizeHeader(path);
            return header;
        } catch (error) {
            strapi.log.error(`startMatching(${documentId}): header recognition failed for ${path}`, error instanceof Error ? error : undefined);
            throw error;
        }
    }));
    console.log(headerResults)
    console.log(`End recognizing header... for schedule ${schedule.documentId}`)

    // 6.1 更新papers数组,追加name和studentId
    papers.forEach((paper, index) => {
        paper.name = headerResults[index].name;
        paper.studentId = headerResults[index].studentId;
        paper.headerImgUrl = path.join('pipeline', schedule.documentId, paper.paperId, 'questions', `${headerComponentId}.png`)
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
                    headerImgUrl: path.join('pipeline', schedule.documentId, paper.paperId, 'questions', `${headerComponentId}.png`)
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
            await markMatchError(
                schedule,
                documentId,
                error instanceof Error ? error.message : 'Unknown matching error',
                error,
            );
        } else {
            strapi.log.error(`startMatching(${documentId}) failed before schedule initialisation`, error);
        }
    }
}
