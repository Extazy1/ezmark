'use client'

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import Cookies from "js-cookie";
import { useRouter } from "next/navigation";

import { AuthContextObject } from "@/types/types";
import { axiosInstance } from "@/lib/axios";

type StoredUser = {
  userName: string;
  email: string;
  id: string;
  documentId: string;
};

const STORAGE_KEYS: StoredUser = {
  userName: "userName",
  email: "email",
  id: "id",
  documentId: "documentId",
};

const writeStorage = (key: string, value: string) => {
  if (!key) {
    return;
  }

  if (value) {
    localStorage.setItem(key, value);
  } else {
    localStorage.removeItem(key);
  }
};

const readStoredUser = (): StoredUser | null => {
  const storedUserName = localStorage.getItem(STORAGE_KEYS.userName);
  const storedEmail = localStorage.getItem(STORAGE_KEYS.email);
  const storedId = localStorage.getItem(STORAGE_KEYS.id);
  const storedDocumentId = localStorage.getItem(STORAGE_KEYS.documentId);

  if (storedUserName && storedEmail && storedId && storedDocumentId) {
    return {
      userName: storedUserName,
      email: storedEmail,
      id: storedId,
      documentId: storedDocumentId,
    };
  }

  return null;
};

export const AuthContext = createContext<AuthContextObject>({
  userName: "",
  email: "",
  id: "",
  jwt: "",
  authenticated: false,
  isLoading: true,
  setUserName: () => {},
  setEmail: () => {},
  setId: () => {},
  setJwt: () => {},
  setAuthenticated: () => {},
  logout: () => Promise.resolve(),
  documentId: "",
  setDocumentId: () => {},
});

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [userName, setUserName] = useState("");
  const [email, setEmail] = useState("");
  const [id, setId] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [jwt, setJwt] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();

  const clearStoredSession = useCallback(() => {
    Object.values(STORAGE_KEYS).forEach((key) => localStorage.removeItem(key));
  }, []);

  const applyUser = useCallback(
    ({ userName, email, id, documentId }: StoredUser) => {
      setUserName(userName);
      setEmail(email);
      setId(id);
      setDocumentId(documentId);

      writeStorage(STORAGE_KEYS.userName, userName);
      writeStorage(STORAGE_KEYS.email, email);
      writeStorage(STORAGE_KEYS.id, id);
      writeStorage(STORAGE_KEYS.documentId, documentId);

      const hasCompleteProfile = Boolean(
        userName && email && id && documentId,
      );

      setAuthenticated(hasCompleteProfile);
    },
    [],
  );

  const clearSession = useCallback(() => {
    Cookies.remove("jwt");
    clearStoredSession();
    setAuthenticated(false);
    setUserName("");
    setEmail("");
    setId("");
    setDocumentId("");
    setJwt("");
  }, [clearStoredSession]);

  const logout = useCallback(async () => {
    clearSession();
    router.push("/");
  }, [clearSession, router]);

  const hydrateSession = useCallback(async () => {
    const cookieJwt = Cookies.get("jwt");

    if (!cookieJwt) {
      clearSession();
      setIsLoading(false);
      return;
    }

    setJwt(cookieJwt);

    const storedUser = readStoredUser();
    if (storedUser) {
      applyUser(storedUser);
    }

    try {
      const response = await axiosInstance.get("/users/me");

      const profile = response?.data as
        | (Partial<StoredUser> & {
            id?: number | string;
            username?: string;
            email?: string;
            documentId?: string;
            error?: unknown;
            success?: boolean;
          })
        | undefined;

      const hasValidStatus = response && response.status >= 200 && response.status < 300;
      const isErrorPayload = profile?.success === false || profile?.error;

      if (!hasValidStatus || !profile || isErrorPayload) {
        throw new Error("Failed to load user profile");
      }

      applyUser({
        userName: profile.username ?? storedUser?.userName ?? "",
        email: profile.email ?? storedUser?.email ?? "",
        id:
          typeof profile.id === "number"
            ? String(profile.id)
            : profile.id ?? storedUser?.id ?? "",
        documentId: profile.documentId ?? storedUser?.documentId ?? "",
      });
    } catch (error) {
      clearSession();
      router.replace("/auth/login");
    } finally {
      setIsLoading(false);
    }
  }, [applyUser, clearSession, router]);

  useEffect(() => {
    hydrateSession();
  }, [hydrateSession]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (!event.key) {
        return;
      }

      if (!Object.values(STORAGE_KEYS).includes(event.key)) {
        return;
      }

      const storedUser = readStoredUser();

      if (storedUser) {
        applyUser(storedUser);
      } else {
        clearSession();
      }
    };

    window.addEventListener("storage", handleStorage);

    return () => {
      window.removeEventListener("storage", handleStorage);
    };
  }, [applyUser, clearSession]);

  return (
    <AuthContext.Provider
      value={{
        userName,
        email,
        id,
        jwt,
        authenticated,
        isLoading,
        setUserName,
        setEmail,
        setId,
        setJwt,
        setAuthenticated,
        logout,
        documentId,
        setDocumentId,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  return useContext(AuthContext);
};
