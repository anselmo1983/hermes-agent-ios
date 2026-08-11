# Hermes iOS Native Capability Matrix

## Current State
The Hermes iOS Mobile Client operates as a Capacitor iOS wrapper around the shared React UI renderer (`apps/desktop/src`), communicating with self-hosted Hermes servers via HTTP (`/api/status`, `/auth/password-login`, `/api/auth/ws-ticket`) and WebSocket (`/api/ws`).

Currently integrated native capabilities:
- **`@capacitor/core`**: Native JS bridge runtime
- **`@capacitor/ios`**: iOS native project and WKWebView wrapper
- **`@capacitor/keyboard`**: Software keyboard resize mode (`body`)
- **`@capacitor/status-bar`**: Native status bar styling

---

## Candidate Technologies

### 1. Dynamic Island & Live Activities (ActivityKit)
- **Framework:** `ActivityKit.framework` (iOS 16.1+)
- **Mechanism:** Displays real-time agent execution status (`TASK_RUNNING`, `TASK_PROGRESS`, `APPROVAL_REQUIRED`) on the iPhone Dynamic Island and Lock Screen.
- **Native Requirement:** Requires a native **Widget Extension** target in Xcode with SwiftUI layout (`ActivityConfiguration`) and shared `ActivityAttributes` models.
- **Push Integration:** APNs Activity Push Notifications allow server-driven status updates even when the main app is closed.

### 2. Background Execution (BackgroundTasks)
- **Framework:** `BackgroundTasks.framework` (`BGAppRefreshTask`, `BGProcessingTask`)
- **Mechanism:** Maintains background WebSocket polling or periodic server pinging when the app is backgrounded.
- **Native Constraint:** iOS severely throttles background execution based on battery state and usage patterns.

### 3. Push Notifications (APNs)
- **Framework:** Apple Push Notification service (APNs) + `UserNotifications.framework`
- **Mechanism:** Delivers real-time alerts for long-running agent tasks (`TASK_COMPLETED`, `APPROVAL_REQUIRED`, `ERROR`) when the user is outside the app.

### 4. Native Bridge Architecture
- **Framework:** Capacitor Swift Plugin API (`CAPPlugin`, `@objc`)
- **Mechanism:** Bidirectional event dispatch between `hermes-web-shim.js` and Swift native code.

---

## Open Source Absorption

### Evaluated Open Source Solutions

| Solution | Repository / Author | License | Stars | Last Update | Language | Maintainer | Maturity | Decision |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`@capacitor/push-notifications`** | `ionic-team/capacitor-plugins` | MIT | 4.2k | Active (2026) | TypeScript / Swift | Official Ionic Team | Production Ready | `ABSORB_NOW` |
| **`@capacitor/background-runner`** | `ionic-team/capacitor-background-runner` | MIT | 850+ | Active (2026) | TypeScript / Swift | Official Ionic Team | Production Ready | `ABSORB_NOW` |
| **`@capgo/capacitor-live-activities`** | `Capgo/capacitor-live-activities` | MIT | 320+ | Active (2026) | TypeScript / Swift | Capgo Team | High | `ABSORB_LATER` |
| **`capacitor-live-activity`** | `kisimediaDE/capacitor-live-activity` | MIT | 150+ | Active (2026) | TypeScript / Swift | Community | Medium | `ABSORB_LATER` |
| **Custom SwiftUI ActivityKit Bridge** | N/A | N/A | N/A | N/A | Swift | Internal | Low | `IGNORE` |

---

## Ponytail Decision

### Classification Criteria:
- **`ABSORB_NOW`**: Official, production-proven Ionic/Capacitor plugins with active maintenance and zero core changes required.
- **`ABSORB_LATER`**: High-value capabilities requiring Xcode Widget Extension targets or Apple Developer APNs credentials.
- **`IGNORE`**: Reinventing native bridges from scratch when proven community/official plugins exist.

| Candidate Capability | Source | Value | Risk | Ponytail Decision | Rationale |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **APNs Push Notifications** | `@capacitor/push-notifications` | High | Low | `ABSORB_NOW` | Standard, official plugin for delivering agent task completion alerts. |
| **Background Task Execution** | `@capacitor/background-runner` | Medium | Medium | `ABSORB_NOW` | Official plugin for lightweight background websocket pinging. |
| **Dynamic Island / Live Activities** | `@capgo/capacitor-live-activities` | High | Medium | `ABSORB_LATER` | Requires Xcode Widget Extension target setup in Phase 6.2+. |
| **Custom Swift Bridge** | Custom Code | Low | High | `IGNORE` | Re-inventing bridge violates Ponytail principle. Re-use official plugins. |

---

## Compatibility with Hermes Mobile Architecture

```
Hermes Server (WebSocket / HTTP)
       │ (Events: TASK_PROGRESS, APPROVAL_REQUIRED, TASK_COMPLETED)
       ▼
hermes-web-shim.js (Mobile Bridge Shim)
       │ (Capacitor.toNative())
       ▼
Capacitor Native Plugin (@capacitor/push-notifications / background-runner)
       │ (APNs / BackgroundTasks)
       ▼
iOS Native Runtime (Dynamic Island / Lock Screen / System Banners)
```

### Mapped Hermes Agent Events:

1. **`SESSION_STARTED`**: No push notification required. UI updates inside active webview.
2. **`TASK_RUNNING`**: Live Activity initialized (Dynamic Island displays active agent spinner).
3. **`TASK_PROGRESS`**: Live Activity state updated (displays step progress / tool execution count).
4. **`TASK_COMPLETED`**: APNs Push Notification + Live Activity dismissal (`"Task finished successfully"`).
5. **`ERROR`**: APNs Push Notification (`"Agent encountered error"`).
6. **`APPROVAL_REQUIRED`**: High-priority APNs Push Notification + Live Activity alert (`"Tool execution requires user approval"`).

---

## Recommended Roadmap

- **Phase 6.1.5 (Current):** Capability Absorption & Architectural Matrix (READ-ONLY).
- **Phase 6.2 (Repository Extraction):** Standalone mobile repository setup (`hermes-agent-ios`).
- **Phase 6.3 (APNs & Push Notification Setup):** Integrate `@capacitor/push-notifications` for task alerts.
- **Phase 6.4 (Dynamic Island & Live Activity Extension):** Add Xcode Widget Extension target & `@capgo/capacitor-live-activities`.

---

## Risks

1. **iOS Background Execution Restrictions:** iOS can suspend or kill background WebSocket connections when the app is backgrounded.
2. **Xcode Target Complexity:** Live Activities require adding a native SwiftUI Widget Extension target inside Xcode.
3. **Developer Account Requirement:** APNs remote push notifications require a valid Apple Developer Program membership.

---

## Kill Criteria

- **Reject** custom native C/Swift bridge code if an official `@capacitor/*` plugin exists.
- **Reject** background execution models that drain battery or violate Apple App Store guidelines.
- **Reject** Live Activity implementations that bypass the established `hermes-web-shim.js` host seam.
