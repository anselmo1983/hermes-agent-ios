# Hermes Mobile iOS Repository Extraction Plan

## 1. Current State (`current_state`)
- **Location:** `apps/mobile/` within the `hermes-agent` monorepo.
- **UI Renderer Dependency:** `apps/desktop/src` (Vite / React UI renderer).
- **Protocol Dependency:** `apps/shared/` (TypeScript protocol models and WebSocket URL helpers).
- **Native iOS Project:** `apps/mobile/ios/` (Xcode workspace `App.xcworkspace`, CocoaPods dependencies, native App target).

---

## 2. Proposed Target Repository Structure (`target_repository`)
Proposed target repository: `hermes-mobile-ios/`

```
hermes-mobile-ios/
├── ios/                       # Native Xcode workspace (App.xcworkspace, Podfile, App target)
├── mobile/                    # Mobile wrapper assets & capacitor.config.ts
├── desktop-port/              # Mobile bridge shim & build scripts
│   ├── shim/                  # hermes-web-shim.js
│   ├── scripts/               # inject-shim.mjs, fix-assets.mjs
│   ├── build.sh               # Independent renderer build runner
│   └── test/                  # Headless VM bridge unit tests
├── shared/                    # Extracted shared TypeScript types (@hermes/shared)
├── package.json               # Standalone npm workspace definitions & build scripts
├── MOBILE_BOUNDARY_DECISION.md
├── IOS_EVENT_CONTRACT.md
└── README.md
```

---

## 3. Dependency Classification

### COPIAR (Files to migrate directly into target repository):
- `apps/mobile/ios/**` (Native iOS Xcode project, CocoaPods configurations, App target)
- `apps/mobile/capacitor.config.ts` (Capacitor iOS configuration)
- `apps/mobile/assets/**` (Icons and splash screens)
- `apps/mobile/desktop-port/shim/hermes-web-shim.js` (Mobile bridge shim)
- `apps/mobile/desktop-port/scripts/**` (`inject-shim.mjs`, `fix-assets.mjs`)
- `apps/mobile/desktop-port/build.sh` (Build runner script)
- `apps/mobile/desktop-port/test/**` (Unit test suite)
- `apps/mobile/package.json` (Mobile package definitions)

### REFERENCIAR (Shared packages to bundle or reference via npm / workspace):
- `apps/desktop/src/**` (React UI renderer source, to be packaged as `@hermes/ui-renderer`)
- `apps/shared/**` (TypeScript domain types and WS URL helpers, packaged as `@hermes/shared`)

### REMOVER / ISOLAR (Monorepo components excluded from mobile repository):
- Backend Python Code (`hermes_cli/`, `gateway/`, `agent/`, `tools/`, `cron/`, `acp_adapter/`, `run_agent.py`)
- Electron Main Process (`apps/desktop/electron/`)
- Server Deployment Assets (`docker/`, `Dockerfile`, `docker-compose.yml`, `website/`, `docs/`, `packaging/`)

---

## 4. Build Isolation Report (`build_isolation_report`)

1. **Can mobile build compile without Python Backend (`hermes_cli`, `gateway`, `agent`)?**
   **YES.** The mobile app is compiled entirely in JavaScript/TypeScript and Swift. No Python code is imported or required at build time.

2. **Can mobile build compile without Docker & Deployment assets?**
   **YES.** Docker files are server deployment scripts; mobile target compiles for iOS native devices via Xcode.

3. **Can mobile build compile without Electron (`apps/desktop/electron`)?**
   **YES.** `hermes-web-shim.js` provides `window.hermesDesktop` in browser JS, replacing Electron IPC bridge calls.

4. **Which packages still depend on the monorepo?**
   Only `apps/desktop/src` (React UI components) and `apps/shared`. When `apps/desktop/src` is published or linked as `@hermes/ui-renderer`, the mobile client becomes 100% standalone.

---

## 5. Migration Order (`migration_order`)

1. **Step 1:** Initialize target repository `hermes-mobile-ios`.
2. **Step 2:** Copy `apps/mobile/` assets, scripts, shim, and `ios/` workspace into target repository root.
3. **Step 3:** Link `@hermes/ui-renderer` (`apps/desktop/src`) and `@hermes/shared` as workspace / npm dependencies.
4. **Step 4:** Execute validation test suite: `npm test`, `npm run build`, `npx cap sync ios`, `xcodebuild`.
5. **Step 5:** Tag initial release `v1.0.0-standalone`.

---

## 6. Rollback Plan (`rollback`)

- The current monorepo on branch `pony-work-ios` and checkpoint tag `p5-mobile-boundary-baseline` remains 100% untouched.
- In case of dry run issues, revert to git checkpoint tag `p5-mobile-boundary-baseline`.
