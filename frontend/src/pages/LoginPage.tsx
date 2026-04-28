import { useState } from "react";
import {
  Form,
  FormField,
  Input,
  Button,
  Alert,
  SpaceBetween,
  Box,
  Link,
} from "@cloudscape-design/components";
import { useAuth } from "../auth/AuthContext";

type View = "login" | "register" | "confirm" | "new_password";

const FEATURES = [
  "AI-generated podcasts with two hosts",
  "Interactive Q&A mid-playback",
  "Interactive mind maps you can explore branch by branch",
  "Scored quizzes with explanations",
  "Multi-language support",
];

export default function LoginPage() {
  const { login, register, confirmRegistration, confirmNewPassword, pendingNewPassword } = useAuth();
  const [view, setView] = useState<View>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (pendingNewPassword && view !== "new_password") setView("new_password");

  const handle = async () => {
    setError("");
    setLoading(true);
    try {
      if (view === "login")             await login(email, password);
      else if (view === "register")     { await register(email, password); setView("confirm"); }
      else if (view === "confirm")      { await confirmRegistration(email, code); await login(email, password); }
      else if (view === "new_password") await confirmNewPassword(newPassword);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  const titles: Record<View, [string, string]> = {
    login:        ["Sign in", "Sign in to your BrainstormAI account"],
    register:     ["Create account", "Start turning content into knowledge"],
    confirm:      ["Verify your email", "Enter the verification code we sent you"],
    new_password: ["Set a new password", "Your account requires a password change"],
  };
  const [title, subtitle] = titles[view];

  const primaryLabel =
    view === "login"        ? "Sign in" :
    view === "register"     ? "Create account" :
    view === "new_password" ? "Set password" : "Verify";

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>

      {/* ── Brand panel ── */}
      <div style={{
        flex: 1,
        background: "linear-gradient(150deg, #0f1b2d 0%, #0d2d4a 55%, #0f3460 100%)",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "64px",
        color: "#fff",
      }}>
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 48 }}>
          <img src="/banner.png" alt="BrainstormAI" style={{ height: 36 }} />
        </div>

        <Box
          fontSize="display-l"
          fontWeight="bold"
          color="inherit"
        >
          Turn content into<br />conversations
        </Box>

        <div style={{ marginTop: 16, marginBottom: 48, maxWidth: 400 }}>
          <Box fontSize="body-m" color="inherit">
            <span style={{ color: "#8ecae6" }}>
              Upload PDFs, paste URLs, or drop in text — BrainstormAI transforms your sources into podcasts, mind maps, and quizzes you can interact with.
            </span>
          </Box>
        </div>

        <SpaceBetween size="s">
          {FEATURES.map((f) => (
            <div key={f} style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "#0972d3",
                flexShrink: 0,
              }} />
              <Box fontSize="body-m" color="inherit">
                <span style={{ color: "#a8dadc" }}>{f}</span>
              </Box>
            </div>
          ))}
        </SpaceBetween>
      </div>

      {/* ── Form panel ── */}
      <div style={{
        width: 480,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "64px 52px",
        background: "var(--color-background-container-content, #fff)",
      }}>
        <SpaceBetween size="l">
          <div>
            <Box fontSize="heading-xl" fontWeight="bold">
              {title}
            </Box>
            <Box fontSize="body-m" color="text-body-secondary">
              {subtitle}
            </Box>
          </div>

          {error && <Alert type="error">{error}</Alert>}

          <Form>
            <SpaceBetween size="m">
              {(view === "login" || view === "register") && (
                <>
                  <FormField label="Email">
                    <Input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.detail.value)}
                      placeholder="you@example.com"
                      onKeyDown={(e) => e.detail.key === "Enter" && handle()}
                    />
                  </FormField>
                  <FormField label="Password">
                    <Input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.detail.value)}
                      placeholder="••••••••"
                      onKeyDown={(e) => e.detail.key === "Enter" && handle()}
                    />
                  </FormField>
                </>
              )}

              {view === "confirm" && (
                <FormField
                  label="Verification code"
                  description="Check your email for a 6-digit code"
                >
                  <Input
                    value={code}
                    onChange={(e) => setCode(e.detail.value)}
                    placeholder="123456"
                    onKeyDown={(e) => e.detail.key === "Enter" && handle()}
                  />
                </FormField>
              )}

              {view === "new_password" && (
                <FormField
                  label="New password"
                  description="Must be 8+ characters with upper, lower, and a number"
                >
                  <Input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.detail.value)}
                    placeholder="New password"
                    onKeyDown={(e) => e.detail.key === "Enter" && handle()}
                  />
                </FormField>
              )}
            </SpaceBetween>
          </Form>

          {/* Button + switch link — centered, outside Form to avoid Form's own layout */}
          <style>{`
            .login-primary-btn button[class*="button"][class*="variant-primary"] {
              background: #e07941 !important;
              border-color: #e07941 !important;
            }
            .login-primary-btn button[class*="button"][class*="variant-primary"]:hover {
              background: #c96730 !important;
              border-color: #c96730 !important;
            }
            .login-primary-btn button[class*="button"][class*="variant-primary"]:active {
              background: #b85a28 !important;
              border-color: #b85a28 !important;
            }
          `}</style>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
            <div className="login-primary-btn" style={{ width: "100%" }}>
              <Button variant="primary" loading={loading} onClick={handle} fullWidth>
                {primaryLabel}
              </Button>
            </div>
            <Box fontSize="body-s" color="text-body-secondary">
              {view === "login" && <>Don't have an account? <Link onFollow={() => setView("register")}>Create one</Link></>}
              {view === "register" && <>Already have an account? <Link onFollow={() => setView("login")}>Sign in</Link></>}
              {view === "confirm" && <Link onFollow={() => setView("login")}>Back to sign in</Link>}
            </Box>
          </div>

        </SpaceBetween>
      </div>
    </div>
  );
}
