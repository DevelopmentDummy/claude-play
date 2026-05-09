# Frontend

## Pages

| Route | Component | Purpose |
|-------|-----------|---------|
| `/` | `page.tsx` | Home — persona list, session list, profile management, import / publish / clone entry points |
| `/login` | `login/page.tsx` | Admin login page (shown when `ADMIN_PASSWORD` is set) |
| `/setup` | `setup/page.tsx` | First-run setup wizard (admin password, ComfyUI, Gemini, Civitai, TTS config) |
| `/builder/[name]` | `builder/[name]/page.tsx` | Persona builder UI with usage indicator + session resume menu |
| `/chat/[sessionId]` | `chat/[sessionId]/page.tsx` | Main session chat UI with panels, usage modal, options modal, steering presets |

## Hooks (`src/hooks/`)

| Hook | Role |
|------|------|
| `useWebSocket.ts` | Manages the `/ws` connection lifecycle (bind/leave, reconnect) |
| `useSSE.ts` | Subscribes to Server-Sent Events for streamed turns |
| `useChat.ts` | High-level chat state — send, history pagination, OOC toggle, regen |
| `useLayout.ts` | Reads/writes layout config, drives panel placement (right/left/bottom/dock/modal/hidden) |
| `useIsMobile.ts` | Mobile breakpoint detector (drives compact UI variants) |

## Components (`src/components/`)

### Chat

| Component | Role |
|-----------|------|
| `ChatMessages.tsx` | Message rendering with `<dialog_response>` extraction, scene-break (❖❖❖), inline images/panels, infinite scroll |
| `ChatInput.tsx` | Message input with OOC mode toggle, `*` insert button |
| `ToolBlock.tsx` | Collapsible tool invocation display showing tool name and details |
| `InlineImage.tsx` | Image component with polling support and error handling for lazy-loaded images |
| `InlinePanel.tsx` | Panel that renders HTML in Shadow DOM with image modal support |
| `ThinkingIndicator.tsx` | Animated loading indicator with bouncing dots for AI thinking state |

### Navigation & Status

| Component | Role |
|-----------|------|
| `StatusBar.tsx` | Navigation bar with model selector, Sync button, status indicator |
| `ErrorBanner.tsx` | Auto-dismissing error display (10 second timeout) |
| `PopupEffect.tsx` | Animated popup queue with enter/visible/exit phases |
| `ToastEffect.tsx` | Toast notification system with enter/visible/exit animations (also drives background-job/fire-ai notices) |
| `KebabMenu.tsx` | Reusable "···" overflow menu for cards and action rows |
| `UsageIndicator.tsx` | Compact provider token-usage badge polling `/api/usage` |
| `UsageModal.tsx` | Detailed provider usage breakdown (windows, resets_at, time progress) |

### Panels

| Component | Role |
|-----------|------|
| `PanelSlot.tsx` | Side panel rendering with Shadow DOM CSS isolation |
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
| `SteeringPresetsModal.tsx` | Autoplay steering presets management (load, add, update, delete) |
| `SessionListModal.tsx` | Provider conversation picker for resume / relink flows |
| `NewPersonaDialog.tsx` | New persona creation with name input validation |
| `ClonePersonaDialog.tsx` | Duplicate an existing persona under a new folder name |
| `ImportPersonaModal.tsx` | Install a persona from a GitHub URL with metadata preview |
| `PublishPersonaModal.tsx` | Push a persona dir to a GitHub repo (publish flow) |
| `ProfileSelectDialog.tsx` | Profile selection or creation for a persona |
| `NewProfileDialog.tsx` | Profile creation/editing with name, description, primary flag |
| `PersonaStartModal.tsx` | Session start modal (profile selection) |

### Cards

| Component | Role |
|-----------|------|
| `PersonaCard.tsx` | Persona display with gradient accent colors, session count, kebab menu |
| `SessionCard.tsx` | Session info display (title, persona, creation date, model provider) |
| `ProfileCard.tsx` | Profile display with edit/delete actions |

### Builder

| Component | Role |
|-----------|------|
| `BuilderOverview.tsx` | Builder page overview showing files, panels, data files |

### Voice & Audio

| Component | Role |
|-----------|------|
| `VoiceSettings.tsx` | Per-persona voice configuration UI |
