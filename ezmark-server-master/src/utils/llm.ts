import "dotenv/config";
import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
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

type MatchingResolution = {
    provider: "openai" | "qwen";
    client: OpenAI;
    model: string;
    modelSource: string;
};

function resolveMatchingModel(provider: "openai" | "qwen", rawModel?: string): { model: string; source: string } {
    const trimmed = rawModel?.trim();

    if (provider === "qwen") {
        if (trimmed && /^(qwen|dashscope)/i.test(trimmed)) {
            return { model: trimmed, source: "MATCHING_MODEL_NAME" };
        }

        if (trimmed) {
            llmLogger.info("[llm] ignoring non-Qwen matching model for Qwen provider", { model: trimmed });
        }

        const qwenSpecific = optionalEnv("QWEN_MATCHING_MODEL_NAME");
        if (qwenSpecific) {
            return { model: qwenSpecific, source: "QWEN_MATCHING_MODEL_NAME" };
        }

        return { model: "qwen-vl-max-2025-01-25", source: "default-qwen" };
    }

    if (trimmed && !/^qwen/i.test(trimmed)) {
        return { model: trimmed, source: "MATCHING_MODEL_NAME" };
    }

    const openaiSpecific = optionalEnv("OPENAI_MATCHING_MODEL_NAME");
    if (openaiSpecific) {
        return { model: openaiSpecific, source: "OPENAI_MATCHING_MODEL_NAME" };
    }

    return { model: "gpt-4o-mini", source: "default-openai" };
}

function resolveMatchingClient(): MatchingResolution {
    const providerHint = optionalEnv("MATCHING_PROVIDER")
        ?? optionalEnv("MATCHING_CLIENT")
        ?? optionalEnv("MATCHING_VENDOR");
    const normalizedHint = providerHint?.toLowerCase();
    const rawModel = optionalEnv("MATCHING_MODEL_NAME");
    const hasQwenCredentials = Boolean(optionalEnv("QWEN_API_KEY"));

    if (normalizedHint) {
        if (["qwen", "dashscope", "ali", "aliyun"].includes(normalizedHint)) {
            const resolved = resolveMatchingModel("qwen", rawModel);
            return { provider: "qwen", client: getQwenClient(), model: resolved.model, modelSource: resolved.source };
        }
        if (["openai", "azure-openai", "azure"].includes(normalizedHint)) {
            const resolved = resolveMatchingModel("openai", rawModel);
            return { provider: "openai", client: getGptClient(), model: resolved.model, modelSource: resolved.source };
        }
    }

    if (hasQwenCredentials) {
        const resolved = resolveMatchingModel("qwen", rawModel);
        return { provider: "qwen", client: getQwenClient(), model: resolved.model, modelSource: resolved.source };
    }

    if ((rawModel?.toLowerCase() ?? "").includes("qwen") || (rawModel?.toLowerCase() ?? "").includes("dashscope")) {
        const resolved = resolveMatchingModel("qwen", rawModel);
        return { provider: "qwen", client: getQwenClient(), model: resolved.model, modelSource: resolved.source };
    }

    const resolved = resolveMatchingModel("openai", rawModel);
    return { provider: "openai", client: getGptClient(), model: resolved.model, modelSource: resolved.source };
}

export async function recognizeHeader(imagePath: string, options: RecognizeHeaderOptions = {}): Promise<Header> {
    const resolution = resolveMatchingClient();
    const { client, provider, model, modelSource } = resolution;
    const label = typeof options.headerIndex === "number" && typeof options.totalHeaders === "number"
        ? `${options.headerIndex + 1}/${options.totalHeaders}`
        : `${(options.headerIndex ?? 0) + 1}`;

    llmLogger.info("[llm] sending header image for recognition", {
        scheduleId: options.scheduleId,
        imagePath,
        model,
        modelSource,
        header: label,
        provider,
    });

    try {
        const base64Image = imageToBase64(imagePath);

        const openaiContent: ChatCompletionCreateParamsNonStreaming["messages"][number]["content"] = [
            {
                type: "image_url",
                image_url: {
                    url: `data:image/png;base64,${base64Image}`,
                },
            },
            {
                type: "text",
                text: HEADER_PROMPT,
            },
        ];

        const qwenContent = [
            {
                type: "input_text",
                text: HEADER_PROMPT,
            },
            {
                type: "input_image",
                image_url: {
                    url: `data:image/png;base64,${base64Image}`,
                },
            },
        ];

        const request: ChatCompletionCreateParamsNonStreaming = {
            model,
            messages: [] as unknown as ChatCompletionCreateParamsNonStreaming["messages"],
            stream: false,
        };

        (request.messages as unknown as Array<{ role: "user"; content: unknown }>).push({
            role: "user",
            content: provider === "openai" ? openaiContent : qwenContent,
        });

        if (provider === "openai") {
            request.response_format = zodResponseFormat(HeaderSchema, "header");
        }

        const response = await client.chat.completions.create(request);

        const rawContent = response.choices[0]?.message?.content;
        let content: string | undefined;
        if (typeof rawContent === "string") {
            content = rawContent;
        } else if (Array.isArray(rawContent)) {
            content = (rawContent as Array<Record<string, unknown> | string>).map((part) => {
                if (typeof part === "string") {
                    return part;
                }
                if (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string") {
                    return (part as { text: string }).text;
                }
                return "";
            }).join("");
        } else if (rawContent && typeof rawContent === "object" && "text" in rawContent && typeof (rawContent as { text?: unknown }).text === "string") {
            content = (rawContent as { text: string }).text;
        }
        llmLogger.info("[llm] header recognition succeeded", {
            scheduleId: options.scheduleId,
            header: label,
            provider,
            model,
        });

        try {
            const parsedContent: unknown = typeof content === "string" && content.trim().length > 0
                ? JSON.parse(content)
                : {};
            const headerData = HeaderSchema.parse(parsedContent);
            return {
                name: headerData.name,
                studentId: headerData.studentId,
            } satisfies Header;
        } catch (parseError) {
            llmLogger.error("[llm] failed to parse header recognition response", parseError, {
                scheduleId: options.scheduleId,
                header: label,
                provider,
                model,
                preview: content?.slice(0, 200)
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
            provider,
            modelSource,
        });
        throw new LLMRequestError(message, {
            scheduleId: options.scheduleId,
            header: label,
            model,
            provider,
            modelSource,
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