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

    setJwt(responseData.jwt);
    setUserName(responseData.user.username);
    setEmail(responseData.user.email);
    setId(responseData.user.id.toString());
    setDocumentId(responseData.user.documentId);
    setAuthenticated(true);

    localStorage.setItem("userName", responseData.user.username);
    localStorage.setItem("email", responseData.user.email);
    localStorage.setItem("id", responseData.user.id.toString());
    localStorage.setItem("documentId", responseData.user.documentId);

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
