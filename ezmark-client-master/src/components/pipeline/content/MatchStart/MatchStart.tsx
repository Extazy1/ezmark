"use client";

import React, { useState, useEffect } from "react";
import { AlertTriangle, Loader2, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { MatchStartProps } from "./interface";
import { Button } from "@/components/ui/button";
import { startMatching as startMatchingPipeline } from "@/lib/api";

const loadingMessages = [
    "Identifying students' names and IDs",
    "Matching students with exam papers",
    "Calling LLM for processing",
    "Analyzing handwriting patterns",
    "Evaluating answer structure",
    "Preparing grading framework",
    "Organizing student submissions",
    "Setting up AI-assisted marking"
];

export default function MatchStart({ updateSchedule, schedule }: MatchStartProps) {
    const [currentMessageIndex, setCurrentMessageIndex] = useState(0);
    const [retrying, setRetrying] = useState(false);

    const matchError = schedule.result.error?.stage === "MATCH" ? schedule.result.error : null;

    useEffect(() => {
        const interval = setInterval(() => {
            setCurrentMessageIndex((prevIndex) =>
                (prevIndex + 1) % loadingMessages.length
            );
        }, 2000);

        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        if (matchError) {
            return;
        }
        const interval = setInterval(() => {
            // 轮询接口,等待状态更新
            updateSchedule();
        }, 500);
        return () => clearInterval(interval);
    }, [matchError, updateSchedule]);

    const handleRetry = async () => {
        try {
            setRetrying(true);
            await startMatchingPipeline(schedule.documentId);
            await updateSchedule();
        } catch (error) {
            console.error("Failed to restart matching", error);
        } finally {
            setRetrying(false);
        }
    };

    if (matchError) {
        return (
            <div className="w-full h-full flex flex-col items-center justify-center px-4 text-center space-y-6">
                <AlertTriangle className="h-16 w-16 text-destructive" />
                <div className="space-y-2 max-w-xl">
                    <h2 className="text-2xl font-semibold">Matching failed</h2>
                    <p className="text-muted-foreground">
                        {matchError.message}
                    </p>
                    {matchError.details ? (
                        <p className="text-sm text-muted-foreground/80 whitespace-pre-wrap">
                            {matchError.details}
                        </p>
                    ) : null}
                </div>
                <div className="flex flex-wrap items-center justify-center gap-3">
                    <Button
                        variant="outline"
                        onClick={updateSchedule}
                        disabled={retrying}
                    >
                        Refresh status
                    </Button>
                    <Button
                        onClick={handleRetry}
                        disabled={retrying}
                        className="gap-2"
                    >
                        {retrying ? (
                            <>
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Retrying...
                            </>
                        ) : (
                            <>
                                <RotateCcw className="h-4 w-4" />
                                Retry matching
                            </>
                        )}
                    </Button>
                </div>
                {matchError.timestamp ? (
                    <p className="text-xs text-muted-foreground/70">
                        Last failure at {new Date(matchError.timestamp).toLocaleString()}
                    </p>
                ) : null}
            </div>
        );
    }

    return (
        <div className=" w-full h-full flex flex-col items-center justify-center">
            <div className="w-full flex flex-col items-center space-y-12 max-w-md text-center">
                <div className="relative">
                    <Loader2 className="h-16 w-16 text-primary animate-spin" />
                </div>

                <div className="space-y-8 w-full">
                    <div className="h-[60px] relative overflow-hidden">
                        {loadingMessages.map((message, index) => (
                            <div
                                key={index}
                                className={cn(
                                    "absolute w-full transition-all duration-500 ease-in-out",
                                    index === currentMessageIndex
                                        ? "opacity-100 translate-y-0"
                                        : "opacity-0 translate-y-8"
                                )}
                            >
                                <p className="text-xl font-medium text-foreground">
                                    {message}
                                </p>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}
