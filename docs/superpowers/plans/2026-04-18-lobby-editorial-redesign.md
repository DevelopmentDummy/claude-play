# Lobby Editorial Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 메인 랜딩(로비) 페이지를 Premium/Editorial 디자인 방향으로 개편 — 구조 유지, 타이포·색·카드 재질감·세션 인지성 업그레이드, 케밥 드롭다운 액션 메뉴 도입.

**Architecture:** CSS 변수 토큰을 `globals.css`에 추가하고 `next/font/google`로 Playfair Display를 로딩한다. `PersonaCard`는 상단 비주얼 + 하단 본문 + 케밥 메뉴 구조로 재작성, `SessionCard`는 34×34 페르소나 아이콘 + 넘버링을 추가, `ProfileCard`는 chip 스타일로 통일한다. `listPersonas` API는 태그라인(persona.md 첫 단락 첫 문장)을 반환한다.

**Tech Stack:** Next.js 15 App Router, React 19, Tailwind CSS 3, TypeScript strict. 프로젝트에 테스트 프레임워크 없음 — 검증은 `npm run build`(타입체크 + 빌드)와 수동 브라우저 확인으로 수행.

**Reference:** 디자인 스펙 `docs/superpowers/specs/2026-04-18-lobby-editorial-redesign-design.md`

---

## File Structure

### Modify
| File | Responsibility |
|------|---------------|
| `src/app/globals.css` | `--plum*`, `--lobby-*` 토큰 추가. Playfair/Inter 유틸리티 클래스 |
| `src/app/layout.tsx` | `next/font/google`로 Inter + Playfair Display 로딩, body className에 font 변수 주입 |
| `tailwind.config.ts` | `plum`, `lobby-*` 색상 확장. `fontFamily.serif`에 Playfair 연결 |
| `src/app/page.tsx` | Header(brand + breadcrumb), Hero(eyebrow + headline + divider), Grid(반응형 `auto-fill minmax(200px, 1fr)`) 재작성 |
| `src/components/PersonaCard.tsx` | 상단 비주얼(140px) + 하단 본문 구조, 태그라인 렌더, 케밥 메뉴 통합 |
| `src/components/SessionCard.tsx` | 좌측 34×34 아이콘 + 제목 ellipsis + 우상단 넘버링 + 삭제 버튼 위치 조정 |
| `src/components/ProfileCard.tsx` | 칩 크기/배경 통일, primary 인디케이터를 plum dot로 |
| `src/lib/session-manager.ts` | `listPersonas` 반환에 `tagline?: string` 추가 (persona.md 첫 단락 첫 문장) |

### Create
| File | Responsibility |
|------|---------------|
| `src/components/KebabMenu.tsx` | 재사용 가능한 ⋯ 버튼 + 드롭다운. `items: { label, onClick, danger?, hidden? }[]` |

### No changes
- `ChatMessages`, `ChatInput`, 빌더 페이지, 채팅 페이지, 기타 모달 (내부 accent 참조가 `var(--accent)`이므로 플럼으로 바뀌어도 자연 흡수)

---

## Task 1: 디자인 토큰 + 폰트 로딩

**Files:**
- Modify: `src/app/globals.css`
- Modify: `src/app/layout.tsx`
- Modify: `tailwind.config.ts`

- [ ] **Step 1: `src/app/globals.css`의 `:root` 블록에 토큰 추가**

기존 `:root { ... }` 블록의 마지막(`--transition-normal: 0.25s ease;` 뒤, 닫는 `}` 앞)에 삽입:

```css
  /* ── Lobby (Editorial) tokens ──────────────────── */
  --lobby-bg: #0a0a0e;
  --lobby-surface: #0c0c10;
  --lobby-card: #0f0f14;
  --lobby-border: rgba(255, 255, 255, 0.05);
  --lobby-border-hover: rgba(184, 125, 184, 0.25);
  --plum: #b87db8;
  --plum-soft: rgba(184, 125, 184, 0.08);
  --plum-hairline: rgba(184, 125, 184, 0.3);
  --plum-glow: rgba(184, 125, 184, 0.5);
  --text-mute: rgba(250, 250, 250, 0.4);
```

- [ ] **Step 2: `src/app/layout.tsx`에 Inter + Playfair Display 로딩**

전체 교체:

```tsx
import type { Metadata, Viewport } from "next";
import { Inter, Playfair_Display } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  weight: ["200", "300", "400", "500", "600"],
  variable: "--font-inter",
  display: "swap",
});

const playfair = Playfair_Display({
  subsets: ["latin"],
  weight: ["400", "500"],
  style: ["italic"],
  variable: "--font-playfair",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Claude Play",
  description: "Chat UI bridging to Claude Code CLI",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${playfair.variable}`}>
      <body className="h-screen overflow-hidden font-sans">{children}</body>
    </html>
  );
}
```

- [ ] **Step 3: `tailwind.config.ts` 확장**

전체 교체:

```ts
import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        surface: "var(--surface)",
        "surface-light": "var(--surface-light)",
        text: "var(--text)",
        "text-dim": "var(--text-dim)",
        "text-mute": "var(--text-mute)",
        accent: "var(--accent)",
        "accent-hover": "var(--accent-hover)",
        "accent-glow": "var(--accent-glow)",
        "user-bubble": "var(--user-bubble)",
        "assistant-bubble": "var(--assistant-bubble)",
        error: "var(--error)",
        success: "var(--success)",
        warning: "var(--warning)",
        border: "var(--border)",
        "code-bg": "var(--code-bg)",
        // Lobby tokens
        "lobby-bg": "var(--lobby-bg)",
        "lobby-surface": "var(--lobby-surface)",
        "lobby-card": "var(--lobby-card)",
        "lobby-border": "var(--lobby-border)",
        "lobby-border-hover": "var(--lobby-border-hover)",
        plum: "var(--plum)",
        "plum-soft": "var(--plum-soft)",
        "plum-hairline": "var(--plum-hairline)",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        serif: ["var(--font-playfair)", "Georgia", "serif"],
      },
      backdropBlur: {
        glass: "var(--glass-blur)",
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
      },
      transitionDuration: {
        fast: "150ms",
        normal: "250ms",
      },
    },
  },
  plugins: [],
};

export default config;
```

- [ ] **Step 4: 빌드 검증**

Run: `npm run build`
Expected: 에러 없이 완료. 새 폰트가 `.next/static/`에 생성됨.

- [ ] **Step 5: Commit**

```bash
git add src/app/globals.css src/app/layout.tsx tailwind.config.ts
git commit -m "feat(lobby): 에디토리얼 디자인 토큰 + Playfair/Inter 폰트 로딩"
```

---

## Task 2: `listPersonas`에 태그라인 추가

**Files:**
- Modify: `src/lib/session-manager.ts`

페르소나 카드에 표시할 태그라인(persona.md 첫 단락의 첫 문장)을 API에서 제공한다.

- [ ] **Step 1: `PersonaInfo` 타입 찾기 + `tagline?: string` 추가**

`src/lib/session-manager.ts`에서 `PersonaInfo` 타입 정의를 찾고 필드 추가:

```bash
grep -n "PersonaInfo" src/lib/session-manager.ts
```

해당 타입 인터페이스/타입에 다음 필드를 추가:

```ts
tagline?: string;
```

- [ ] **Step 2: `listPersonas` 내부에서 태그라인 추출**

`src/lib/session-manager.ts`의 `listPersonas` 메서드(약 271-312 라인)에서 `displayName` 추출 블록 바로 아래에 태그라인 로직을 추가하고, 마지막 `return` 객체에 포함.

`if (firstLine) displayName = firstLine;` 줄의 다음 라인부터 `const hasIcon = ...` 이전까지를 다음으로 교체:

```ts
          if (firstLine) displayName = firstLine;
        }
        let tagline: string | undefined;
        if (fs.existsSync(personaMd)) {
          const content = fs.readFileSync(personaMd, "utf-8");
          const lines = content.split("\n");
          const bodyStart = lines.findIndex((l, i) => i > 0 && l.trim() !== "" && !l.startsWith("#"));
          if (bodyStart > 0) {
            const paragraph: string[] = [];
            for (let i = bodyStart; i < lines.length; i++) {
              if (lines[i].trim() === "") break;
              paragraph.push(lines[i].trim());
            }
            const joined = paragraph.join(" ").replace(/[*_`]/g, "");
            const sentence = joined.split(/(?<=[.!?。!?…])\s+/)[0]?.trim();
            if (sentence) tagline = sentence.length > 120 ? sentence.slice(0, 117) + "…" : sentence;
          }
        }
        const hasIcon = fs.existsSync(path.join(dir, d.name, "images", "icon.png"));
```

그리고 리턴 객체(`return { name: d.name, displayName, hasIcon, importMeta, publishMeta };`)에 `tagline` 추가:

```ts
        return { name: d.name, displayName, hasIcon, importMeta, publishMeta, tagline };
```

- [ ] **Step 3: 타입체크**

Run: `npx tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 4: 수동 확인**

Run: `npm run dev`
브라우저에서 `http://localhost:3340/api/personas` 호출 → 응답 JSON에 `tagline` 필드가 포함되어 있는지 확인. (persona.md 본문이 있는 페르소나에 대해 문장 하나)

- [ ] **Step 5: Commit**

```bash
git add src/lib/session-manager.ts
git commit -m "feat(persona): listPersonas 응답에 tagline 추가"
```

---

## Task 3: `KebabMenu` 재사용 컴포넌트

**Files:**
- Create: `src/components/KebabMenu.tsx`

의존성 없이 자체 구현한다(Headless UI 미사용). 외부 클릭 시 자동 닫힘 + ESC 닫힘 + 화면 우측 경계 체크로 왼쪽 열림 지원.

- [ ] **Step 1: 파일 생성**

```tsx
"use client";

import { useState, useRef, useEffect, ReactNode } from "react";

export interface KebabMenuItem {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  danger?: boolean;
  hidden?: boolean;
  confirm?: string; // 누르면 이 라벨로 바뀌고 3초 내 재클릭 시 실행
}

interface KebabMenuProps {
  items: KebabMenuItem[];
  badge?: ReactNode; // 버튼 옆 작은 배지(예: 업데이트 알림 dot)
  className?: string;
}

export default function KebabMenu({ items, badge, className = "" }: KebabMenuProps) {
  const [open, setOpen] = useState(false);
  const [confirmingIndex, setConfirmingIndex] = useState<number | null>(null);
  const [alignLeft, setAlignLeft] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      if (btnRef.current?.contains(e.target as Node)) return;
      setOpen(false);
      setConfirmingIndex(null);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); setConfirmingIndex(null); }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    setAlignLeft(window.innerWidth - rect.right < 180);
  }, [open]);

  useEffect(() => {
    return () => { if (confirmTimer.current) clearTimeout(confirmTimer.current); };
  }, []);

  const visibleItems = items
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => !it.hidden);

  const handleItemClick = (e: React.MouseEvent, origIndex: number, item: KebabMenuItem) => {
    e.stopPropagation();
    if (item.confirm) {
      if (confirmingIndex === origIndex) {
        item.onClick();
        setOpen(false);
        setConfirmingIndex(null);
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
      } else {
        setConfirmingIndex(origIndex);
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
        confirmTimer.current = setTimeout(() => setConfirmingIndex(null), 3000);
      }
      return;
    }
    item.onClick();
    setOpen(false);
  };

  return (
    <div className={`relative ${className}`} onClick={(e) => e.stopPropagation()}>
      <button
        ref={btnRef}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="relative w-7 h-7 flex items-center justify-center rounded-lg
          bg-black/35 backdrop-blur-sm border border-white/[0.08]
          text-white/80 text-base tracking-widest cursor-pointer
          hover:bg-black/55 hover:text-white transition-all duration-fast"
        title="More"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        &#8943;
        {badge && (
          <span className="absolute -top-1 -right-1">{badge}</span>
        )}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          className={`absolute top-9 ${alignLeft ? "right-0" : "left-0"} min-w-[150px]
            bg-[#14141a] border border-white/[0.08] rounded-lg p-1.5
            shadow-[0_8px_24px_rgba(0,0,0,0.5)] z-20`}
        >
          {visibleItems.map(({ it, i }, displayIdx) => {
            const isDanger = it.danger;
            const isConfirming = confirmingIndex === i;
            const label = isConfirming && it.confirm ? it.confirm : it.label;
            return (
              <button
                key={displayIdx}
                role="menuitem"
                onClick={(e) => handleItemClick(e, i, it)}
                className={`w-full text-left px-3 py-2 rounded-md text-xs cursor-pointer
                  flex items-center gap-2 transition-colors duration-fast
                  ${isDanger
                    ? "text-[#f97a7a] hover:bg-[#f97a7a]/10"
                    : "text-white/85 hover:bg-plum-soft"}
                  ${isConfirming ? "bg-[#f97a7a]/15" : ""}`}
              >
                {it.icon && <span className="opacity-80">{it.icon}</span>}
                <span>{label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 타입체크**

Run: `npx tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 3: Commit**

```bash
git add src/components/KebabMenu.tsx
git commit -m "feat(components): 재사용 가능한 KebabMenu 컴포넌트 추가"
```

---

## Task 4: `PersonaCard` 재작성

**Files:**
- Modify: `src/components/PersonaCard.tsx`

- [ ] **Step 1: 전체 교체**

```tsx
"use client";

import KebabMenu, { KebabMenuItem } from "./KebabMenu";

const PERSONA_GRADIENTS = [
  { from: "#2a1a3a", to: "#1a1028", line: "#b87db8" },
  { from: "#3a2a1a", to: "#28180a", line: "#e6a664" },
  { from: "#1a2a3a", to: "#0a1828", line: "#6ac4e6" },
  { from: "#2a3a1a", to: "#182810", line: "#8ec46a" },
  { from: "#3a1a28", to: "#28101a", line: "#e66a8c" },
  { from: "#2a1a2a", to: "#1a081a", line: "#c888e6" },
];

interface PersonaCardProps {
  name: string;
  displayName: string;
  hasIcon?: boolean;
  index?: number;
  sessionCount?: number;
  tagline?: string;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onClone: () => void;
  importMeta?: {
    source: string;
    url: string;
    installedAt: string;
    installedCommit: string;
  };
  publishMeta?: { url: string };
  onCheckUpdate?: () => void;
  updateStatus?: string | null;
  behindCount?: number;
  onUpdate?: () => void;
}

export default function PersonaCard({
  name,
  displayName,
  hasIcon,
  index = 0,
  sessionCount = 0,
  tagline,
  onSelect,
  onEdit,
  onDelete,
  onClone,
  importMeta,
  publishMeta,
  onCheckUpdate,
  updateStatus,
  behindCount,
  onUpdate,
}: PersonaCardProps) {
  const grad = PERSONA_GRADIENTS[index % PERSONA_GRADIENTS.length];
  const initial = displayName.charAt(0).toUpperCase();
  const numLabel = `No. ${String(index + 1).padStart(2, "0")}`;
  const iconUrl = hasIcon
    ? `/api/personas/${encodeURIComponent(name)}/images?file=icon.png`
    : null;

  const items: KebabMenuItem[] = [
    { label: "Edit", onClick: onEdit, icon: <span>&#9998;</span> },
    { label: "Clone", onClick: onClone, icon: <span>&#10291;</span> },
    {
      label: updateStatus === "checking" ? "Checking…" :
             updateStatus === "update-available" ? `${behindCount ?? ""} update(s)` :
             updateStatus === "up-to-date" ? "Up to date" :
             "Check update",
      onClick: () => onCheckUpdate?.(),
      icon: <span>&#8635;</span>,
      hidden: !onCheckUpdate,
    },
    {
      label: "Apply update",
      onClick: () => onUpdate?.(),
      icon: <span>&#8593;</span>,
      hidden: !(onUpdate && updateStatus === "update-available"),
    },
    {
      label: "Delete",
      confirm: sessionCount > 0 ? `Delete (${sessionCount} sessions)` : "Delete?",
      onClick: onDelete,
      danger: true,
      icon: <span>&times;</span>,
    },
  ];

  return (
    <div
      className="group relative rounded-xl overflow-hidden cursor-pointer
        bg-lobby-card border border-lobby-border
        transition-all duration-normal
        hover:border-lobby-border-hover hover:-translate-y-0.5"
      onClick={onSelect}
    >
      {/* Visual area */}
      <div
        className="relative h-[140px] border-b"
        style={{
          background: iconUrl
            ? `url(${iconUrl}) center/cover no-repeat, linear-gradient(160deg, ${grad.from}, ${grad.to})`
            : `linear-gradient(160deg, ${grad.from}, ${grad.to})`,
          borderColor: "rgba(184,125,184,0.08)",
        }}
      >
        {!iconUrl && (
          <div className="absolute inset-0 flex items-center justify-center font-serif italic text-[28px]"
            style={{ color: "rgba(255,255,255,0.85)" }}>
            {initial}
          </div>
        )}
        <div className="absolute top-2.5 left-3 font-serif italic text-[10px]" style={{ color: "rgba(184,125,184,0.8)" }}>
          {numLabel}
        </div>
        {sessionCount > 0 && (
          <div className="absolute top-3 right-9 w-1.5 h-1.5 rounded-full"
            style={{ background: "var(--plum)", boxShadow: "0 0 10px var(--plum-glow)" }} />
        )}
        <div className="absolute top-2 right-2 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-fast">
          <KebabMenu
            items={items}
            badge={updateStatus === "update-available" ? (
              <span className="block w-2 h-2 rounded-full bg-[var(--warning)] ring-2 ring-black" />
            ) : undefined}
          />
        </div>
        {(importMeta || publishMeta) && (
          <div className="absolute bottom-2 left-2.5 flex gap-1">
            {importMeta ? (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 border border-sky-500/30 tracking-wide">
                &#8595; 외부
              </span>
            ) : publishMeta ? (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 tracking-wide">
                &#8593; 업로드됨
              </span>
            ) : null}
          </div>
        )}
      </div>

      {/* Body area */}
      <div className="p-3.5">
        <div className="text-[15px] font-medium text-text" style={{ letterSpacing: "-0.01em" }}>
          {displayName}
        </div>
        <div className="text-[10px] text-text-mute mt-0.5">
          {sessionCount === 0 ? "No sessions yet" : `${sessionCount} session${sessionCount > 1 ? "s" : ""}`}
        </div>
        {tagline && (
          <div className="mt-2.5 text-[10px] italic text-text-dim/80 line-clamp-2 leading-[1.45]">
            &ldquo;{tagline}&rdquo;
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 호출 측 prop 추가**

`src/app/page.tsx`의 `Persona` 인터페이스에 `tagline?: string` 추가:

```ts
interface Persona {
  name: string;
  displayName: string;
  hasIcon?: boolean;
  tagline?: string;
  importMeta?: { ... };
  publishMeta?: { url: string };
}
```

그리고 `<PersonaCard />` 렌더에 `tagline={p.tagline}` prop 전달 (Task 6에서 통째로 교체하므로 여기서는 생략 가능).

- [ ] **Step 3: 타입체크 + 빌드**

Run: `npx tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 4: Commit**

```bash
git add src/components/PersonaCard.tsx src/app/page.tsx
git commit -m "feat(lobby): PersonaCard 에디토리얼 구조 + 케밥 액션 메뉴"
```

---

## Task 5: `SessionCard` 재작성

**Files:**
- Modify: `src/components/SessionCard.tsx`

- [ ] **Step 1: 전체 교체**

```tsx
"use client";

import { useState, useRef, useEffect } from "react";

const SESSION_GRADIENTS = [
  { from: "#2a1a3a", to: "#1a1028" },
  { from: "#3a2a1a", to: "#28180a" },
  { from: "#1a2a3a", to: "#0a1828" },
  { from: "#2a3a1a", to: "#182810" },
  { from: "#3a1a28", to: "#28101a" },
  { from: "#2a1a2a", to: "#1a081a" },
];

interface SessionCardProps {
  id: string;
  title: string;
  persona: string;
  createdAt: string;
  hasIcon?: boolean;
  model?: string;
  index?: number;
  personaIndex?: number;
  onOpen: () => void;
  onDelete: () => void;
}

function providerInfo(model?: string): { label: string; cls: string } | null {
  if (!model) return null;
  const lower = model.split(":")[0].toLowerCase();
  if (/^(gpt-5|codex-mini|o3|o4)/.test(lower))
    return { label: "Codex", cls: "bg-[#2a5a3a]/60 text-[#4dff91]/80 border-[#4dff91]/15" };
  if (/^gemini/.test(lower))
    return { label: "Gemini", cls: "bg-[#1a3a5c]/60 text-[#64b5f6]/80 border-[#64b5f6]/15" };
  if (/(sonnet|opus|haiku|claude)/.test(lower))
    return { label: "Claude", cls: "bg-[#4a2a1a]/60 text-[#ff9f43]/80 border-[#ff9f43]/15" };
  return null;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w}w ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export default function SessionCard({
  id,
  title,
  persona,
  createdAt,
  hasIcon,
  model,
  index = 0,
  personaIndex = 0,
  onOpen,
  onDelete,
}: SessionCardProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirmDelete) { onDelete(); return; }
    setConfirmDelete(true);
    timerRef.current = setTimeout(() => setConfirmDelete(false), 2500);
  };

  const grad = SESSION_GRADIENTS[personaIndex % SESSION_GRADIENTS.length];
  const info = providerInfo(model);
  const numLabel = String(index + 1).padStart(2, "0");

  return (
    <div
      className="group relative mx-2 px-2.5 py-2.5 pr-8 rounded-lg cursor-pointer
        transition-all duration-fast flex items-center gap-2.5
        hover:bg-plum-soft"
      onClick={onOpen}
    >
      {/* Icon */}
      <div
        className="w-[34px] h-[34px] rounded-[9px] shrink-0 relative overflow-hidden border border-white/[0.06]"
        style={{
          background: hasIcon
            ? `url(/api/sessions/${id}/files/images/icon.png) center/cover no-repeat`
            : `linear-gradient(135deg, ${grad.from}, ${grad.to})`,
        }}
      >
        {!hasIcon && (
          <div className="absolute inset-0 flex items-center justify-center font-serif italic text-sm"
            style={{ color: "rgba(255,255,255,0.85)" }}>
            {persona.charAt(0).toUpperCase()}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 min-w-0">
        <div className="text-[13px] text-text font-medium truncate leading-snug" style={{ letterSpacing: "-0.005em" }}>
          {title}
        </div>
        <div className="text-[10px] text-text-mute mt-0.5 flex items-center gap-1.5 truncate">
          <span className="truncate">{persona}</span>
          <span className="w-[3px] h-[3px] rounded-full bg-white/30 shrink-0" />
          <span className="shrink-0">{relativeTime(createdAt)}</span>
          {info && (
            <span className={`inline-flex items-center px-1 py-0 rounded text-[8px] font-semibold tracking-wide border ${info.cls}`}>
              {info.label}
            </span>
          )}
        </div>
      </div>

      {/* Numbering (hover: hide; replaced by delete button) */}
      <div className="absolute top-2 right-2.5 font-serif italic text-[9px] opacity-100 md:group-hover:opacity-0 transition-opacity duration-fast"
        style={{ color: "rgba(184,125,184,0.5)" }}>
        {numLabel}
      </div>

      {/* Delete button */}
      <button
        onClick={handleDelete}
        className={`absolute top-1.5 right-1.5 flex items-center justify-center rounded-md cursor-pointer transition-all duration-fast
          ${confirmDelete
            ? "px-2 py-0.5 text-[10px] text-error bg-error/15 border border-error/30 opacity-100"
            : "w-6 h-6 text-sm text-text-dim/40 opacity-0 md:group-hover:opacity-100 hover:text-error hover:bg-error/10"
          }`}
      >
        {confirmDelete ? <span>삭제</span> : <>&times;</>}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: 타입체크**

Run: `npx tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 3: Commit**

```bash
git add src/components/SessionCard.tsx
git commit -m "feat(lobby): SessionCard에 페르소나 아이콘 + 넘버링 + 상대시간"
```

---

## Task 6: `ProfileCard` 칩 재스타일

**Files:**
- Modify: `src/components/ProfileCard.tsx`

- [ ] **Step 1: 전체 교체**

```tsx
"use client";

interface ProfileCardProps {
  name: string;
  isPrimary?: boolean;
  onEdit: () => void;
  onDelete: () => void;
}

export default function ProfileCard({ name, isPrimary, onEdit, onDelete }: ProfileCardProps) {
  return (
    <div
      className={`group relative inline-flex items-center gap-2 px-3 py-1.5 rounded-full cursor-pointer
        transition-all duration-fast border
        ${isPrimary
          ? "border-plum-hairline bg-plum-soft text-text"
          : "border-lobby-border bg-white/[0.02] text-text-dim hover:text-text"}`}
      onClick={onEdit}
      title={isPrimary ? `${name} (primary)` : name}
    >
      {isPrimary && (
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: "var(--plum)" }} />
      )}
      <span className="text-[11px] font-medium">{name}</span>
      <button
        className="text-xs text-text-dim/40 cursor-pointer ml-0.5
          opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-fast
          hover:text-error"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
      >
        &times;
      </button>
    </div>
  );
}
```

- [ ] **Step 2: 타입체크**

Run: `npx tsc --noEmit`
Expected: 에러 없음.

- [ ] **Step 3: Commit**

```bash
git add src/components/ProfileCard.tsx
git commit -m "feat(lobby): ProfileCard 플럼 액센트 칩 스타일"
```

---

## Task 7: `page.tsx` 헤더/Hero/그리드 개편

**Files:**
- Modify: `src/app/page.tsx`

- [ ] **Step 1: `Persona` 인터페이스에 `tagline?: string` + `personaIndex` 전달 준비**

`interface Persona { ... }` 블록에 다음 필드 추가:

```ts
  tagline?: string;
```

- [ ] **Step 2: Persona index 맵 계산**

`return (` 바로 앞에 페르소나 이름 → 인덱스 맵 계산:

```tsx
  const personaIndexMap = new Map<string, number>();
  personas.forEach((p, i) => personaIndexMap.set(p.name, i));
```

- [ ] **Step 3: 렌더 JSX 교체**

`return (` 이하 전체를 다음으로 교체:

```tsx
  return (
    <div className="flex h-screen relative bg-lobby-bg text-text">
      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar: Sessions */}
      <aside
        className={`shrink-0 flex flex-col border-r border-lobby-border bg-lobby-surface transition-all duration-normal overflow-hidden
          fixed inset-y-0 left-0 z-40 md:relative md:z-auto ${
          sidebarOpen ? "w-[280px]" : "w-0 border-r-0"
        }`}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-lobby-border">
          <span className="font-serif italic text-sm" style={{ color: "var(--plum)" }}>
            Sessions
          </span>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-text-mute uppercase tracking-[0.15em]">
              {sessions.length}
            </span>
            <button
              onClick={() => setSidebarOpen(false)}
              className="w-7 h-7 flex items-center justify-center rounded-md text-text-dim/60 cursor-pointer
                hover:bg-white/5 hover:text-text transition-all duration-fast text-sm"
            >
              &lsaquo;
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {sessions.length === 0 ? (
            <p className="font-serif italic text-text-mute text-sm text-center py-10">
              No sessions yet
            </p>
          ) : (
            sessions.map((s, i) => (
              <SessionCard
                key={s.id}
                id={s.id}
                title={s.displayName || s.title}
                persona={s.displayName || s.persona}
                createdAt={s.createdAt}
                hasIcon={s.hasIcon}
                model={s.model}
                index={i}
                personaIndex={personaIndexMap.get(s.persona) ?? 0}
                onOpen={() => {
                  router.push(`/chat/${encodeURIComponent(s.id)}`);
                  if (window.innerWidth < 768) setSidebarOpen(false);
                }}
                onDelete={() => deleteSession(s.id)}
              />
            ))
          )}
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="flex items-center gap-3 px-4 py-3 md:px-7 md:py-4 border-b border-lobby-border bg-[var(--lobby-bg)]/50 backdrop-blur-glass">
          {!sidebarOpen && (
            <button
              onClick={() => setSidebarOpen(true)}
              className="w-8 h-8 flex items-center justify-center rounded-md text-text-dim cursor-pointer
                border border-lobby-border hover:bg-white/5 hover:text-text transition-all duration-fast text-sm"
            >
              &rsaquo;
            </button>
          )}
          <div className="flex items-baseline gap-[3px]">
            <span className="font-sans font-medium text-[15px]" style={{ letterSpacing: "-0.01em" }}>
              Claude
            </span>
            <span className="font-serif italic text-[15px]" style={{ color: "var(--plum)", letterSpacing: "-0.01em" }}>
              Play
            </span>
          </div>
          <div className="w-px h-3.5 bg-white/10 mx-3 hidden sm:block" />
          <span className="hidden sm:inline text-[11px] text-text-mute uppercase tracking-[0.2em]">
            Lobby
          </span>

          <div className="ml-auto flex items-center gap-1.5 md:gap-2 overflow-x-auto">
            {profiles.map((p) => (
              <ProfileCard
                key={p.slug}
                name={p.name}
                isPrimary={p.isPrimary}
                onEdit={() => editProfile(p.slug)}
                onDelete={() => deleteProfile(p.slug)}
              />
            ))}
            <button
              onClick={() => { setEditingProfile(null); setProfileDialogOpen(true); }}
              className="w-6 h-6 flex items-center justify-center rounded-full text-text-dim/60 cursor-pointer
                border border-dashed border-white/15 hover:bg-white/5 hover:text-text transition-all duration-fast text-xs"
              title="Add profile"
            >
              +
            </button>
          </div>
        </header>

        {/* Persona area */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-[1040px] mx-auto px-4 py-10 md:px-12 md:py-14">
            {/* Hero */}
            <div className="text-center mb-12 md:mb-14 animate-[slideUp_0.4s_ease_both]">
              <div className="text-[10px] font-medium uppercase mb-3.5" style={{ color: "var(--plum)", letterSpacing: "0.35em" }}>
                Tonight&rsquo;s Cast
              </div>
              <h2 className="font-sans font-extralight text-[30px] md:text-[38px] leading-[1.1]" style={{ letterSpacing: "-0.035em" }}>
                Who would you like to meet
                <span className="font-serif italic font-normal" style={{ color: "var(--plum)" }}>?</span>
              </h2>
              <p className="text-[13px] text-text-dim/70 mt-3.5 font-light">
                Choose a persona to start a new session
              </p>
              <div className="w-10 h-px mx-auto mt-5" style={{ background: "var(--plum-hairline)" }} />
            </div>

            {/* Grid */}
            <div
              className="grid gap-4 md:gap-[18px] mb-8 animate-[slideUp_0.4s_ease_0.08s_both]"
              style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(200px, 100%), 1fr))" }}
            >
              {personas.map((p, i) => (
                <PersonaCard
                  key={p.name}
                  name={p.name}
                  displayName={p.displayName}
                  hasIcon={p.hasIcon}
                  tagline={p.tagline}
                  index={i}
                  sessionCount={sessionCountByPersona(p.name)}
                  onSelect={() => handlePersonaClick(p.name, p.displayName, i)}
                  onEdit={() => editPersona(p.name)}
                  onDelete={() => deletePersona(p.name)}
                  onClone={() => setCloneTarget(p.name)}
                  importMeta={p.importMeta}
                  publishMeta={p.publishMeta}
                  onCheckUpdate={p.importMeta ? () => handleCheckUpdate(p.name) : undefined}
                  updateStatus={updateStatuses[p.name]?.status ?? null}
                  behindCount={updateStatuses[p.name]?.behindCount}
                  onUpdate={updateStatuses[p.name]?.status === "update-available" ? () => handleUpdate(p.name) : undefined}
                />
              ))}

              {/* New Persona */}
              <button
                onClick={() => setDialogOpen(true)}
                className="flex flex-col items-center justify-center gap-2 rounded-xl cursor-pointer
                  border border-dashed border-white/10 min-h-[220px]
                  transition-all duration-fast hover:border-plum-hairline hover:bg-plum-soft"
              >
                <div className="w-9 h-9 rounded-[10px] flex items-center justify-center bg-plum-soft border border-plum-hairline"
                  style={{ color: "var(--plum)" }}>
                  <span className="text-lg font-extralight">+</span>
                </div>
                <span className="text-[11px] text-text-dim tracking-wider">New Persona</span>
              </button>

              {/* Import from GitHub */}
              <button
                onClick={() => setImportOpen(true)}
                className="flex flex-col items-center justify-center gap-2 rounded-xl cursor-pointer
                  border border-dashed border-white/10 min-h-[220px] text-text-dim
                  transition-all duration-fast hover:border-plum-hairline hover:text-text"
              >
                <div className="w-9 h-9 rounded-[10px] flex items-center justify-center bg-white/[0.03] border border-white/10 text-text-dim/80">
                  <span className="text-base">&darr;</span>
                </div>
                <span className="text-[11px] tracking-wider">Import from GitHub</span>
              </button>
            </div>

            <div className="mt-8 text-center text-[10px] uppercase tracking-[0.25em] text-white/[0.18]">
              — Claude Play · Lobby —
            </div>
          </div>
        </div>
      </main>

      <NewPersonaDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreate={startBuilder}
      />

      <NewProfileDialog
        open={profileDialogOpen}
        onClose={() => {
          setProfileDialogOpen(false);
          setEditingProfile(null);
        }}
        onSave={saveProfile}
        editData={editingProfile}
        required={profiles.length === 0}
      />

      <PersonaStartModal
        open={startModal.open}
        personaName={startModal.personaName}
        personaDisplayName={startModal.personaDisplayName}
        accentColor={startModal.accentColor}
        profiles={profiles}
        onClose={() =>
          setStartModal({ open: false, personaName: "", personaDisplayName: "", accentColor: "" })
        }
        onStart={(profileSlug, model) => {
          const pName = startModal.personaName;
          setStartModal({ open: false, personaName: "", personaDisplayName: "", accentColor: "" });
          startSession(pName, profileSlug, model);
        }}
        onPublish={() => {
          const pName = startModal.personaName;
          setStartModal({ open: false, personaName: "", personaDisplayName: "", accentColor: "" });
          setPublishTarget(pName);
        }}
        isImported={!!personas.find(p => p.name === startModal.personaName)?.importMeta}
        isPublished={!!personas.find(p => p.name === startModal.personaName)?.publishMeta}
      />

      <ImportPersonaModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={handleImported}
        onOpenBuilder={handleOpenBuilder}
      />
      <PublishPersonaModal
        open={!!publishTarget}
        personaName={publishTarget || ""}
        onClose={() => setPublishTarget(null)}
        onOpenBuilder={handleOpenBuilder}
      />
      <ClonePersonaDialog
        open={!!cloneTarget}
        sourceName={cloneTarget || ""}
        onClose={() => setCloneTarget(null)}
        onCloned={() => loadLobby()}
      />
    </div>
  );
}
```

`PERSONA_ACCENTS` 상수는 더 이상 참조되지 않으므로 파일 상단에서 제거해도 됨 (선택).

- [ ] **Step 4: `PERSONA_ACCENTS` 및 `handlePersonaClick`의 `accentColor` 정리**

`handlePersonaClick`에서 넘기는 `accentColor`는 `PersonaStartModal`이 여전히 받음. 당분간 유지하되 값은 `var(--plum)`로 교체 가능. 최소 변경 원칙으로 기존 로직 그대로 둠.

현재 `PERSONA_ACCENTS` 배열을 다음으로 교체(페르소나별 플럼/앰버/에메랄드 등):

```ts
const PERSONA_ACCENTS = [
  "var(--plum)",
  "#e6a664",
  "#8ec46a",
  "#6ac4e6",
  "#e66a8c",
  "#c888e6",
];
```

- [ ] **Step 5: 빌드 검증**

Run: `npm run build`
Expected: 타입체크 + 빌드 모두 성공.

- [ ] **Step 6: 수동 브라우저 확인**

Run: `npm run dev`

브라우저(http://localhost:3340)에서 확인:
- 헤더: "Claude *Play*" + `LOBBY` 브레드크럼 + 프로필 칩
- Hero: "Tonight's Cast" eyebrow + 경량 헤드라인 + 세리프 `?` + 플럼 디바이더
- 페르소나 카드: 상단 비주얼 영역 + `No. 01` + 호버 시 ⋯ 케밥 → Edit/Clone/Delete 드롭다운 정상
- 그리드: 창 너비를 좁혀도 카드가 찌부러지지 않고 열 수 자동 감소
- 사이드바 세션: 34×34 아이콘 + 제목 ellipsis + `01` 넘버 + 호버 시 × 버튼

- [ ] **Step 7: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat(lobby): 에디토리얼 헤더/Hero/반응형 그리드 적용"
```

---

## Task 8: 엣지 케이스 + 최종 검증

- [ ] **Step 1: 페르소나 0개 상태 확인**

`data/personas/` 비우고(또는 임시로 이동) `npm run dev` → 그리드에 New Persona / Import 2개만 보이는지. 깨짐 없음 확인. 복구.

- [ ] **Step 2: 세션 0개 상태 확인**

사이드바에 "No sessions yet" 이탤릭 세리프 중앙 정렬로 표시되는지.

- [ ] **Step 3: Import/Publish 배지 확인**

import된 페르소나(있는 경우)에서 비주얼 영역 좌하단 `↓ 외부` 배지 표시. 없는 경우 스킵.

- [ ] **Step 4: 케밥 드롭다운 키보드/경계 동작**

- Tab으로 케밥에 포커스 → Enter → 드롭다운 열림
- Esc → 닫힘
- 외부 클릭 → 닫힘
- 우측 끝 카드의 케밥 → 드롭다운이 왼쪽으로 열림

- [ ] **Step 5: 모바일 뷰(DevTools 375px) 확인**

- 사이드바 토글 정상
- 카드 1열로 내려옴
- 케밥 메뉴 항상 표시(호버 필요 없음)

- [ ] **Step 6: 빌드 + 린트**

Run: `npm run build`
Expected: 성공. 경고 없음 목표(`any` 미사용, 사용 안 하는 import 없음).

- [ ] **Step 7: 최종 commit + push (권한 확인 후)**

남은 변경 사항이 있다면 커밋:

```bash
git status
git add -A
git commit -m "chore(lobby): 엣지 케이스 다듬기"
```

푸시는 사용자 확인 후.

---

## Self-Review

**Spec coverage:**
- §2.1 색상 토큰 → Task 1 ✓
- §2.2 타이포(Inter + Playfair) → Task 1 ✓
- §3 레이아웃 유지 → Task 7 ✓
- §4.1 Header → Task 7 ✓
- §4.2 Profile chips → Task 6 ✓
- §4.3 Hero → Task 7 ✓
- §4.4 Persona Card (hybrid + 케밥) → Task 4 ✓
- §4.5 New/Import 카드 통일 → Task 7 ✓
- §4.6 Responsive grid → Task 7 ✓
- §4.7 Sessions Sidebar → Task 5 + 7 ✓
- §4.8 Modals (토큰만 상속) → 기본 var(--accent) 상속이므로 추가 변경 불필요 ✓
- §5 Edge cases → Task 8 ✓
- §6 Files → 모두 커버 ✓
- §7 Testing → Task 8의 수동 체크리스트로 치환(테스트 프레임워크 없음) ✓

**Placeholder scan:** 모든 코드 블록은 완전한 구현을 포함. TBD/TODO 없음.

**Type consistency:** `KebabMenuItem`, `PersonaCardProps`의 `tagline`, `SessionCardProps`의 `personaIndex`, `PersonaInfo`의 `tagline` — 모두 Task 간 일관.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-18-lobby-editorial-redesign.md`. Two execution options:

1. **Subagent-Driven (recommended)** — Task별 서브에이전트 dispatch + 사이사이 리뷰
2. **Inline Execution** — 이 세션에서 계속 실행, 체크포인트 승인

어느 쪽으로 진행할까요?
