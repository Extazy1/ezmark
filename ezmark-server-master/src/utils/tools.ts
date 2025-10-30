import sharp from "sharp";
import type { Metadata } from "sharp";
import fs from 'fs'
import { ExamScheduleResult } from "../../types/type";
import type { Position, UnionComponent } from "../../types/exam";

// 转换毫米到像素的函数
export function mmToPixels(
    mm: number,
    imageInfo: sharp.Metadata,
    axis: "x" | "y" = "x",
    pageSizeMM?: number,
): number {
    const dimension = axis === "x" ? imageInfo.width : imageInfo.height;
    if (!dimension || dimension <= 0) {
        throw new Error(`Cannot convert mm to pixels without valid image ${axis === "x" ? "width" : "height"}`);
    }

    const defaultPageSize = pageSizeMM ?? (axis === "x" ? 210 : 297);
    const pixelsPerMm = dimension / defaultPageSize;
    return Math.round(mm * pixelsPerMm);
}

export function imageToBase64(image: string) {
    const imageBuffer = fs.readFileSync(image)
    const base64 = imageBuffer.toString('base64')
    return base64
}

export function ensureScheduleResult(result: unknown): ExamScheduleResult {
    let parsed: ExamScheduleResult;

    if (typeof result === "string") {
        try {
            parsed = JSON.parse(result) as ExamScheduleResult;
        } catch (error) {
            throw new Error(`Failed to parse schedule result JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
    } else if (result && typeof result === "object") {
        parsed = result as ExamScheduleResult;
    } else {
        throw new Error("Schedule result is missing or invalid");
    }

    if (typeof parsed.error === "undefined") {
        parsed.error = null;
    }

    return parsed;
}

export function serialiseScheduleResult(result: ExamScheduleResult) {
    return JSON.parse(JSON.stringify(result));
}

export const QUESTION_CROP_PADDING = 10;

export function toFiniteNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
            return null;
        }

        const parsed = Number(trimmed);
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }

    return null;
}

export interface CropBox {
    left: number;
    top: number;
    width: number;
    height: number;
}

export function getComponentCropBox(options: {
    position: Position;
    metadata: Metadata;
    nextTopMm?: number | null;
    padding?: number;
}): CropBox | null {
    const { position, metadata, nextTopMm, padding = QUESTION_CROP_PADDING } = options;

    const pageWidth = metadata.width ?? 0;
    const pageHeight = metadata.height ?? 0;

    if (!pageWidth || !pageHeight) {
        return null;
    }

    const topMm = toFiniteNumber(position.top);
    const leftMm = toFiniteNumber(position.left);
    const widthMm = toFiniteNumber(position.width);
    const heightMm = toFiniteNumber(position.height);

    if (topMm === null || leftMm === null || widthMm === null || heightMm === null) {
        return null;
    }

    const contentTopPx = mmToPixels(topMm, metadata, "y");
    const contentLeftPx = mmToPixels(leftMm, metadata, "x");
    const contentWidthPx = mmToPixels(widthMm, metadata, "x");
    const contentHeightPx = mmToPixels(heightMm, metadata, "y");

    const paddedLeftPx = Math.max(contentLeftPx - padding, 0);
    const paddedTopPx = Math.max(contentTopPx - padding, 0);

    let paddedRightPx = Math.min(contentLeftPx + contentWidthPx + padding, pageWidth);
    let paddedBottomPx = Math.min(contentTopPx + contentHeightPx + padding, pageHeight);

    if (nextTopMm !== null && typeof nextTopMm !== "undefined") {
        const nextTopPx = mmToPixels(nextTopMm, metadata, "y");
        const limitBottomPx = Math.max(nextTopPx - padding, paddedTopPx + 1);
        paddedBottomPx = Math.min(paddedBottomPx, limitBottomPx);
    }

    const widthPx = Math.max(1, Math.min(pageWidth - paddedLeftPx, Math.round(paddedRightPx - paddedLeftPx)));
    const heightPx = Math.max(1, Math.min(pageHeight - paddedTopPx, Math.round(paddedBottomPx - paddedTopPx)));

    return {
        left: Math.round(paddedLeftPx),
        top: Math.round(paddedTopPx),
        width: widthPx,
        height: heightPx,
    };
}

export function computeNextComponentTopMap(components: UnionComponent[]) {
    const map = new Map<string, number | null>();
    const pageBuckets = new Map<number, Array<{ id: string; top: number }>>();

    for (const component of components) {
        const position = component.position;
        if (!position) {
            continue;
        }

        const pageIndex = toFiniteNumber(position.pageIndex);
        const top = toFiniteNumber(position.top);

        if (pageIndex === null || top === null) {
            continue;
        }

        if (!pageBuckets.has(pageIndex)) {
            pageBuckets.set(pageIndex, []);
        }

        pageBuckets.get(pageIndex)!.push({ id: component.id, top });
        map.set(component.id, null);
    }

    for (const [, entries] of pageBuckets) {
        entries.sort((a, b) => {
            if (a.top !== b.top) {
                return a.top - b.top;
            }
            return a.id.localeCompare(b.id);
        });

        for (let index = 0; index < entries.length; index++) {
            const current = entries[index];
            let nextTop: number | null = null;

            for (let nextIndex = index + 1; nextIndex < entries.length; nextIndex++) {
                const candidate = entries[nextIndex];
                if (candidate.top > current.top) {
                    nextTop = candidate.top;
                    break;
                }
            }

            map.set(current.id, nextTop);
        }
    }

    return map;
}
