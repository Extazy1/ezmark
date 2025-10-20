"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { DashboardLayout } from "@/components/dashboard";
import { useAuth } from "@/context/Auth";

const shouldLogAuth =
  process.env.NEXT_PUBLIC_AUTH_DEBUG === "true" || process.env.NODE_ENV !== "production";

const DashboardClient = () => {
  const { authenticated, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (shouldLogAuth) {
      // eslint-disable-next-line no-console
      console.info("[dashboard] state", { authenticated, isLoading });
    }

    if (!isLoading && !authenticated) {
      router.replace("/auth/login");
    }
  }, [authenticated, isLoading, router]);

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

  return <DashboardLayout />;
};

export default DashboardClient;
