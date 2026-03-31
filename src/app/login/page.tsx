"use client";

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (res.ok) {
        // Full page navigation to ensure middleware re-evaluates auth cookie
        window.location.href = "/";
        return;
      }

      const data = await res.json().catch(() => null);
      if (res.status === 429) {
        setError(data?.error || "Too many attempts. Try again later.");
      } else {
        setError("Incorrect password");
      }
    } catch {
      setError("Connection failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        background: "var(--bg)",
      }}
    >
      <form
        onSubmit={handleSubmit}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "16px",
          padding: "32px",
          borderRadius: "12px",
          background: "var(--surface)",
          backdropFilter: "blur(var(--glass-blur))",
          border: "1px solid var(--border)",
          boxShadow: "var(--shadow-lg)",
          width: "340px",
        }}
      >
        <h1
          style={{
            fontSize: "20px",
            fontWeight: 600,
            color: "var(--text)",
            textAlign: "center",
            marginBottom: "8px",
          }}
        >
          Claude Play
        </h1>

        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoFocus
          disabled={loading}
          style={{
            padding: "10px 14px",
            borderRadius: "8px",
            border: "1px solid var(--border)",
            background: "var(--surface-light)",
            color: "var(--text)",
            fontSize: "14px",
            outline: "none",
          }}
        />

        {error && (
          <p style={{ color: "var(--error)", fontSize: "13px", textAlign: "center" }}>
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading || !password}
          style={{
            padding: "10px",
            borderRadius: "8px",
            border: "none",
            background: "var(--accent)",
            color: "#fff",
            fontSize: "14px",
            fontWeight: 500,
            cursor: loading || !password ? "not-allowed" : "pointer",
            opacity: loading || !password ? 0.5 : 1,
            transition: "var(--transition-fast)",
          }}
        >
          {loading ? "..." : "Login"}
        </button>
      </form>
    </div>
  );
}
