// app/dashboard/page.tsx
import dynamic from "next/dynamic";

// 防止被静态预渲染（可选但推荐）
export const dynamic = "force-dynamic";

// 关键：客户端加载，跳过 SSR，避免 Node 环境访问到 File 小写
const DashboardClient = dynamic(() => import("./DashboardClient"), {
  ssr: false,
});

export default function Page() {
  return <DashboardClient />;
}
