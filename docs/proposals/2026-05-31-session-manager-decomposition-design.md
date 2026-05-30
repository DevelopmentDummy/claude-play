# session-manager.ts 분해 (Wave 12) 설계+플랜

> 거대 클래스 분해(⑥) 두 번째 타깃. `SessionManager`(`src/lib/session-manager.ts`, 2414줄, 앱 백본).
> 멀티에이전트 understand 워크플로(95메서드 분류)가 식별한 **6개 안전 클러스터만** 추출. behavior-preserving.

## ⚠️ 핵심 제약 (comfyui와 다름)

1. **public 메서드는 17+파일서 소비됨(60 grep hits)** → public 메서드는 **body만 모듈로 이동하고 클래스에는 얇은 위임 래퍼 유지**(`xxx(...args) { return extractedFn(...args, this.appRoot); }`). 공개 API 시그니처·호출부 무변경.
2. **private 헬퍼는 외부 호출자 없음** → 클래스에서 완전히 제거, 호출부(orchestrator)가 import해서 직접 호출.
3. **코어 CRUD는 절대 추출 안 함**: constructor, path-helpers(profilesDir/personasDir/sessionsDir/getSessionDir/getPersonaDir/childDir/sanitizePathSegment 등 this.dataDir linchpin), createSession, deleteSession, deletePersona, sync*, refreshSessionInstructionFiles, createPersonaDir, listSessions/listPersonas/readPersonaOverview, 15개 session-id accessor, resolveOptions/resolveOpening, refreshToolSkills/copyToolSkills/refreshPanelSpec, builder accessor.
4. `getDataDir()`/`getPort()`/`getApiBase()`/`getInternalToken()`는 **모듈-레벨 import**(this 아님) — 주입 불필요.
5. 검증: 클러스터당 `npm run build`(strict tsc — 시그니처 drift 잡음) + 적대적 토큰대조 + 누락 `this.X` grep 0. tsc는 동작 drift는 못 잡으므로 수동 create/open 스모크 권장(헤드리스 후 사용자).

## 6개 클러스터 (추출 순서 = 위험 오름차순)

### ① `src/lib/session-sync-diff.ts` (low, ~110L, 주입 없음, 래퍼 0)
`fileDiffers, dirDiffers, personaSkillsDiffer, toolsDiffer, variablesDiffer, stripAssembledSections, liveInstructionsDiffer, getCustomDataFiles` — 전부 private read-only 술어. this-refs는 sibling diff 헬퍼뿐(fileDiffers←dirDiffers←personaSkillsDiffer/toolsDiffer; stripAssembledSections←liveInstructionsDiffer). 모듈로 이동→cross-call 로컬화. 호출부(getSyncDiff ~1167–1235, getReverseSyncDiff ~1260–1322, syncSessionToPersonaSelective ~1480, syncPersonaToSession 968) `this.X`→`X` repoint. 외부 호출자 없어 **래퍼 불필요**. 가장 안전 → 먼저.

### ② `src/lib/runtime-instructions.ts` (low, ~60L, 주입 없음, public 래퍼 3)
`writeCodexInstructions, writeGeminiInstructions, writeKimiInstructions, writeAntigravityInstructions` — this-refs 0. 인자 projectDir/content/runtimePrompt만 사용. Codex/Gemini/Kimi 3개 public(session-instance/builder/open서 소비) → 얇은 위임 래퍼 유지. Antigravity는 호출자 확인 후 처리.

### ③ `src/lib/session-config-io.ts` (low, ~70L, 주입 없음, public 래퍼)
`readLayout, readVoiceConfig, writeVoiceConfig, readOptions, writeOptions, readOptionsSchema` — this-refs 0(dir은 인자, readOptionsSchema는 module-level getDataDir()). 전부 public, 17파일서 소비 → 위임 래퍼 유지, body만 이동. module-level DEFAULT_LAYOUT 상수 동반 이동. **resolveOptions 제외**(getPersonaDir→this.dataDir).

### ④ `src/lib/runtime-config.ts` (low, ~180L, appRoot 주입, ensureClaudeRuntimeConfig 래퍼)
`writeClaudeSettings, writeMcpConfig, writeCodexConfig, writeGeminiConfig, ensurePolicyContext, ensureClaudeRuntimeConfig` — 유일 instance dep은 this.appRoot(writeMcpConfig/writeCodexConfig/writeGeminiConfig의 serverScript 경로용). appRoot를 string 파라미터로 주입. ensureClaudeRuntimeConfig은 public(createSession/createPersonaDir/refreshSessionInstructionFiles 호출) → 얇은 래퍼가 this.appRoot 전달.

### ⑤ `src/lib/prompt-assembly.ts` (low, ~150L, appRoot 주입, public 래퍼)
`resolveOpeningPlaceholders, escapeRegExp, extractActiveSystemPrompt, readGuideContent, buildPromptFromGuideFiles, buildServiceSystemPrompt, buildBuilderSystemPrompt, getBuilderPrompt` — read-only 프롬프트 텍스트 조립. resolveOpeningPlaceholders는 이미 module fn. 체인 escapeRegExp←extractActiveSystemPrompt←readGuideContent←buildPromptFromGuideFiles의 유일 instance dep은 this.appRoot. buildService/Builder/getBuilderPrompt public → 래퍼가 this.appRoot 전달. module-level GUIDE_FILES 상수 동반.

### ⑥ `src/lib/fs-mirror.ts` (low, ~70L, 주입 없음, LAST)
`copyDirRecursive, mirrorAdditive, mirrorNewPersonaFiles` — 범용 재귀복사/additive-mirror. this-ref는 자기재귀뿐(로컬 fn명 rebind). copyDirRecursive는 risky writer(createSession/sync*/copyToolSkills)가 사용 → 그 writer들은 제자리 두되 free copyDirRecursive import. 안정 타깃 확보 위해 **마지막**. copyDirRecursive export 유지(grep 등장).

## 동작 보존 불변식
- 각 함수 body byte-동일(명시된 this.→param/local 치환 외). in-place 변형·throw·console 무변경.
- public 메서드: 시그니처·동작 동일(위임 래퍼). private: 호출부 repoint만.
- 주입값(appRoot)은 생성자서 1회 설정 후 불변 → 호출부 평가 = 내부 read 동치.

## 진행
한 브랜치 `feat/session-manager-decomposition`, 클러스터당 (모듈 생성 커밋 + client repoint 커밋), 클러스터당 `npm run build` + 적대적 토큰대조. 6개 완료 후 최종 build + ff-merge + push. 미커밋 사용자 파일 무오염 유지.
