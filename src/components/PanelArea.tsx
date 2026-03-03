"use client";

import PanelSlot from "./PanelSlot";

interface Panel {
  name: string;
  html: string;
}

interface PanelAreaProps {
  panels: Panel[];
  position: "right" | "left" | "bottom" | "hidden";
  size: number;
}

export default function PanelArea({ panels, position, size }: PanelAreaProps) {
  if (position === "hidden" || panels.length === 0) return null;

  const isBottom = position === "bottom";
  const style: React.CSSProperties = isBottom
    ? { height: `${size}px` }
    : { width: `${size}px` };

  return (
    <aside
      className={`shrink-0 overflow-y-auto bg-surface backdrop-blur-[16px] flex flex-col gap-px ${
        isBottom
          ? "border-t border-border flex-row overflow-x-auto overflow-y-hidden"
          : position === "left"
            ? "border-r border-border"
            : "border-l border-border"
      }`}
      style={style}
    >
      {panels.map((panel) => (
        <PanelSlot key={panel.name} name={panel.name} html={panel.html} />
      ))}
    </aside>
  );
}
