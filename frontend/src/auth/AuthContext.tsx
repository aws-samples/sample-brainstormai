import React, { createContext, useContext, useEffect, useState } from "react";
import { Amplify } from "aws-amplify";
import {
  signIn,
  signOut,
  signUp,
  confirmSignUp,
  confirmSignIn,
  getCurrentUser,
  fetchAuthSession,
} from "aws-amplify/auth";
import { getRuntimeConfig } from "../api/client";

interface AuthUser {
  userId: string;
  email: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  pendingNewPassword: boolean;
  login: (email: string, password: string) => Promise<void>;
  confirmNewPassword: (newPassword: string) => Promise<void>;
  logout: () => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  confirmRegistration: (email: string, code: string) => Promise<void>;
  getIdToken: () => Promise<string>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingNewPassword, setPendingNewPassword] = useState(false);
  const [pendingEmail, setPendingEmail] = useState("");

  useEffect(() => {
    const config = getRuntimeConfig();
    Amplify.configure({
      Auth: {
        Cognito: {
          userPoolId: config.userPoolId,
          userPoolClientId: config.userPoolClientId,
          loginWith: { email: true },
        },
      },
    });

    getCurrentUser()
      .then((u) => setUser({ userId: u.userId, email: u.signInDetails?.loginId ?? "" }))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const _finalizeSignIn = async (email: string) => {
    const session = await fetchAuthSession();
    const payload = session.tokens?.idToken?.payload;
    setUser({
      userId: (payload?.sub as string) ?? email,
      email: (payload?.email as string) ?? email,
    });
    setPendingNewPassword(false);
    setPendingEmail("");
  };

  const login = async (email: string, password: string) => {
    const result = await signIn({ username: email, password });
    if (result.nextStep?.signInStep === "CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED") {
      setPendingNewPassword(true);
      setPendingEmail(email);
      return;
    }
    if (!result.isSignedIn) {
      throw new Error(result.nextStep?.signInStep ?? "Sign-in requires additional steps");
    }
    await _finalizeSignIn(email);
  };

  const confirmNewPassword = async (newPassword: string) => {
    const result = await confirmSignIn({ challengeResponse: newPassword });
    if (!result.isSignedIn) {
      throw new Error(result.nextStep?.signInStep ?? "Sign-in requires additional steps");
    }
    await _finalizeSignIn(pendingEmail);
  };

  const logout = async () => {
    await signOut();
    setUser(null);
  };

  const register = async (email: string, password: string) => {
    await signUp({ username: email, password, options: { userAttributes: { email } } });
  };

  const confirmRegistration = async (email: string, code: string) => {
    await confirmSignUp({ username: email, confirmationCode: code });
  };

  const getIdToken = async (): Promise<string> => {
    const session = await fetchAuthSession();
    return session.tokens?.idToken?.toString() ?? "";
  };

  return (
    <AuthContext.Provider
      value={{ user, loading, pendingNewPassword, login, confirmNewPassword, logout, register, confirmRegistration, getIdToken }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
