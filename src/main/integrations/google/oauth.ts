/**
 * Google OAuth for installed apps: PKCE + loopback redirect
 * (https://developers.google.com/identity/protocols/oauth2/native-app).
 *
 * The user supplies their own OAuth client (Google Cloud Console, type
 * "Desktop app"). The browser opens Google's consent page; Google redirects
 * to http://127.0.0.1:<random port>, where a one-shot local server receives
 * the code. Nothing passes through a Second server.
 */

import { createHash, randomBytes } from 'crypto'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'

export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
export const USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo'
export const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke'
export const AUTH_TIMEOUT_MS = 5 * 60_000

export type FetchFn = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
}>

export interface TokenResponse {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string[]
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(48))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export function buildAuthUrl(p: { clientId: string; redirectUri: string; scopes: string[]; challenge: string; state: string; loginHint?: string }): string {
  const u = new URL(AUTH_ENDPOINT)
  u.searchParams.set('client_id', p.clientId)
  u.searchParams.set('redirect_uri', p.redirectUri)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('scope', p.scopes.join(' '))
  u.searchParams.set('code_challenge', p.challenge)
  u.searchParams.set('code_challenge_method', 'S256')
  u.searchParams.set('state', p.state)
  // Offline access + consent so Google returns a refresh token.
  u.searchParams.set('access_type', 'offline')
  u.searchParams.set('prompt', 'consent')
  u.searchParams.set('include_granted_scopes', 'true')
  if (p.loginHint) u.searchParams.set('login_hint', p.loginHint)
  return u.toString()
}

const form = (params: Record<string, string>) =>
  Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')

async function postToken(fetchFn: FetchFn, params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetchFn(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form(params),
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const err = typeof data.error_description === 'string' ? data.error_description : typeof data.error === 'string' ? data.error : `HTTP ${res.status}`
    throw new Error(`Google token request failed: ${err}`)
  }
  return data
}

export async function exchangeCode(
  fetchFn: FetchFn,
  p: { clientId: string; clientSecret: string; code: string; verifier: string; redirectUri: string },
  now = Date.now(),
): Promise<TokenResponse> {
  const data = await postToken(fetchFn, {
    client_id: p.clientId,
    client_secret: p.clientSecret,
    code: p.code,
    code_verifier: p.verifier,
    grant_type: 'authorization_code',
    redirect_uri: p.redirectUri,
  })
  if (typeof data.access_token !== 'string') throw new Error('Google did not return an access token')
  if (typeof data.refresh_token !== 'string') throw new Error('Google did not return a refresh token. Remove Second from your Google account permissions and connect again.')
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: now + (Number(data.expires_in) || 3600) * 1000,
    scopes: typeof data.scope === 'string' ? data.scope.split(' ') : [],
  }
}

export async function refreshAccessToken(
  fetchFn: FetchFn,
  p: { clientId: string; clientSecret: string; refreshToken: string },
  now = Date.now(),
): Promise<{ accessToken: string; expiresAt: number }> {
  const data = await postToken(fetchFn, {
    client_id: p.clientId,
    client_secret: p.clientSecret,
    refresh_token: p.refreshToken,
    grant_type: 'refresh_token',
  })
  if (typeof data.access_token !== 'string') throw new Error('Google did not return an access token')
  return { accessToken: data.access_token, expiresAt: now + (Number(data.expires_in) || 3600) * 1000 }
}

export async function fetchEmail(fetchFn: FetchFn, accessToken: string): Promise<string> {
  const res = await fetchFn(USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) return ''
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return typeof data.email === 'string' ? data.email : ''
}

export async function revokeToken(fetchFn: FetchFn, token: string): Promise<void> {
  try {
    await fetchFn(REVOKE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ token }),
    })
  } catch {
    // Best effort: the local token is deleted regardless.
  }
}

const DONE_PAGE = (ok: boolean, msg: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Second</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#141B2D;color:#F4EFE6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
div{max-width:420px;text-align:center}h1{font-family:Georgia,serif;font-weight:600;letter-spacing:.08em}p{opacity:.8}</style></head>
<body><div><h1>SECOND</h1><p>${ok ? 'Google is connected. You can close this tab and return to Second.' : msg}</p></div></body></html>`

/**
 * Run the full consent flow: start a loopback listener, open the browser,
 * wait for the redirect, exchange the code. Resolves with tokens + email.
 */
export async function runAuthFlow(p: {
  clientId: string
  clientSecret: string
  scopes: string[]
  openBrowser: (url: string) => Promise<void> | void
  fetchFn: FetchFn
  timeoutMs?: number
}): Promise<TokenResponse & { email: string }> {
  const { verifier, challenge } = createPkce()
  const state = base64url(randomBytes(16))

  let server: Server | null = null
  try {
    const code = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
      let redirectUri = ''
      const timer = setTimeout(() => reject(new Error('Google sign-in timed out. Try again.')), p.timeoutMs ?? AUTH_TIMEOUT_MS)
      server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (url.pathname !== '/') {
          res.writeHead(404).end()
          return
        }
        const error = url.searchParams.get('error')
        const gotState = url.searchParams.get('state')
        const gotCode = url.searchParams.get('code')
        if (error || !gotCode || gotState !== state) {
          const msg = error === 'access_denied' ? 'Access was not granted. You can close this tab.' : 'Sign-in failed. You can close this tab and try again.'
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(DONE_PAGE(false, msg))
          clearTimeout(timer)
          reject(new Error(error === 'access_denied' ? 'Google access was not granted.' : 'Google sign-in failed (state mismatch or missing code).'))
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(DONE_PAGE(true, ''))
        clearTimeout(timer)
        resolve({ code: gotCode, redirectUri })
      })
      server.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      server.listen(0, '127.0.0.1', () => {
        const port = (server!.address() as AddressInfo).port
        redirectUri = `http://127.0.0.1:${port}`
        const authUrl = buildAuthUrl({ clientId: p.clientId, redirectUri, scopes: p.scopes, challenge, state })
        Promise.resolve(p.openBrowser(authUrl)).catch(reject)
      })
    })

    const tokens = await exchangeCode(p.fetchFn, {
      clientId: p.clientId,
      clientSecret: p.clientSecret,
      code: code.code,
      verifier,
      redirectUri: code.redirectUri,
    })
    const email = await fetchEmail(p.fetchFn, tokens.accessToken)
    return { ...tokens, email }
  } finally {
    ;(server as Server | null)?.close()
  }
}
