"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { DashboardLayout } from "@/components/dashboard";
import { useAuth } from "@/context/Auth";
import { DashboardDiagnostics } from "@/components/dashboard/DashboardDiagnostics";

const shouldLogAuth =
  process.env.NEXT_PUBLIC_AUTH_DEBUG === "true" || process.env.NODE_ENV !== "production";

type ServerRenderInfo = {
  timestamp: number;
  isoTimestamp: string;
  randomSeed: number;
};

type ServerSeedComparison = "unknown" | "identical" | "changed";

type ClientRuntimeInfo = {
  hasWindow: boolean;
  userAgent: string;
  href: string;
  timezone: string;
};

type HydrationSnapshot = {
  hydratedAt: number | null;
  readyState: DocumentReadyState | "unknown";
  visibilityState: DocumentVisibilityState | "unknown";
};

const showDiagnostics = process.env.NEXT_PUBLIC_DASHBOARD_DEBUG === "true";

interface DashboardClientProps {
  serverRenderInfo: ServerRenderInfo;
}

const DashboardClient = ({ serverRenderInfo }: DashboardClientProps) => {
  const { authenticated, isLoading } = useAuth();
  const router = useRouter();
  const [clientRuntimeInfo, setClientRuntimeInfo] = useState<ClientRuntimeInfo>({
    hasWindow: false,
    userAgent: "",
    href: "",
    timezone: "",
  });
  const [hydrationSnapshot, setHydrationSnapshot] = useState<HydrationSnapshot>({
    hydratedAt: null,
    readyState: "unknown",
    visibilityState: "unknown",
  });
  const [seedComparison, setSeedComparison] = useState<ServerSeedComparison>("unknown");

  useEffect(() => {
    const hasWindow = typeof window !== "undefined";
    const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "";
    const href = hasWindow ? window.location.href : "";
    const timezone =
      typeof Intl !== "undefined"
        ? Intl.DateTimeFormat().resolvedOptions().timeZone ?? ""
        : "";

    setClientRuntimeInfo({ hasWindow, userAgent, href, timezone });

    setHydrationSnapshot({
      hydratedAt: Date.now(),
      readyState: typeof document !== "undefined" ? document.readyState : "unknown",
      visibilityState:
        typeof document !== "undefined" ? document.visibilityState : "unknown",
    });

    if (hasWindow) {
      const storageKey = "dashboard:last-server-seed";
      const previousSeed = window.sessionStorage.getItem(storageKey);
      const nextSeed = String(serverRenderInfo.randomSeed);

      if (previousSeed) {
        setSeedComparison(previousSeed === nextSeed ? "identical" : "changed");
      }

      window.sessionStorage.setItem(storageKey, nextSeed);
    }
  }, [serverRenderInfo.randomSeed]);

  useEffect(() => {
    if (shouldLogAuth) {
      const payload = {
        authenticated,
        isLoading,
        serverRenderInfo,
      };

      // eslint-disable-next-line no-console
      console.info("[dashboard] state", payload);
    }

    if (!isLoading && !authenticated) {
      router.replace("/auth/login");
    }
  }, [authenticated, isLoading, router]);

  const diagnostics = useMemo(
    () => ({
      authState: { authenticated, isLoading },
      serverRenderInfo,
      clientRuntimeInfo,
      hydrationSnapshot,
      seedComparison,
    }),
    [authenticated, isLoading, serverRenderInfo, clientRuntimeInfo, hydrationSnapshot, seedComparison],
  );

  if (isLoading) {
    return (
      <div className="flex h-screen w-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="flex h-screen w-full flex-col items-center justify-center gap-2 text-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          Checking your session. If this page does not redirect automatically, please
          log in again.
        </p>
      </div>
    );
  }

  return (
    <>
      {showDiagnostics ? <DashboardDiagnostics {...diagnostics} /> : null}
      <DashboardLayout />
    </>
  );
};

export default DashboardClient;
