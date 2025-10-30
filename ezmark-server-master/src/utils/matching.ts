import path from "path";
import fs from "fs";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { Class, ExamSchedule, Paper, Student, User } from "../../types/type";
import { ExamResponse } from "../../types/exam";
import pdf2png from "./pdf2png";
import { mmToPixels } from "./tools";
import { recognizeHeader } from "./llm";

const PADDING = 10;

function ensureScheduleResultObject(schedule: ExamSchedule): any {
    if (typeof schedule.result === "string") {
        try {
            return JSON.parse(schedule.result);
        } catch (error) {
            strapi.log.error(`startMatching(${schedule.documentId}): failed to parse schedule result JSON`, error as Error);
            return {};
        }
    }
    if (!schedule.result || typeof schedule.result !== "object") {
        schedule.result = {} as any;
    }
    return schedule.result;
}

function toPosix(...segments: string[]): string {
    return path.posix.join(...segments);
}

export async function startMatching(documentId: string) {
    const { nanoid } = await import("nanoid");
    // 1. 先通过documentId获得schedule
    const scheduleData = await strapi.documents('api::schedule.schedule').findOne({
        documentId,
        populate: ['exam', 'class', 'teacher']
    });

    if (!scheduleData) {
        strapi.log.error(`startMatching(${documentId}): schedule not found`);
        return;
    }

    const schedule = scheduleData as unknown as ExamSchedule; // 强制将返回结果转换为ExamSchedule类型
    const scheduleResult = ensureScheduleResultObject(schedule);
    strapi.log.info(`[matching:${documentId}] Step 1: schedule metadata loaded`);

    // 2. 拿到pdfId (从result属性中获取)
    const pdfUrl = scheduleResult.pdfUrl as string | undefined; // /uploads/exam_scan_732425fbd9.pdf

    if (!pdfUrl) {
        strapi.log.error(`startMatching(${documentId}): PDF url missing on schedule result`);
        return;
    }

    // 3. 通过pdfId直接从文件夹中获取pdf文件
    const rootDir = process.cwd();
    const pdfPath = path.join(rootDir, 'public', pdfUrl.replace(/^\/+/, ''));

    // 4. 检查pdf文件是否存在
    if (!fs.existsSync(pdfPath)) {
        strapi.log.error(`startMatching(${documentId}): PDF file not found at ${pdfPath}`);
        return;
    }
    strapi.log.info(`[matching:${documentId}] Step 2: PDF located at ${pdfPath}`);

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

    if (!examData || !classRawData || !teacherData) {
        strapi.log.error(`startMatching(${documentId}): failed to load exam/class/teacher metadata`);
        return;
    }

    const exam = examData as unknown as ExamResponse;
    const classData = classRawData as unknown as Class;
    const teacher = teacherData as unknown as User;

    void teacher; // 目前未使用，避免编译警告
    strapi.log.info(`[matching:${documentId}] Step 3: exam, class, and teacher data loaded`);

    // 5. 根据Exam的数据分割PDF文件成多份试卷，保存到不同的文件夹
    // 5.1 校验PDF的页数是否等于(学生人数 * 试卷页数)
    const studentCount = classData.students.length;
    if (studentCount === 0) {
        strapi.log.error(`startMatching(${documentId}): class has no students`);
        return;
    }

    const components = Array.isArray(exam.examData?.components) ? exam.examData.components : [];
    const lastComponent = components[components.length - 1];
    if (!lastComponent || !lastComponent.position) {
        strapi.log.error(`startMatching(${documentId}): exam definition missing component positioning data`);
        return;
    }

    const pagesPerExam = (lastComponent.position.pageIndex ?? 0) + 1;
    const totalPages = studentCount * pagesPerExam;
    const pdfBuffer = fs.readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const actualTotalPages = pdfDoc.getPageCount();
    if (actualTotalPages !== totalPages) {
        const msg = `The number of PDF pages does not equal (number of students * number of exam pages), please check if the PDF file is correct`;
        strapi.log.error(`startMatching(${documentId}): ${msg}`);
        return;
    }
    strapi.log.info(`[matching:${documentId}] Step 4: validated PDF page count (${actualTotalPages} pages)`);

    // 5.2 把PDF转换成图片
    // 创建public/pipeline/{scheduleDocumentId}/all文件夹,保存PDF的所有图片
    const allImagesDir = path.join(rootDir, 'public', 'pipeline', schedule.documentId, 'all');
    if (!fs.existsSync(allImagesDir)) {
        fs.mkdirSync(allImagesDir, { recursive: true });
    }
    await pdf2png(pdfPath, allImagesDir);
    strapi.log.info(`[matching:${documentId}] Step 5: converted PDF pages to images in ${allImagesDir}`);

    // 5.3 根据Exam的数据分割PDF文件成多份试卷，保存到不同的文件夹 public/pipeline/{scheduleDocumentId}/{paperId}
    const papers: Paper[] = []; // 保存所有试卷的id, startPage, endPage
    const headerComponent = components.find(com => com.type === 'default-header');

    if (!headerComponent) {
        strapi.log.error(`startMatching(${documentId}): exam definition missing default-header component`);
        return;
    }

    const headerComponentId = headerComponent.id;
    const headerImagePaths: string[] = [];
    const allImages = fs.readdirSync(allImagesDir).filter(name => name.endsWith('.png')).sort((a, b) => a.localeCompare(b));

    for (let i = 0; i < studentCount; i++) {
        const paperId = nanoid();
        const paperDir = path.join(rootDir, 'public', 'pipeline', schedule.documentId, paperId);
        if (!fs.existsSync(paperDir)) {
            fs.mkdirSync(paperDir, { recursive: true });
        }
        // 计算页面范围
        const startPage = i * pagesPerExam;
        const endPage = startPage + pagesPerExam;
        // 根据页面范围，从allImagesDir中获取图片
        const imagesInRange = allImages.slice(startPage, endPage);
        // 将图片保存到paperDir中
        imagesInRange.forEach((image, index) => {
            fs.copyFileSync(path.join(allImagesDir, image), path.join(paperDir, `page-${index}.png`));
        });

        // 5.4 更新papers数组,追加一条
        papers.push({
            paperId,
            startPage,
            endPage,
            name: '',
            studentId: '',
            headerImgUrl: '',
            studentDocumentId: '',
            questionImageMap: {}
        });
        // 5.5 根据Exam的数据，切割题目 public/pipeline/{scheduleDocumentId}/{paperId}/questions
        const questionsDir = path.join(paperDir, 'questions');
        if (!fs.existsSync(questionsDir)) {
            fs.mkdirSync(questionsDir, { recursive: true });
        }

        // 循环处理每一页
        for (let pageIndex = 0; pageIndex < pagesPerExam; pageIndex++) {
            const imgPath = path.join(paperDir, `page-${pageIndex}.png`);
            if (!fs.existsSync(imgPath)) {
                continue;
            }
            // 加载当前页图片
            const image = sharp(imgPath);
            const imageInfo = await image.metadata();
            if (!imageInfo.width || !imageInfo.height) {
                continue;
            }
            // 过滤出当前页面的组件
            const pageComponents = components.filter(com => com.position?.pageIndex === pageIndex);
            // 循环处理每个组件
            for (const comp of pageComponents) {
                const rect = comp.position;
                if (!rect) {
                    continue;
                }
                const outputFilePath = path.join(questionsDir, `${comp.id}.png`); // 组件的id作为文件名
                // 将毫米转换为像素
                const top = Math.max(mmToPixels(rect.top ?? 0, imageInfo, "y") - PADDING, 0);
                const height = Math.max(mmToPixels(rect.height ?? 0, imageInfo, "y") + PADDING * 2, 1);
                const width = imageInfo.width;
                const left = 0;
                // 裁剪图片
                await image.clone().extract({ left, top, width, height }).toFile(outputFilePath);
            }
        }

        // 把Header添加到数组中
        headerImagePaths.push(path.join(paperDir, 'questions', `${headerComponentId}.png`));
    }
    strapi.log.info(`[matching:${documentId}] Step 6: generated ${papers.length} paper folders with cropped component images`);

    // 6. VLM识别姓名和学号
    // 6.1 识别所有header
    strapi.log.info(`Start recognizing header... for schedule ${schedule.documentId}`);
    const headerResults = await Promise.all(headerImagePaths.map(async (headerPath) => {
        return recognizeHeader(headerPath);
    }));
    strapi.log.info(headerResults as any);
    strapi.log.info(`End recognizing header... for schedule ${schedule.documentId}`);
    strapi.log.info(`[matching:${documentId}] Step 7: header recognition completed`);

    // 6.1 更新papers数组,追加name和studentId
    papers.forEach((paper, index) => {
        paper.name = headerResults[index]?.name || '';
        paper.studentId = headerResults[index]?.studentId || '';
        paper.headerImgUrl = toPosix('pipeline', schedule.documentId, paper.paperId, 'questions', `${headerComponentId}.png`);
    });

    // 7. 和students和papers进行比对和关联
    const students = classData.students;

    // 创建匹配和未匹配记录
    const matchedPairs: { paper: Paper, student: Student }[] = []; // 已经匹配好的对
    const unmatchedPapers: Paper[] = []; // 未匹配到学生的试卷
    const matchedStudentIds = new Set<string>();

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
    strapi.log.info(`匹配成功: ${matchedPairs.length} 份试卷`);
    strapi.log.info(`未匹配试卷: ${unmatchedPapers.length} 份`);
    strapi.log.info(`未匹配学生: ${unmatchedStudents.length} 名`);
    strapi.log.info(`[matching:${documentId}] Step 8: matching comparison complete`);

    const updatedResult = {
        ...scheduleResult,
        papers,
        progress: 'MATCH_DONE',
        matchResult: {
            matched: matchedPairs.map(pair => ({
                studentId: pair.student.studentId,
                paperId: pair.paper.paperId,
                headerImgUrl: toPosix('pipeline', schedule.documentId, pair.paper.paperId, 'questions', `${headerComponentId}.png`)
            })),
            unmatched: {
                studentIds: unmatchedStudents.map(student => student.studentId),
                papers: unmatchedPapers.map(paper => ({
                    paperId: paper.paperId,
                    headerImgUrl: toPosix('pipeline', schedule.documentId, paper.paperId, 'questions', `${headerComponentId}.png`)
                }))
            },
            done: unmatchedPapers.length === 0 && unmatchedStudents.length === 0
        }
    };

    // 8. 更新Schedule的result和papers，添加匹配结果
    await strapi.documents('api::schedule.schedule').update({
        documentId: schedule.documentId,
        data: {
            result: JSON.stringify(updatedResult)
        }
    });
    strapi.log.info(`[matching:${documentId}] Step 9: schedule result updated`);

    // END: 当前流水线结束，在前端展示结果，前端通过接口开启下一个流水线
}
