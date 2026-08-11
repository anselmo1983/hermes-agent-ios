# Hermes iOS Event Contract Specification

## 1. Overview & Architecture
The Hermes Event Contract defines the standardized JSON event schema that drives future iOS native capabilities (Dynamic Island, Push Notifications, and Background Task management).

This contract is **client-agnostic**: events originate from the self-hosted Hermes Backend (`VM201`) over the WebSocket protocol (`/api/ws`), are received by `hermes-web-shim.js`, and bridged to native consumers. The exact same event schemas can be consumed by Android, Desktop, or Web clients without backend modification.

---

## 2. Event Pipeline Architecture

```
┌─────────────────────────────────────────────────────────┐
│                 Hermes Backend (VM201)                  │
└────────────────────────────┬────────────────────────────┘
                             │ WebSocket JSON-RPC (/api/ws)
                             ▼
┌─────────────────────────────────────────────────────────┐
│           Mobile Shim (hermes-web-shim.js)              │
└────────────────────────────┬────────────────────────────┘
                             │ Capacitor Bridge
                             ▼
┌─────────────────────────────────────────────────────────┐
│                 iOS Native Consumer                     │
├────────────────────────────┬────────────────────────────┤
│  Dynamic Island            │ Push Notifications (APNs)  │
│  (ActivityKit)             │ (UNUserNotification)       │
└────────────────────────────┴────────────────────────────┘
```

---

## 3. Existing Hermes Gateway Events & Native Mapping

| Gateway Event (`type`) | Native Category | Dynamic Island | Push Notification (APNs) | Action |
| :--- | :--- | :--- | :--- | :--- |
| `gateway.ready` | `SESSION_ACTIVE` | Idle | None | Connection established |
| `session.info` | `SESSION_ACTIVE` | Active (`session_id`) | None | Session state active |
| `message.start` | `TASK_RUNNING` | Active (`"Agent started"`) | None | Task execution initiated |
| `tool.start` | `TASK_RUNNING` | Update (`tool_name`, `step`) | None | Tool call executing |
| `tool.progress` | `TASK_RUNNING` | Update (`status_text`) | None | Streaming tool output |
| `approval.request` | `APPROVAL_REQUIRED` | Alert Badge (`ACTION_REQ`) | High Priority Push | User permission required |
| `sudo.request` / `secret.request` | `APPROVAL_REQUIRED` | Alert Badge (`CRED_REQ`) | High Priority Push | Secret/credential input required |
| `message.complete` / `background.complete` | `TASK_COMPLETED` | Activity End (`COMPLETED`) | Task Complete Push | Agent turn completed |
| `error` | `ERROR` | Activity End (`ERROR`) | Error Push | Task execution failure |

---

## 4. Mobile Event Envelope & Payload Schemas

### Mobile Bridge Event Envelope
All events passed through the Capacitor bridge inherit the standard `MobileEventEnvelope`:

```json
{
  "type": "hermes.mobile.native_event",
  "version": "1.0",
  "session_id": "sess-85911b21-4bcf",
  "timestamp": "2026-08-11T16:35:00.000Z",
  "event": {
    "name": "tool.start",
    "category": "TASK_RUNNING",
    "payload": {
      "tool_name": "npx cap sync ios",
      "args_summary": "Syncing web assets to iOS workspace",
      "step_index": 3,
      "total_steps": 8
    }
  }
}
```

---

### Payload Definitions by Category

#### A) `TASK_RUNNING` (Dynamic Island Live Activity Update)
```json
{
  "name": "tool.start",
  "category": "TASK_RUNNING",
  "payload": {
    "tool_name": "executing_command",
    "args_summary": "HERMES_AGENT_SRC=$(pwd) npm run build",
    "step_index": 4,
    "status_text": "Building UI renderer bundle..."
  }
}
```

#### B) `APPROVAL_REQUIRED` (APNs High-Priority Push & Dynamic Island Alert)
```json
{
  "name": "approval.request",
  "category": "APPROVAL_REQUIRED",
  "payload": {
    "request_id": "req-9921",
    "action": "run_command",
    "description": "Execute rm -rf on temporary build cache",
    "requires_auth": true
  }
}
```

#### C) `TASK_COMPLETED` (APNs Push Notification & ActivityKit Termination)
```json
{
  "name": "message.complete",
  "category": "TASK_COMPLETED",
  "payload": {
    "session_id": "sess-85911b21-4bcf",
    "summary": "Build succeeded and synced to iOS native workspace",
    "duration_ms": 14200,
    "total_tool_calls": 6
  }
}
```

#### D) `ERROR` (APNs Error Alert)
```json
{
  "name": "error",
  "category": "ERROR",
  "payload": {
    "error_code": "BUILD_FAILED",
    "message": "xcodebuild failed with exit code 1",
    "fatal": false
  }
}
```

---

## 5. Client Independence & Multi-Platform Reusability
- **Pure JSON Contracts:** Schemas contain zero Swift or iOS-specific attributes.
- **Platform Parity:** Android (via Notification Channels & Live Status Widgets) and Web App clients can consume the identical event pipeline without server changes.
- **Loose Coupling:** The native iOS layer acts purely as a passive subscriber to `hermes.mobile.native_event`.

---

## 6. Contract Invariants
1. `session_id` MUST be present on all session-scoped events.
2. `category` MUST strictly evaluate to one of: `SESSION_ACTIVE`, `TASK_RUNNING`, `APPROVAL_REQUIRED`, `TASK_COMPLETED`, `ERROR`.
3. All payloads MUST be serializable JSON objects (no raw binary streams).
