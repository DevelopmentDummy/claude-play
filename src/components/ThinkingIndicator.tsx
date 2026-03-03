"use client";

export default function ThinkingIndicator() {
  return (
    <div className="self-start flex items-center gap-1.5 px-[18px] py-3 bg-assistant-bubble backdrop-blur-[12px] rounded-2xl rounded-bl-[4px] shadow-sm animate-[messageIn_0.25s_ease-out]">
      {[0, 0.2, 0.4].map((delay, i) => (
        <div
          key={i}
          className="w-1.5 h-1.5 rounded-full bg-text-dim animate-[thinking-bounce_1.4s_infinite_ease-in-out_both]"
          style={{ animationDelay: `${delay}s` }}
        />
      ))}
    </div>
  );
}
