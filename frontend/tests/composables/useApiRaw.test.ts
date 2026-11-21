import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

/**
 * #440: blob downloads go through ``useApi().raw``, which must recover
 * from an expired access cookie the same way ``$api`` does — otherwise
 * "Download PDF" after an idle answers "Not authenticated" while the
 * rest of the page refreshes silently.
 */
const refresh = vi.fn(async () => true)
const logout = vi.fn(async () => {})

mockNuxtImport('useAuth', () => () => ({ refresh, logout }))
mockNuxtImport('useToast', () => () => ({ add: vi.fn() }))
mockNuxtImport('useI18n', () => () => ({ t: (key: string, fallback?: string) => fallback ?? key }))

async function raw(path: string) {
  const { useApi } = await import('~/composables/useApi')
  return await useApi().raw(path)
}

describe('useApi().raw', () => {
  beforeEach(() => {
    refresh.mockClear()
    refresh.mockResolvedValue(true)
    logout.mockClear()
  })

  it('returns the response untouched when the session is valid', async () => {
    const fetchMock = vi.fn(async () => new Response('pdf', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await raw('/api/v1/billing/invoices/1/pdf')

    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('refreshes once and retries when the access cookie has expired', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('pdf', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await raw('/api/v1/billing/invoices/1/pdf')

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(res.status).toBe(200)
    expect(logout).not.toHaveBeenCalled()
  })

  it('hands back the 401 without logging out when the refresh fails', async () => {
    // A failed refresh is not proof the session is over: refresh() itself
    // ends it on a definitive 401/403 and stays put on transient failures
    // (backend restart, 429 burst, network blip). raw() must not second-guess.
    refresh.mockResolvedValue(false)
    const fetchMock = vi.fn(async () => new Response('', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await raw('/api/v1/billing/invoices/1/pdf')

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(logout).not.toHaveBeenCalled()
    expect(res.status).toBe(401)
  })
})
