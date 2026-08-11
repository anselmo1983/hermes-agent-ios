# Mobile Boundary Decision & Isolation Architecture

## 1. Mobile Runtime Boundary (`MOBILE_BUILD_SURFACE`)
The canonical file surface required to build, test, and run the Hermes iOS Mobile Client:

- **`apps/mobile/`**: Native iOS Capacitor wrapper (`App.xcworkspace`, `Podfile`), assets, `capacitor.config.ts`, `package.json`, mobile bridge shim (`desktop-port/shim/hermes-web-shim.js`), build scripts (`build.sh`, `inject-shim.mjs`, `fix-assets.mjs`), and unit tests.
- **`apps/desktop/src/`**: Shared Vite / React UI renderer source code (components, pages, stores, hooks, styles).
- **`apps/desktop/vite.config.ts` & `package.json`**: Frontend bundling options & dependencies.
- **`apps/shared/`**: Shared TypeScript domain models, protocol definitions, and WS URL helpers.
- **Monorepo Root Configs**: Root `package.json` and `package-lock.json`.

## 2. Required Dependencies
- **`@capacitor/core`** (`^8.4.2`): In-webview plugin bridge runtime.
- **`@capacitor/ios`** (`^8.4.2`): Native iOS Capacitor framework and Pods integration.
- **`@capacitor/cli`** (`^8.4.2`): Build-time CLI tooling (`npx cap sync ios`).
- **`@capacitor/assets`** (`^3.0.5`): Native icon and splash asset generator.
- **`typescript`** (`^5.9.3`): Compiler for build-time configuration files.

## 3. Forbidden Dependencies (`SERVER_SURFACE`)
The following server and desktop infrastructure components are **strictly excluded** from the mobile client build and runtime scope:

- **Python Backend Core**: `hermes_cli/`, `gateway/`, `agent/`, `tools/`, `cron/`, `acp_adapter/`, `tui_gateway/`, `providers/`, `plugins/`, `skills/`, `run_agent.py`, `hermes_state.py`.
- **Electron Main Process**: `apps/desktop/electron/` main process CJS scripts and desktop auto-updater.
- **Server Deployment Assets**: `docker/`, `Dockerfile`, `docker-compose.yml`, `website/`, `docs/`, `packaging/`.

## 4. Future Extraction Roadmap
- **Phase 1 (Monorepo Co-existence):** Mobile client resides in monorepo, building UI from `apps/desktop/src` and models from `apps/shared`.
- **Phase 2 (Frontend Package Boundary):** Formalize `apps/desktop/src` into a shared workspace package (`@hermes/ui-renderer`), decoupling `apps/mobile` from file path references to `apps/desktop`.
- **Phase 3 (Standalone Mobile Repository):** Publish `@hermes/ui-renderer` as a versioned npm package, enabling `apps/mobile` to operate as an independent standalone repository (`hermes-agent-ios`).
