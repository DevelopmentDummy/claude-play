"use client";

import { useState } from "react";
import type { ToolAnswer } from "@/lib/session-instance";

type Question = {
  question: string;
  header: string;
  multiSelect: boolean;
  options: Array<{ label: string; description?: string }>;
};

interface Props {
  toolUseId: string | undefined;
  input: { questions: Question[] };
  answer?: ToolAnswer;
  sessionId: string;
}

const OTHER_LABEL = "Other";

// ─── Stacked Summary (read-only, answer prop present) ──────────────────────

function StackedSummary({
  questions,
  answer,
}: {
  questions: Question[];
  answer: ToolAnswer;
}) {
  return (
    <div
      className="mt-2 rounded-xl overflow-hidden w-full"
      style={{
        background: "rgba(22, 33, 62, 0.55)",
        border: "1px solid rgba(42, 58, 94, 0.5)",
        boxShadow: "0 2px 12px rgba(0,0,0,0.18)",
      }}
    >
      {questions.map((q, qIdx) => {
        const ans = answer.answers[q.question];
        const selected = q.multiSelect
          ? Array.isArray(ans)
            ? ans
            : []
          : typeof ans === "string"
          ? [ans]
          : [];
        const otherNote = answer.notes?.[q.question];
        const freeform = answer.notes?._freeform;
        const hasOtherSelected = selected.includes(OTHER_LABEL);

        return (
          <div key={qIdx}>
            {qIdx > 0 && (
              <div
                style={{
                  height: "1px",
                  background:
                    "linear-gradient(90deg, transparent, rgba(124,111,255,0.15) 20%, rgba(42,58,94,0.5) 50%, rgba(124,111,255,0.15) 80%, transparent)",
                }}
              />
            )}
            <div className="px-3 py-2.5">
              {/* Question header */}
              <div className="flex items-center gap-1.5 mb-2">
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                  className="shrink-0 mt-px"
                >
                  <circle cx="5" cy="5" r="4.5" fill="rgba(77,255,145,0.15)" stroke="rgba(77,255,145,0.6)" strokeWidth="1" />
                  <path d="M3 5l1.4 1.4L7 3.5" stroke="rgba(77,255,145,0.9)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span
                  className="text-[10px] font-semibold tracking-widest uppercase"
                  style={{ color: "rgba(77,255,145,0.75)" }}
                >
                  {q.header}
                </span>
              </div>

              {/* Selected options */}
              <div className="space-y-0.5 pl-1">
                {q.options.map((opt) => {
                  const isSel = selected.includes(opt.label);
                  if (!isSel) return null;
                  return (
                    <div
                      key={opt.label}
                      className="flex items-center gap-2 px-2 py-1 rounded-md text-xs"
                      style={{
                        background: "rgba(77,255,145,0.06)",
                        color: "rgba(232,232,240,0.9)",
                      }}
                    >
                      <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className="shrink-0">
                        <path d="M1.5 4l2 2 3-3.5" stroke="rgba(77,255,145,0.8)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <span className="font-medium">{opt.label}</span>
                    </div>
                  );
                })}

                {/* Other selected */}
                {hasOtherSelected && (
                  <div
                    className="flex items-center gap-2 px-2 py-1 rounded-md text-xs"
                    style={{
                      background: "rgba(77,255,145,0.06)",
                      color: "rgba(232,232,240,0.9)",
                    }}
                  >
                    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className="shrink-0">
                      <path d="M1.5 4l2 2 3-3.5" stroke="rgba(77,255,145,0.8)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span className="font-medium">
                      Other{otherNote ? <> &rarr; <em className="not-italic opacity-80">&ldquo;{otherNote}&rdquo;</em></> : ""}
                    </span>
                  </div>
                )}

                {/* Freeform chat answer (first question only) */}
                {freeform && qIdx === 0 && (
                  <div
                    className="flex items-start gap-2 px-2 py-1 rounded-md text-xs mt-1"
                    style={{ color: "rgba(136,136,160,0.9)" }}
                  >
                    <span className="shrink-0 mt-0.5">💬</span>
                    <span className="italic">&ldquo;{freeform}&rdquo;</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Dot step indicator ─────────────────────────────────────────────────────

function StepDots({
  total,
  current,
}: {
  total: number;
  current: number;
}) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2">
        {Array.from({ length: total }, (_, i) => {
          const done = i < current;
          const active = i === current;
          return (
            <span
              key={i}
              style={{
                display: "inline-block",
                width: active ? 18 : 6,
                height: 6,
                borderRadius: 3,
                background: done
                  ? "rgba(77,255,145,0.7)"
                  : active
                  ? "var(--accent)"
                  : "rgba(42,58,94,0.7)",
                boxShadow: active ? "0 0 6px rgba(124,111,255,0.5)" : "none",
                transition: "width 0.2s ease, background 0.2s ease",
              }}
            />
          );
        })}
      </div>
      <span
        className="text-[10px] tabular-nums"
        style={{ color: "rgba(136,136,160,0.7)" }}
      >
        {current + 1}&thinsp;/&thinsp;{total}
      </span>
    </div>
  );
}

// ─── Option button ──────────────────────────────────────────────────────────

function OptionButton({
  label,
  description,
  selected,
  multiSelect,
  onClick,
}: {
  label: string;
  description?: string;
  selected: boolean;
  multiSelect: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left flex items-start gap-2.5 px-2.5 py-2 rounded-lg transition-all duration-fast"
      style={{
        border: selected
          ? "1px solid rgba(124,111,255,0.55)"
          : "1px solid rgba(42,58,94,0.45)",
        background: selected
          ? "rgba(124,111,255,0.1)"
          : "rgba(22,33,62,0.3)",
        boxShadow: selected ? "0 0 0 1px rgba(124,111,255,0.08) inset" : "none",
      }}
    >
      {/* Radio / checkbox indicator */}
      <span
        className="shrink-0 mt-0.5"
        style={{
          width: 14,
          height: 14,
          borderRadius: multiSelect ? 3 : 7,
          border: selected
            ? "2px solid rgba(124,111,255,0.9)"
            : "2px solid rgba(42,58,94,0.8)",
          background: selected ? "rgba(124,111,255,0.25)" : "transparent",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          transition: "all 0.15s ease",
          flexShrink: 0,
        }}
      >
        {selected && (
          <span
            style={{
              display: "block",
              width: 6,
              height: 6,
              borderRadius: multiSelect ? 1 : 3,
              background: "rgba(124,111,255,0.95)",
            }}
          />
        )}
      </span>

      <span className="flex-1 min-w-0">
        <span
          className="text-xs font-medium"
          style={{
            color: selected ? "rgba(232,232,240,0.95)" : "rgba(136,136,160,0.85)",
          }}
        >
          {label}
        </span>
        {description && (
          <span
            className="block text-[11px] mt-0.5 leading-relaxed"
            style={{ color: "rgba(136,136,160,0.6)" }}
          >
            {description}
          </span>
        )}
      </span>
    </button>
  );
}

// ─── Wizard (main interactive mode) ────────────────────────────────────────

export default function InteractiveQuestionCard({
  toolUseId,
  input,
  answer,
  sessionId,
}: Props) {
  const questions = input.questions;
  const [step, setStep] = useState(0);
  const [selections, setSelections] = useState<
    Record<string, string | string[]>
  >({});
  const [otherTexts, setOtherTexts] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [otherDirty, setOtherDirty] = useState<Record<string, boolean>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);

  // ── Stacked summary mode ────────────────────────────────────────────────
  if (answer) {
    return <StackedSummary questions={questions} answer={answer} />;
  }

  // ── Wizard state ────────────────────────────────────────────────────────
  const q = questions[step];
  const qKey = q.question;
  const isLastStep = step === questions.length - 1;
  const isMulti = questions.length > 1;

  const isCurrentValid = (): boolean => {
    const sel = selections[qKey];
    if (q.multiSelect) {
      if (!Array.isArray(sel) || sel.length === 0) return false;
      if (sel.includes(OTHER_LABEL) && !otherTexts[qKey]?.trim()) return false;
    } else {
      if (!sel || typeof sel !== "string") return false;
      if (sel === OTHER_LABEL && !otherTexts[qKey]?.trim()) return false;
    }
    return true;
  };

  const toggleOption = (label: string): void => {
    setSelections((prev) => {
      if (q.multiSelect) {
        const cur = (prev[qKey] as string[]) || [];
        const next = cur.includes(label)
          ? cur.filter((x) => x !== label)
          : [...cur, label];
        return { ...prev, [qKey]: next };
      } else {
        return { ...prev, [qKey]: label };
      }
    });
  };

  const isSelected = (label: string): boolean => {
    const sel = selections[qKey];
    if (q.multiSelect) return Array.isArray(sel) && sel.includes(label);
    return sel === label;
  };

  const otherSelected = isSelected(OTHER_LABEL);
  const otherEmpty = !otherTexts[qKey]?.trim();
  const otherInvalid = otherSelected && otherEmpty && (otherDirty[qKey] ?? false);

  const handleNext = (): void => {
    if (!isCurrentValid()) {
      // Mark other as dirty to show red border
      if (otherSelected && otherEmpty) {
        setOtherDirty((p) => ({ ...p, [qKey]: true }));
      }
      return;
    }
    if (!isLastStep) {
      setStep(step + 1);
    } else {
      void handleSubmit();
    }
  };

  const handlePrev = (): void => {
    if (step > 0) setStep(step - 1);
  };

  const handleSubmit = async (): Promise<void> => {
    if (!toolUseId) {
      console.warn(
        "[InteractiveQuestionCard] toolUseId missing — cannot submit"
      );
      return;
    }
    setSubmitting(true);
    try {
      const finalAnswer: ToolAnswer = {
        answers: selections,
        ...(Object.keys(otherTexts).length > 0 ? { notes: otherTexts } : {}),
      };
      const res = await fetch(`/api/sessions/${sessionId}/tool-answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolUseId, answer: finalAnswer }),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => res.statusText);
        console.error(`[InteractiveQuestionCard] submit returned ${res.status}: ${errBody}`);
        setSubmitError(`제출 실패 (${res.status})`);
      }
    } catch (err) {
      console.error("[InteractiveQuestionCard] submit failed:", err);
      setSubmitError("네트워크 오류로 제출 실패");
    } finally {
      setSubmitting(false);
    }
  };

  const valid = isCurrentValid();

  return (
    <div
      className="mt-2 rounded-xl overflow-hidden w-full"
      style={{
        background: "rgba(22, 33, 62, 0.55)",
        border: "1px solid rgba(42, 58, 94, 0.5)",
        boxShadow: "0 2px 16px rgba(0,0,0,0.2)",
      }}
    >
      {/* Top accent stripe */}
      <div
        style={{
          height: 2,
          background:
            "linear-gradient(90deg, transparent, rgba(124,111,255,0.6) 30%, rgba(149,137,255,0.4) 70%, transparent)",
        }}
      />

      <div className="px-3.5 py-3">
        {/* Step dots — only for multi-question wizard */}
        {isMulti && (
          <StepDots total={questions.length} current={step} />
        )}

        {/* Question header */}
        <div className="flex items-baseline gap-2 mb-1">
          <span
            className="text-[10px] font-semibold tracking-widest uppercase"
            style={{ color: "rgba(124,111,255,0.75)" }}
          >
            {q.header}
          </span>
          {q.multiSelect && (
            <span
              className="text-[10px]"
              style={{ color: "rgba(136,136,160,0.55)" }}
            >
              여러 개 선택 가능
            </span>
          )}
        </div>

        {/* Question text */}
        <p
          className="text-sm mb-3 leading-snug"
          style={{ color: "rgba(232,232,240,0.88)" }}
        >
          {q.question}
        </p>

        {/* Options */}
        <div className="space-y-1.5">
          {q.options.map((opt) => (
            <OptionButton
              key={opt.label}
              label={opt.label}
              description={opt.description}
              selected={isSelected(opt.label)}
              multiSelect={q.multiSelect}
              onClick={() => toggleOption(opt.label)}
            />
          ))}

          {/* Other option — skip if AI already defined an option with same label */}
          {!q.options.some(opt => opt.label === OTHER_LABEL) && (
          <div
            className="flex items-center gap-2 px-2.5 py-2 rounded-lg transition-all duration-fast"
            style={{
              border: otherSelected
                ? "1px solid rgba(124,111,255,0.55)"
                : "1px solid rgba(42,58,94,0.45)",
              background: otherSelected
                ? "rgba(124,111,255,0.1)"
                : "rgba(22,33,62,0.3)",
            }}
          >
            {/* Other toggle button */}
            <button
              type="button"
              onClick={() => toggleOption(OTHER_LABEL)}
              className="shrink-0"
              style={{
                width: 14,
                height: 14,
                borderRadius: q.multiSelect ? 3 : 7,
                border: otherSelected
                  ? "2px solid rgba(124,111,255,0.9)"
                  : "2px solid rgba(42,58,94,0.8)",
                background: otherSelected
                  ? "rgba(124,111,255,0.25)"
                  : "transparent",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "all 0.15s ease",
                cursor: "pointer",
              }}
            >
              {otherSelected && (
                <span
                  style={{
                    display: "block",
                    width: 6,
                    height: 6,
                    borderRadius: q.multiSelect ? 1 : 3,
                    background: "rgba(124,111,255,0.95)",
                  }}
                />
              )}
            </button>

            <span
              className="text-xs font-medium shrink-0"
              style={{
                color: otherSelected
                  ? "rgba(232,232,240,0.95)"
                  : "rgba(136,136,160,0.85)",
              }}
            >
              Other
            </span>

            {/* Text input */}
            <input
              type="text"
              value={otherTexts[qKey] || ""}
              onChange={(e) => {
                setOtherTexts((prev) => ({
                  ...prev,
                  [qKey]: e.target.value,
                }));
                setOtherDirty((p) => ({ ...p, [qKey]: true }));
              }}
              onFocus={() => {
                if (!otherSelected) toggleOption(OTHER_LABEL);
              }}
              placeholder="직접 입력..."
              disabled={!otherSelected}
              className="flex-1 min-w-0 text-xs bg-transparent outline-none placeholder:text-[rgba(136,136,160,0.35)] transition-colors duration-fast"
              style={{
                color: "rgba(232,232,240,0.88)",
                borderBottom: otherSelected
                  ? otherInvalid
                    ? "1px solid rgba(255,77,106,0.7)"
                    : "1px solid rgba(124,111,255,0.4)"
                  : "1px solid rgba(42,58,94,0.3)",
                paddingBottom: 1,
              }}
            />
          </div>
          )}
        </div>

        {/* Freeform hint — always shown in wizard mode (no answer yet) */}
        <p
          className="mt-3 text-[11px] italic"
          style={{ color: "rgba(136,136,160,0.5)" }}
        >
          💡 혹은 채팅창에 자유롭게 답하세요
        </p>

        {/* Submit error */}
        {submitError && (
          <div className="mt-2 text-[11px] text-red-400">⚠ {submitError}</div>
        )}

        {/* Navigation */}
        <div className="mt-3 flex items-center justify-end gap-2">
          {step > 0 && (
            <button
              type="button"
              onClick={handlePrev}
              className="px-3 py-1.5 text-xs rounded-lg transition-all duration-fast"
              style={{
                border: "1px solid rgba(42,58,94,0.6)",
                background: "rgba(22,33,62,0.4)",
                color: "rgba(136,136,160,0.8)",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  "rgba(42,58,94,0.5)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background =
                  "rgba(22,33,62,0.4)";
              }}
            >
              ← 이전
            </button>
          )}

          <button
            type="button"
            onClick={handleNext}
            disabled={!valid || submitting}
            className="px-4 py-1.5 text-xs rounded-lg font-medium transition-all duration-fast"
            style={
              valid && !submitting
                ? {
                    background:
                      "linear-gradient(135deg, rgba(124,111,255,0.9), rgba(100,88,230,0.9))",
                    border: "1px solid rgba(124,111,255,0.5)",
                    color: "rgba(232,232,240,0.97)",
                    boxShadow: "0 0 10px rgba(124,111,255,0.25)",
                  }
                : {
                    background: "rgba(22,33,62,0.4)",
                    border: "1px solid rgba(42,58,94,0.4)",
                    color: "rgba(136,136,160,0.4)",
                    cursor: "not-allowed",
                  }
            }
          >
            {submitting
              ? "제출 중…"
              : isLastStep
              ? "제출하기"
              : "다음 →"}
          </button>
        </div>
      </div>
    </div>
  );
}
