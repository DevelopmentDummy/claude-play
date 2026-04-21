# CLI Usage Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Bridge에 내장된 3-provider (Claude/Codex/Gemini) 사용량 트래커를 독립 Windows 데스크탑 위젯(Tauri)으로 분리 배포한다.

**Architecture:** Tauri (Rust + WebView2) 단일 프로세스. Rust 측이 토큰 파일 읽기·HTTPS·CLI spawn·폴링 스케줄러를 담당하고, React/TS WebView는 렌더링과 설정 UI만 맡는다. 3 provider 모두 OAuth 토큰 파일 직읽기 + HTTPS 호출 방식으로 통일 — CLI 프로세스 의존 없음.

**Tech Stack:** Tauri 2, Rust (reqwest, tokio, serde, chrono, jsonwebtoken, winreg), React 19, TypeScript, Vite, Tailwind CSS 3.

**Spec:** `docs/superpowers/specs/2026-04-22-cli-usage-widget-design.md`

**Target Repository:** 별도 저장소 `claude-usage-widget` (아직 생성되지 않음). Task 1에서 새 저장소를 초기화한다.

---

## File Structure

**Rust (src-tauri/src/)**
- `main.rs` — Tauri 앱 진입점, window/event/command 등록
- `types.rs` — 공유 타입 (`Provider`, `Status`, `UsageWindow`, `UsageResponse`, `Settings`, `PersistedState`)
- `errors.rs` — `thiserror` 기반 에러 타입
- `cache.rs` — 30초 TTL 인메모리 캐시 (provider별)
- `settings.rs` — `settings.json` 읽기/쓰기 (원자적)
- `state_store.rs` — `state.json` lastUtilization 스칼라 관리
- `providers/mod.rs` — provider 트레이트 + 디스패치
- `providers/claude.rs` — Anthropic OAuth usage API
- `providers/codex.rs` — ChatGPT backend wham/usage API
- `providers/gemini.rs` — CloudCode retrieveUserQuota API
- `cli_refresher.rs` — CLI spawn + mtime 기반 갱신 검증
- `autostart.rs` — Windows `HKCU\Run` 레지스트리
- `poller.rs` — tokio interval 기반 자동 폴링 + 이벤트 emit
- `commands.rs` — Tauri invoke 명령어들

**Frontend (src/)**
- `main.tsx` — React 루트
- `App.tsx` — 최상위, 이벤트 구독
- `lib/types.ts` — Rust 타입의 TS 미러
- `lib/ipc.ts` — `invoke` 래퍼 + 이벤트 구독 헬퍼
- `components/UsageGauge.tsx` — 잔여량 바 + 위험 오버레이 (Bridge 포팅)
- `components/ProviderCard.tsx` — provider 1개의 모든 windows + 에러 상태
- `components/Header.tsx` — 타이틀, 새로고침, 메뉴, 닫기
- `components/SettingsMenu.tsx` — 드롭다운 (always-on-top, 불투명도, 간격, autostart, About)
- `styles.css` — Tailwind + 커스텀 CSS 변수
- `assets/` — 아이콘

**프로젝트 루트**
- `package.json`, `vite.config.ts`, `tsconfig.json`, `tailwind.config.js`, `postcss.config.js`, `index.html`
- `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/build.rs`, `src-tauri/icons/`
- `README.md`, `.gitignore`, `LICENSE`
- `.github/workflows/release.yml`

---

## Task 1: 프로젝트 스캐폴딩

**Files:**
- Create: `claude-usage-widget/` (새 디렉토리 — 저장소 루트)
- Create: `claude-usage-widget/package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/styles.css`, `tailwind.config.js`, `postcss.config.js`, `.gitignore`, `README.md`
- Create: `claude-usage-widget/src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/build.rs`, `src-tauri/src/main.rs`, `src-tauri/icons/` (기본 아이콘 세트)

- [ ] **Step 1: 저장소 디렉토리 생성 및 `create-tauri-app` 스캐폴딩**

저장소 부모 디렉토리에서 실행 (예: `c:/repository/`). `claude-usage-widget`은 아직 없어야 함.

```bash
cd c:/repository
npm create tauri-app@latest claude-usage-widget -- --template react-ts --manager npm --identifier com.example.claudeusagewidget
cd claude-usage-widget
npm install
```

선택 프롬프트가 뜨면: React + TypeScript. `identifier`는 위에서 주었지만 확인.

- [ ] **Step 2: Tailwind 설치 및 구성**

```bash
npm install -D tailwindcss@^3 postcss autoprefixer
npx tailwindcss init -p
```

`tailwind.config.js`를 다음으로 교체:

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: "#1a1a1a",
        "surface-light": "#2a2a2a",
        text: "#e5e5e5",
        "text-dim": "#9ca3af",
        border: "#333333",
        accent: "#22c55e",
      },
    },
  },
  plugins: [],
};
```

`src/styles.css`를 다음으로 교체:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

html, body, #root { height: 100%; }
body {
  background: transparent;
  color: var(--text, #e5e5e5);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  -webkit-user-select: none;
  user-select: none;
  overflow: hidden;
}
```

`src/main.tsx`에서 `./App.css` import를 제거하고 `./styles.css`를 import하도록 수정.

- [ ] **Step 3: Rust 의존성 추가**

`src-tauri/Cargo.toml`의 `[dependencies]` 섹션을 아래로 교체:

```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-shell = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "json"] }
chrono = { version = "0.4", features = ["serde"] }
jsonwebtoken = "9"
dirs = "5"
anyhow = "1"
thiserror = "1"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }

[target.'cfg(windows)'.dependencies]
winreg = "0.52"
```

- [ ] **Step 4: `tauri.conf.json` 창 설정**

`src-tauri/tauri.conf.json`의 `app.windows` 배열을 다음으로 교체:

```json
[
  {
    "label": "main",
    "title": "Claude Usage Widget",
    "width": 320,
    "height": 520,
    "minWidth": 280,
    "minHeight": 200,
    "resizable": false,
    "decorations": false,
    "transparent": true,
    "alwaysOnTop": true,
    "skipTaskbar": true,
    "fullscreen": false
  }
]
```

그리고 최상위에 `productName: "claude-usage-widget"`, `version: "0.1.0"` 확인.

- [ ] **Step 5: `npm run tauri dev`로 빈 창이 뜨는지 확인**

```bash
npm run tauri dev
```

Expected: Frameless 투명 창이 뜨고 기본 Vite+React 화면 렌더링. 창 닫고 다음 스텝.

- [ ] **Step 6: README + .gitignore + git 초기화 + 첫 커밋**

`README.md`에 아래 최소 내용 작성:

```markdown
# Claude Usage Widget

Windows desktop widget for tracking usage of Claude Code, Codex, and Gemini CLIs.

## Status

Early development. See `docs/` for design.

## Dev

```bash
npm install
npm run tauri dev
```

## Build

```bash
npm run tauri build
```
```

`.gitignore`에 다음 추가 (스캐폴딩이 생성한 내용 + 아래):

```
node_modules/
dist/
src-tauri/target/
src-tauri/gen/
.DS_Store
*.log
```

```bash
git init
git add .
git commit -m "chore: scaffold Tauri + React + TS + Tailwind"
```

---

## Task 2: 공유 타입 정의 (Rust + TS)

**Files:**
- Create: `src-tauri/src/types.rs`
- Create: `src-tauri/src/errors.rs`
- Create: `src/lib/types.ts`
- Modify: `src-tauri/src/main.rs` (mod 선언)

- [ ] **Step 1: `src-tauri/src/errors.rs` 작성**

```rust
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("not authenticated: {0}")]
    NotAuthenticated(String),
    #[error("token expired")]
    Expired,
    #[error("api error {status}: {message}")]
    Api { status: u16, message: String },
    #[error("other: {0}")]
    Other(String),
}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
```

- [ ] **Step 2: `src-tauri/src/types.rs` 작성**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Codex,
    Gemini,
}

impl Provider {
    pub fn as_str(&self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
            Provider::Gemini => "gemini",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Ok,
    NotAuthenticated,
    Expired,
    NetworkError,
    UnknownError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageWindow {
    pub key: String,
    pub name: String,
    pub utilization: f64,
    #[serde(rename = "resetsAt")]
    pub resets_at: String,
    #[serde(rename = "timeProgress")]
    pub time_progress: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtraUsage {
    #[serde(rename = "isEnabled")]
    pub is_enabled: bool,
    #[serde(rename = "monthlyLimit")]
    pub monthly_limit: f64,
    #[serde(rename = "usedCredits")]
    pub used_credits: f64,
    pub utilization: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageResponse {
    pub provider: Provider,
    pub status: Status,
    pub windows: Vec<UsageWindow>,
    #[serde(rename = "extraUsage", skip_serializing_if = "Option::is_none")]
    pub extra_usage: Option<ExtraUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub window: WindowRect,
    #[serde(rename = "alwaysOnTop")]
    pub always_on_top: bool,
    pub opacity: f64,
    #[serde(rename = "refreshIntervalSec")]
    pub refresh_interval_sec: u64,
    pub autostart: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            window: WindowRect { x: 1580, y: 40, width: 320, height: 520 },
            always_on_top: true,
            opacity: 0.92,
            refresh_interval_sec: 300,
            autostart: false,
        }
    }
}
```

`utilization`/`time_progress`는 소수 정확도 보존을 위해 `f64`. JSON 직렬화 시 자연수여도 숫자 그대로 나감.

- [ ] **Step 3: `src/lib/types.ts` 작성 (Rust 미러)**

```ts
export type Provider = "claude" | "codex" | "gemini";
export type Status = "ok" | "not_authenticated" | "expired" | "network_error" | "unknown_error";

export interface UsageWindow {
  key: string;
  name: string;
  utilization: number;
  resetsAt: string;
  timeProgress: number;
}

export interface ExtraUsage {
  isEnabled: boolean;
  monthlyLimit: number;
  usedCredits: number;
  utilization: number | null;
}

export interface UsageResponse {
  provider: Provider;
  status: Status;
  windows: UsageWindow[];
  extraUsage?: ExtraUsage;
  error?: string;
}

export interface WindowRect { x: number; y: number; width: number; height: number }

export interface Settings {
  window: WindowRect;
  alwaysOnTop: boolean;
  opacity: number;
  refreshIntervalSec: number;
  autostart: boolean;
}
```

- [ ] **Step 4: `main.rs`에 모듈 등록**

`src-tauri/src/main.rs` 최상단 (`fn main` 앞)에 추가:

```rust
mod errors;
mod types;
```

- [ ] **Step 5: 빌드 확인**

```bash
cd src-tauri
cargo check
```

Expected: PASS (경고는 무시 OK — 모듈들이 아직 미사용)

- [ ] **Step 6: 커밋**

```bash
git add .
git commit -m "feat: shared types + error enum (Rust + TS mirror)"
```

---

## Task 3: 30초 TTL 캐시

**Files:**
- Create: `src-tauri/src/cache.rs`
- Modify: `src-tauri/src/main.rs` (mod)

- [ ] **Step 1: 테스트 먼저 작성**

`src-tauri/src/cache.rs`:

```rust
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::types::{Provider, UsageResponse};

const TTL: Duration = Duration::from_secs(30);

struct Entry {
    value: UsageResponse,
    at: Instant,
}

pub struct UsageCache {
    map: Mutex<HashMap<Provider, Entry>>,
}

impl UsageCache {
    pub fn new() -> Self {
        Self { map: Mutex::new(HashMap::new()) }
    }

    pub fn get(&self, provider: Provider) -> Option<UsageResponse> {
        let map = self.map.lock().unwrap();
        let entry = map.get(&provider)?;
        if entry.at.elapsed() < TTL {
            Some(entry.value.clone())
        } else {
            None
        }
    }

    pub fn put(&self, provider: Provider, value: UsageResponse) {
        let mut map = self.map.lock().unwrap();
        map.insert(provider, Entry { value, at: Instant::now() });
    }

    pub fn invalidate(&self, provider: Provider) {
        self.map.lock().unwrap().remove(&provider);
    }

    pub fn clear(&self) {
        self.map.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Status, UsageResponse};

    fn make_resp(provider: Provider) -> UsageResponse {
        UsageResponse {
            provider,
            status: Status::Ok,
            windows: vec![],
            extra_usage: None,
            error: None,
        }
    }

    #[test]
    fn put_and_get_within_ttl() {
        let cache = UsageCache::new();
        cache.put(Provider::Claude, make_resp(Provider::Claude));
        assert!(cache.get(Provider::Claude).is_some());
    }

    #[test]
    fn separate_providers_do_not_collide() {
        let cache = UsageCache::new();
        cache.put(Provider::Claude, make_resp(Provider::Claude));
        assert!(cache.get(Provider::Codex).is_none());
    }

    #[test]
    fn invalidate_removes_entry() {
        let cache = UsageCache::new();
        cache.put(Provider::Claude, make_resp(Provider::Claude));
        cache.invalidate(Provider::Claude);
        assert!(cache.get(Provider::Claude).is_none());
    }
}
```

- [ ] **Step 2: `main.rs`에 `mod cache;` 추가 후 테스트 실행**

```bash
cd src-tauri
cargo test cache
```

Expected: 3 tests pass.

- [ ] **Step 3: 커밋**

```bash
git add .
git commit -m "feat: 30s TTL per-provider usage cache"
```

---

## Task 4: Settings store (원자적 파일 R/W)

**Files:**
- Create: `src-tauri/src/settings.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: `settings.rs` 작성 + 테스트**

```rust
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::errors::{AppError, AppResult};
use crate::types::Settings;

fn atomic_write(path: &Path, bytes: &[u8]) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

pub struct SettingsStore {
    path: PathBuf,
}

impl SettingsStore {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self { path: app_data_dir.join("settings.json") }
    }

    pub fn load(&self) -> Settings {
        match fs::read_to_string(&self.path) {
            Ok(s) => serde_json::from_str::<Settings>(&s).unwrap_or_default(),
            Err(_) => Settings::default(),
        }
    }

    pub fn save(&self, settings: &Settings) -> AppResult<()> {
        let bytes = serde_json::to_vec_pretty(settings)?;
        atomic_write(&self.path, &bytes).map_err(|e| AppError::Other(e.to_string()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn load_returns_default_when_missing() {
        let tmp = TempDir::new().unwrap();
        let store = SettingsStore::new(tmp.path().to_path_buf());
        let s = store.load();
        assert_eq!(s.refresh_interval_sec, 300);
        assert!(s.always_on_top);
    }

    #[test]
    fn save_then_load_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let store = SettingsStore::new(tmp.path().to_path_buf());
        let mut s = Settings::default();
        s.opacity = 0.7;
        s.refresh_interval_sec = 60;
        store.save(&s).unwrap();
        let loaded = store.load();
        assert!((loaded.opacity - 0.7).abs() < 1e-9);
        assert_eq!(loaded.refresh_interval_sec, 60);
    }

    #[test]
    fn load_recovers_from_corrupt_json() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("settings.json");
        fs::write(&path, "not json").unwrap();
        let store = SettingsStore::new(tmp.path().to_path_buf());
        let s = store.load();
        assert_eq!(s.refresh_interval_sec, 300);
    }
}
```

- [ ] **Step 2: `tempfile` 개발 의존성 추가**

`src-tauri/Cargo.toml`:

```toml
[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 3: `main.rs`에 `mod settings;` 추가, 테스트 실행**

```bash
cd src-tauri
cargo test settings
```

Expected: 3 tests pass.

- [ ] **Step 4: 커밋**

```bash
git add .
git commit -m "feat: SettingsStore with atomic write + corrupt-recovery"
```

---

## Task 5: State store (tamagotchi 훅용 스칼라)

**Files:**
- Create: `src-tauri/src/state_store.rs`

- [ ] **Step 1: `state_store.rs` 작성 + 테스트**

```rust
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::errors::AppResult;
use crate::types::{Provider, UsageResponse};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PersistedState {
    #[serde(default)]
    pub last_utilization: HashMap<String, f64>,
    #[serde(default)]
    pub last_updated_at: Option<String>,
}

fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

pub struct StateStore {
    path: PathBuf,
}

impl StateStore {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self { path: app_data_dir.join("state.json") }
    }

    pub fn load(&self) -> PersistedState {
        match fs::read_to_string(&self.path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
            Err(_) => PersistedState::default(),
        }
    }

    pub fn save(&self, state: &PersistedState) -> AppResult<()> {
        let bytes = serde_json::to_vec_pretty(state)?;
        atomic_write(&self.path, &bytes)?;
        Ok(())
    }

    /// 현재 UsageResponse 배열로부터 delta 계산 + 새 상태 반환.
    /// 리턴: (new_state, delta_map). delta 키는 `${provider}.${window_key}`.
    pub fn compute_and_update(
        &self,
        prev: &PersistedState,
        current: &[UsageResponse],
    ) -> (PersistedState, HashMap<String, f64>) {
        let mut new_util: HashMap<String, f64> = prev.last_utilization.clone();
        let mut delta: HashMap<String, f64> = HashMap::new();

        for resp in current {
            for w in &resp.windows {
                let key = format!("{}.{}", resp.provider.as_str(), w.key);
                let prev_v = prev.last_utilization.get(&key).copied().unwrap_or(w.utilization);
                delta.insert(key.clone(), w.utilization - prev_v);
                new_util.insert(key, w.utilization);
            }
        }

        let new_state = PersistedState {
            last_utilization: new_util,
            last_updated_at: Some(Utc::now().to_rfc3339()),
        };
        (new_state, delta)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Status, UsageWindow};
    use tempfile::TempDir;

    fn mk_resp(provider: Provider, windows: Vec<(&str, f64)>) -> UsageResponse {
        UsageResponse {
            provider,
            status: Status::Ok,
            windows: windows.into_iter().map(|(k, u)| UsageWindow {
                key: k.to_string(),
                name: k.to_string(),
                utilization: u,
                resets_at: "2026-04-22T00:00:00Z".to_string(),
                time_progress: 50.0,
            }).collect(),
            extra_usage: None,
            error: None,
        }
    }

    #[test]
    fn delta_zero_when_no_prior_state() {
        let tmp = TempDir::new().unwrap();
        let store = StateStore::new(tmp.path().to_path_buf());
        let prev = PersistedState::default();
        let current = vec![mk_resp(Provider::Claude, vec![("five_hour", 42.0)])];
        let (_new, delta) = store.compute_and_update(&prev, &current);
        assert_eq!(delta.get("claude.five_hour").copied(), Some(0.0));
    }

    #[test]
    fn delta_positive_when_usage_grew() {
        let tmp = TempDir::new().unwrap();
        let store = StateStore::new(tmp.path().to_path_buf());
        let mut prev = PersistedState::default();
        prev.last_utilization.insert("claude.five_hour".into(), 40.0);
        let current = vec![mk_resp(Provider::Claude, vec![("five_hour", 55.0)])];
        let (new, delta) = store.compute_and_update(&prev, &current);
        assert_eq!(delta["claude.five_hour"], 15.0);
        assert_eq!(new.last_utilization["claude.five_hour"], 55.0);
    }

    #[test]
    fn delta_negative_on_window_reset() {
        let tmp = TempDir::new().unwrap();
        let store = StateStore::new(tmp.path().to_path_buf());
        let mut prev = PersistedState::default();
        prev.last_utilization.insert("claude.five_hour".into(), 80.0);
        let current = vec![mk_resp(Provider::Claude, vec![("five_hour", 5.0)])];
        let (_new, delta) = store.compute_and_update(&prev, &current);
        assert_eq!(delta["claude.five_hour"], -75.0);
    }

    #[test]
    fn save_load_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let store = StateStore::new(tmp.path().to_path_buf());
        let mut s = PersistedState::default();
        s.last_utilization.insert("claude.five_hour".into(), 42.0);
        store.save(&s).unwrap();
        let loaded = store.load();
        assert_eq!(loaded.last_utilization["claude.five_hour"], 42.0);
    }
}
```

- [ ] **Step 2: `main.rs`에 `mod state_store;` 추가 + 테스트**

```bash
cd src-tauri
cargo test state_store
```

Expected: 4 tests pass.

- [ ] **Step 3: 커밋**

```bash
git add .
git commit -m "feat: StateStore for per-window utilization delta tracking"
```

---

## Task 6: Claude provider

**Files:**
- Create: `src-tauri/src/providers/mod.rs`
- Create: `src-tauri/src/providers/claude.rs`

- [ ] **Step 1: `providers/mod.rs` 작성**

```rust
pub mod claude;
pub mod codex;
pub mod gemini;

use crate::errors::AppResult;
use crate::types::{Provider, UsageResponse};

pub async fn fetch(provider: Provider) -> AppResult<UsageResponse> {
    match provider {
        Provider::Claude => claude::fetch().await,
        Provider::Codex => codex::fetch().await,
        Provider::Gemini => gemini::fetch().await,
    }
}
```

Codex/Gemini 파일은 빈 stub으로 생성 (컴파일 통과용):

`src-tauri/src/providers/codex.rs`:

```rust
use crate::errors::{AppError, AppResult};
use crate::types::UsageResponse;

pub async fn fetch() -> AppResult<UsageResponse> {
    Err(AppError::Other("codex not yet implemented".into()))
}
```

`src-tauri/src/providers/gemini.rs`:

```rust
use crate::errors::{AppError, AppResult};
use crate::types::UsageResponse;

pub async fn fetch() -> AppResult<UsageResponse> {
    Err(AppError::Other("gemini not yet implemented".into()))
}
```

- [ ] **Step 2: `providers/claude.rs` — 토큰 파싱 순수 함수 + 테스트 작성 (실패)**

```rust
use std::path::PathBuf;

use serde::Deserialize;

use crate::errors::{AppError, AppResult};
use crate::types::{Provider, Status, UsageResponse, UsageWindow};

#[derive(Deserialize)]
struct Creds {
    #[serde(rename = "claudeAiOauth")]
    claude_ai_oauth: OauthBlock,
}

#[derive(Deserialize)]
struct OauthBlock {
    #[serde(rename = "accessToken")]
    access_token: String,
}

#[derive(Deserialize)]
struct RawWindow {
    utilization: f64,
    #[serde(rename = "resets_at")]
    resets_at: String,
}

#[derive(Deserialize, Default)]
pub(crate) struct RawUsage {
    pub five_hour: Option<RawWindow>,
    pub seven_day: Option<RawWindow>,
    pub seven_day_sonnet: Option<RawWindow>,
    pub seven_day_opus: Option<RawWindow>,
    pub seven_day_cowork: Option<RawWindow>,
}

fn credentials_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".claude").join(".credentials.json")
}

fn read_token() -> AppResult<String> {
    let path = credentials_path();
    let raw = std::fs::read_to_string(&path)
        .map_err(|_| AppError::NotAuthenticated("claude credentials not found".into()))?;
    let creds: Creds = serde_json::from_str(&raw)
        .map_err(|_| AppError::NotAuthenticated("claude credentials malformed".into()))?;
    Ok(creds.claude_ai_oauth.access_token)
}

const WIN_DEFS: &[(&str, &str, u64)] = &[
    ("five_hour", "5시간", 5 * 60 * 60),
    ("seven_day", "7일", 7 * 24 * 60 * 60),
    ("seven_day_sonnet", "7일 (Sonnet)", 7 * 24 * 60 * 60),
    ("seven_day_opus", "7일 (Opus)", 7 * 24 * 60 * 60),
    ("seven_day_cowork", "7일 (Cowork)", 7 * 24 * 60 * 60),
];

fn compute_time_progress(resets_at: &str, duration_sec: u64) -> f64 {
    let reset = match chrono::DateTime::parse_from_rfc3339(resets_at) {
        Ok(dt) => dt.timestamp(),
        Err(_) => return 0.0,
    };
    let now = chrono::Utc::now().timestamp();
    let start = reset - duration_sec as i64;
    if now <= start { return 0.0; }
    if now >= reset { return 100.0; }
    ((now - start) as f64 / duration_sec as f64 * 100.0).round()
}

pub(crate) fn map_raw_to_response(raw: &RawUsage) -> UsageResponse {
    let mut windows = Vec::new();
    for (key, label, dur) in WIN_DEFS {
        let w = match *key {
            "five_hour" => raw.five_hour.as_ref(),
            "seven_day" => raw.seven_day.as_ref(),
            "seven_day_sonnet" => raw.seven_day_sonnet.as_ref(),
            "seven_day_opus" => raw.seven_day_opus.as_ref(),
            "seven_day_cowork" => raw.seven_day_cowork.as_ref(),
            _ => None,
        };
        if let Some(w) = w {
            windows.push(UsageWindow {
                key: (*key).to_string(),
                name: (*label).to_string(),
                utilization: w.utilization,
                resets_at: w.resets_at.clone(),
                time_progress: compute_time_progress(&w.resets_at, *dur),
            });
        }
    }
    UsageResponse {
        provider: Provider::Claude,
        status: Status::Ok,
        windows,
        extra_usage: None,
        error: None,
    }
}

pub async fn fetch() -> AppResult<UsageResponse> {
    let token = read_token()?;
    let client = reqwest::Client::new();
    let res = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {}", token))
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await?;

    let status = res.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(AppError::Expired);
    }
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(AppError::Api { status: status.as_u16(), message: body });
    }

    let raw: RawUsage = res.json().await?;
    Ok(map_raw_to_response(&raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_five_hour_and_seven_day() {
        let raw = RawUsage {
            five_hour: Some(RawWindow { utilization: 42.0, resets_at: "2030-01-01T00:00:00Z".into() }),
            seven_day: Some(RawWindow { utilization: 10.0, resets_at: "2030-01-01T00:00:00Z".into() }),
            ..Default::default()
        };
        let resp = map_raw_to_response(&raw);
        assert_eq!(resp.provider, Provider::Claude);
        assert_eq!(resp.windows.len(), 2);
        assert_eq!(resp.windows[0].key, "five_hour");
        assert_eq!(resp.windows[0].utilization, 42.0);
        assert_eq!(resp.windows[1].key, "seven_day");
    }

    #[test]
    fn skips_missing_windows() {
        let raw = RawUsage::default();
        let resp = map_raw_to_response(&raw);
        assert_eq!(resp.windows.len(), 0);
    }

    #[test]
    fn time_progress_zero_when_reset_far_future() {
        let far = "2099-01-01T00:00:00Z";
        let tp = compute_time_progress(far, 5 * 60 * 60);
        assert_eq!(tp, 0.0);
    }
}
```

- [ ] **Step 3: `main.rs`에 `mod providers;` 추가 + 테스트**

```bash
cd src-tauri
cargo test providers::claude
```

Expected: 3 tests pass.

- [ ] **Step 4: 커밋**

```bash
git add .
git commit -m "feat(providers): Claude OAuth usage fetch + mapping"
```

---

## Task 7: Gemini provider

**Files:**
- Modify: `src-tauri/src/providers/gemini.rs`

- [ ] **Step 1: `providers/gemini.rs` 구현 + 테스트**

```rust
use std::path::PathBuf;

use serde::Deserialize;

use crate::errors::{AppError, AppResult};
use crate::types::{Provider, Status, UsageResponse, UsageWindow};

#[derive(Deserialize)]
struct Creds {
    access_token: String,
    #[serde(default)]
    expiry_date: Option<i64>,
}

#[derive(Deserialize)]
struct ProjectsFile {
    #[serde(default)]
    projects: std::collections::HashMap<String, String>,
}

#[derive(Deserialize)]
pub(crate) struct QuotaBucket {
    #[serde(rename = "resetTime")]
    pub resets_at: String,
    #[serde(rename = "tokenType")]
    pub token_type: String,
    #[serde(rename = "modelId")]
    pub model_id: String,
    #[serde(rename = "remainingFraction")]
    pub remaining_fraction: f64,
}

#[derive(Deserialize, Default)]
pub(crate) struct QuotaResponse {
    #[serde(default)]
    pub buckets: Vec<QuotaBucket>,
}

fn creds_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".gemini").join("oauth_creds.json")
}

fn projects_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".gemini").join("projects.json")
}

fn read_token() -> AppResult<(String, Option<i64>)> {
    let s = std::fs::read_to_string(creds_path())
        .map_err(|_| AppError::NotAuthenticated("gemini creds not found".into()))?;
    let c: Creds = serde_json::from_str(&s)
        .map_err(|_| AppError::NotAuthenticated("gemini creds malformed".into()))?;
    Ok((c.access_token, c.expiry_date))
}

fn read_first_project_id() -> Option<String> {
    let s = std::fs::read_to_string(projects_path()).ok()?;
    let pf: ProjectsFile = serde_json::from_str(&s).ok()?;
    pf.projects.into_values().next()
}

fn model_tier(model_id: &str) -> &'static str {
    if model_id.contains("flash-lite") { "flash_lite" }
    else if model_id.contains("flash") { "flash" }
    else if model_id.contains("pro") { "pro" }
    else { "other" }
}

fn tier_label(key: &str) -> &'static str {
    match key {
        "flash_lite" => "Flash Lite",
        "flash" => "Flash",
        "pro" => "Pro",
        _ => "Other",
    }
}

const TIER_ORDER: &[&str] = &["flash_lite", "flash", "pro"];
const DAY_SEC: u64 = 24 * 60 * 60;

fn compute_time_progress(resets_at: &str, duration_sec: u64) -> f64 {
    let reset = match chrono::DateTime::parse_from_rfc3339(resets_at) {
        Ok(dt) => dt.timestamp(),
        Err(_) => return 0.0,
    };
    let now = chrono::Utc::now().timestamp();
    let start = reset - duration_sec as i64;
    if now <= start { return 0.0; }
    if now >= reset { return 100.0; }
    ((now - start) as f64 / duration_sec as f64 * 100.0).round()
}

pub(crate) fn map_raw_to_response(raw: &QuotaResponse) -> UsageResponse {
    let mut first_per_tier: std::collections::HashMap<&str, &QuotaBucket> = Default::default();
    for b in &raw.buckets {
        if b.token_type != "REQUESTS" { continue; }
        let tier = model_tier(&b.model_id);
        first_per_tier.entry(tier).or_insert(b);
    }

    let mut windows = Vec::new();
    for key in TIER_ORDER {
        if let Some(b) = first_per_tier.get(key) {
            let util = ((1.0 - b.remaining_fraction) * 100.0).round();
            windows.push(UsageWindow {
                key: (*key).to_string(),
                name: tier_label(key).to_string(),
                utilization: util,
                resets_at: b.resets_at.clone(),
                time_progress: compute_time_progress(&b.resets_at, DAY_SEC),
            });
        }
    }

    UsageResponse {
        provider: Provider::Gemini,
        status: Status::Ok,
        windows,
        extra_usage: None,
        error: None,
    }
}

pub async fn fetch() -> AppResult<UsageResponse> {
    let (token, _exp) = read_token()?;
    let project_id = read_first_project_id();
    let body = match project_id {
        Some(p) => serde_json::json!({ "project": p }),
        None => serde_json::json!({}),
    };
    let client = reqwest::Client::new();
    let res = client
        .post("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota")
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await?;

    let status = res.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(AppError::Expired);
    }
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(AppError::Api { status: status.as_u16(), message: body });
    }

    let raw: QuotaResponse = res.json().await?;
    Ok(map_raw_to_response(&raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedupe_tier_and_compute_utilization() {
        let raw = QuotaResponse {
            buckets: vec![
                QuotaBucket {
                    resets_at: "2030-01-01T00:00:00Z".into(),
                    token_type: "REQUESTS".into(),
                    model_id: "gemini-2.0-flash-exp".into(),
                    remaining_fraction: 0.2,
                },
                QuotaBucket {
                    resets_at: "2030-01-01T00:00:00Z".into(),
                    token_type: "REQUESTS".into(),
                    model_id: "gemini-2.0-flash-002".into(),
                    remaining_fraction: 0.5,
                },
                QuotaBucket {
                    resets_at: "2030-01-01T00:00:00Z".into(),
                    token_type: "REQUESTS".into(),
                    model_id: "gemini-2.5-pro".into(),
                    remaining_fraction: 0.9,
                },
            ],
        };
        let resp = map_raw_to_response(&raw);
        assert_eq!(resp.windows.len(), 2);
        assert_eq!(resp.windows[0].key, "flash");
        assert_eq!(resp.windows[0].utilization, 80.0);
        assert_eq!(resp.windows[1].key, "pro");
        assert_eq!(resp.windows[1].utilization, 10.0);
    }

    #[test]
    fn skips_non_requests_tokens() {
        let raw = QuotaResponse {
            buckets: vec![QuotaBucket {
                resets_at: "2030-01-01T00:00:00Z".into(),
                token_type: "INPUT_TOKENS".into(),
                model_id: "gemini-2.5-pro".into(),
                remaining_fraction: 0.5,
            }],
        };
        let resp = map_raw_to_response(&raw);
        assert_eq!(resp.windows.len(), 0);
    }
}
```

- [ ] **Step 2: 테스트 실행**

```bash
cargo test providers::gemini
```

Expected: 2 tests pass.

- [ ] **Step 3: 커밋**

```bash
git add .
git commit -m "feat(providers): Gemini CloudCode quota fetch + tier mapping"
```

---

## Task 8: Codex provider

**Files:**
- Modify: `src-tauri/src/providers/codex.rs`

- [ ] **Step 1: `providers/codex.rs` 구현 + 테스트**

```rust
use std::path::PathBuf;

use serde::Deserialize;

use crate::errors::{AppError, AppResult};
use crate::types::{ExtraUsage, Provider, Status, UsageResponse, UsageWindow};

#[derive(Deserialize)]
struct Auth {
    tokens: Tokens,
}

#[derive(Deserialize)]
struct Tokens {
    access_token: String,
    #[serde(default)]
    account_id: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct RawWindow {
    #[serde(default)]
    pub used_percent: Option<f64>,
    #[serde(default)]
    pub reset_at: Option<i64>,
    #[serde(default)]
    pub limit_window_seconds: Option<u64>,
}

#[derive(Deserialize)]
pub(crate) struct RawRateLimit {
    #[serde(default)]
    pub primary_window: Option<RawWindow>,
    #[serde(default)]
    pub secondary_window: Option<RawWindow>,
}

#[derive(Deserialize)]
pub(crate) struct RawCredits {
    #[serde(default)]
    pub has_credits: Option<bool>,
    #[serde(default)]
    pub unlimited: Option<bool>,
    #[serde(default)]
    pub balance: Option<f64>,
}

#[derive(Deserialize)]
pub(crate) struct RawUsage {
    #[serde(default)]
    pub rate_limit: Option<RawRateLimit>,
    #[serde(default)]
    pub credits: Option<RawCredits>,
}

fn auth_path() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".codex").join("auth.json")
}

fn read_auth() -> AppResult<(String, Option<String>)> {
    let s = std::fs::read_to_string(auth_path())
        .map_err(|_| AppError::NotAuthenticated("codex auth not found".into()))?;
    let a: Auth = serde_json::from_str(&s)
        .map_err(|_| AppError::NotAuthenticated("codex auth malformed".into()))?;
    Ok((a.tokens.access_token, a.tokens.account_id))
}

fn window_name(dur_sec: u64) -> String {
    let hours = dur_sec / 3600;
    if hours >= 24 {
        let days = hours / 24;
        format!("{}일", days)
    } else {
        format!("{}시간", hours)
    }
}

fn iso_from_epoch(sec: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp(sec, 0)
        .map(|dt| dt.to_rfc3339())
        .unwrap_or_default()
}

fn compute_time_progress(resets_epoch: i64, duration_sec: u64) -> f64 {
    let now = chrono::Utc::now().timestamp();
    let start = resets_epoch - duration_sec as i64;
    if now <= start { return 0.0; }
    if now >= resets_epoch { return 100.0; }
    ((now - start) as f64 / duration_sec as f64 * 100.0).round()
}

fn push_window(out: &mut Vec<UsageWindow>, key: &str, w: &RawWindow) {
    let (util, reset_at, dur) = match (w.used_percent, w.reset_at, w.limit_window_seconds) {
        (Some(u), Some(r), Some(d)) => (u, r, d),
        _ => return,
    };
    out.push(UsageWindow {
        key: key.to_string(),
        name: window_name(dur),
        utilization: util,
        resets_at: iso_from_epoch(reset_at),
        time_progress: compute_time_progress(reset_at, dur),
    });
}

pub(crate) fn map_raw_to_response(raw: &RawUsage) -> UsageResponse {
    let mut windows = Vec::new();
    if let Some(rl) = &raw.rate_limit {
        if let Some(p) = &rl.primary_window { push_window(&mut windows, "primary", p); }
        if let Some(s) = &rl.secondary_window { push_window(&mut windows, "secondary", s); }
    }
    let extra = raw.credits.as_ref().map(|c| ExtraUsage {
        is_enabled: c.has_credits.unwrap_or(false),
        monthly_limit: 0.0,
        used_credits: c.balance.unwrap_or(0.0),
        utilization: None,
    });
    UsageResponse {
        provider: Provider::Codex,
        status: Status::Ok,
        windows,
        extra_usage: extra,
        error: None,
    }
}

pub async fn fetch() -> AppResult<UsageResponse> {
    let (token, account_id) = read_auth()?;
    let account_id = account_id
        .ok_or_else(|| AppError::NotAuthenticated("codex account_id missing".into()))?;

    let client = reqwest::Client::new();
    let res = client
        .get("https://chatgpt.com/backend-api/wham/usage")
        .header("Authorization", format!("Bearer {}", token))
        .header("ChatGPT-Account-Id", account_id)
        .header("User-Agent", "codex-cli")
        .send()
        .await?;

    let status = res.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(AppError::Expired);
    }
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(AppError::Api { status: status.as_u16(), message: body });
    }
    let raw: RawUsage = res.json().await?;
    Ok(map_raw_to_response(&raw))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_primary_and_secondary() {
        let raw = RawUsage {
            rate_limit: Some(RawRateLimit {
                primary_window: Some(RawWindow {
                    used_percent: Some(20.0),
                    reset_at: Some(4_000_000_000),
                    limit_window_seconds: Some(18000),
                }),
                secondary_window: Some(RawWindow {
                    used_percent: Some(55.0),
                    reset_at: Some(4_000_000_000),
                    limit_window_seconds: Some(604800),
                }),
            }),
            credits: None,
        };
        let resp = map_raw_to_response(&raw);
        assert_eq!(resp.windows.len(), 2);
        assert_eq!(resp.windows[0].key, "primary");
        assert_eq!(resp.windows[0].name, "5시간");
        assert_eq!(resp.windows[1].name, "7일");
    }

    #[test]
    fn skips_window_with_missing_fields() {
        let raw = RawUsage {
            rate_limit: Some(RawRateLimit {
                primary_window: Some(RawWindow {
                    used_percent: Some(20.0),
                    reset_at: None,
                    limit_window_seconds: Some(18000),
                }),
                secondary_window: None,
            }),
            credits: None,
        };
        let resp = map_raw_to_response(&raw);
        assert_eq!(resp.windows.len(), 0);
    }

    #[test]
    fn maps_credits_to_extra_usage() {
        let raw = RawUsage {
            rate_limit: None,
            credits: Some(RawCredits {
                has_credits: Some(true),
                unlimited: Some(false),
                balance: Some(150.0),
            }),
        };
        let resp = map_raw_to_response(&raw);
        let extra = resp.extra_usage.unwrap();
        assert!(extra.is_enabled);
        assert_eq!(extra.used_credits, 150.0);
    }
}
```

- [ ] **Step 2: 테스트**

```bash
cargo test providers::codex
```

Expected: 3 tests pass.

- [ ] **Step 3: 커밋**

```bash
git add .
git commit -m "feat(providers): Codex wham/usage fetch + window/credits mapping"
```

---

## Task 9: CLI refresher (mtime 기반 spawn 검증)

**Files:**
- Create: `src-tauri/src/cli_refresher.rs`

- [ ] **Step 1: `cli_refresher.rs` 작성**

```rust
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use tokio::process::Command;
use tokio::time::timeout;

use crate::errors::{AppError, AppResult};
use crate::types::Provider;

const SPAWN_TIMEOUT: Duration = Duration::from_secs(15);

fn token_path(provider: Provider) -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    match provider {
        Provider::Claude => home.join(".claude").join(".credentials.json"),
        Provider::Codex => home.join(".codex").join("auth.json"),
        Provider::Gemini => home.join(".gemini").join("oauth_creds.json"),
    }
}

fn mtime(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

fn commands(provider: Provider) -> (Command, Command) {
    let prompt = "Reply with exactly: hi. No other text.";
    match provider {
        Provider::Claude => {
            let mut light = Command::new("claude");
            light.arg("--version");
            let mut full = Command::new("claude");
            full.args(["-p", prompt]);
            (light, full)
        }
        Provider::Gemini => {
            let mut light = Command::new("gemini");
            light.arg("--version");
            let mut full = Command::new("gemini");
            full.args(["-p", prompt]);
            (light, full)
        }
        Provider::Codex => {
            let mut light = Command::new("codex");
            light.arg("--version");
            let mut full = Command::new("codex");
            full.args(["exec", prompt]);
            (light, full)
        }
    }
}

async fn run_with_timeout(mut cmd: Command) -> AppResult<std::process::ExitStatus> {
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let child = cmd.spawn().map_err(|e| AppError::Other(format!("spawn failed: {}", e)))?;
    let mut child = child;
    let status = timeout(SPAWN_TIMEOUT, child.wait())
        .await
        .map_err(|_| AppError::Other("cli spawn timed out".into()))??;
    Ok(status)
}

/// CLI를 실행해서 토큰 파일 mtime이 바뀌면 성공으로 판단.
pub async fn refresh_via_cli(provider: Provider) -> AppResult<()> {
    let path = token_path(provider);
    let before = mtime(&path);

    let (light, full) = commands(provider);

    // 1순위: --version
    let _ = run_with_timeout(light).await.ok();
    let after_light = mtime(&path);
    if after_light != before && after_light.is_some() {
        return Ok(());
    }

    // 2순위: 최소 프롬프트
    let status = run_with_timeout(full).await?;
    let after_full = mtime(&path);
    if after_full != before && after_full.is_some() {
        return Ok(());
    }
    if !status.success() {
        return Err(AppError::Other(format!(
            "cli exited non-zero and token file did not change (provider: {})",
            provider.as_str()
        )));
    }
    // exit 0인데 mtime 변경 없음 — 토큰 이미 유효했을 수 있으나, 호출자는 이를 성공으로 간주해도 됨
    Ok(())
}
```

- [ ] **Step 2: `main.rs`에 `mod cli_refresher;` 추가, 컴파일 확인**

```bash
cargo check
```

Expected: PASS.

**Note:** 이 모듈은 실제 spawn을 mock 없이 테스트하기 어려우므로 단위 테스트 생략. Task 14의 수동 QA에서 검증.

- [ ] **Step 3: 커밋**

```bash
git add .
git commit -m "feat: CLI refresher with version fallback to minimal prompt (mtime check)"
```

---

## Task 10: Autostart (Windows HKCU\Run)

**Files:**
- Create: `src-tauri/src/autostart.rs`

- [ ] **Step 1: `autostart.rs` 작성**

```rust
use crate::errors::{AppError, AppResult};

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE_NAME: &str = "ClaudeUsageWidget";

#[cfg(windows)]
pub fn set(enabled: bool) -> AppResult<()> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey_with_flags(RUN_KEY, KEY_SET_VALUE)
        .map_err(|e| AppError::Other(format!("registry open: {}", e)))?;

    if enabled {
        let exe = std::env::current_exe()
            .map_err(|e| AppError::Other(format!("current_exe: {}", e)))?;
        let exe_str = format!("\"{}\"", exe.display());
        key.set_value(VALUE_NAME, &exe_str)
            .map_err(|e| AppError::Other(format!("registry set: {}", e)))?;
    } else {
        let _ = key.delete_value(VALUE_NAME);
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn set(_enabled: bool) -> AppResult<()> {
    Err(AppError::Other("autostart only supported on Windows".into()))
}

#[cfg(windows)]
pub fn is_enabled() -> bool {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    match hkcu.open_subkey_with_flags(RUN_KEY, KEY_READ) {
        Ok(k) => k.get_value::<String, _>(VALUE_NAME).is_ok(),
        Err(_) => false,
    }
}

#[cfg(not(windows))]
pub fn is_enabled() -> bool { false }
```

- [ ] **Step 2: `main.rs`에 `mod autostart;` 추가, `cargo check`**

Expected: PASS.

- [ ] **Step 3: 커밋**

```bash
git add .
git commit -m "feat: Windows HKCU\\Run autostart toggle"
```

---

## Task 11: App state + get_all_usage aggregation

**Files:**
- Create: `src-tauri/src/app_state.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: `app_state.rs` 작성**

```rust
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::cache::UsageCache;
use crate::errors::AppError;
use crate::providers;
use crate::settings::SettingsStore;
use crate::state_store::{PersistedState, StateStore};
use crate::types::{Provider, Status, UsageResponse};

pub struct AppState {
    pub cache: UsageCache,
    pub settings: SettingsStore,
    pub state: StateStore,
    pub persisted: Mutex<PersistedState>,
}

impl AppState {
    pub fn new(app_data_dir: PathBuf) -> Arc<Self> {
        let state = StateStore::new(app_data_dir.clone());
        let persisted = state.load();
        Arc::new(Self {
            cache: UsageCache::new(),
            settings: SettingsStore::new(app_data_dir),
            state,
            persisted: Mutex::new(persisted),
        })
    }

    pub async fn fetch_all(&self, force: bool) -> (Vec<UsageResponse>, HashMap<String, f64>) {
        let providers = [Provider::Claude, Provider::Codex, Provider::Gemini];

        let futs = providers.iter().map(|&p| async move {
            if !force {
                if let Some(cached) = self.cache.get(p) {
                    return cached;
                }
            }
            let resp = match providers::fetch(p).await {
                Ok(r) => r,
                Err(e) => error_to_response(p, e),
            };
            if resp.status == Status::Ok {
                self.cache.put(p, resp.clone());
            }
            resp
        });

        let responses: Vec<UsageResponse> = futures::future::join_all(futs).await;

        let mut persisted = self.persisted.lock().await;
        let (new_state, delta) = self.state.compute_and_update(&*persisted, &responses);
        *persisted = new_state.clone();
        let _ = self.state.save(&new_state);

        (responses, delta)
    }
}

fn error_to_response(provider: Provider, err: AppError) -> UsageResponse {
    let (status, msg) = match err {
        AppError::NotAuthenticated(m) => (Status::NotAuthenticated, m),
        AppError::Expired => (Status::Expired, "token expired".into()),
        AppError::Http(e) => (Status::NetworkError, e.to_string()),
        AppError::Api { status: 429, .. } => (Status::NetworkError, "rate limited".into()),
        AppError::Api { status, message } => (Status::UnknownError, format!("api {}: {}", status, message)),
        other => (Status::UnknownError, other.to_string()),
    };
    UsageResponse {
        provider,
        status,
        windows: vec![],
        extra_usage: None,
        error: Some(msg),
    }
}
```

- [ ] **Step 2: `futures` 의존성 추가**

`src-tauri/Cargo.toml`의 `[dependencies]`:

```toml
futures = "0.3"
```

- [ ] **Step 3: `main.rs`에 `mod app_state;` 추가 + `cargo check`**

Expected: PASS.

- [ ] **Step 4: 커밋**

```bash
git add .
git commit -m "feat: AppState + parallel fetch_all with delta computation"
```

---

## Task 12: Tauri commands 등록

**Files:**
- Create: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/main.rs`

- [ ] **Step 1: `commands.rs` 작성**

```rust
use std::sync::Arc;

use serde::Serialize;
use tauri::{Emitter, State};

use crate::app_state::AppState;
use crate::autostart;
use crate::cli_refresher;
use crate::errors::AppResult;
use crate::types::{Provider, Settings, UsageResponse};

#[derive(Serialize, Clone)]
pub struct UsageUpdatedPayload {
    pub current: Vec<UsageResponse>,
    pub delta: std::collections::HashMap<String, f64>,
}

#[tauri::command]
pub async fn get_all_usage(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    force: Option<bool>,
) -> Result<Vec<UsageResponse>, String> {
    let _ = app.emit("usage:refreshing", serde_json::json!({ "manual": force.unwrap_or(false) }));
    let (current, delta) = state.fetch_all(force.unwrap_or(false)).await;
    let _ = app.emit("usage:updated", UsageUpdatedPayload { current: current.clone(), delta });
    Ok(current)
}

#[tauri::command]
pub async fn refresh_via_cli(
    provider: Provider,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    cli_refresher::refresh_via_cli(provider).await.map_err(|e| e.to_string())?;
    state.cache.invalidate(provider);
    Ok(())
}

#[tauri::command]
pub async fn get_settings(state: State<'_, Arc<AppState>>) -> Result<Settings, String> {
    Ok(state.settings.load())
}

#[tauri::command]
pub async fn save_settings(
    settings: Settings,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    state.settings.save(&settings).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn set_autostart(enabled: bool) -> Result<(), String> {
    autostart::set(enabled).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    webbrowser::open(&url).map_err(|e| e.to_string())
}
```

- [ ] **Step 2: `webbrowser` 의존성 추가**

`Cargo.toml`:

```toml
webbrowser = "1"
```

- [ ] **Step 3: `main.rs` 업데이트 — state 등록 + invoke handler**

`src-tauri/src/main.rs`를 다음으로 교체:

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_state;
mod autostart;
mod cache;
mod cli_refresher;
mod commands;
mod errors;
mod poller;
mod providers;
mod settings;
mod state_store;
mod types;

use std::sync::Arc;

use app_state::AppState;
use tauri::Manager;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("app_data_dir resolution");
            std::fs::create_dir_all(&data_dir).ok();

            let state = AppState::new(data_dir);
            app.manage(state.clone());

            // 초기 설정 적용 (창 크기/위치/alwaysOnTop/opacity)
            let settings = state.settings.load();
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_always_on_top(settings.always_on_top);
                let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize {
                    width: settings.window.width as f64,
                    height: settings.window.height as f64,
                }));
                let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition {
                    x: settings.window.x as f64,
                    y: settings.window.y as f64,
                }));
            }

            // 자동 폴링 시작
            poller::spawn(app.handle().clone(), state.clone(), settings.refresh_interval_sec);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_all_usage,
            commands::refresh_via_cli,
            commands::get_settings,
            commands::save_settings,
            commands::set_autostart,
            commands::open_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 4: poller 스텁 생성 (다음 Task에서 구현)**

`src-tauri/src/poller.rs`:

```rust
use std::sync::Arc;

use tauri::AppHandle;

use crate::app_state::AppState;

pub fn spawn(_app: AppHandle, _state: Arc<AppState>, _interval_sec: u64) {
    // implemented in Task 13
}
```

- [ ] **Step 5: `cargo check`**

Expected: PASS.

- [ ] **Step 6: 커밋**

```bash
git add .
git commit -m "feat: register Tauri commands + wire AppState in setup"
```

---

## Task 13: 자동 폴링 (tokio interval)

**Files:**
- Modify: `src-tauri/src/poller.rs`

- [ ] **Step 1: `poller.rs` 구현**

```rust
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tokio::time::interval;

use crate::app_state::AppState;
use crate::commands::UsageUpdatedPayload;

pub fn spawn(app: AppHandle, state: Arc<AppState>, interval_sec: u64) {
    tokio::spawn(async move {
        // 첫 실행 즉시
        tick(&app, &state).await;

        let mut t = interval(Duration::from_secs(interval_sec.max(30)));
        t.tick().await; // 첫 tick은 즉시 반환됨, skip
        loop {
            t.tick().await;
            tick(&app, &state).await;
        }
    });
}

async fn tick(app: &AppHandle, state: &Arc<AppState>) {
    let _ = app.emit("usage:refreshing", serde_json::json!({ "manual": false }));
    let (current, delta) = state.fetch_all(false).await;
    let _ = app.emit("usage:updated", UsageUpdatedPayload { current, delta });
}
```

**제약**: 사용자가 간격을 변경하면 재시작 필요. MVP에서는 **앱 재시작 시 반영**으로 단순화 (설정 저장 후 "재시작 필요" 안내). Task 18에서 UI 경고 표시.

- [ ] **Step 2: `cargo check`**

Expected: PASS.

- [ ] **Step 3: 커밋**

```bash
git add .
git commit -m "feat: tokio interval poller emitting usage:refreshing/updated"
```

---

## Task 14: 프론트엔드 IPC 래퍼 + 타입

**Files:**
- Create: `src/lib/ipc.ts`

- [ ] **Step 1: `ipc.ts` 작성**

```ts
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Provider, Settings, UsageResponse } from "./types";

export interface UsageUpdatedPayload {
  current: UsageResponse[];
  delta: Record<string, number>;
}

export interface UsageRefreshingPayload {
  manual: boolean;
}

export const ipc = {
  getAllUsage: (force = false) => invoke<UsageResponse[]>("get_all_usage", { force }),
  refreshViaCli: (provider: Provider) => invoke<void>("refresh_via_cli", { provider }),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  setAutostart: (enabled: boolean) => invoke<void>("set_autostart", { enabled }),
  openUrl: (url: string) => invoke<void>("open_url", { url }),

  onUsageUpdated: (cb: (p: UsageUpdatedPayload) => void): Promise<UnlistenFn> =>
    listen<UsageUpdatedPayload>("usage:updated", (e) => cb(e.payload)),
  onUsageRefreshing: (cb: (p: UsageRefreshingPayload) => void): Promise<UnlistenFn> =>
    listen<UsageRefreshingPayload>("usage:refreshing", (e) => cb(e.payload)),
};
```

- [ ] **Step 2: 커밋**

```bash
git add .
git commit -m "feat(ui): ipc wrapper with typed invoke + event listeners"
```

---

## Task 15: UsageGauge 컴포넌트

**Files:**
- Create: `src/components/UsageGauge.tsx`

- [ ] **Step 1: 구현 (브릿지 포팅)**

```tsx
import type { UsageWindow } from "../lib/types";

function formatRemaining(resetsAt: string): string {
  const diff = new Date(resetsAt).getTime() - Date.now();
  if (diff <= 0) return "리셋 완료";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (h > 24) {
    const d = Math.floor(h / 24);
    return `${d}일 ${h % 24}시간 후 리셋`;
  }
  return h > 0 ? `${h}시간 ${m}분 후 리셋` : `${m}분 후 리셋`;
}

function gaugeColor(remain: number, expectedRemain: number) {
  if (remain < expectedRemain) {
    return remain < expectedRemain - 10
      ? { barOpacity: 0.25, labelOpacity: 0.4 }
      : { barOpacity: 0.5, labelOpacity: 0.65 };
  }
  return { barOpacity: 0.85, labelOpacity: 1 };
}

export default function UsageGauge({ window: w }: { window: UsageWindow }) {
  const remain = 100 - w.utilization;
  const expectedRemain = 100 - w.timeProgress;
  const colors = gaugeColor(remain, expectedRemain);

  return (
    <div className="mb-3">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-xs font-medium text-text">{w.name}</span>
        <span className="text-xs font-mono text-accent" style={{ opacity: colors.labelOpacity }}>
          {Math.round(remain)}% 남음
        </span>
      </div>
      <div className="relative h-4 rounded-full bg-surface-light overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 rounded-full transition-all duration-500 bg-accent"
          style={{ opacity: colors.barOpacity, width: `${Math.max(remain, 0)}%` }}
        />
        {expectedRemain > 0 && expectedRemain < 100 && (
          <>
            <div className="absolute inset-y-0 left-0 bg-red-500/15 z-10" style={{ width: `${expectedRemain}%` }} />
            <div className="absolute inset-y-0 w-0.5 bg-white/50 z-10" style={{ left: `${expectedRemain}%` }} />
          </>
        )}
      </div>
      <div className="flex justify-between mt-0.5">
        <span className="text-[10px] text-text-dim">사용 {Math.round(w.utilization)}%</span>
        <span className="text-[10px] text-text-dim">{formatRemaining(w.resetsAt)}</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 커밋**

```bash
git add .
git commit -m "feat(ui): UsageGauge component (ported from bridge)"
```

---

## Task 16: ProviderCard 컴포넌트

**Files:**
- Create: `src/components/ProviderCard.tsx`

- [ ] **Step 1: 구현**

```tsx
import { useState } from "react";
import type { Provider, UsageResponse } from "../lib/types";
import UsageGauge from "./UsageGauge";
import { ipc } from "../lib/ipc";

const COLORS: Record<Provider, string> = {
  claude: "#ff9f43",
  codex: "#4dff91",
  gemini: "#64b5f6",
};

const LABELS: Record<Provider, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
};

const LOGIN_CMD: Record<Provider, string> = {
  claude: "claude login",
  codex: "codex login",
  gemini: "gemini",
};

export default function ProviderCard({ data }: { data: UsageResponse }) {
  const [refreshing, setRefreshing] = useState(false);
  const [cliError, setCliError] = useState<string | null>(null);

  const triggerCliRefresh = async () => {
    setRefreshing(true);
    setCliError(null);
    try {
      await ipc.refreshViaCli(data.provider);
      await ipc.getAllUsage(true);
    } catch (e) {
      setCliError(String(e));
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="mb-4 last:mb-0">
      <div className="flex items-center gap-2 mb-2">
        <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: COLORS[data.provider] }} />
        <span className="text-xs text-text-dim">{LABELS[data.provider]}</span>
        {data.status === "network_error" && (
          <span title={data.error} className="text-xs text-yellow-500">⚠</span>
        )}
      </div>

      {data.status === "not_authenticated" && (
        <div className="text-xs text-text-dim">
          <div className="mb-1">로그인되지 않음</div>
          <code className="text-[10px] bg-surface-light px-1.5 py-0.5 rounded">{LOGIN_CMD[data.provider]}</code>
        </div>
      )}

      {data.status === "expired" && (
        <div className="text-xs">
          <div className="mb-1.5 text-text-dim">토큰 만료</div>
          <button
            onClick={triggerCliRefresh}
            disabled={refreshing}
            className="px-2 py-1 text-[11px] rounded bg-accent/20 hover:bg-accent/30 disabled:opacity-50"
          >
            {refreshing ? "갱신 중... (최대 15초)" : "CLI로 갱신"}
          </button>
          {cliError && (
            <div className="mt-1.5 text-[10px] text-red-400">
              CLI 실행 실패 — 수동 로그인 필요: <code>{LOGIN_CMD[data.provider]}</code>
            </div>
          )}
        </div>
      )}

      {data.status === "ok" && data.windows.map((w) => (
        <UsageGauge key={`${data.provider}-${w.key}`} window={w} />
      ))}

      {data.status === "ok" && data.extraUsage?.isEnabled && (
        <div className="mt-1 pt-1 border-t border-border/40">
          <div className="flex items-baseline justify-between">
            <span className="text-xs text-text-dim">추가 사용</span>
            <span className="text-xs font-mono text-text-dim">
              ${data.extraUsage.usedCredits.toFixed(2)}
              {data.extraUsage.monthlyLimit > 0 && ` / $${data.extraUsage.monthlyLimit.toLocaleString()}`}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 커밋**

```bash
git add .
git commit -m "feat(ui): ProviderCard with per-status rendering + CLI refresh button"
```

---

## Task 17: Header 컴포넌트 (새로고침 + 메뉴 + 닫기)

**Files:**
- Create: `src/components/Header.tsx`

- [ ] **Step 1: 구현**

```tsx
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface HeaderProps {
  onRefresh: () => void;
  refreshing: boolean;
  onOpenMenu: () => void;
  lastUpdatedAt: Date | null;
}

const COOLDOWN_SEC = 30;

export default function Header({ onRefresh, refreshing, onOpenMenu, lastUpdatedAt }: HeaderProps) {
  const [cooldownLeft, setCooldownLeft] = useState(0);

  useEffect(() => {
    if (!lastUpdatedAt) return;
    const tick = () => {
      const elapsed = (Date.now() - lastUpdatedAt.getTime()) / 1000;
      setCooldownLeft(Math.max(0, Math.ceil(COOLDOWN_SEC - elapsed)));
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [lastUpdatedAt]);

  const disabled = cooldownLeft > 0 || refreshing;

  const close = async () => {
    await getCurrentWindow().close();
  };

  return (
    <div
      data-tauri-drag-region
      className="flex items-center justify-between px-3 py-2 border-b border-border/40 select-none"
    >
      <span data-tauri-drag-region className="text-xs font-semibold text-text">Claude Usage Widget</span>
      <div className="flex items-center gap-1">
        <button
          onClick={onRefresh}
          disabled={disabled}
          title={disabled && cooldownLeft > 0 ? `${cooldownLeft}초 후 가능` : "새로고침"}
          className="w-6 h-6 rounded hover:bg-surface-light disabled:opacity-40 text-text-dim hover:text-text"
        >
          <span className={refreshing ? "inline-block animate-spin" : ""}>⟳</span>
        </button>
        <button
          onClick={onOpenMenu}
          title="메뉴"
          className="w-6 h-6 rounded hover:bg-surface-light text-text-dim hover:text-text"
        >
          ⋯
        </button>
        <button
          onClick={close}
          title="닫기"
          className="w-6 h-6 rounded hover:bg-red-500/30 text-text-dim hover:text-text"
        >
          ×
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 커밋**

```bash
git add .
git commit -m "feat(ui): Header with drag region, refresh cooldown, close button"
```

---

## Task 18: SettingsMenu 드롭다운

**Files:**
- Create: `src/components/SettingsMenu.tsx`

- [ ] **Step 1: 구현**

```tsx
import { useEffect } from "react";
import type { Settings } from "../lib/types";
import { ipc } from "../lib/ipc";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface Props {
  settings: Settings;
  onChange: (next: Settings) => void;
  onClose: () => void;
}

export default function SettingsMenu({ settings, onChange, onClose }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const update = async (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    onChange(next);
    await ipc.saveSettings(next);
    if ("alwaysOnTop" in patch) {
      await getCurrentWindow().setAlwaysOnTop(next.alwaysOnTop);
    }
    if ("autostart" in patch) {
      try { await ipc.setAutostart(next.autostart); }
      catch (e) { console.error("autostart failed", e); }
    }
  };

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div className="absolute right-2 top-10 z-50 w-60 bg-surface border border-border rounded-lg shadow-xl p-3 text-xs space-y-2.5">
        <label className="flex items-center justify-between">
          <span>항상 위</span>
          <input
            type="checkbox"
            checked={settings.alwaysOnTop}
            onChange={(e) => update({ alwaysOnTop: e.target.checked })}
          />
        </label>

        <label className="flex items-center justify-between">
          <span>시작 시 자동 실행</span>
          <input
            type="checkbox"
            checked={settings.autostart}
            onChange={(e) => update({ autostart: e.target.checked })}
          />
        </label>

        <div>
          <div className="flex items-center justify-between mb-1">
            <span>불투명도</span>
            <span className="text-text-dim">{Math.round(settings.opacity * 100)}%</span>
          </div>
          <input
            type="range"
            min="0.5"
            max="1"
            step="0.01"
            value={settings.opacity}
            onChange={(e) => update({ opacity: parseFloat(e.target.value) })}
            className="w-full"
          />
        </div>

        <div>
          <div className="mb-1">자동 갱신 간격 (재시작 필요)</div>
          <div className="flex gap-1">
            {[
              { l: "1분", v: 60 },
              { l: "5분", v: 300 },
              { l: "15분", v: 900 },
            ].map((opt) => (
              <button
                key={opt.v}
                onClick={() => update({ refreshIntervalSec: opt.v })}
                className={`px-2 py-1 rounded flex-1 ${
                  settings.refreshIntervalSec === opt.v
                    ? "bg-accent/30 text-text"
                    : "bg-surface-light text-text-dim hover:bg-surface-light/70"
                }`}
              >
                {opt.l}
              </button>
            ))}
          </div>
        </div>

        <div className="pt-2 border-t border-border/40 flex justify-between items-center">
          <span className="text-text-dim">v0.1.0</span>
          <button
            onClick={() => ipc.openUrl("https://github.com/")}
            className="text-accent hover:underline"
          >
            GitHub
          </button>
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: 커밋**

```bash
git add .
git commit -m "feat(ui): SettingsMenu dropdown with always-on-top/autostart/opacity/interval"
```

---

## Task 19: App.tsx 통합

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: 교체**

```tsx
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Header from "./components/Header";
import ProviderCard from "./components/ProviderCard";
import SettingsMenu from "./components/SettingsMenu";
import { ipc } from "./lib/ipc";
import type { Settings, UsageResponse } from "./lib/types";

export default function App() {
  const [responses, setResponses] = useState<UsageResponse[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);

  useEffect(() => {
    ipc.getSettings().then(async (s) => {
      setSettings(s);
      const win = getCurrentWindow();
      // 불투명도는 window.effectsCss로 처리 (아래 CSS 변수)
      document.documentElement.style.setProperty("--widget-opacity", String(s.opacity));
    });
    ipc.getAllUsage(false).then(setResponses);

    const unsubUpdated = ipc.onUsageUpdated((p) => {
      setResponses(p.current);
      setRefreshing(false);
      setLastUpdatedAt(new Date());
    });
    const unsubRefreshing = ipc.onUsageRefreshing(() => setRefreshing(true));

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F5") { e.preventDefault(); manualRefresh(); }
      if (e.key === "Escape") { getCurrentWindow().minimize(); }
      if (e.ctrlKey && e.key === "q") { getCurrentWindow().close(); }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      unsubUpdated.then((u) => u());
      unsubRefreshing.then((u) => u());
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    if (settings) {
      document.documentElement.style.setProperty("--widget-opacity", String(settings.opacity));
    }
  }, [settings?.opacity]);

  const manualRefresh = async () => {
    setRefreshing(true);
    try { await ipc.getAllUsage(true); }
    catch { setRefreshing(false); }
  };

  const lastUpdatedLabel = (() => {
    if (!lastUpdatedAt) return "—";
    const diffSec = Math.floor((Date.now() - lastUpdatedAt.getTime()) / 1000);
    if (diffSec < 60) return `${diffSec}초 전`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}분 전`;
    return `${Math.floor(diffSec / 3600)}시간 전`;
  })();

  return (
    <div
      className="w-full h-full flex flex-col rounded-xl border border-border/60 overflow-hidden"
      style={{ backgroundColor: `rgba(26, 26, 26, var(--widget-opacity, 0.92))` }}
    >
      <Header
        onRefresh={manualRefresh}
        refreshing={refreshing}
        onOpenMenu={() => setMenuOpen(true)}
        lastUpdatedAt={lastUpdatedAt}
      />
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {responses.length === 0 && <div className="text-xs text-text-dim text-center py-4">로딩 중...</div>}
        {responses.map((r) => <ProviderCard key={r.provider} data={r} />)}
      </div>
      <div className="px-3 py-1.5 border-t border-border/40 text-[10px] text-text-dim text-right">
        마지막 갱신: {lastUpdatedLabel}
      </div>

      {menuOpen && settings && (
        <SettingsMenu
          settings={settings}
          onChange={setSettings}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: `npm run tauri dev`로 실행 + 수동 확인**

Expected:
- 창이 뜨고 3 provider 카드 렌더링
- 토큰이 있는 provider는 게이지 표시
- 없는 provider는 "로그인되지 않음" + 명령 표시
- 헤더 드래그로 창 이동
- 새로고침 버튼 클릭 시 refetch + 30초 쿨다운
- 설정 메뉴에서 always-on-top 토글 시 창이 뒤로 가는지 확인

- [ ] **Step 3: 커밋**

```bash
git add .
git commit -m "feat(ui): App integration with event subscription + keyboard shortcuts"
```

---

## Task 20: 아이콘 교체 + tauri.conf.json 메타데이터

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Modify: `src-tauri/icons/*` (선택)

- [ ] **Step 1: 메타데이터 설정**

`src-tauri/tauri.conf.json`의 `bundle` 섹션을 확인·수정:

```json
{
  "productName": "claude-usage-widget",
  "version": "0.1.0",
  "identifier": "com.example.claudeusagewidget",
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "icon": ["icons/icon.ico"],
    "windows": {
      "nsis": {
        "installMode": "perUser",
        "displayLanguageSelector": false
      }
    }
  }
}
```

아이콘은 기본 Tauri 아이콘 유지해도 되고, 자체 아이콘 준비되면 `src-tauri/icons/icon.ico`로 교체.

- [ ] **Step 2: 커밋**

```bash
git add .
git commit -m "chore: set bundle metadata for release (perUser NSIS)"
```

---

## Task 21: 프로덕션 빌드 테스트

**Files:** —

- [ ] **Step 1: 프로덕션 빌드 실행**

```bash
npm run tauri build
```

Expected:
- `src-tauri/target/release/claude-usage-widget.exe` 생성
- `src-tauri/target/release/bundle/nsis/claude-usage-widget_0.1.0_x64-setup.exe` 생성
- 에러/경고 없음 (또는 경고만)

- [ ] **Step 2: 포터블 exe 실행 테스트**

`target/release/claude-usage-widget.exe`를 더블클릭 → 창이 뜨고 동작하는지 확인.

- [ ] **Step 3: 커밋 없음 (빌드 산출물은 .gitignore)**

---

## Task 22: GitHub Actions 릴리스 워크플로

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: 워크플로 작성**

```yaml
name: release

on:
  push:
    tags: ["v*"]

jobs:
  release:
    runs-on: windows-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - uses: dtolnay/rust-toolchain@stable

      - uses: swatinem/rust-cache@v2
        with:
          workspaces: "src-tauri -> target"

      - run: npm ci

      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          tagName: ${{ github.ref_name }}
          releaseName: "Claude Usage Widget ${{ github.ref_name }}"
          releaseDraft: true
          prerelease: false
```

- [ ] **Step 2: 커밋**

```bash
git add .
git commit -m "ci: tauri-action release workflow on v* tags (windows-latest)"
```

---

## Task 23: 수동 QA 체크리스트 실행

**Files:** —

다음 시나리오를 순서대로 검증. 각 항목 PASS/FAIL 기록. FAIL 발견 시 별도 이슈로 기록하고 MVP 이후 수정 계획.

- [ ] **1.** 3 provider 전부 로그인된 상태에서 앱 실행 → 각 provider 게이지 로딩
- [ ] **2.** `~/.claude/.credentials.json` 파일 이름 변경 → Claude 카드가 "로그인되지 않음" + `claude login` 표시
- [ ] **3.** 파일 복원 후 앱 재시작 → 정상 표시
- [ ] **4.** 네트워크 단절 후 새로고침 버튼 → Claude 카드에 ⚠ 아이콘 + 마지막 값 유지
- [ ] **5.** 새로고침 버튼 클릭 직후 다시 클릭 → 회색 + "N초 후 가능" 툴팁
- [ ] **6.** 설정 메뉴 → always-on-top OFF → 다른 창 클릭 → 위젯이 뒤로 → ON 복원 확인
- [ ] **7.** 불투명도 슬라이더 → 50%로 내림 → 배경 투명도 반영
- [ ] **8.** 창 드래그 이동 → 종료 → 재시작 시 같은 위치에 뜸
- [ ] **9.** autostart 토글 → `regedit`로 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\ClaudeUsageWidget` 확인 → OFF → 값 삭제 확인
- [ ] **10.** F5 키 → 새로고침 (쿨다운 적용)
- [ ] **11.** Ctrl+Q → 종료 확인
- [ ] **12.** ESC → 최소화 확인
- [ ] **13.** 자동 갱신 간격 1분 → 설정 저장 → **재시작 필요 안내** 확인 → 재시작 후 1분마다 갱신되는지 devtools Network 탭으로 확인
- [ ] **14.** devtools 콘솔에서 `window.__TAURI__` 이벤트 확인:
  ```js
  const { listen } = window.__TAURI__.event;
  listen("usage:updated", (e) => console.log(e.payload.delta));
  ```
  → `delta` 객체에 `claude.five_hour` 등 키 존재 확인
- [ ] **15.** (선택) Codex 토큰 파일에서 `access_token`을 잘못된 값으로 변조 → Codex 카드 `expired` 상태 + [CLI로 갱신] 버튼 → 클릭 → CLI 실행 → 파일 mtime 변경 → 재조회 성공 확인

---

## 완료 기준

- Task 1~23 모두 완료
- `npm run tauri build` 성공
- 포터블 exe가 다른 Windows 환경 (테스터 PC 1대 이상)에서 실행됨
- Task 23의 체크리스트 중 최소 1~11번 PASS (12~15는 nice-to-have)
- README에 설치/사용 방법 기본 문서화
- `v0.1.0` 태그 푸시 → GitHub Releases에 인스톨러 업로드 자동화 성공

후속 작업 (v0.2.0+):
- 다마고치 모듈 (별도 스펙)
- 자동 갱신 간격 변경 시 재시작 없이 반영 (poller 재시작 채널)
- 코드 서명
- Tauri updater
