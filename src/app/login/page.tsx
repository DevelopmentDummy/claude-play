"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const endpoint = isRegister ? "/api/auth/register" : "/api/auth/login";
      const body = isRegister
        ? { username, password, displayName: displayName || undefined }
        : { username, password };

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed");
        return;
      }

      router.push("/");
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, [isRegister, username, password, displayName, router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg)]">
      <div className="w-[380px] bg-surface border border-border/60 rounded-2xl p-8 shadow-2xl">
        <h1 className="text-xl font-semibold text-text text-center mb-1">
          Claude Bridge
        </h1>
        <p className="text-xs text-text-dim/60 text-center mb-6">
          {isRegister ? "새 계정을 만드세요" : "로그인하세요"}
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="text"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="px-3.5 py-2.5 rounded-xl text-sm text-text bg-[rgba(15,15,26,0.6)]
              border border-border/60 outline-none transition-all duration-fast
              focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-glow)]
              placeholder:text-text-dim/40"
            autoFocus
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="px-3.5 py-2.5 rounded-xl text-sm text-text bg-[rgba(15,15,26,0.6)]
              border border-border/60 outline-none transition-all duration-fast
              focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-glow)]
              placeholder:text-text-dim/40"
            required
          />
          {isRegister && (
            <input
              type="text"
              placeholder="Display Name (optional)"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="px-3.5 py-2.5 rounded-xl text-sm text-text bg-[rgba(15,15,26,0.6)]
                border border-border/60 outline-none transition-all duration-fast
                focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-glow)]
                placeholder:text-text-dim/40"
            />
          )}

          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="mt-1 px-5 py-2.5 rounded-xl text-sm font-medium text-white bg-accent
              border-none cursor-pointer shadow-[0_2px_12px_var(--accent-glow)]
              transition-all duration-fast
              hover:bg-accent-hover hover:-translate-y-px hover:shadow-[0_4px_20px_var(--accent-glow)]
              disabled:opacity-50 disabled:cursor-not-allowed disabled:translate-y-0"
          >
            {loading ? "..." : isRegister ? "Register" : "Login"}
          </button>
        </form>

        <div className="mt-5 text-center">
          <button
            onClick={() => { setIsRegister((v) => !v); setError(null); }}
            className="text-xs text-text-dim/50 hover:text-accent cursor-pointer bg-transparent border-none transition-colors"
          >
            {isRegister ? "Already have an account? Login" : "No account? Register"}
          </button>
        </div>
      </div>
    </div>
  );
}
