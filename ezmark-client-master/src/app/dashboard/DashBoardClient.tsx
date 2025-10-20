// app/dashboard/DashboardClient.tsx
"use client";

import React from "react";

export default function DashboardClient() {
  // 只能在浏览器的逻辑，放到 effect/事件里
  const isBrowser =
    typeof window !== "undefined" && typeof File !== "undefined";

  React.useEffect(() => {
    if (!isBrowser) return;
    // 这里写用到 File / FileReader / window 的初始化逻辑
  }, [isBrowser]);

  return <div>{/* 你的 Dashboard UI 放这里（含文件上传/下载等） */}</div>;
}
