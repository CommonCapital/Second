import { describe, expect, it } from 'vitest'
import { buildAuthUrl, createPkce, exchangeCode, runAuthFlow, TOKEN_ENDPOINT, USERINFO_ENDPOINT, type FetchFn } from '../oauth'
import { GoogleAuthError, GoogleClient } from '../client'
import { createHash } from 'crypto'

type Call = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } }

function fakeFetch(routes: (call: Call) => { status?: number; body: unknown } | undefined) {
  const calls: Call[] = []
  const fn: FetchFn = async (url, init) => {
    calls.push({ url, init })
    const r = routes({ url, init }) ?? { status: 404, body: { error: 'not found' } }
    const status = r.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.body,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    }
  }
  return { fn, calls }
}

describe('OAuth helpers', () => {
  it('creates a valid S256 PKCE pair', () => {
    const { verifier, challenge } = createPkce()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    const expected = createHash('sha256').update(verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(challenge).toBe(expected)
  })

  it('builds a consent URL for offline access', () => {
    const u = new URL(buildAuthUrl({ clientId: 'cid.apps.googleusercontent.com', redirectUri: 'http://127.0.0.1:5555', scopes: ['openid', 'email'], challenge: 'ch', state: 'st' }))
    expect(u.searchParams.get('access_type')).toBe('offline')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('scope')).toBe('openid email')
    expect(u.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5555')
  })

  it('reports a missing refresh token clearly', async () => {
    const { fn } = fakeFetch(() => ({ body: { access_token: 'a', expires_in: 3600 } }))
    await expect(exchangeCode(fn, { clientId: 'c', clientSecret: 's', code: 'x', verifier: 'v', redirectUri: 'r' })).rejects.toThrow(/refresh token/)
  })

  it('runs the loopback flow end to end', async () => {
    const { fn, calls } = fakeFetch((c) => {
      if (c.url === TOKEN_ENDPOINT) return { body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/calendar.readonly' } }
      if (c.url === USERINFO_ENDPOINT) return { body: { email: 'me@example.com' } }
      return undefined
    })
    const result = await runAuthFlow({
      clientId: 'cid.apps.googleusercontent.com',
      clientSecret: 'secret',
      scopes: ['openid', 'email'],
      fetchFn: fn,
      timeoutMs: 5000,
      // Simulate the browser: Google redirects back to the loopback URL.
      openBrowser: async (authUrl) => {
        const u = new URL(authUrl)
        const back = `${u.searchParams.get('redirect_uri')}/?code=the-code&state=${u.searchParams.get('state')}`
        const res = await fetch(back)
        expect(await res.text()).toContain('Google is connected')
      },
    })
    expect(result).toMatchObject({ refreshToken: 'rt', email: 'me@example.com' })
    const tokenCall = calls.find((c) => c.url === TOKEN_ENDPOINT)!
    expect(tokenCall.init?.body).toContain('code=the-code')
    expect(tokenCall.init?.body).toContain('code_verifier=')
    expect(tokenCall.init?.body).toContain('grant_type=authorization_code')
  })

  it('rejects a redirect with the wrong state', async () => {
    const { fn } = fakeFetch(() => undefined)
    await expect(runAuthFlow({
      clientId: 'c', clientSecret: 's', scopes: ['openid'], fetchFn: fn, timeoutMs: 5000,
      openBrowser: async (authUrl) => {
        const u = new URL(authUrl)
        await fetch(`${u.searchParams.get('redirect_uri')}/?code=x&state=forged`)
      },
    })).rejects.toThrow(/state mismatch/)
  })
})

describe('GoogleClient', () => {
  const creds = () => ({ clientId: 'c', clientSecret: 's', refreshToken: 'rt' })
  const now = () => Date.parse('2026-10-12T14:00:00Z')

  it('refreshes a token, lists upcoming events, and reuses the token', async () => {
    const { fn, calls } = fakeFetch((c) => {
      if (c.url === TOKEN_ENDPOINT) return { body: { access_token: 'at1', expires_in: 3600 } }
      if (c.url.includes('/calendars/primary/events?')) {
        return { body: { items: [
          { id: 'e1', summary: 'Acme', start: { dateTime: '2026-10-12T15:00:00Z' }, end: { dateTime: '2026-10-12T15:30:00Z' }, attendees: [{ email: 'd@acme.com' }] },
          { id: 'e0', summary: 'Already over', start: { dateTime: '2026-10-12T12:00:00Z' }, end: { dateTime: '2026-10-12T13:00:00Z' } },
        ] } }
      }
      return undefined
    })
    const client = new GoogleClient(creds, fn, now)
    const events = await client.upcomingEvents()
    await client.upcomingEvents()
    expect(events.map((e) => e.id)).toEqual(['e1'])
    expect(calls.filter((c) => c.url === TOKEN_ENDPOINT)).toHaveLength(1)
    expect(calls[1].init?.headers?.Authorization).toBe('Bearer at1')
  })

  it('retries once with a fresh token on 401, then raises an auth error', async () => {
    let tokenN = 0
    const { fn } = fakeFetch((c) => {
      if (c.url === TOKEN_ENDPOINT) return { body: { access_token: `at${++tokenN}`, expires_in: 3600 } }
      return { status: 401, body: { error: 'unauthorized' } }
    })
    const client = new GoogleClient(creds, fn, now)
    await expect(client.upcomingEvents()).rejects.toBeInstanceOf(GoogleAuthError)
    expect(tokenN).toBe(2)
  })

  it('gathers Gmail threads (deduped) and Drive docs with provenance', async () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64url')
    const { fn } = fakeFetch((c) => {
      if (c.url === TOKEN_ENDPOINT) return { body: { access_token: 'at', expires_in: 3600 } }
      if (c.url.includes('/messages?')) return { body: { messages: [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't1' }, { id: 'm3', threadId: 't2' }] } }
      if (c.url.includes('/messages/m1')) return { body: { internalDate: '1791500000000', payload: { headers: [{ name: 'Subject', value: 'Cap table' }, { name: 'From', value: 'Dana' }], mimeType: 'text/plain', body: { data: b64('Attached.') } } } }
      if (c.url.includes('/messages/m3')) return { body: { snippet: 'Thanks', payload: { headers: [], mimeType: 'text/plain' } } }
      if (c.url.includes('/drive/v3/files?')) return { body: { files: [
        { id: 'f1', name: 'Acme deck', mimeType: 'application/vnd.google-apps.presentation', modifiedTime: '2026-10-01T00:00:00Z' },
        { id: 'f2', name: 'Acme model.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      ] } }
      if (c.url.includes('/files/f1/export')) return { body: 'Slide 1: ARR $5M' }
      return undefined
    })
    const client = new GoogleClient(creds, fn, now)
    const mail = await client.mailWithPeople(['d@acme.com'])
    expect(mail.map((m) => m.ref)).toEqual(['packet:gmail:t1', 'packet:gmail:t2'])
    expect(mail[0]).toMatchObject({ title: 'Cap table', text: 'Attached.' })
    expect(mail[1].text).toBe('Thanks')
    const docs = await client.docsMatching(['Acme'])
    expect(docs[0]).toMatchObject({ ref: 'packet:drive:f1', text: 'Slide 1: ARR $5M' })
    expect(docs[1].text).toMatch(/not available as text/)
  })

  it('refuses to call Google when not connected', async () => {
    const { fn } = fakeFetch(() => undefined)
    const client = new GoogleClient(() => ({ clientId: '', clientSecret: '', refreshToken: '' }), fn, now)
    await expect(client.upcomingEvents()).rejects.toThrow(/not connected/)
  })
})
