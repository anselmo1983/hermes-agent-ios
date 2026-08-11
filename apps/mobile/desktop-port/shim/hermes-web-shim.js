/*
 * Browser shim for `window.hermesDesktop` — remote gateway, token & Basic Auth mode.
 *
 * Absorbed from PR #64962 + PR #49834 for Hermes Mobile Client.
 * Supports both Basic Auth (canonical VM201 backend) and Token Auth.
 */
(() => {
  'use strict'

  const STORAGE_KEY = 'hermes.remoteGateway'
  const DEFAULT_GATEWAY_URL = 'http://100.105.139.115:9119'

  const NO_CONFIG_MESSAGE =
    'No Hermes gateway is configured. Open Settings → Gateway to enter your gateway URL and credentials.'

  // ── Session Cookie Jar ──────────────────────────────────────────────────
  const sessionCookies = new Map()

  function captureCookies(baseUrl, headers) {
    if (!headers) return
    let setCookie = null
    if (typeof headers.get === 'function') {
      setCookie = headers.get('set-cookie')
    } else if (headers) {
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === 'set-cookie') {
          setCookie = headers[k]
          break
        }
      }
    }
    if (!setCookie) return
    try {
      const host = new URL(baseUrl).host
      const map = sessionCookies.get(host) || {}
      const list = Array.isArray(setCookie) ? setCookie : [setCookie]
      for (const raw of list) {
        const first = raw.split(';', 1)[0].trim()
        const eq = first.indexOf('=')
        if (eq > 0) {
          const name = first.slice(0, eq).trim()
          const val = first.slice(eq + 1).trim()
          if (val === '' || /expires=Thu, 01 Jan 1970/i.test(raw)) {
            delete map[name]
          } else {
            map[name] = val
          }
        }
      }
      sessionCookies.set(host, map)
    } catch {
      /* best effort */
    }
  }

  function getCookieHeader(baseUrl) {
    try {
      const host = new URL(baseUrl).host
      const map = sessionCookies.get(host)
      if (!map) return ''
      return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ')
    } catch {
      return ''
    }
  }

  function toBase64(str) {
    try {
      return btoa(unescape(encodeURIComponent(str)))
    } catch {
      return btoa(str)
    }
  }

  function basicAuthHeader(username, password) {
    if (!username && !password) return null
    return 'Basic ' + toBase64((username || '') + ':' + (password || ''))
  }

  // ── Stored config layer ─────────────────────────────────────────────────
  function readStoredRaw() {
    let raw
    try {
      raw = window.localStorage.getItem(STORAGE_KEY)
    } catch {
      return null
    }
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return null
      return {
        url: typeof parsed.url === 'string' ? parsed.url.trim() : '',
        authMode: parsed.authMode === 'basic' ? 'basic' : (parsed.authMode === 'token' || parsed.token ? 'token' : 'basic'),
        username: typeof parsed.username === 'string' ? parsed.username : '',
        password: typeof parsed.password === 'string' ? parsed.password : '',
        token: typeof parsed.token === 'string' ? parsed.token : ''
      }
    } catch {
      return null
    }
  }

  function writeStored(config) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        url: config.url,
        authMode: config.authMode || 'basic',
        username: config.username || '',
        password: config.password || '',
        token: config.token || ''
      }))
    } catch {
      throw new Error('Could not save the gateway configuration to local storage.')
    }
  }

  function requireConnection() {
    const stored = readStoredRaw()
    if (!stored || !stored.url) {
      throw new Error(NO_CONFIG_MESSAGE)
    }
    if (stored.authMode === 'token' && !stored.token) {
      throw new Error(NO_CONFIG_MESSAGE)
    }
    return stored
  }

  // ── URL helpers ─────────────────────────────────────────────────────────
  function normalizeBaseUrl(rawUrl) {
    const value = String(rawUrl || '').trim()
    if (!value) {
      throw new Error('Remote gateway URL is required.')
    }
    let parsed
    try {
      parsed = new URL(value)
    } catch (err) {
      throw new Error('Remote gateway URL is not valid: ' + (err && err.message ? err.message : String(err)))
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Remote gateway URL must be http:// or https://, got ' + parsed.protocol)
    }
    parsed.hash = ''
    parsed.search = ''
    parsed.pathname = parsed.pathname.replace(/\/+$/, '')
    return parsed.toString().replace(/\/+$/, '')
  }

  const DEFAULT_FETCH_TIMEOUT_MS = 15000
  function resolveTimeoutMs(value) {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : DEFAULT_FETCH_TIMEOUT_MS
  }

  function normalizeProfileKey(name) {
    return String(name == null ? '' : name).trim() || 'default'
  }
  function isPrimaryProfile(profile) {
    return normalizeProfileKey(profile) === 'default'
  }
  function assertPrimaryProfile(profile) {
    if (!isPrimaryProfile(profile)) {
      throw new Error('This iOS client is bound to a single remote gateway (the default profile).')
    }
  }

  // ── api(request) ───────────────────────────────────────────────────────
  async function api(request) {
    assertPrimaryProfile(request && request.profile)
    const conn = requireConnection()
    const path = String((request && request.path) || '')
    const method = (request && request.method) || 'GET'
    const hasBody = request && request.body !== undefined
    const timeoutMs = resolveTimeoutMs(request && request.timeoutMs)

    const headers = { 'Content-Type': 'application/json' }
    if (conn.authMode === 'basic' || (!conn.authMode && (conn.username || conn.password))) {
      const basic = basicAuthHeader(conn.username, conn.password)
      if (basic) headers['Authorization'] = basic
      const cookie = getCookieHeader(conn.url)
      if (cookie) headers['Cookie'] = cookie
    } else if (conn.token) {
      headers['X-Hermes-Session-Token'] = conn.token
    }

    let res
    try {
      res = await fetch(conn.url + path, {
        method,
        headers,
        body: hasBody ? JSON.stringify(request.body) : undefined,
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (err) {
      if (err && err.name === 'TimeoutError') {
        throw new Error('Timed out connecting to Hermes backend after ' + timeoutMs + 'ms')
      }
      throw err
    }

    captureCookies(conn.url, res.headers)

    if (res.status === 401) {
      openConnectOverlay({ dismissible: false })
      throw new Error('401: Unauthorized')
    }

    const text = await res.text()

    if (!res.ok) {
      throw new Error(res.status + ': ' + (text || res.statusText))
    }
    if (!text) {
      return null
    }
    const contentType = res.headers.get('content-type') || ''
    if (/^\s*<(?:!doctype|html)/i.test(text) || /text\/html/i.test(contentType)) {
      throw new Error(
        'Expected JSON from ' + conn.url + path + ' but got HTML (status ' + res.status + ').'
      )
    }
    try {
      return JSON.parse(text)
    } catch {
      throw new Error('Invalid JSON from ' + conn.url + path + ' (status ' + res.status + '): ' + text.slice(0, 200))
    }
  }

  // ── getConnection(profile?) ──────────────────────────────────────────────
  async function getConnection(profile) {
    assertPrimaryProfile(profile)
    const conn = requireConnection()
    const parsed = new URL(conn.url)
    const wsScheme = parsed.protocol === 'https:' ? 'wss' : 'ws'
    const prefix = parsed.pathname.replace(/\/+$/, '')

    let wsUrl = ''
    if (conn.authMode === 'basic' || (!conn.authMode && (conn.username || conn.password))) {
      try {
        const ticketRes = await api({ path: '/api/auth/ws-ticket', method: 'POST' })
        if (ticketRes && ticketRes.ticket) {
          wsUrl = wsScheme + '://' + parsed.host + prefix + '/api/ws?ticket=' + encodeURIComponent(ticketRes.ticket)
        }
      } catch {
        wsUrl = wsScheme + '://' + parsed.host + prefix + '/api/ws'
      }
    } else {
      wsUrl = wsScheme + '://' + parsed.host + prefix + '/api/ws?token=' + encodeURIComponent(conn.token)
    }

    return {
      baseUrl: conn.url,
      isFullscreen: false,
      mode: 'remote',
      authMode: conn.authMode || 'basic',
      nativeOverlayWidth: 0,
      source: 'settings',
      token: conn.token || '',
      wsUrl,
      logs: [],
      windowButtonPosition: null,
      profile: null
    }
  }

  // ── Gateway settings ──────────────────────────────────────────────────────
  function sanitizeConfig(profileScope) {
    const stored = readStoredRaw()
    const scopeKey = String(profileScope == null ? '' : profileScope).trim() || null
    return {
      envOverride: false,
      mode: 'remote',
      profile: scopeKey,
      remoteAuthMode: stored ? stored.authMode : 'basic',
      remoteOauthConnected: false,
      remoteTokenPreview: stored ? (stored.username || stored.token || 'set') : null,
      remoteTokenSet: Boolean(stored && (stored.username || stored.token)),
      remoteUrl: stored && stored.url ? stored.url : DEFAULT_GATEWAY_URL
    }
  }

  function coerceRemote(payload) {
    if (!payload || payload.mode !== 'remote') {
      throw new Error('This build only connects to a remote Hermes gateway.')
    }
    const stored = readStoredRaw()
    const rawUrl = payload.remoteUrl != null && String(payload.remoteUrl).trim() ? payload.remoteUrl : (stored && stored.url) || ''
    const url = normalizeBaseUrl(rawUrl)
    const authMode = payload.remoteAuthMode === 'token' ? 'token' : 'basic'
    const username = typeof payload.remoteUsername === 'string' ? payload.remoteUsername.trim() : (stored ? stored.username : '')
    const password = typeof payload.remotePassword === 'string' ? payload.remotePassword.trim() : (stored ? stored.password : '')
    const token = typeof payload.remoteToken === 'string' ? payload.remoteToken.trim() : (stored ? stored.token : '')

    return { url, authMode, username, password, token }
  }

  async function fetchStatus(baseUrl, headers) {
    let res
    try {
      res = await fetch(baseUrl + '/api/status', { method: 'GET', headers: headers || {}, signal: AbortSignal.timeout(8000) })
    } catch (err) {
      if (err && err.name === 'TimeoutError') {
        throw new Error('Timed out reaching gateway at ' + baseUrl)
      }
      throw err
    }
    const text = await res.text()
    if (!res.ok) {
      throw new Error(res.status + ': ' + (text || res.statusText))
    }
    try {
      return text ? JSON.parse(text) : null
    } catch {
      return null
    }
  }

  function probeWebSocket(wsUrl) {
    const CONNECT_TIMEOUT_MS = 10000
    const READY_GRACE_MS = 750
    return new Promise(resolve => {
      let settled = false
      let opened = false
      let connectTimer = null
      let graceTimer = null
      let socket

      const finish = result => {
        if (settled) return
        settled = true
        if (connectTimer !== null) clearTimeout(connectTimer)
        if (graceTimer !== null) clearTimeout(graceTimer)
        try {
          if (socket && socket.close) socket.close()
        } catch {}
        resolve(result)
      }

      try {
        socket = new WebSocket(wsUrl)
      } catch {
        finish({ ok: false, reason: 'WebSocket connection failed.' })
        return
      }

      socket.addEventListener('open', () => {
        if (settled) return
        opened = true
        graceTimer = setTimeout(() => finish({ ok: true }), READY_GRACE_MS)
      })
      socket.addEventListener('message', () => finish({ ok: true }))
      socket.addEventListener('error', () => {
        finish({ ok: false, reason: opened ? 'WebSocket closed after opening.' : 'WebSocket closed before opening.' })
      })
      socket.addEventListener('close', event => {
        if (settled) return
        const code = event && typeof event.code === 'number' ? event.code : null
        finish({ ok: false, reason: 'WebSocket closed (code ' + code + ')' })
      })

      connectTimer = setTimeout(
        () => finish({ ok: false, reason: 'Timed out waiting for WebSocket' }),
        CONNECT_TIMEOUT_MS
      )
    })
  }

  const noopUnsub = () => () => {}

  window.hermesDesktop = {
    api,
    getConnection,
    getGatewayWsUrl: async profile => {
      assertPrimaryProfile(profile)
      const conn = requireConnection()
      const parsed = new URL(conn.url)
      const wsScheme = parsed.protocol === 'https:' ? 'wss' : 'ws'
      const prefix = parsed.pathname.replace(/\/+$/, '')

      if (conn.authMode === 'basic' || (!conn.authMode && (conn.username || conn.password))) {
        try {
          const ticketRes = await api({ path: '/api/auth/ws-ticket', method: 'POST' })
          if (ticketRes && ticketRes.ticket) {
            return wsScheme + '://' + parsed.host + prefix + '/api/ws?ticket=' + encodeURIComponent(ticketRes.ticket)
          }
        } catch {
          return wsScheme + '://' + parsed.host + prefix + '/api/ws'
        }
      }
      return wsScheme + '://' + parsed.host + prefix + '/api/ws?token=' + encodeURIComponent(conn.token)
    },
    revalidateConnection: async () => {
      const raw = readStoredRaw()
      return { ok: Boolean(raw && raw.url && (raw.username || raw.token)), rebuilt: false }
    },
    touchBackend: async profile => {
      assertPrimaryProfile(profile)
      return { ok: true }
    },

    getConnectionConfig: async profile => sanitizeConfig(profile),
    saveConnectionConfig: async payload => {
      const block = coerceRemote(payload)
      writeStored(block)
      return sanitizeConfig(payload && payload.profile)
    },
    applyConnectionConfig: async payload => {
      const block = coerceRemote(payload)
      writeStored(block)
      const next = sanitizeConfig(payload && payload.profile)
      setTimeout(() => {
        try { window.location.reload() } catch {}
      }, 150)
      return next
    },
    testConnectionConfig: async payload => {
      const { url, authMode, username, password, token } = coerceRemote(payload)
      const headers = {}
      if (authMode === 'basic') {
        const basic = basicAuthHeader(username, password)
        if (basic) headers['Authorization'] = basic
      } else if (token) {
        headers['X-Hermes-Session-Token'] = token
      }

      const status = await fetchStatus(url, headers)

      let wsUrl = ''
      const parsed = new URL(url)
      const wsScheme = parsed.protocol === 'https:' ? 'wss' : 'ws'
      const prefix = parsed.pathname.replace(/\/+$/, '')

      if (authMode === 'basic') {
        try {
          if (username || password) {
            const loginRes = await fetch(url + '/auth/password-login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ provider: 'basic', username, password })
            })
            captureCookies(url, loginRes.headers)
          }

          const ticketHeaders = { 'Content-Type': 'application/json', ...headers }
          const cookieHeader = getCookieHeader(url)
          if (cookieHeader) ticketHeaders['Cookie'] = cookieHeader

          const ticketRes = await fetch(url + '/api/auth/ws-ticket', {
            method: 'POST',
            headers: ticketHeaders
          })
          captureCookies(url, ticketRes.headers)
          if (ticketRes.ok) {
            const ticketData = await ticketRes.json()
            if (ticketData && ticketData.ticket) {
              wsUrl = wsScheme + '://' + parsed.host + prefix + '/api/ws?ticket=' + encodeURIComponent(ticketData.ticket)
            }
          }
        } catch {
          wsUrl = wsScheme + '://' + parsed.host + prefix + '/api/ws'
        }
      } else {
        wsUrl = wsScheme + '://' + parsed.host + prefix + '/api/ws?token=' + encodeURIComponent(token)
      }

      if (!wsUrl) wsUrl = wsScheme + '://' + parsed.host + prefix + '/api/ws'

      const ws = await probeWebSocket(wsUrl)
      if (!ws.ok) {
        throw new Error('Reached HTTP endpoint, but WebSocket check failed: ' + ws.reason)
      }
      return { ok: true, baseUrl: url, version: (status && status.version) || null }
    },
    probeConnectionConfig: async remoteUrl => {
      let baseUrl
      try {
        baseUrl = normalizeBaseUrl(remoteUrl)
      } catch (err) {
        return { baseUrl: String(remoteUrl || ''), reachable: false, authMode: 'unknown', version: null, error: err.message }
      }
      try {
        const status = await fetchStatus(baseUrl, null)
        const authRequired = Boolean(status && status.auth_required)
        return {
          baseUrl,
          reachable: true,
          authMode: authRequired ? 'basic' : 'token',
          providers: (status && status.auth_providers) || [],
          version: (status && status.version) || null,
          error: null
        }
      } catch (err) {
        return { baseUrl, reachable: false, authMode: 'unknown', version: null, error: err.message }
      }
    },

    getRecentLogs: async () => ({ path: '', lines: [] }),
    revealLogs: async () => ({ ok: false, path: '', error: 'Logs unavailable' }),
    resetBootstrap: async () => ({ ok: true }),
    repairBootstrap: async () => ({ ok: true }),

    profile: {
      get: async () => ({ profile: null }),
      set: async name => {
        assertPrimaryProfile(name)
        return { profile: null }
      }
    },

    getVersion: async () => ({
      appVersion: 'ios-web-shim',
      electronVersion: '',
      nodeVersion: '',
      platform: (navigator && navigator.platform) || 'web',
      hermesRoot: ''
    }),

    zoom: {
      get: async () => ({ level: 0, percent: 100 }),
      setPercent: () => {},
      onChanged: noopUnsub
    },

    onBootProgress: noopUnsub,
    getBootProgress: async () => ({
      error: null,
      fakeMode: false,
      message: 'Connecting to Hermes…',
      phase: 'remote.connect',
      progress: 5,
      running: true,
      timestamp: Date.now()
    }),

    onBackendExit: noopUnsub,
    onPowerResume: noopUnsub,
    onWindowStateChanged: noopUnsub,
    onFocusSession: noopUnsub,
    onNotificationAction: noopUnsub,
    onDeepLink: noopUnsub,
    onClosePreviewRequested: noopUnsub,
    onOpenUpdatesRequested: noopUnsub,
    onPreviewFileChanged: noopUnsub,
    signalDeepLinkReady: async () => ({ ok: true })
  }

  // ── Connect UI Modal ─────────────────────────────────────────────────────
  const CONNECT_OVERLAY_ID = 'hermes-shim-connect-overlay'
  const RECOVERY_BUTTON_ID = 'hermes-shim-recovery-button'
  const CONNECT_STYLE_ID = 'hermes-shim-connect-style'
  const OVERLAY_Z_INDEX = 2147483000
  const CONNECT_FAILURE_MESSAGE = 'Connection failed. Check gateway URL and credentials.'

  function whenBodyReady(cb) {
    if (document.body) cb()
    else document.addEventListener('DOMContentLoaded', cb, { once: true })
  }

  function ensureConnectStyles() {
    if (document.getElementById(CONNECT_STYLE_ID)) return
    const style = document.createElement('style')
    style.id = CONNECT_STYLE_ID
    style.textContent =
      '#' + CONNECT_OVERLAY_ID + '{position:fixed;top:0;left:0;right:0;height:100vh;height:100dvh;' +
      'z-index:' + OVERLAY_Z_INDEX + ';display:flex;flex-direction:column;' +
      'align-items:center;justify-content:flex-start;box-sizing:border-box;' +
      'overflow-y:auto;-webkit-overflow-scrolling:touch;' +
      'padding:max(3rem,calc(env(safe-area-inset-top) + 1.5rem)) max(1.25rem,env(safe-area-inset-right))' +
      ' max(1.25rem,env(safe-area-inset-bottom)) max(1.25rem,env(safe-area-inset-left));' +
      'background:#F8FAFF;color:#17171A;' +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}' +
      '@media (prefers-color-scheme:dark){#' + CONNECT_OVERLAY_ID + '{background:#0D2F86;color:#FFE6CB;}}' +
      '#' + CONNECT_OVERLAY_ID + ' *{box-sizing:border-box;}' +
      '.hermes-shim-card{width:100%;max-width:24rem;display:flex;flex-direction:column;gap:0.7rem;' +
      'padding:1.75rem;border-radius:1rem;background:rgba(255,255,255,0.92);' +
      'border:1px solid rgba(0,83,253,0.18);box-shadow:0 20px 60px rgba(13,47,134,0.18);}' +
      '@media (prefers-color-scheme:dark){.hermes-shim-card{background:rgba(13,47,134,0.6);' +
      'border-color:rgba(255,230,203,0.22);box-shadow:0 20px 60px rgba(0,0,0,0.5);}}' +
      '.hermes-shim-title{margin:0;font-size:1.125rem;font-weight:600;letter-spacing:-0.01em;}' +
      '.hermes-shim-subtitle{margin:0 0 0.2rem;font-size:0.8125rem;opacity:0.72;}' +
      '.hermes-shim-label{font-size:0.75rem;font-weight:500;opacity:0.8;}' +
      '.hermes-shim-input{width:100%;font:inherit;font-size:0.9375rem;padding:0.5rem 0.65rem;' +
      'border-radius:0.5rem;border:1px solid rgba(23,23,26,0.22);background:#ffffff;color:#17171A;}' +
      '@media (prefers-color-scheme:dark){.hermes-shim-input{border-color:rgba(255,230,203,0.3);' +
      'background:rgba(255,255,255,0.08);color:#FFE6CB;}}' +
      '.hermes-shim-input:focus{outline:2px solid #0053FD;outline-offset:1px;}' +
      '.hermes-shim-status{min-height:1.1rem;font-size:0.8125rem;}' +
      '.hermes-shim-status--pending{opacity:0.7;}' +
      '.hermes-shim-status--error{color:#C81E3A;}' +
      '@media (prefers-color-scheme:dark){.hermes-shim-status--error{color:#FFB4C2;}}' +
      '.hermes-shim-status--ok{color:#0053FD;}' +
      '@media (prefers-color-scheme:dark){.hermes-shim-status--ok{color:#FFE6CB;}}' +
      '.hermes-shim-actions{display:flex;justify-content:flex-end;gap:0.5rem;margin-top:0.2rem;}' +
      '.hermes-shim-btn{font:inherit;font-size:0.875rem;font-weight:600;padding:0.5rem 1rem;' +
      'border-radius:0.5rem;border:none;cursor:pointer;}' +
      '.hermes-shim-btn--primary{background:#0053FD;color:#ffffff;}' +
      '.hermes-shim-btn--primary:disabled{opacity:0.6;cursor:default;}' +
      '.hermes-shim-btn--ghost{background:transparent;color:inherit;opacity:0.7;}' +
      '.hermes-shim-btn--ghost:hover{opacity:1;}'
    document.head.appendChild(style)
  }

  function isFirstRunNoConfig() {
    const stored = readStoredRaw()
    return !(stored && stored.url && (stored.username || stored.token))
  }

  function setConnectStatus(el, text, kind) {
    el.textContent = text
    el.className = 'hermes-shim-status' + (kind ? ' hermes-shim-status--' + kind : '')
  }

  function closeConnectOverlay() {
    const el = document.getElementById(CONNECT_OVERLAY_ID)
    if (el) el.remove()
  }

  function openConnectOverlay(opts) {
    const dismissible = Boolean(opts && opts.dismissible)
    if (document.getElementById(CONNECT_OVERLAY_ID)) return
    ensureConnectStyles()

    const stored = readStoredRaw()
    const prefillUrl = stored && stored.url ? stored.url : DEFAULT_GATEWAY_URL

    const overlay = document.createElement('div')
    overlay.id = CONNECT_OVERLAY_ID
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    overlay.setAttribute('aria-label', 'Connect to Hermes')
    overlay.innerHTML =
      '<form class="hermes-shim-card" novalidate>' +
      '<h1 class="hermes-shim-title">Connect to Hermes</h1>' +
      '<p class="hermes-shim-subtitle">Enter your Hermes gateway URL and login credentials.</p>' +
      '<label class="hermes-shim-label" for="hermes-shim-url">Gateway URL</label>' +
      '<input class="hermes-shim-input" id="hermes-shim-url" type="text" inputmode="url" ' +
      'autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" ' +
      'placeholder="http://100.105.139.115:9119" />' +
      '<div id="hermes-shim-auth-fields">' +
      '<label class="hermes-shim-label" for="hermes-shim-user">Username</label>' +
      '<input class="hermes-shim-input" id="hermes-shim-user" type="text" autocomplete="username" ' +
      'autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Username" />' +
      '<label class="hermes-shim-label" for="hermes-shim-pass">Password</label>' +
      '<input class="hermes-shim-input" id="hermes-shim-pass" type="password" autocomplete="current-password" ' +
      'autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Password" />' +
      '</div>' +
      '<div class="hermes-shim-status" id="hermes-shim-status" aria-live="polite"></div>' +
      '<div class="hermes-shim-actions">' +
      (dismissible
        ? '<button type="button" class="hermes-shim-btn hermes-shim-btn--ghost" id="hermes-shim-cancel">Cancel</button>'
        : '') +
      '<button type="submit" class="hermes-shim-btn hermes-shim-btn--primary" id="hermes-shim-connect">Connect</button>' +
      '</div>' +
      '</form>'

    document.body.appendChild(overlay)

    const form = overlay.querySelector('form')
    const urlInput = overlay.querySelector('#hermes-shim-url')
    const userInput = overlay.querySelector('#hermes-shim-user')
    const passInput = overlay.querySelector('#hermes-shim-pass')
    const statusEl = overlay.querySelector('#hermes-shim-status')
    const connectBtn = overlay.querySelector('#hermes-shim-connect')
    const cancelBtn = overlay.querySelector('#hermes-shim-cancel')

    urlInput.value = prefillUrl
    userInput.value = stored ? stored.username : ''
    passInput.value = stored ? stored.password : ''

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => closeConnectOverlay())
    }

    form.addEventListener('submit', e => {
      e.preventDefault()
      const urlValue = urlInput.value
      const userValue = userInput.value
      const passValue = passInput.value

      setConnectStatus(statusEl, 'Connecting…', 'pending')
      connectBtn.disabled = true
      urlInput.disabled = true
      userInput.disabled = true
      passInput.disabled = true
      if (cancelBtn) cancelBtn.disabled = true

      window.hermesDesktop
        .testConnectionConfig({
          mode: 'remote',
          remoteAuthMode: 'basic',
          remoteUrl: urlValue,
          remoteUsername: userValue,
          remotePassword: passValue
        })
        .then(result => {
          writeStored({
            url: result.baseUrl,
            authMode: 'basic',
            username: userValue,
            password: passValue
          })
          setConnectStatus(statusEl, 'Connected! Reloading…', 'ok')
          setTimeout(() => {
            try { window.location.reload() } catch {}
          }, 200)
        })
        .catch(err => {
          setConnectStatus(statusEl, err.message || CONNECT_FAILURE_MESSAGE, 'error')
          connectBtn.disabled = false
          urlInput.disabled = false
          userInput.disabled = false
          passInput.disabled = false
          if (cancelBtn) cancelBtn.disabled = false
        })
    })
  }

  function watchForBootFailure() {
    let triggered = false
    let observer = null

    const tryRecover = () => {
      if (triggered) return
      if (isFirstRunNoConfig()) return
      if (document.getElementById(CONNECT_OVERLAY_ID)) return
      if (!document.querySelector('div.fixed.inset-0.z-\\[1400\\]:not(.backdrop-blur-md)')) return
      triggered = true
      if (observer) observer.disconnect()
      openConnectOverlay({ dismissible: true })
    }

    observer = new MutationObserver(tryRecover)
    observer.observe(document.body, { childList: true, subtree: true })
    tryRecover()
  }

  whenBodyReady(() => {
    if (isFirstRunNoConfig()) {
      openConnectOverlay({ dismissible: false })
    } else {
      watchForBootFailure()
    }
  })

  // ── iOS Layout Adaptation ───────────────────────────────────────────────
  const IOS_STYLE_ID = 'hermes-shim-ios-style'

  function applyMobileViewportMeta() {
    const content = 'width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1, user-scalable=no'
    let meta = document.querySelector('meta[name="viewport"]')
    if (!meta) {
      meta = document.createElement('meta')
      meta.setAttribute('name', 'viewport')
      ;(document.head || document.documentElement).appendChild(meta)
    }
    meta.setAttribute('content', content)
  }

  function iosLayoutCss() {
    return (
      'html,body{position:fixed !important;inset:0 !important;width:100% !important;height:100% !important;height:100dvh !important;' +
      'overflow:hidden !important;overscroll-behavior:none !important;}' +
      'html{-webkit-text-size-adjust:100%;}' +
      'html,body,#root{touch-action:manipulation;}' +
      '#root{height:100% !important;height:100dvh !important;overflow:hidden !important;display:flex;flex-direction:column;}' +
      "[data-slot='sidebar-wrapper']{" +
      '--titlebar-height:calc(3rem + env(safe-area-inset-top, 0px)) !important;' +
      '--titlebar-controls-top:calc(0.5rem + env(safe-area-inset-top, 0px)) !important;' +
      '--titlebar-controls-left:max(14px, env(safe-area-inset-left, 0px)) !important;' +
      '--titlebar-tools-right:max(0.75rem, env(safe-area-inset-right, 0px)) !important;}' +
      '.h-\\(--titlebar-height\\){padding-top:env(safe-area-inset-top, 0px);}' +
      'main.relative.z-3{' +
      'padding-left:env(safe-area-inset-left, 0px);padding-right:env(safe-area-inset-right, 0px);}' +
      "footer[data-slot='statusbar']{" +
      'height:calc(1.5rem + env(safe-area-inset-bottom, 0px)) !important;' +
      'min-height:calc(1.5rem + env(safe-area-inset-bottom, 0px)) !important;' +
      'padding-bottom:env(safe-area-inset-bottom, 0px) !important;' +
      'padding-left:max(0.75rem, env(safe-area-inset-left, 0px)) !important;' +
      'padding-right:max(0.75rem, env(safe-area-inset-right, 0px)) !important;' +
      'background:color-mix(in srgb, currentColor 11%, transparent) !important;' +
      'border-top:1px solid color-mix(in srgb, currentColor 22%, transparent) !important;}' +
      '@media (max-width: 768px), (pointer: coarse){' +
      'div.fixed.z-70 button:has(> .codicon-keyboard),' +
      'div.fixed.z-70 button:has(> .codicon-mute),' +
      'div.fixed.z-70 button:has(> .codicon-unmute){display:none !important;}' +
      "[data-slot='sidebar-wrapper']{" +
      '--titlebar-control-size:2rem;' +
      '--titlebar-control-height:2rem;' +
      '--titlebar-height:calc(3rem + env(safe-area-inset-top, 0px)) !important;' +
      '--titlebar-controls-top:calc(0.5rem + env(safe-area-inset-top, 0px)) !important;' +
      '--titlebar-content-inset:calc(max(14px, env(safe-area-inset-left, 0px)) + 2 * (2rem + 0.25rem) + 0.5rem) !important;}' +
      "[data-slot='aui_thread-content']{padding-top:calc(0.75rem + env(safe-area-inset-top, 0px)) !important;}" +
      "footer[data-slot='statusbar']{" +
      'height:calc(1.75rem + env(safe-area-inset-bottom, 0px)) !important;' +
      'min-height:calc(1.75rem + env(safe-area-inset-bottom, 0px)) !important;}' +
      "[data-slot='composer-root']:not([data-popped-out]){" +
      'width:calc(100% - max(0.5rem, env(safe-area-inset-left, 0px)) - max(0.5rem, env(safe-area-inset-right, 0px))) !important;' +
      'max-width:none !important;' +
      'padding-bottom:max(0.5rem, env(safe-area-inset-bottom, 0px)) !important;}' +
      "[data-slot='aui_composer-clearance']{" +
      'height:calc(var(--composer-surface-measured-height) + var(--status-stack-measured-height) + env(safe-area-inset-bottom, 0px) + 0.5rem) !important;}' +
      "div[role='presentation'].fixed.inset-0.z-50{" +
      'padding:max(0.75rem, env(safe-area-inset-top, 0px)) max(0.75rem, env(safe-area-inset-right, 0px)) ' +
      'max(0.75rem, env(safe-area-inset-bottom, 0px)) max(0.75rem, env(safe-area-inset-left, 0px)) !important;' +
      '--titlebar-height:48px;}' +
      '}'
    )
  }

  function ensureIosLayoutStyles() {
    let style = document.getElementById(IOS_STYLE_ID)
    if (!style) {
      style = document.createElement('style')
      style.id = IOS_STYLE_ID
      style.textContent = iosLayoutCss()
    }
    document.head.appendChild(style)
  }

  function disableComposerPopout() {
    try {
      window.localStorage.removeItem('hermes.desktop.composerPopout.enabled')
      window.localStorage.removeItem('hermes.desktop.composerPopout.position')
    } catch {}
  }

  disableComposerPopout()
  applyMobileViewportMeta()
  ensureIosLayoutStyles()
  whenBodyReady(() => ensureIosLayoutStyles())
  document.addEventListener('gesturestart', e => e.preventDefault(), { passive: false })
})()
