"use client";

import { useState } from "react";

interface ToolBlockProps {
  name: string;
  input: unknown;
}

export default function ToolBlock({ name, input }: ToolBlockProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="inline-flex flex-col">
      <div
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-surface-light border border-border/50 cursor-pointer text-[11px] text-text-dim select-none hover:bg-[rgba(31,47,80,0.9)] transition-colors duration-fast"
        onClick={() => setOpen(!open)}
      >
        <span
          className="text-[9px] transition-transform duration-200"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        >
          &#9654;
        </span>
        <span className="truncate max-w-[200px]">{name}</span>
      </div>
      {open && (
        <div className="mt-1 text-xs w-full min-w-[300px]">
          {input != null && (
            <pre className="bg-code-bg p-2 rounded-md overflow-x-auto">
              <code className="font-mono text-[13px]">
                {typeof input === "string"
                  ? input
                  : JSON.stringify(input, null, 2)}
              </code>
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
