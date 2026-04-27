import { useState } from "react";
import { useAuth } from "../auth/AuthContext";

type View = "login" | "register" | "confirm" | "new_password";

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
      if (view === "login")           { await login(email, password); }
      else if (view === "register")   { await register(email, password); setView("confirm"); }
      else if (view === "confirm")    { await confirmRegistration(email, code); await login(email, password); }
      else if (view === "new_password") { await confirmNewPassword(newPassword); }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  const titles: Record<View, [string, string]> = {
    login:        ["Welcome back", "Sign in to your BrainstormAI account"],
    register:     ["Create account", "Start turning content into knowledge"],
    confirm:      ["Check your email", "Enter the verification code we sent you"],
    new_password: ["Set a new password", "Your account requires a password change"],
  };
  const [title, subtitle] = titles[view];

  return (
    <div className="login-root">
      {/* Brand panel */}
      <div className="login-brand">
        <div className="login-brand-logo">
          <div className="login-brand-icon">🧠</div>
          <span style={{ fontSize: "1.3rem", fontWeight: 800, letterSpacing: "-0.3px" }}>BrainstormAI</span>
        </div>
        <h1>Turn content into<br />conversations</h1>
        <p>Upload PDFs, paste URLs, or drop in text — BrainstormAI transforms your sources into podcasts, mind maps, and quizzes you can interact with.</p>
        <div className="login-brand-features">
          {["AI-generated podcasts with two hosts", "Interactive Q&A mid-playback", "Mind maps and quizzes in seconds", "Multi-language support"].map((f) => (
            <div className="login-brand-feature" key={f}>
              <div className="login-brand-feature-dot" />
              {f}
            </div>
          ))}
        </div>
      </div>

      {/* Form panel */}
      <div className="login-form-panel">
        <p className="login-form-title">{title}</p>
        <p className="login-form-subtitle">{subtitle}</p>

        {error && <div className="login-error">{error}</div>}

        {(view === "login" || view === "register") && (
          <>
            <label className="login-input-label">Email</label>
            <input
              className="login-input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              onKeyDown={(e) => e.key === "Enter" && handle()}
            />
            <label className="login-input-label">Password</label>
            <input
              className="login-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              onKeyDown={(e) => e.key === "Enter" && handle()}
            />
          </>
        )}

        {view === "confirm" && (
          <>
            <label className="login-input-label">Verification code</label>
            <input
              className="login-input"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              onKeyDown={(e) => e.key === "Enter" && handle()}
            />
          </>
        )}

        {view === "new_password" && (
          <>
            <label className="login-input-label">New password</label>
            <input
              className="login-input"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="8+ chars, upper, lower, number"
              onKeyDown={(e) => e.key === "Enter" && handle()}
            />
          </>
        )}

        <button className="login-btn-primary" onClick={handle} disabled={loading}>
          {loading ? "Please wait…" :
           view === "login" ? "Sign in" :
           view === "register" ? "Create account" :
           view === "new_password" ? "Set password" : "Verify"}
        </button>

        <div className="login-switch-row">
          {view === "login" && (
            <>Don't have an account?{" "}
              <button className="login-btn-link" onClick={() => setView("register")}>Create one</button>
            </>
          )}
          {view === "register" && (
            <>Already have an account?{" "}
              <button className="login-btn-link" onClick={() => setView("login")}>Sign in</button>
            </>
          )}
          {view === "confirm" && (
            <button className="login-btn-link" onClick={() => setView("login")}>Back to sign in</button>
          )}
        </div>
      </div>
    </div>
  );
}
