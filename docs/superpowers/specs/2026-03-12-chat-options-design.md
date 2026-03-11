# Chat Options System Design

## Overview

Data-driven option system that controls both AI prompt generation (via Handlebars conditionals in `session-shared.md`) and frontend behavior (e.g., STT auto-send delay). Options are defined in a single global schema, filtered by scope (session/builder/both), and overridable per-persona and per-session.

## Data Structures

### Option Schema (`data/chat-options-schema.json`)

Global schema file defining all available options. UI is auto-generated from this — no frontend changes needed when adding options.

```json
[
  {
    "key": "innerMonologue",
    "label": "내면 독백",
    "description": "매 응답에 캐릭터 내면 독백을 포함합니다",
    "type": "boolean",
    "default": true,
    "scope": "session",
    "target": "prompt",
    "group": "서사"
  },
  {
    "key": "stagnationGuard",
    "label": "서사 정체 방지",
    "description": "같은 장소/감정/행동 반복 시 전환을 시도합니다",
    "type": "boolean",
    "default": true,
    "scope": "session",
    "target": "prompt",
    "group": "서사"
  },
  {
    "key": "generateChoices",
    "label": "선택지 생성",
    "description": "매 응답 끝에 행동 선택지를 제공합니다",
    "type": "boolean",
    "default": true,
    "scope": "session",
    "target": "prompt",
    "group": "서사"
  },
  {
    "key": "userProfiling",
    "label": "사용자 프로파일링",
    "description": "대화에서 사용자 성향을 파악하고 memory.md에 기록합니다",
    "type": "boolean",
    "default": true,
    "scope": "session",
    "target": "prompt",
    "group": "서사"
  },
  {
    "key": "autoSendDelay",
    "label": "음성 자동 전송 대기",
    "description": "음성 입력 후 자동 전송까지 대기 시간",
    "type": "slider",
    "min": 1000,
    "max": 10000,
    "step": 500,
    "unit": "ms",
    "default": 3000,
    "scope": "both",
    "target": "frontend",
    "group": "음성"
  }
]
```

**Field definitions:**
- `key`: Unique identifier, used as Handlebars variable name (`options.<key>`)
- `label`: Display name in UI
- `description`: Tooltip/help text
- `type`: `"boolean"` | `"slider"` | `"select"` | `"text"` | `"number"`
- `default`: Default value when no override exists
- `scope`: `"session"` | `"builder"` | `"both"` — determines which mode shows this option
- `target`: `"prompt"` (Handlebars in session-shared.md) | `"frontend"` (client-side behavior) | `"both"`
- `group`: UI grouping label

For `type: "select"`, an additional `choices` field:
```json
{
  "type": "select",
  "choices": [
    { "value": "short", "label": "짧게" },
    { "value": "medium", "label": "보통" },
    { "value": "long", "label": "길게" }
  ]
}
```

### Option Values (`chat-options.json`)

Stored in persona and/or session directories. Only contains overridden keys — missing keys fall back to schema defaults.

```json
{
  "innerMonologue": false,
  "autoSendDelay": 5000
}
```

### Value Resolution Order

```
Schema default → Persona chat-options.json → Session chat-options.json
```

Each level only overrides keys it explicitly sets. SessionManager provides a `resolveOptions(sessionDir)` method that merges all layers.

## Prompt Integration

### session-shared.md as Handlebars Template

`session-shared.md` becomes a Handlebars template. `buildPromptFromGuideFiles` is modified to run Handlebars compilation on `.md` files when options context is available.

Example transformation:

```markdown
### 응답 형식 규칙

- 캐릭터의 1인칭 시점을 기본으로 하되...
{{#if options.innerMonologue}}
- 캐릭터의 내면 독백을 자연스럽게 녹여라. 매 응답에 최소 한 번 포함하라.
{{/if}}
{{#if options.stagnationGuard}}
- 같은 장소/감정/행동이 2~3턴 반복되면 서사 정체로 판단하고 전환을 시도하라.
{{/if}}
```

### Sections controlled by options

Sections in `session-shared.md` that become conditional:

| Option Key | Section | Current behavior |
|---|---|---|
| `innerMonologue` | 내면 독백 규칙 (line 16) | Always included |
| `stagnationGuard` | 서사 정체 전환 (line 18) | Always included |
| `generateChoices` | 선택지 시스템 (lines 136-157) | Always included |
| `userProfiling` | 사용자 프로파일링 + 외형 모델 (lines 28-90) | Always included |

### buildServiceSystemPrompt Flow

```
1. Read chat-options.json from session dir (or persona dir for builder)
2. Merge with schema defaults → resolved options object
3. For each guide file:
   a. Read raw content
   b. If .md file: compile as Handlebars with { options: resolvedOptions }
   c. If .yaml file: extract active prompt, then Handlebars compile
4. Join sections → final system prompt
```

## Option Change Flow (Session)

Changing prompt-targeting options requires process restart:

```
1. User modifies options in UI → clicks "적용"
2. POST /api/sessions/[id]/options/apply
   a. Save chat-options.json to session dir
   b. Kill current AI process
   c. Rebuild system prompt with new options
   d. Respawn AI process with --resume (preserves conversation)
3. Frontend receives new status via WebSocket
```

Frontend-only options (`target: "frontend"`) take effect immediately without process restart. The API response indicates whether restart occurred.

## API Routes

| Route | Method | Purpose |
|---|---|---|
| `GET /api/chat-options/schema` | GET | Return schema array, optional `?scope=session\|builder` filter |
| `GET /api/sessions/[id]/options` | GET | Return resolved options (schema defaults + persona + session overrides merged) |
| `PUT /api/sessions/[id]/options` | PUT | Save session option overrides (no restart) |
| `POST /api/sessions/[id]/options/apply` | POST | Save + restart AI process with new prompt |
| `GET /api/personas/[name]/options` | GET | Return persona option overrides |
| `PUT /api/personas/[name]/options` | PUT | Save persona option overrides |

### Response format for GET options:

```json
{
  "schema": [ ... ],
  "values": {
    "innerMonologue": true,
    "autoSendDelay": 3000
  }
}
```

## Frontend UI

### Settings Button

Added to StatusBar (both session and builder modes). Gear icon (⚙) that opens a modal.

### Options Modal

- Data-driven rendering from schema
- Grouped by `group` field, each group is a collapsible section
- Input types rendered by `type`:
  - `boolean` → toggle switch
  - `slider` → range slider with value label
  - `select` → dropdown
  - `text` → text input
  - `number` → number input
- Footer: "적용" button (saves + restarts if any `target: "prompt"` options changed) and "취소" button
- If only `target: "frontend"` options changed, saves without restart

### Options Access in Frontend

Options are loaded on session open (included in `/api/sessions/[id]/open` response or fetched separately) and stored in React state. Components that need option values receive them via props.

## File Locations

```
data/
  chat-options-schema.json          # Global schema (single file)
  personas/{name}/
    chat-options.json               # Persona-level overrides
  sessions/{name}-{ts}/
    chat-options.json               # Session-level overrides (runtime)
```

`chat-options.json` should be added to SYSTEM_JSON exclusion set (like session.json, layout.json) to prevent it from being loaded as custom panel data.

## Implementation Notes

- Handlebars is already a dependency (used for panel templates and opening.md)
- `buildPromptFromGuideFiles` needs modification to accept options context
- `chat-options.json` should be copied from persona to session on session creation (like other persona files)
- Schema file is created once with initial options; adding new options is just editing JSON
- Builder mode: options are read from persona dir directly (no session dir)
