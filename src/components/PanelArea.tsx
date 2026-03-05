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
  profileImageUrl?: string | null;
  sessionId?: string;
  panelData?: Record<string, unknown>;
  onSendMessage?: (text: string) => void;
}

export default function PanelArea({ panels, position, size, profileImageUrl, sessionId, panelData, onSendMessage }: PanelAreaProps) {
  if (position === "hidden" || (panels.length === 0 && !profileImageUrl)) return null;

  const isBottom = position === "bottom";

  return (
    <aside
      className={`h-full w-full overflow-y-auto bg-surface/50 backdrop-blur-[16px] flex flex-col gap-3 p-4 ${
        isBottom
          ? "border-t border-border flex-row overflow-x-auto overflow-y-hidden"
          : position === "left"
            ? "border-r border-border"
            : "border-l border-border"
      }`}
    >
      {profileImageUrl && (
        <img
          src={profileImageUrl}
          alt="Profile"
          className="w-full object-cover shrink-0 rounded-xl"
          style={{ maxHeight: `${Math.round(size * 1.2)}px` }}
        />
      )}
      {panels.map((panel) => (
        <PanelSlot
          key={panel.name}
          name={panel.name}
          html={panel.html}
          sessionId={sessionId}
          panelData={panelData}
          onSendMessage={onSendMessage}
        />
      ))}
    </aside>
  );
}
