"use client";

import LoginForm from "@/components/auth/login-form/LoginForm";
import { LoginFormData } from "@/components/auth/login-form/interface";
import { useToast } from "@/hooks/use-toast";
import Cookies from "js-cookie";
import { useRouter } from "next/navigation";
import { LoginResponse } from "@/types/types";
import { motion } from "framer-motion";
import { axiosInstance } from "@/lib/axios";
import { useAuth } from "@/context/Auth";

export default function LoginPage() {
  const { toast } = useToast();
  const router = useRouter();
  const {
    setAuthenticated,
    setDocumentId,
    setEmail,
    setId,
    setJwt,
    setUserName,
  } = useAuth();

  const handleSuccess = (responseData: LoginResponse) => {
    Cookies.set("jwt", responseData.jwt);

    const safeUserName = responseData.user.username ?? "";
    const safeEmail = responseData.user.email ?? "";
    const safeId = responseData.user.id?.toString?.() ?? "";
    const safeDocumentId = responseData.user.documentId ?? "";

    setJwt(responseData.jwt);
    setUserName(safeUserName);
    setEmail(safeEmail);
    setId(safeId);
    setDocumentId(safeDocumentId);
    setAuthenticated(Boolean(responseData.jwt));

    if (safeUserName) {
      localStorage.setItem("userName", safeUserName);
    } else {
      localStorage.removeItem("userName");
    }

    if (safeEmail) {
      localStorage.setItem("email", safeEmail);
    } else {
      localStorage.removeItem("email");
    }

    if (safeId) {
      localStorage.setItem("id", safeId);
    } else {
      localStorage.removeItem("id");
    }

    if (safeDocumentId) {
      localStorage.setItem("documentId", safeDocumentId);
    } else {
      localStorage.removeItem("documentId");
    }

    localStorage.setItem("jwt", responseData.jwt);

    toast({
      title: "Login Successful",
      description: "You have been successfully logged in.",
      duration: 1000,
    });
    router.push("/dashboard");
  };

  const handleLogin = async (data: LoginFormData) => {
    try {
      const response = await axiosInstance.post(`/auth/local`, {
        identifier: data.email,
        password: data.password,
      });
      handleSuccess(response.data);
    } catch (error) {
      // Error toast handled in interceptor
      console.log("Login error was handled by interceptor:", error);
    }
  };

  return (
    <motion.div
      className="container m-auto"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5 }}
    >
      <LoginForm onSubmit={handleLogin} />
    </motion.div>
  );
}
