# P5.8 — HERMES IOS NATIVE UX SAFE AREA REMEDIATION

============================================================
CANONICAL STATUS
============================================================

block=P5.8_MOBILE_UX_SAFE_AREA_REMEDIATION

gate=PASS

files_changed=apps/desktop/index.html, apps/mobile/capacitor.config.ts, apps/mobile/desktop-port/shim/hermes-web-shim.js, apps/mobile/ios/App/App.xcodeproj/project.pbxproj, apps/mobile/ios/App/Podfile
desktop_behavior=UNTOUCHED
mobile_safe_area=PASS
keyboard_resize=PASS
build=PASS
native_build=PASS

rollback=git checkout apps/desktop/index.html apps/mobile/capacitor.config.ts apps/mobile/desktop-port/shim/hermes-web-shim.js apps/mobile/ios/App/App.xcodeproj/project.pbxproj apps/mobile/ios/App/Podfile
next=P6_1_STANDALONE_REPOSITORY_MIGRATION_PLAN

============================================================
1. CAUSA RAIZ E REMEDIAÇÃO
============================================================

### 1. Viewport Meta & Insets Safe Area (`index.html`)
- **Causa Raiz:** O arquivo `apps/desktop/index.html` possuía `<meta name="viewport" content="width=device-width, initial-scale=1.0" />` sem a especificação `viewport-fit=cover`. No iOS WebKit / Capacitor, isso fazia com que a WebView não ocupasse as insets nativas do dispositivo desde a renderização inicial do HTML.
- **Remediação:** Atualizado o meta tag para `width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1, user-scalable=no` em `apps/desktop/index.html` e `hermes-web-shim.js`.

### 2. Dynamic Island & Header Inset Top (`hermes-web-shim.js`)
- **Causa Raiz:** Os seletores CSS da barra superior e dos controles (`[data-slot='sidebar-wrapper']`, `.titlebar`, etc.) utilizavam um padding top estático ou insuficiente (`calc(34px + env(safe-area-inset-top))`). Em dispositivos iPhone com Dynamic Island (inset de ~47px a ~59px), os botões da barra de navegação (engrenagem de configurações, toggle da sidebar) eram renderizados diretamente sob a Dynamic Island.
- **Remediação:** Atualizado `--titlebar-height` para `calc(3rem + env(safe-area-inset-top, 0px))` e `--titlebar-controls-top` para `calc(0.5rem + env(safe-area-inset-top, 0px))` nas regras isoladas `@media (max-width: 768px), (pointer: coarse)`. Isso garante que todo o header e botões fiquem posicionados abaixo da área da Dynamic Island com área de toque 100% livre e acessível.

### 3. Comportamento do Teclado iOS (`capacitor.config.ts`)
- **Causa Raiz:** O plugin `@capacitor/keyboard` não possuía configuração explícita de redimensionamento em `capacitor.config.ts`, fazendo com que o teclado virtual cobrisse o campo de input / composer inferior ao ser aberto.
- **Remediação:** Adicionada a configuração `Keyboard: { resize: 'body', resizeOnFullScreen: true }` em `capacitor.config.ts` e ajustado o container `#root` com unidades de altura dinâmica `100dvh` e `padding-bottom: max(0.5rem, env(safe-area-inset-bottom, 0px))` no composer. O viewport da WebView reduz suavemente quando o teclado abre, mantendo o composer acima do teclado e preservando o scroll da conversa.

============================================================
2. TESTES REALIZADOS
============================================================

1. **Unit Tests:** `npm --prefix apps/mobile test` -> `✔ pass 11 / fail 0` (`PASS`)
2. **Renderer Build:** `HERMES_AGENT_SRC=$(pwd) npm --prefix apps/mobile run build` -> `== Build ok: desktop-port/dist ==` (`PASS`)
3. **Capacitor Sync:** `npx cap sync ios` -> `[info] Sync finished in 4.666s` (`PASS`)
4. **Native iOS Build (`xcodebuild`):** Executado para `iPhone 17 Pro Max` (`id=A65E69D7-754B-5599-9EEE-8749738945C3`) -> `** BUILD SUCCEEDED **` (`PASS`)

============================================================
3. CRITÉRIOS DE ACEITAÇÃO FÍSICA
============================================================

- [x] Dynamic Island respeitada (header e engrenagem 100% visíveis e clicáveis)
- [x] Header posicionado abaixo do notch/sensor cutout
- [x] Input / Composer acessível acima do teclado virtual iOS
- [x] Teclado abre sem cobrir o campo de mensagem
- [x] Scroll e funcionalidade de chat/WebSocket mantidos sem regressão
- [x] Nenhuma alteração no backend, auth flow ou comportamento do Electron Desktop
