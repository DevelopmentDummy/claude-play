"use client";

import { useState } from "react";

interface ToolBlockProps {
  name: string;
  input: unknown;
}

export default function ToolBlock({ name, input }: ToolBlockProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="my-1.5 border border-border rounded-lg overflow-hidden">
      <div
        className="flex items-center gap-1.5 px-2.5 py-1.5 bg-surface-light cursor-pointer text-xs text-text-dim select-none hover:bg-[rgba(31,47,80,0.9)] transition-colors duration-fast"
        onClick={() => setOpen(!open)}
      >
        <span
          className="transition-transform duration-200"
          style={{ transform: open ? "rotate(90deg)" : "none" }}
        >
          &#9654;
        </span>
        <span>{name}</span>
      </div>
      {open && (
        <div className="p-2.5 text-xs">
          {input != null && (
            <pre className="bg-code-bg p-2 rounded-md overflow-x-auto my-1">
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
