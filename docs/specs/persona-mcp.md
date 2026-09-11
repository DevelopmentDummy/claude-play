# Persona-scoped stdio MCP (2026-09-08)

`src/lib/persona-mcp.ts` reads `<projectDir>/runtime-mcp.json`; `runtime-config.ts` merges approved entries alongside the mandatory bridge server into Claude/Kimi JSON, Codex TOML, Gemini JSON and Antigravity JSON. Missing declarations leave existing behavior unchanged. Config writers remain service-owned and are regenerated on open. `runtime-mcp.json` is in `SYSTEM_JSON`, not panel/custom-tool data.

## Declaration v1

```json
{"version":1,"servers":{"blender_studio":{"command":"node","args":["{{project_dir}}/mcp/blender-server.mjs"],"env":{"BLENDER_EXECUTABLE":"{{app_root}}/data/tools/blender/blender-4.5.13-windows-x64/blender.exe"}}}}
```

Only stdio command/args/env are implemented. At most 8 servers. Names use lowercase ASCII identifiers; bridge names and prototype-related names are reserved. Environment keys use uppercase identifiers and may not override `CLAUDE_PLAY_*`. Only `{{project_dir}}` and `{{app_root}}` expand. Runtime context and the bridge token are injected by the service, not stored in the declaration. Codex persona tools have a 30s startup / 180s call timeout; long work should return a handle and provide a bounded wait tool.

## Explicit local approval

`<appRoot>/data/mcp-trust.json` maps persona name to the SHA-256 of the **exact declaration bytes**. No approval, changed bytes, invalid JSON or invalid configuration → no persona MCP processes. The core bridge remains available. Approvals are machine-local and must never be exported with a persona. Code execution is powerful: review the named command and its implementation before writing this hash. The hash pins configuration, **not all referenced program bytes**; this is not a code-signing or sandbox system. Import/update review must also review executable scripts.

This change does not alter global CLI configuration, permissions, authentication, or model selection. Kimi consumes the existing shared `.mcp.json` path. Existing sessions require a reopen after the running service loads the changed code. A manifest is copied into new sessions; existing copied manifests follow the normal explicit sync flow.

## Blender Master implementation

The machine-local persona `data/personas/blender_master` contains a standalone stdio MCP using the already installed SDK v1, and a read-only Handlebars workbench. Its only Blender mutation path is AI → MCP → owned Blender child process (no persona game engine / no panel-side run loop).

Tools: `studio_status`, `studio_build`, `studio_job`, `studio_cancel`, `studio_preview`. Each build saves a new run directory containing source, request, log, scene info, `.blend`, optional PNG and terminal job metadata. The MCP owns `studio.json`, the AI owns plan-only `variables.json`. The MCP serializes jobs and claims a PID/token owner lock so two connections cannot edit one session concurrently.

Lifecycle is session-bound, not durable. MCP EOF/signals stop its Blender child. While running it queries the service's existing status API every 5s; zero clients or monitoring failure cancels the job. In builder/local test mode this session-client check is not applicable. No browser loop, background AI auto-trigger, scheduler registration, or unattended LLM budget is added. UI sees file updates, AI explicitly waits through `studio_job`. Session clients and scheduler counts remain observable through the existing bridge status tool; Blender job handles through `studio_status`.

Python is trusted local execution, not an OS sandbox. MCP path checks constrain input file arguments, not arbitrary Python. Blender loads with `--disable-autoexec`; output wrapper uses new directories. No external asset upload or paid generation is enabled. GUI addon control is a separate uninstalled extension, not claimed as supported by the headless tools.

## Verification

Inspect/approve/revoke a reviewed declaration with `node scripts/approve-persona-mcp.mjs <persona> --inspect|--approve|--revoke`. The approval operation preserves other persona entries and an existing UTF-8 BOM. It is an operator action, not an import hook.

- `npm run typecheck`
- `npx tsx --test src/lib/persona-mcp.test.ts src/lib/session-state.test.ts`
- `node data/personas/blender_master/tests/smoke.mjs` (actual Blender install required)
- Persona lint may report legacy examples in builder-generated CLAUDE/AGENTS/GEMINI files; never edit those generated instructions to silence findings. Check authored files separately.
- Live provider/session reopen remains a separate gate from direct stdio MCP smoke. Never build over a currently served production `.next`.
