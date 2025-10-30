import "dotenv/config";
import OpenAI from "openai";
import { HEADER_PROMPT, MCQ_PROMPT, SUBJECTIVE_PROMPT } from "./prompt";
import { zodResponseFormat } from "openai/helpers/zod";
import { Header, HeaderSchema, MCQResult, MCQSchema, SubjectiveInput, SubjectiveResult, SubjectiveSchema } from "./schema";
import { imageToBase64 } from "./tools";

export class LLMRequestError extends Error {
    public readonly meta: Record<string, unknown>;

    constructor(message: string, meta: Record<string, unknown> = {}, cause?: unknown) {
        super(message);
        this.name = "LLMRequestError";
        this.meta = meta;
        if (cause !== undefined) {
            (this as unknown as { cause?: unknown }).cause = cause;
        }
    }
}

const llmLogger = {
    info(message: string, meta?: Record<string, unknown>) {
        if (typeof strapi !== "undefined" && strapi?.log) {
            strapi.log.info(meta ? `${message} ${JSON.stringify(meta)}` : message);
        } else {
            console.info(message, meta ?? "");
        }
    },
    error(message: string, error?: unknown, meta?: Record<string, unknown>) {
        if (typeof strapi !== "undefined" && strapi?.log) {
            strapi.log.error(meta ? `${message} ${JSON.stringify(meta)}` : message, error instanceof Error ? error : undefined);
        } else {
            console.error(message, meta ?? "", error);
        }
    }
};

type RecognizeHeaderOptions = {
    scheduleId?: string;
    headerIndex?: number;
    totalHeaders?: number;
};

function getRequiredEnvVar(key: string): string {
    const value = process.env[key]?.trim();
    if (!value) {
        throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
}

const optionalEnv = (key: string): string | undefined => process.env[key]?.trim() || undefined;

let gptClient: OpenAI | null = null;
let qwenClient: OpenAI | null = null;

function getGptClient(): OpenAI {
    if (!gptClient) {
        gptClient = new OpenAI({
            apiKey: getRequiredEnvVar("OPENAI_API_KEY"),
            baseURL: optionalEnv("OPENAI_BASE_URL"),
        });
    }
    return gptClient;
}

function getQwenClient(): OpenAI {
    if (!qwenClient) {
        qwenClient = new OpenAI({
            apiKey: getRequiredEnvVar("QWEN_API_KEY"),
            baseURL: optionalEnv("QWEN_BASE_URL"),
        });
    }
    return qwenClient;
}

export async function recognizeHeader(imagePath: string, options: RecognizeHeaderOptions = {}): Promise<Header> {
    const model = process.env.MATCHING_MODEL_NAME;
    const label = typeof options.headerIndex === "number" && typeof options.totalHeaders === "number"
        ? `${options.headerIndex + 1}/${options.totalHeaders}`
        : `${(options.headerIndex ?? 0) + 1}`;

    llmLogger.info("[llm] sending header image for recognition", {
        scheduleId: options.scheduleId,
        imagePath,
        model,
        header: label,
    });

    try {
        const response = await getGptClient().chat.completions.create({
            model,
            messages: [{
                role: "user",
                content: [
                    {
                        type: "image_url",
                        image_url: {
                            url: `data:image/png;base64,${imageToBase64(imagePath)}`,
                        },
                    },
                    {
                        type: "text",
                        text: HEADER_PROMPT,
                    },
                ]
            }],
            response_format: zodResponseFormat(HeaderSchema, 'header')
        });

        const content = response.choices[0].message.content;
        llmLogger.info("[llm] header recognition succeeded", {
            scheduleId: options.scheduleId,
            header: label,
        });

        try {
            const header = JSON.parse(content ?? "{}");
            return header as Header;
        } catch (parseError) {
            llmLogger.error("[llm] failed to parse header recognition response", parseError, {
                scheduleId: options.scheduleId,
                header: label,
            });
            return {
                name: 'Unknown',
                studentId: 'Unknown'
            };
        }
    } catch (error) {
        const message = "Failed to send header image to the matching model";
        llmLogger.error("[llm] header recognition failed", error, {
            scheduleId: options.scheduleId,
            header: label,
            model,
        });
        throw new LLMRequestError(message, {
            scheduleId: options.scheduleId,
            header: label,
            model,
        }, error);
    }
}

export async function recognizeMCQ(imagePath: string): Promise<MCQResult> {
    console.log('MODEL NAME', process.env.OBJECTIVE_MODEL_NAME);
    const response = await getQwenClient().chat.completions.create({
        model: process.env.OBJECTIVE_MODEL_NAME,
        messages: [{
            role: "user",
            content: [
                {
                    type: "image_url",
                    image_url: {
                        url: `data:image/png;base64,${imageToBase64(imagePath)}`,
                    },
                },
                {
                    type: "text",
                    text: MCQ_PROMPT,
                },
            ]
        }],
        response_format: zodResponseFormat(MCQSchema, 'answer')
    });

    try {
        const answer = JSON.parse(response.choices[0].message.content!);
        return answer as MCQResult;
    } catch (error) {
        return {
            answer: ['Unknown']
        };
    }
}

export async function askSubjective(question: SubjectiveInput): Promise<SubjectiveResult> {
    console.log('LLM SUBJECTIVE START');
    console.log('MODEL NAME', process.env.SUBJECTIVE_MODEL_NAME);
    console.log(question);
    const response = await getGptClient().chat.completions.create({
        model: process.env.SUBJECTIVE_MODEL_NAME,
        messages: [{
            role: "user",
            content: [
                {
                    type: "image_url",
                    image_url: {
                        url: `data:image/png;base64,${imageToBase64(question.imageUrl)}`,
                    },
                },
                {
                    type: "text",
                    text: SUBJECTIVE_PROMPT,
                },
            ]
        }],
        response_format: zodResponseFormat(SubjectiveSchema, 'answer')
    });
    console.log('LLM SUBJECTIVE END');
    console.log(response.choices[0].message.content);
    try {
        const result = JSON.parse(response.choices[0].message.content!);
        return result as SubjectiveResult;
    } catch (error) {
        return {
            reasoning: 'Unknown',
            ocrResult: 'Unknown',
            suggestion: 'Failed to Generate Result',
            score: -1
        }
    }
}