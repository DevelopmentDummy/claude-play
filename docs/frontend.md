# Frontend

## Pages

| Route | Component | Purpose |
|-------|-----------|---------|
| `/` | `page.tsx` | Home — persona list, session list, profile management |
| `/login` | `login/page.tsx` | Admin login page (shown when `ADMIN_PASSWORD` is set) |
| `/setup` | `setup/page.tsx` | First-run setup wizard (admin password, ComfyUI, Gemini, Civitai, TTS config) |
| `/builder/[name]` | `builder/[name]/page.tsx` | Persona builder UI |
| `/chat/[sessionId]` | `chat/[sessionId]/page.tsx` | Main session chat UI with panels |

## Components (`src/components/`)

### Chat

| Component | Role |
|-----------|------|
| `ChatMessages.tsx` | Message rendering with `<dialog_response>` extraction, inline images/panels, infinite scroll |
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
| `ToastEffect.tsx` | Toast notification system with enter/visible/exit animations |

### Panels

| Component | Role |
|-----------|------|
| `PanelSlot.tsx` | Side panel rendering with Shadow DOM CSS isolation |
| `PanelArea.tsx` | Container managing panel layout (position: right/left/bottom/hidden) |
| `PanelDrawer.tsx` | Drawer wrapper for panels with open/close state |
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
| `NewPersonaDialog.tsx` | New persona creation with name input validation |
| `ProfileSelectDialog.tsx` | Profile selection or creation for a persona |
| `NewProfileDialog.tsx` | Profile creation/editing with name, description, primary flag |
| `PersonaStartModal.tsx` | Session start modal (profile selection) |

### Cards

| Component | Role |
|-----------|------|
| `PersonaCard.tsx` | Persona display with gradient accent colors, session count |
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
