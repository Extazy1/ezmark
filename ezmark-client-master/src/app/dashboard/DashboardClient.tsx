"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Cookies from "js-cookie";
import { Loader2 } from "lucide-react";

import { DashboardLayout } from "@/components/dashboard";
import { useAuth } from "@/context/Auth";

const DashboardClient = () => {
  const {
    authenticated,
    setAuthenticated,
    setDocumentId,
    setEmail,
    setId,
    setJwt,
    setUserName,
  } = useAuth();
  const router = useRouter();
  const [isHydrating, setIsHydrating] = useState(true);

  useEffect(() => {
    const jwt = Cookies.get("jwt");

    if (!jwt) {
      setIsHydrating(false);
      router.replace("/auth/login");
      return;
    }

    setJwt(jwt);

    if (!authenticated) {
      const storedUserName = localStorage.getItem("userName");
      const storedEmail = localStorage.getItem("email");
      const storedId = localStorage.getItem("id");
      const storedDocumentId = localStorage.getItem("documentId");

      if (
        storedUserName &&
        storedEmail &&
        storedId &&
        storedDocumentId
      ) {
        setUserName(storedUserName);
        setEmail(storedEmail);
        setId(storedId);
        setDocumentId(storedDocumentId);
        setAuthenticated(true);
      }
    }

    setIsHydrating(false);
  }, [
    authenticated,
    router,
    setAuthenticated,
    setDocumentId,
    setEmail,
    setId,
    setJwt,
    setUserName,
  ]);

  if (isHydrating) {
    return (
      <div className="flex h-screen w-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!authenticated) {
    return null;
  }

  return <DashboardLayout />;
};

export default DashboardClient;
