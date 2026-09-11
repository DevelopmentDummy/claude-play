"use client";

import { type CSSProperties } from "react";
import { MODEL_GROUPS, parseModelEffort, type AIProvider } from "@/lib/ai-provider";

interface ModelSelectProps {
  value: string;
  onChange: (value: string) => void;
  provider?: AIProvider;
  className?: string;
  style?: CSSProperties;
}

const groups = MODEL_GROUPS.map((group) => ({
  ...group,
  models: [...new Set(group.options.map((option) => parseModelEffort(option.value).model))].map((model) => {
    const options = group.options.filter((option) => parseModelEffort(option.value).model === model);
    const first = options[0];
    const effort = parseModelEffort(first.value).effort;
    return {
      model,
      label: effort ? first.label.slice(0, -(effort.length + 1)) : first.label,
      efforts: options.map((option) => parseModelEffort(option.value).effort || ""),
    };
  }),
}));

const optionClass = "bg-[#1a1a2e] text-[#ccc]";
const defaultClass = "min-w-0 w-full px-3 py-2.5 rounded-xl text-sm text-text bg-[rgba(15,15,26,0.6)] border border-border/60 outline-none cursor-pointer focus:border-accent";

export default function ModelSelect({ value, onChange, provider, className = defaultClass, style }: ModelSelectProps) {
  const { model, effort, advisor } = parseModelEffort(value);
  const available = groups.filter((group) => !provider || group.provider === provider);
  const models = available.flatMap((group) => group.models);
  const current = models.find((entry) => entry.model === model);
  const efforts = [...new Set([...(current?.efforts || []), effort || ""])];
  const emit = (nextModel: string, nextEffort: string) => {
    onChange(`${nextModel}${nextEffort ? `:${nextEffort}` : ""}${advisor ? `@${advisor}` : ""}`);
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <select
        aria-label="모델"
        title="모델"
        value={model}
        onChange={(event) => {
          const next = models.find((entry) => entry.model === event.target.value);
          if (next) emit(next.model, next.efforts.includes(effort || "") ? effort || "" : next.efforts[0]);
        }}
        className={`${className} flex-1`}
        style={style}
      >
        {!current && <option value={model} className={optionClass}>{model || "기본 모델"}</option>}
        {available.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.models.map((entry) => <option key={entry.model} value={entry.model} className={optionClass}>{entry.label}</option>)}
          </optgroup>
        ))}
      </select>
      <select
        aria-label="추론 강도"
        title="추론 강도"
        value={effort || ""}
        disabled={!model || !efforts.some(Boolean)}
        onChange={(event) => emit(model, event.target.value)}
        className={`${className} !w-auto shrink-0 disabled:opacity-40 disabled:cursor-default`}
        style={style}
      >
        {efforts.map((level) => <option key={level} value={level} className={optionClass}>{level ? level === "xhigh" ? "XHigh" : level[0].toUpperCase() + level.slice(1) : "기본"}</option>)}
      </select>
    </div>
  );
}
