"use client";

import { useState, useEffect, FormEvent } from "react";
import { useRouter } from "next/navigation";

interface FormData {
  adminPassword: string;
  adminPasswordConfirm: string;
  comfyuiEnabled: boolean;
  comfyuiHost: string;
  comfyuiPort: string;
  comfyuiTested: boolean;
  geminiEnabled: boolean;
  geminiKey: string;
  geminiTested: boolean;
  civitaiEnabled: boolean;
  civitaiKey: string;
  ttsEdgeEnabled: boolean;
  ttsLocalEnabled: boolean;
}

interface StatusResponse {
  setupComplete: boolean;
  adminPassword?: boolean;
  comfyui?: boolean;
  comfyuiHost?: string;
  comfyuiPort?: number;
  geminiKey?: boolean;
  civitaiKey?: boolean;
  ttsEnabled?: boolean;
  localTtsEnabled?: boolean;
  port?: number;
}

const TOTAL_STEPS = 5;

const styles = {
  page: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100vh",
    background: "var(--bg)",
    padding: "20px",
  } as React.CSSProperties,
  container: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "20px",
    padding: "32px",
    borderRadius: "12px",
    background: "var(--surface)",
    backdropFilter: "blur(var(--glass-blur))",
    border: "1px solid var(--border)",
    boxShadow: "var(--shadow-lg)",
    width: "480px",
    maxWidth: "100%",
  } as React.CSSProperties,
  title: {
    fontSize: "20px",
    fontWeight: 600,
    color: "var(--text)",
    textAlign: "center" as const,
    marginBottom: "4px",
  } as React.CSSProperties,
  subtitle: {
    fontSize: "13px",
    color: "var(--text-dim)",
    textAlign: "center" as const,
  } as React.CSSProperties,
  input: {
    padding: "10px 14px",
    borderRadius: "8px",
    border: "1px solid var(--border)",
    background: "var(--surface-light)",
    color: "var(--text)",
    fontSize: "14px",
    outline: "none",
    width: "100%",
  } as React.CSSProperties,
  button: {
    padding: "10px",
    borderRadius: "8px",
    border: "none",
    background: "var(--accent)",
    color: "#fff",
    fontSize: "14px",
    fontWeight: 500,
    cursor: "pointer",
    transition: "var(--transition-fast)",
  } as React.CSSProperties,
  buttonDisabled: {
    opacity: 0.5,
    cursor: "not-allowed",
  } as React.CSSProperties,
  buttonSecondary: {
    padding: "10px",
    borderRadius: "8px",
    border: "1px solid var(--border)",
    background: "transparent",
    color: "var(--text)",
    fontSize: "14px",
    fontWeight: 500,
    cursor: "pointer",
    transition: "var(--transition-fast)",
  } as React.CSSProperties,
  label: {
    fontSize: "14px",
    fontWeight: 500,
    color: "var(--text)",
    marginBottom: "4px",
  } as React.CSSProperties,
  hint: {
    fontSize: "12px",
    color: "var(--text-dim)",
    marginTop: "2px",
  } as React.CSSProperties,
  error: {
    color: "var(--error)",
    fontSize: "13px",
  } as React.CSSProperties,
  success: {
    color: "var(--success)",
    fontSize: "13px",
  } as React.CSSProperties,
  fieldGroup: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "8px",
  } as React.CSSProperties,
  navRow: {
    display: "flex",
    gap: "10px",
    marginTop: "4px",
  } as React.CSSProperties,
  toggleRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "10px 14px",
    borderRadius: "8px",
    border: "1px solid var(--border)",
    background: "var(--surface-light)",
  } as React.CSSProperties,
  notice: {
    fontSize: "13px",
    color: "var(--warning)",
    textAlign: "center" as const,
    padding: "10px",
    borderRadius: "8px",
    border: "1px solid rgba(255, 166, 77, 0.3)",
    background: "rgba(255, 166, 77, 0.08)",
  } as React.CSSProperties,
  summaryRow: {
    display: "flex",
    justifyContent: "space-between",
    padding: "8px 0",
    borderBottom: "1px solid var(--border)",
    fontSize: "14px",
  } as React.CSSProperties,
  summaryLabel: {
    color: "var(--text-dim)",
  } as React.CSSProperties,
  summaryValue: {
    color: "var(--text)",
    fontWeight: 500,
  } as React.CSSProperties,
};

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={() => !disabled && onChange(!checked)}
      style={{
        width: "42px",
        height: "24px",
        borderRadius: "12px",
        border: "none",
        background: checked ? "var(--accent)" : "var(--border)",
        position: "relative",
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "var(--transition-fast)",
        flexShrink: 0,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <div
        style={{
          width: "18px",
          height: "18px",
          borderRadius: "50%",
          background: "#fff",
          position: "absolute",
          top: "3px",
          left: checked ? "21px" : "3px",
          transition: "var(--transition-fast)",
        }}
      />
    </button>
  );
}

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "8px", marginBottom: "4px" }}>
      {Array.from({ length: total }, (_, i) => {
        const step = i + 1;
        const isActive = step === current;
        const isDone = step < current;
        return (
          <div key={step} style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <div
              style={{
                width: "28px",
                height: "28px",
                borderRadius: "50%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "12px",
                fontWeight: 600,
                background: isActive ? "var(--accent)" : isDone ? "rgba(124, 111, 255, 0.3)" : "var(--surface-light)",
                color: isActive || isDone ? "#fff" : "var(--text-dim)",
                border: isActive ? "2px solid var(--accent)" : "1px solid var(--border)",
                transition: "var(--transition-fast)",
              }}
            >
              {isDone ? "\u2713" : step}
            </div>
            {step < total && (
              <div
                style={{
                  width: "24px",
                  height: "2px",
                  background: isDone ? "rgba(124, 111, 255, 0.5)" : "var(--border)",
                  borderRadius: "1px",
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function SetupPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [isReconfigure, setIsReconfigure] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  const [form, setForm] = useState<FormData>({
    adminPassword: "",
    adminPasswordConfirm: "",
    comfyuiEnabled: false,
    comfyuiHost: "127.0.0.1",
    comfyuiPort: "8188",
    comfyuiTested: false,
    geminiEnabled: false,
    geminiKey: "",
    geminiTested: false,
    civitaiEnabled: false,
    civitaiKey: "",
    ttsEdgeEnabled: true,
    ttsLocalEnabled: false,
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [comfyuiTestResult, setComfyuiTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [geminiTestResult, setGeminiTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [serverRestarting, setServerRestarting] = useState(false);
  const [existingStatus, setExistingStatus] = useState<StatusResponse | null>(null);

  useEffect(() => {
    fetch("/api/setup/status")
      .then((r) => r.json())
      .then((data: StatusResponse) => {
        setExistingStatus(data);
        if (data.setupComplete) {
          setIsReconfigure(true);
          setForm((prev) => ({
            ...prev,
            comfyuiEnabled: !!data.comfyui,
            comfyuiHost: data.comfyuiHost || "127.0.0.1",
            comfyuiPort: String(data.comfyuiPort || 8188),
            geminiEnabled: !!data.geminiKey,
            civitaiEnabled: !!data.civitaiKey,
            ttsEdgeEnabled: data.ttsEnabled !== false,
            ttsLocalEnabled: !!data.localTtsEnabled,
          }));
        }
      })
      .catch(() => {})
      .finally(() => setInitialLoading(false));
  }, []);

  function updateForm(patch: Partial<FormData>) {
    setForm((prev) => ({ ...prev, ...patch }));
    setErrors({});
  }

  function validateStep1(): boolean {
    const errs: Record<string, string> = {};
    if (!isReconfigure) {
      if (!form.adminPassword) {
        errs.adminPassword = "비밀번호를 입력해주세요.";
      } else if (form.adminPassword.length < 4) {
        errs.adminPassword = "비밀번호는 최소 4자 이상이어야 합니다.";
      }
      if (form.adminPassword !== form.adminPasswordConfirm) {
        errs.adminPasswordConfirm = "비밀번호가 일치하지 않습니다.";
      }
    } else {
      if (form.adminPassword && form.adminPassword.length < 4) {
        errs.adminPassword = "비밀번호는 최소 4자 이상이어야 합니다.";
      }
      if (form.adminPassword && form.adminPassword !== form.adminPasswordConfirm) {
        errs.adminPasswordConfirm = "비밀번호가 일치하지 않습니다.";
      }
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function handleNext() {
    if (step === 1 && !validateStep1()) return;
    setStep((s) => Math.min(s + 1, TOTAL_STEPS));
  }

  function handleBack() {
    setStep((s) => Math.max(s - 1, 1));
  }

  async function testComfyui() {
    setLoading(true);
    setComfyuiTestResult(null);
    try {
      const res = await fetch("/api/setup/test-comfyui", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host: form.comfyuiHost, port: parseInt(form.comfyuiPort) }),
      });
      const data = await res.json();
      if (data.ok) {
        setComfyuiTestResult({ ok: true, message: "ComfyUI에 성공적으로 연결되었습니다." });
        updateForm({ comfyuiTested: true });
      } else {
        setComfyuiTestResult({ ok: false, message: data.error || "연결에 실패했습니다." });
      }
    } catch {
      setComfyuiTestResult({ ok: false, message: "연결 요청에 실패했습니다." });
    } finally {
      setLoading(false);
    }
  }

  async function testGemini() {
    setLoading(true);
    setGeminiTestResult(null);
    try {
      const res = await fetch("/api/setup/test-gemini", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: form.geminiKey }),
      });
      const data = await res.json();
      if (data.ok) {
        setGeminiTestResult({ ok: true, message: "Gemini API 키가 유효합니다." });
        updateForm({ geminiTested: true });
      } else {
        setGeminiTestResult({ ok: false, message: data.error || "API 키 검증에 실패했습니다." });
      }
    } catch {
      setGeminiTestResult({ ok: false, message: "검증 요청에 실패했습니다." });
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {};

      if (form.adminPassword) {
        payload.adminPassword = form.adminPassword;
      }
      payload.comfyuiEnabled = form.comfyuiEnabled;
      if (form.comfyuiEnabled) {
        payload.comfyuiHost = form.comfyuiHost;
        payload.comfyuiPort = form.comfyuiPort;
      }
      if (form.geminiEnabled && form.geminiKey) {
        payload.geminiKey = form.geminiKey;
      }
      if (form.civitaiEnabled && form.civitaiKey) {
        payload.civitaiKey = form.civitaiKey;
      }
      payload.ttsEnabled = form.ttsEdgeEnabled;

      const res = await fetch("/api/setup/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setErrors({ save: data?.error || "저장에 실패했습니다." });
        setSaving(false);
        return;
      }

      setServerRestarting(true);
      setSaving(false);
    } catch {
      setErrors({ save: "저장 요청에 실패했습니다." });
      setSaving(false);
    }
  }

  if (initialLoading) {
    return (
      <div style={styles.page}>
        <div style={{ ...styles.container, alignItems: "center" }}>
          <p style={{ color: "var(--text-dim)", fontSize: "14px" }}>Loading...</p>
        </div>
      </div>
    );
  }

  if (serverRestarting) {
    return (
      <div style={styles.page}>
        <div style={{ ...styles.container, alignItems: "center", gap: "16px" }}>
          <h1 style={styles.title}>Claude Bridge</h1>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "12px" }}>
            <div style={{ fontSize: "32px", color: "var(--accent)" }}>&#10003;</div>
            <p style={{ color: "var(--text)", fontSize: "16px", fontWeight: 600 }}>
              설정이 저장되었습니다!
            </p>
            <p style={{ color: "var(--text-dim)", fontSize: "14px", textAlign: "center", lineHeight: "1.6" }}>
              서버를 재시작해야 설정이 적용됩니다.<br />
              터미널을 닫고 <strong>start.bat</strong> 또는 <strong>start-dev.bat</strong>으로<br />
              서버를 다시 시작해주세요.
            </p>
          </div>
        </div>
      </div>
    );
  }

  function renderStep1() {
    return (
      <div style={styles.fieldGroup}>
        <h2 style={{ fontSize: "16px", fontWeight: 600, color: "var(--text)" }}>관리자 비밀번호</h2>
        <p style={styles.hint}>
          서비스 접근을 보호하기 위한 비밀번호를 설정합니다.
        </p>

        {isReconfigure && existingStatus?.adminPassword && (
          <p style={{ fontSize: "13px", color: "var(--success)" }}>
            비밀번호가 이미 설정되어 있습니다. 변경하려면 새 비밀번호를 입력하세요.
          </p>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <label style={styles.label}>비밀번호</label>
          <input
            type="password"
            value={form.adminPassword}
            onChange={(e) => updateForm({ adminPassword: e.target.value })}
            placeholder={isReconfigure ? "변경하려면 입력 (빈칸이면 유지)" : "비밀번호 입력"}
            autoFocus
            style={styles.input}
          />
          {errors.adminPassword && <p style={styles.error}>{errors.adminPassword}</p>}
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <label style={styles.label}>비밀번호 확인</label>
          <input
            type="password"
            value={form.adminPasswordConfirm}
            onChange={(e) => updateForm({ adminPasswordConfirm: e.target.value })}
            placeholder="비밀번호 재입력"
            style={styles.input}
          />
          {errors.adminPasswordConfirm && <p style={styles.error}>{errors.adminPasswordConfirm}</p>}
        </div>

        <p style={styles.hint}>최소 4자 이상을 권장합니다.</p>
      </div>
    );
  }

  function renderStep2() {
    return (
      <div style={styles.fieldGroup}>
        <h2 style={{ fontSize: "16px", fontWeight: 600, color: "var(--text)" }}>ComfyUI 연결</h2>
        <p style={styles.hint}>이미지 생성에 ComfyUI를 사용할 수 있습니다.</p>

        <div style={styles.toggleRow}>
          <span style={{ fontSize: "14px", color: "var(--text)" }}>ComfyUI를 사용하시나요?</span>
          <Toggle
            checked={form.comfyuiEnabled}
            onChange={(v) => {
              updateForm({ comfyuiEnabled: v, comfyuiTested: false });
              setComfyuiTestResult(null);
            }}
          />
        </div>

        {form.comfyuiEnabled && (
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            <div style={{ display: "flex", gap: "10px" }}>
              <div style={{ flex: 2 }}>
                <label style={styles.label}>Host</label>
                <input
                  value={form.comfyuiHost}
                  onChange={(e) => updateForm({ comfyuiHost: e.target.value, comfyuiTested: false })}
                  style={styles.input}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={styles.label}>Port</label>
                <input
                  value={form.comfyuiPort}
                  onChange={(e) => updateForm({ comfyuiPort: e.target.value, comfyuiTested: false })}
                  style={styles.input}
                />
              </div>
            </div>

            <p style={{ fontSize: "13px", color: "var(--text-dim)" }}>
              ComfyUI 서비스를 실행한 후 아래 버튼을 눌러주세요.
            </p>

            <button
              type="button"
              onClick={testComfyui}
              disabled={loading}
              style={{
                ...styles.button,
                ...(loading ? styles.buttonDisabled : {}),
              }}
            >
              {loading ? "테스트 중..." : "연결 테스트"}
            </button>

            {comfyuiTestResult && (
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                <p style={comfyuiTestResult.ok ? styles.success : styles.error}>
                  {comfyuiTestResult.message}
                </p>
                {!comfyuiTestResult.ok && (
                  <div style={{ display: "flex", gap: "8px" }}>
                    <button
                      type="button"
                      onClick={testComfyui}
                      style={{ ...styles.buttonSecondary, flex: 1, fontSize: "13px" }}
                    >
                      다시 시도
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        updateForm({ comfyuiEnabled: false });
                        setComfyuiTestResult(null);
                      }}
                      style={{ ...styles.buttonSecondary, flex: 1, fontSize: "13px" }}
                    >
                      나중에 설정
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  function renderStep3() {
    return (
      <div style={styles.fieldGroup}>
        <h2 style={{ fontSize: "16px", fontWeight: 600, color: "var(--text)" }}>API 키</h2>
        <p style={styles.hint}>외부 서비스 연동을 위한 API 키를 설정합니다.</p>

        {/* Gemini */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <div style={styles.toggleRow}>
            <span style={{ fontSize: "14px", color: "var(--text)" }}>Gemini 이미지 생성을 사용하시나요?</span>
            <Toggle
              checked={form.geminiEnabled}
              onChange={(v) => {
                updateForm({ geminiEnabled: v, geminiTested: false });
                setGeminiTestResult(null);
              }}
            />
          </div>

          {form.geminiEnabled && (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px", paddingLeft: "8px" }}>
              {isReconfigure && existingStatus?.geminiKey && !form.geminiKey && (
                <p style={{ fontSize: "12px", color: "var(--success)" }}>API 키가 이미 설정되어 있습니다.</p>
              )}
              <input
                type="password"
                value={form.geminiKey}
                onChange={(e) => updateForm({ geminiKey: e.target.value, geminiTested: false })}
                placeholder={isReconfigure && existingStatus?.geminiKey ? "변경하려면 새 키 입력" : "Gemini API Key"}
                style={styles.input}
              />
              {form.geminiKey && (
                <button
                  type="button"
                  onClick={testGemini}
                  disabled={loading || !form.geminiKey}
                  style={{
                    ...styles.button,
                    ...(loading || !form.geminiKey ? styles.buttonDisabled : {}),
                    fontSize: "13px",
                  }}
                >
                  {loading ? "검증 중..." : "키 검증"}
                </button>
              )}
              {geminiTestResult && (
                <p style={geminiTestResult.ok ? styles.success : styles.error}>
                  {geminiTestResult.message}
                </p>
              )}
            </div>
          )}
        </div>

        {/* CivitAI */}
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <div style={styles.toggleRow}>
            <span style={{ fontSize: "14px", color: "var(--text)" }}>CivitAI에서 모델을 다운로드하시겠습니까?</span>
            <Toggle
              checked={form.civitaiEnabled}
              onChange={(v) => updateForm({ civitaiEnabled: v })}
            />
          </div>

          {form.civitaiEnabled && (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px", paddingLeft: "8px" }}>
              {isReconfigure && existingStatus?.civitaiKey && !form.civitaiKey && (
                <p style={{ fontSize: "12px", color: "var(--success)" }}>API 키가 이미 설정되어 있습니다.</p>
              )}
              <input
                type="password"
                value={form.civitaiKey}
                onChange={(e) => updateForm({ civitaiKey: e.target.value })}
                placeholder={isReconfigure && existingStatus?.civitaiKey ? "변경하려면 새 키 입력" : "CivitAI API Key"}
                style={styles.input}
              />
              <p style={styles.hint}>CivitAI API 키는 별도 검증 없이 저장됩니다.</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  function renderStep4() {
    return (
      <div style={styles.fieldGroup}>
        <h2 style={{ fontSize: "16px", fontWeight: 600, color: "var(--text)" }}>TTS 설정</h2>
        <p style={styles.hint}>텍스트 음성 변환(TTS) 기능을 설정합니다.</p>

        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <div>
            <div style={styles.toggleRow}>
              <span style={{ fontSize: "14px", color: "var(--text)" }}>Edge TTS (클라우드, 무료)</span>
              <Toggle
                checked={form.ttsEdgeEnabled}
                onChange={(v) => updateForm({ ttsEdgeEnabled: v })}
              />
            </div>
            <p style={{ ...styles.hint, padding: "4px 14px 0" }}>
              Microsoft Edge TTS를 사용합니다. 인터넷 연결이 필요하며, 다양한 음성을 무료로 사용할 수 있습니다.
            </p>
          </div>

          <div>
            <div style={styles.toggleRow}>
              <span style={{ fontSize: "14px", color: "var(--text)" }}>Local TTS (GPU, 음성 클로닝)</span>
              <Toggle
                checked={form.ttsLocalEnabled}
                onChange={(v) => updateForm({ ttsLocalEnabled: v })}
              />
            </div>
            <p style={{ ...styles.hint, padding: "4px 14px 0" }}>
              Qwen3-TTS 모델 기반 로컬 음성 합성 (음성 클로닝 지원). GPU 필수. 첫 사용 시 HuggingFace에서 모델을 자동 다운로드합니다 (~3.5GB).
            </p>
          </div>
        </div>
      </div>
    );
  }

  function renderStep5() {
    return (
      <div style={styles.fieldGroup}>
        <h2 style={{ fontSize: "16px", fontWeight: 600, color: "var(--text)" }}>설정 확인</h2>
        <p style={styles.hint}>아래 설정을 확인하고 저장하세요.</p>

        <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          <div style={styles.summaryRow}>
            <span style={styles.summaryLabel}>관리자 비밀번호</span>
            <span style={styles.summaryValue}>
              {form.adminPassword
                ? "새로 설정"
                : isReconfigure && existingStatus?.adminPassword
                ? "기존 유지"
                : "미설정"}
            </span>
          </div>

          <div style={styles.summaryRow}>
            <span style={styles.summaryLabel}>ComfyUI</span>
            <span style={styles.summaryValue}>
              {form.comfyuiEnabled
                ? `${form.comfyuiHost}:${form.comfyuiPort}${form.comfyuiTested ? " (테스트 완료)" : ""}`
                : "사용 안 함"}
            </span>
          </div>

          <div style={styles.summaryRow}>
            <span style={styles.summaryLabel}>Gemini API</span>
            <span style={styles.summaryValue}>
              {form.geminiEnabled
                ? form.geminiKey
                  ? form.geminiTested
                    ? "설정 완료 (검증됨)"
                    : "설정 완료"
                  : isReconfigure && existingStatus?.geminiKey
                  ? "기존 유지"
                  : "키 미입력"
                : "사용 안 함"}
            </span>
          </div>

          <div style={styles.summaryRow}>
            <span style={styles.summaryLabel}>CivitAI API</span>
            <span style={styles.summaryValue}>
              {form.civitaiEnabled
                ? form.civitaiKey
                  ? "설정 완료"
                  : isReconfigure && existingStatus?.civitaiKey
                  ? "기존 유지"
                  : "키 미입력"
                : "사용 안 함"}
            </span>
          </div>

          <div style={styles.summaryRow}>
            <span style={styles.summaryLabel}>Edge TTS</span>
            <span style={styles.summaryValue}>
              {form.ttsEdgeEnabled ? "사용" : "사용 안 함"}
            </span>
          </div>

          <div style={{ ...styles.summaryRow, borderBottom: "none" }}>
            <span style={styles.summaryLabel}>Local TTS</span>
            <span style={styles.summaryValue}>
              {form.ttsLocalEnabled ? "사용" : "사용 안 함"}
            </span>
          </div>
        </div>

        {errors.save && <p style={styles.error}>{errors.save}</p>}
      </div>
    );
  }

  const stepRenderers = [renderStep1, renderStep2, renderStep3, renderStep4, renderStep5];

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        <h1 style={styles.title}>Claude Bridge Setup</h1>

        {isReconfigure && (
          <p style={styles.notice as React.CSSProperties}>
            설정이 이미 완료되었습니다. 변경하려면 수정 후 저장하세요.
          </p>
        )}

        <StepIndicator current={step} total={TOTAL_STEPS} />

        {stepRenderers[step - 1]()}

        <div style={styles.navRow}>
          {step > 1 && (
            <button
              type="button"
              onClick={handleBack}
              style={{ ...styles.buttonSecondary, flex: 1 }}
            >
              이전
            </button>
          )}

          {step < TOTAL_STEPS ? (
            <button
              type="button"
              onClick={handleNext}
              style={{ ...styles.button, flex: 1 }}
            >
              다음
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              style={{
                ...styles.button,
                flex: 1,
                ...(saving ? styles.buttonDisabled : {}),
              }}
            >
              {saving ? "저장 중..." : "설정 완료"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
