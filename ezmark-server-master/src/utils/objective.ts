import fs from "fs";
import path from "path";
import sharp from "sharp";
import type { Metadata } from "sharp";
import { Exam, MultipleChoiceQuestionData, QuestionType, UnionComponent } from "../../types/exam";
import { ExamSchedule } from "../../types/type";
import { recognizeMCQ } from "./llm";
import {
    QUESTION_CROP_PADDING,
    computeNextComponentTopMap,
    ensureScheduleResult,
    getComponentCropBox,
    serialiseScheduleResult,
    toFiniteNumber,
} from "./tools";

const joinPipelineUrl = (...segments: string[]) => path.posix.join(...segments);

type QuestionPosition = UnionComponent["position"];

async function ensureQuestionImage(options: {
    publicDir: string;
    scheduleId: string;
    paperId: string;
    questionId: string;
    position?: QuestionPosition;
    nextTopMm?: number | null;
}) {
    const { publicDir, scheduleId, paperId, questionId, position, nextTopMm } = options;
    const questionDir = path.join(publicDir, 'pipeline', scheduleId, paperId, 'questions');
    const questionPath = path.join(questionDir, `${questionId}.png`);

    if (fs.existsSync(questionPath)) {
        return questionPath;
    }

    const pageIndex = toFiniteNumber(position?.pageIndex) ?? 0;
    const pagePath = path.join(publicDir, 'pipeline', scheduleId, paperId, `page-${pageIndex}.png`);

    if (!fs.existsSync(pagePath)) {
        strapi.log.warn(`startObjective(${scheduleId}): page image missing for paper ${paperId}, expected ${pagePath}`);
        return null;
    }

    try {
        fs.mkdirSync(questionDir, { recursive: true });
    } catch (dirError) {
        strapi.log.error(`startObjective(${scheduleId}): failed to prepare question directory ${questionDir}`, dirError);
        return null;
    }

    try {
        const pageImage = sharp(pagePath);
        const metadata: Metadata = await pageImage.metadata();
        const width = metadata.width ?? 0;
        const height = metadata.height ?? 0;

        if (!width || !height) {
            strapi.log.warn(`startObjective(${scheduleId}): invalid metadata for page ${pagePath} (width=${width}, height=${height})`);
            return null;
        }

        const output = pageImage.clone();

        const cropBox = position
            ? getComponentCropBox({
                position,
                metadata,
                nextTopMm,
                padding: QUESTION_CROP_PADDING,
            })
            : null;

        if (cropBox) {
            await output.extract(cropBox).toFile(questionPath);
            strapi.log.info(`startObjective(${scheduleId}): regenerated missing question ${questionId} for paper ${paperId} on page ${pageIndex}`);
        } else {
            await output.toFile(questionPath);
            strapi.log.warn(`startObjective(${scheduleId}): regenerated question ${questionId} for paper ${paperId} using full page ${pageIndex} due to missing position data`);
        }

        return questionPath;
    } catch (error) {
        strapi.log.error(`startObjective(${scheduleId}): failed to regenerate question ${questionId} for paper ${paperId}`, error);
        return null;
    }
}

export async function startObjective(documentId: string) {
    // 1. 先通过documentId获得schedule
    const scheduleData = await strapi.documents('api::schedule.schedule').findOne({
        documentId,
        populate: ['exam', 'class', 'teacher']
    });
    const schedule = scheduleData as unknown as ExamSchedule; //
    schedule.result = ensureScheduleResult(schedule.result);

    // 2. 遍历每一个paper，补充学生documentId和name
    schedule.result.papers = await Promise.all(schedule.result.papers.map(async (paper) => {
        const student = await strapi.documents('api::student.student').findFirst({
            filters: {
                studentId: {
                    $eq: paper.studentId,
                }
            },
        });
        paper.studentDocumentId = student?.documentId;
        paper.name = student?.name;
        return paper;
    }));

    // 3. 遍历每一个paper，创建studentPaper
    schedule.result.studentPapers = schedule.result.papers.map((paper) => {
        return {
            student: {
                name: paper.name,
                studentId: paper.studentId,
                documentId: paper.studentDocumentId,
                publishedAt: '',
            },
            paperId: paper.paperId,
            objectiveQuestions: [],
            subjectiveQuestions: [],
            totalScore: 0,
        }
    })

    // 4. 更新schema到数据库
    await strapi.documents('api::schedule.schedule').update({
        documentId,
        data: {
            result: serialiseScheduleResult(schedule.result),
        },
    });

    // 下面的工作都会在schedule.result.studentPapers中进行

    // 目前只有MCQ是客观题
    const OBJECTIVE_TYPES: QuestionType[] = ['multiple-choice']

    // 5. 收集所有的客观题
    const examData = schedule.exam.examData as Exam;
    const allComponents: UnionComponent[] = Array.isArray(examData.components)
        ? examData.components
        : [];
    const objectiveQuestions = allComponents.filter((question) =>
        OBJECTIVE_TYPES.includes(question.type as QuestionType),
    );

    const nextComponentTopMap = computeNextComponentTopMap(allComponents);

    // 6. 一次性发送所有学生的所有客观题答案图片的请求
    const rootDir = process.cwd();
    const publicDir = path.join(rootDir, 'public');

    // 6.1 收集所有学生的所有答案图片
    type StudentAnswerTask = {
        studentId: string;
        paperId: string;
        questionId: string;
        answerImage: string;
        position?: QuestionPosition;
        nextTopMm?: number | null;
    };

    const allStudentAnswers: StudentAnswerTask[] = [];
    for (const question of objectiveQuestions) {
        const questionId = question.id;
        schedule.result.papers.forEach((paper) => {
            allStudentAnswers.push({
                studentId: paper.studentId,
                paperId: paper.paperId,
                questionId: questionId,
                answerImage: joinPipelineUrl('pipeline', schedule.documentId, paper.paperId, 'questions', `${questionId}.png`),
                position: question.position,
                nextTopMm: nextComponentTopMap.get(question.id) ?? null,
            });
        });
    }

    // 6.2 一次性发送所有请求
    console.log(`LLM starts to process all MCQ answers, there are ${allStudentAnswers.length} answers`);
    const allLlmResults = await Promise.all(allStudentAnswers.map(async (studentAnswer) => {
        const ensuredPath = await ensureQuestionImage({
            publicDir,
            scheduleId: schedule.documentId,
            paperId: studentAnswer.paperId,
            questionId: studentAnswer.questionId,
            position: studentAnswer.position,
            nextTopMm: studentAnswer.nextTopMm,
        });

        if (!ensuredPath) {
            strapi.log.error(`startObjective(${schedule.documentId}): missing answer image for question ${studentAnswer.questionId} on paper ${studentAnswer.paperId}`);
            return {
                ...studentAnswer,
                result: { answer: ['Unknown'] },
            };
        }

        try {
            const answer = await recognizeMCQ(ensuredPath);
            return {
                ...studentAnswer,
                result: answer
            };
        } catch (error) {
            strapi.log.error(`startObjective(${schedule.documentId}): LLM recognition failed for question ${studentAnswer.questionId} on paper ${studentAnswer.paperId}`, error);
            return {
                ...studentAnswer,
                result: { answer: ['Unknown'] },
            };
        }
    }));
    console.log(`All LLM requests have been processed`);

    // 6.3 把allLlmResults添加到studentPapers中
    for (const result of allLlmResults) {
        const studentPaperIndex = schedule.result.studentPapers.findIndex(
            paper => paper.paperId === result.paperId
        );
        if (studentPaperIndex !== -1) {
            const studentPaper = schedule.result.studentPapers[studentPaperIndex];
            studentPaper.objectiveQuestions.push({
                questionId: result.questionId,
                studentAnswer: result.result.answer,
                llmUnknown: result.result.answer.length === 0 || result.result.answer.includes('Unknown'),
                score: -1, // 客观题的分数最后再计算
                imageUrl: result.answerImage,
            });
        }
    }

    // 7. 计算客观题的分数
    // 遍历所有客观题目
    for (const question of objectiveQuestions) {
        const questionData = question as MultipleChoiceQuestionData;
        const questionId = questionData.id;
        const questionAnswer = questionData.answer;
        // 遍历所有学生试卷中的客观题
        for (const studentPaper of schedule.result.studentPapers) {
            const studentAnswer = studentPaper.objectiveQuestions.find((answer) => answer.questionId === questionId);
            if (studentAnswer.llmUnknown) continue // LLM识别失败，跳过不计算
            // 比较学生答案和标准答案数组,如果完全匹配(顺序可以不一样)，则得分，否则0分
            if (studentAnswer.studentAnswer.sort().join(',') === questionAnswer.sort().join(',')) {
                studentAnswer.score = questionData.score;
            } else {
                studentAnswer.score = 0;
            }
        }
    }

    // 8. 更新schema到数据库
    schedule.result.progress = 'OBJECTIVE_DONE'; // 更新进度
    await strapi.documents('api::schedule.schedule').update({
        documentId,
        data: {
            result: serialiseScheduleResult(schedule.result),
        },
    });

    // 客观题流水线结束
    console.log('OBJECTIVE DONE')
}