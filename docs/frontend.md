# Frontend

## Pages

| Route | Component | Purpose |
|-------|-----------|---------|
| `/` | `page.tsx` | Home — persona list, session list (카드 메모 줄 인라인 편집 → `PATCH /api/sessions/[id]/memo`), profile management, import / publish / clone entry points |
| `/login` | `login/page.tsx` | Admin login page (shown when `ADMIN_PASSWORD` is set) |
| `/setup` | `setup/page.tsx` | First-run setup wizard (admin password, ComfyUI, Gemini, Civitai, TTS config) |
| `/builder/[name]` | `builder/[name]/page.tsx` | Persona builder UI with usage indicator + session resume menu |
| `/chat/[sessionId]` | `chat/[sessionId]/page.tsx` | Main session chat UI with panels, usage modal, options modal, steering presets, 턴 중 개입 토글(localStorage `bridge_interject_enabled`), 헤더 메모 칩 상태, ☰ 메뉴의 "세션 종료"(`handleCloseSession` → `POST /api/sessions/[id]/close`) |

## Hooks (`src/hooks/`)

| Hook | Role |
|------|------|
| `useWebSocket.ts` | Manages the `/ws` connection lifecycle (bind/leave, reconnect) |
| `useSSE.ts` | Subscribes to Server-Sent Events for streamed turns |
| `useChat.ts` | High-level chat state — send, history pagination (loadHistory/loadMore), per-message OOC toggle, streaming message assembly, tool-answer/cancel handling, `prepareInterject`(턴 중 개입 — 누적 ref를 리셋하지 않음; `addUserMessage`가 꼬리의 live stream 버블에 **표시 본문이 있으면 턴을 분할**한다: 그 버블을 얼려(live 해제) 남기고 뒤에 유저 메시지를 붙여 이후 delta가 새 버블을 열게 한다 → `[유저][앞부분][개입][뒷부분]`. 본문이 없으면(툴만 돌던 중) 종전대로 라이브 버블 *위*에 삽입. 분할 시 `turnSplitRef`가 서면 UTF-8 healing과 `result` 텍스트 폴백을 이번 턴 한정으로 끈다(둘 다 턴 전체 텍스트라 나머지 버블과 어긋남). 서버가 같은 시점에 history를 쪼개고 `chat:split`으로 확정 id를 보내면 `assignSplitMessageId`가 얼린 버블에 부여한다. 로컬 개입과 다른 클라이언트의 `chat:user` 브로드캐스트가 같은 규칙을 탄다; `handleCancelled`는 live를 지워 취소 버블이 이 규칙에 걸리지 않게 한다) |
| `useLayout.ts` | Reads/writes layout config: panel-area position (right/left/bottom/hidden) and per-panel placement (left/right/modal/modal-dismissible/full-screen/dock/dock-left/dock-right/dock-bottom) |
| `useIsMobile.ts` | Mobile breakpoint detector (drives compact UI variants) |
| `useFocusTrap.ts` | Traps Tab focus inside modal dialogs (a11y); shared by the modal components |
| `useEscapeKey.ts` | Shared ESC-to-close handler for modals (replaces hand-rolled keydown effects) |

## Components (`src/components/`)

Accessibility conventions (2026-06 a11y wave): modal components share `useFocusTrap`/`useEscapeKey` for dialog semantics and keyboard handling; components use aria-labels and keyboard-accessible buttons; `prefers-reduced-motion` is honored in `globals.css`.

### Chat

| Component | Role |
|-----------|------|
| `ChatMessages.tsx` | Message rendering with `<dialog_response>` extraction, scene-break (❖❖❖), inline images/panels, infinite scroll; dock panels float over messages (sticky overlay) instead of reserving a band |
| `ChatInput.tsx` | Message input with OOC mode toggle, `*` insert button, voice-chat mode (STT auto-start/auto-send), autoplay toggle + "오토 메시지 프리셋" entry, 턴 중 개입 토글(ON이면 스트리밍 중에도 Send/Stop 동시 노출), choice buttons, embedded `UsageIndicator` |
| `InteractiveQuestionCard.tsx` | Renders AskUserQuestion tool calls as interactive answer cards (choice buttons + freeform input); answers POST to `/api/sessions/[id]/tool-answer` and are relayed as plain user messages (headless `claude -p` auto-rejects the tool), synced via `tool:answered` WS event |
| `ToolBlock.tsx` | Collapsible tool invocation display showing tool name and details |
| `InlineImage.tsx` | Inline media component for `$IMAGE$` tokens — image by default, `<video>` for `.mp4/.webm/.mov`, `<audio>` for `.flac/.mp3/.wav/.ogg/.m4a` (`VIDEO_RE`/`AUDIO_RE`); polling + error card for not-yet-generated files; stable keys so OOC toggles don't re-fetch every image |
| `InlinePanel.tsx` | Panel that renders HTML in Shadow DOM with image modal support |
| `ThinkingIndicator.tsx` | Animated loading indicator with bouncing dots for AI thinking state |

> **AskUserQuestion card checklist** — any page/surface that renders `ChatMessages` with question cards needs both: (1) pass `sessionId` to `ChatMessages` (without it the card POSTs to `/api/sessions//tool-answer` → 404 — the answer never reaches the AI and the card surfaces a '제출 실패' error), and (2) handle the `tool:answered` WS event (`handleToolAnswered` from `useChat`) or answered cards never collapse to their summary state. Both are wired in the chat page and the builder page — replicate when adding a new card-rendering surface.

### Navigation & Status

| Component | Role |
|-----------|------|
| `StatusBar.tsx` | Navigation bar with model selector, Sync button, status indicator, 세션 메모 칩(`memo`/`onMemoSave` — 인라인 편집, Escape로 되돌림), ☰ 메뉴의 "세션 종료"(`onCloseSession`); sub-agent entry point — ambient "busy sub" indicator (`busySubNames`) + menu entry that opens `SubAgentChatModal` (`onSubAgents`) |
| `ErrorBanner.tsx` | Auto-dismissing error display (10 second timeout) |
| `PopupEffect.tsx` | Animated popup queue with enter/visible/exit phases |
| `ToastEffect.tsx` | Toast notification system with enter/visible/exit animations (also drives background-job/fire-ai notices) |
| `KebabMenu.tsx` | Reusable "···" overflow menu for cards and action rows |
| `UsageIndicator.tsx` | Compact provider token-usage badge polling `/api/usage` |
| `UsageModal.tsx` | Detailed provider usage breakdown (windows, resets_at, time progress) |

### Panels

| Component | Role |
|-----------|------|
| `PanelSlot.tsx` | Side panel rendering with Shadow DOM CSS isolation. Exports `PANEL_DEFENSIVE_STYLE` — 좁은 뷰포트 방어 CSS(`:host max-width:100%; overflow-x:auto` + img/table/pre clamp). PanelSlot/ModalPanel/DockPanel 세 컨테이너가 공통 주입, 저자 `<style>`이 뒤에 로드되어 우선 |
| `PanelArea.tsx` | Container managing panel layout (position: right/left/bottom/hidden) |
| `PanelDrawer.tsx` | Drawer wrapper for panels with open/close state |
| `PanelResizeHandle.tsx` | Drag handle for resizing panel areas |
| `DockPanel.tsx` | Collapsible dock panel with image polling and dismissible support |
| `ModalPanel.tsx` | Modal overlay panel via `createPortal` |
| `MinimizedModals.tsx` | Minimized/collapsed modal states with restore buttons |

### Modals & Dialogs

| Component | Role |
|-----------|------|
| `ImageModal.tsx` | Fullscreen image viewer via `createPortal` |
| `SyncModal.tsx` | Bidirectional sync modal with direction toggle, per-element selection, diff badges |
| `ChatOptionsModal.tsx` | Configurable chat/persona options (sliders, toggles, selects, text inputs) with grouping |
| `VersionHistoryModal.tsx` | Git-like version history for personas with restore capability |
| `SteeringPresetsModal.tsx` | Autoplay preset management (load, add, update, delete) — UI 제목은 "오토 메시지 프리셋" (턴 중 개입/steer와 혼동을 피하려고 개명; 코드 식별자는 `SteeringPreset` 유지) |
| `SessionListModal.tsx` | Provider conversation picker for resume / relink flows |
| `ModelSelect.tsx` | Shared separate model/effort dropdowns derived from `MODEL_GROUPS`. Preserves supported effort on model changes, falls back to the first catalog option otherwise, retains existing custom values/advisor suffixes, and supports a locked provider. Emits the existing `model:effort` format. Used by StatusBar, NewPersonaDialog, and PersonaStartModal. |
| `NewPersonaDialog.tsx` | New persona creation with name input validation + separate builder model/effort selectors (`ModelSelect`, `onCreate(name, model?)`) |
| `ClonePersonaDialog.tsx` | Duplicate an existing persona under a new folder name |
| `ImportPersonaModal.tsx` | Install a persona from a GitHub URL with metadata preview |
| `PublishPersonaModal.tsx` | Push a persona dir to a GitHub repo (publish flow) |
| `ProfileSelectDialog.tsx` | Profile selection or creation for a persona |
| `NewProfileDialog.tsx` | Profile creation/editing with name, description, primary flag |
| `PersonaStartModal.tsx` | Session start modal (profile + model selection — `onStart(profileSlug?, model?)`) |
| `SubAgentChatModal.tsx` | Messenger-style modal for persona sub-agents: per-sub transcript view (`transcript.jsonl`), live `subagent:message` WS updates, direct operator→sub messages; opened from `StatusBar`, unread tracking lives in the chat page |

### Cards

| Component | Role |
|-----------|------|
| `PersonaCard.tsx` | Persona display with gradient accent colors, session count, kebab menu |
| `SessionCard.tsx` | Session info display (title, persona, creation date, model provider) + 메모 줄 — 표시 우선순위 `memo → autoMemo → memoFallback`, 클릭 인라인 편집(`onMemoSave`) |
| `ProfileCard.tsx` | Profile display with edit/delete actions |

### Builder

| Component | Role |
|-----------|------|
| `BuilderOverview.tsx` | Builder page overview showing files, panels, data files |

### Voice & Audio

| Component | Role |
|-----------|------|
| `VoiceSettings.tsx` | Per-persona voice configuration UI |
