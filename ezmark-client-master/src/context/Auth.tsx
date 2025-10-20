'use client'
import { useContext, useEffect, useState, useCallback } from "react";
import Cookies from "js-cookie";
import { AuthContextObject } from "@/types/types";
import { createContext } from "react";
import { useRouter, usePathname } from "next/navigation";

export const AuthContext = createContext<AuthContextObject>({
    userName: "",
    email: "",
    id: "",
    jwt: "",
    authenticated: false,
    setUserName: () => { },
    setEmail: () => { },
    setId: () => { },
    setJwt: () => { },
    setAuthenticated: () => { },
    logout: () => Promise.resolve(),
    documentId: "",
    setDocumentId: () => { }
})

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
    const [userName, setUserName] = useState("");
    const [email, setEmail] = useState("");
    const [id, setId] = useState("");
    const [documentId, setDocumentId] = useState("");
    const [jwt, setJwt] = useState("");
    const [authenticated, setAuthenticated] = useState(false);
    const pathname = usePathname();
    const router = useRouter();

    const logout = useCallback(async () => {
        // Clear authentication data
        Cookies.remove("jwt");
        localStorage.removeItem("userName");
        localStorage.removeItem("email");
        localStorage.removeItem("id");
        localStorage.removeItem("documentId");
        // Update auth context
        setAuthenticated(false);
        setUserName("");
        setEmail("");
        setId("");
        setDocumentId("");
        setJwt("");

        // Redirect to home page
        router.push("/");
    }, [router]);

    // 封装验证逻辑为可重用函数
    const checkAuthStatus = useCallback(() => {
        console.log("Checking auth status");
        const jwt = Cookies.get("jwt");
        if (jwt) {
            setJwt(jwt);
            const userName = localStorage.getItem("userName");
            const email = localStorage.getItem("email");
            const id = localStorage.getItem("id");
            const documentId = localStorage.getItem("documentId");
            if (userName && email && id && documentId) {
                setUserName(userName);
                setEmail(email);
                setId(id);
                setDocumentId(documentId);
                // 只有当用户名和邮箱都存在时，才认为用户已登录
                setAuthenticated(true);
            } else {
                // 检测到JWT但找不到用户信息时,清除JWT
                Cookies.remove("jwt");
                localStorage.removeItem("userName");
                localStorage.removeItem("email");
                localStorage.removeItem("id");
                localStorage.removeItem("documentId");
                setAuthenticated(false);
            }
        } else {
            // 没有JWT，清除认证状态
            setAuthenticated(false);
        }
    }, [pathname]);


    // 组件挂载时和路径变化时检查认证状态
    useEffect(() => {
        checkAuthStatus();
    }, [pathname]);

    return (
        <AuthContext.Provider value={{
            userName,
            email,
            id,
            jwt,
            authenticated,
            setUserName,
            setEmail,
            setId,
            setJwt,
            setAuthenticated,
            logout,
            documentId,
            setDocumentId
        }}>
            {children}
        </AuthContext.Provider>
    )
}

export const useAuth = () => {
    return useContext(AuthContext);
}