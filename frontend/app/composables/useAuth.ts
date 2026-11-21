import type { User, LoginCredentials, AuthResponse, MeResponse, ApiResponse } from '~/types'

// Client-only module-level dedupe slot for the in-flight refresh promise.
// Storing a Promise inside useState() leaks it into the SSR payload, which
// devalue cannot serialize (DevalueError "Cannot stringify arbitrary
// non-POJOs"). On the server, refreshes happen per-request anyway and
// don't need cross-component dedupe — so we keep this client-only and
// never touch it during SSR.
let clientRefreshInFlight: Promise<boolean> | null = null

export function useAuth() {
  const config = useRuntimeConfig()
  const router = useRouter()

  // Use different API URL for server (SSR) vs client (browser)
  const apiBaseUrl = computed(() =>
    import.meta.server ? config.apiBaseUrlServer : config.public.apiBaseUrl
  )

  // State
  const user = useState<User | null>('auth:user', () => null)
  const permissions = useState<string[]>('auth:permissions', () => [])
  // ADR 0023: the tokens are HttpOnly cookies set by the backend — JS
  // never sees them. ``dp_csrf`` (readable) doubles as the "a session
  // probably exists" hint, so anonymous visitors don't cost a /me call.
  const { csrfHeaders, hasSession } = useSessionRequest()
  // SSR forwards the (possibly rotated) cookie jar per call, see useSsrCookies.
  const { cookieHeaders, applySetCookies } = useSsrCookies()
  // Captured at setup, like useSsrCookies: calling useRequestEvent() after
  // an await can throw "nuxt instance unavailable". Used to coalesce
  // server-side refreshes per request (see refresh()).
  const ssrEvent = import.meta.server ? useRequestEvent() : undefined
  const sessionHeaders = (method = 'GET'): Record<string, string> => ({
    ...csrfHeaders(method),
    ...cookieHeaders()
  })

  // Computed
  const isAuthenticated = computed(() => !!user.value)

  // Actions
  async function login(credentials: LoginCredentials): Promise<void> {
    // OAuth2PasswordRequestForm expects form data with 'username' field
    const formData = new URLSearchParams()
    formData.append('username', credentials.email)
    formData.append('password', credentials.password)

    await $fetch<AuthResponse>('/api/v1/auth/login', {
      baseURL: apiBaseUrl.value,
      method: 'POST',
      body: formData,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    })

    // The backend set the session cookies; load the user through them.
    await fetchUser()
  }

  /** The backend already set the session cookies on the out-of-band call
   *  (e.g. invite set-password); just load the user. The token arguments
   *  stay for call-site compatibility during the transition release. */
  async function applyTokens(_access?: string, _refresh?: string): Promise<void> {
    await fetchUser()
  }

  async function logout(): Promise<void> {
    if (import.meta.client) {
      try {
        await $fetch('/api/v1/auth/logout', {
          baseURL: apiBaseUrl.value,
          method: 'POST',
          credentials: 'include',
          headers: sessionHeaders('POST')
        })
      } catch {
        // Cookies are cleared server-side on success; on failure the
        // access cookie simply expires — state is cleared below either way.
      }
    }
    user.value = null
    permissions.value = []
    // SSR: skip router.push — calling it from middleware can crash the
    // response. The global auth middleware redirects to /login once it
    // sees isAuthenticated === false.
    if (import.meta.client) {
      await router.push('/login')
    }
  }

  // Dedupe concurrent refreshes. Without this, a page that fires N
  // parallel requests on an expired access token triggers N refresh
  // calls — all but one race past the rate limiter and trip 429, which
  // then logs the user out. Sharing one in-flight promise keeps the
  // refresh single-shot per session.
  //
  // Client: module-level slot (see top of file) — a Promise inside
  // useState() breaks SSR payload serialization.
  // Server: coalesced per request on the H3 event, because a single SSR
  // render fires several loaders at once and each 401 used to start its
  // own refresh — concurrent rotations of the same cookie, plus the
  // 10/min limiter. Both were enough to end sessions that were still
  // perfectly valid.
  async function refresh(): Promise<boolean> {
    if (!hasSession.value) {
      return false
    }

    if (import.meta.server) {
      if (!ssrEvent) return await doRefresh()
      const inFlight = ssrEvent.context.dpRefreshInFlight as Promise<boolean> | undefined
      if (inFlight) return inFlight
      const run = doRefresh()
      ssrEvent.context.dpRefreshInFlight = run
      return run
    }

    if (clientRefreshInFlight) {
      return clientRefreshInFlight
    }

    const run = doRefresh()
    clientRefreshInFlight = run
    try {
      return await run
    } finally {
      clientRefreshInFlight = null
    }
  }

  async function doRefresh(): Promise<boolean> {
    let attempt = 0
    for (;;) {
      try {
        // The browser (or SSR, forwarding the page request's jar) presents
        // the refresh cookie; the backend rotates it and re-sets the cookies.
        const raw = await $fetch.raw<AuthResponse>('/api/v1/auth/refresh', {
          baseURL: apiBaseUrl.value,
          method: 'POST',
          credentials: 'include',
          headers: sessionHeaders('POST')
        })
        // SSR: the rotated cookies came back on the *backend* response.
        // Relay them onto the Nuxt response (or the browser keeps the old,
        // now revoked refresh token and burns the family next time) and
        // switch this render's forwarded jar to them, so every later
        // backend call in the same render uses the live session.
        if (import.meta.server) {
          applySetCookies(raw.headers.getSetCookie?.() ?? [])
        }
        const response = raw._data as AuthResponse
        user.value = response.user

        // /auth/refresh returns user but not the expanded permissions list,
        // so pull /me with the new session. Without this, callers that
        // wake up from an expired access token end up with empty
        // permissions and the sidebar/home strip every gated entry.
        const me = await $fetch<ApiResponse<MeResponse>>('/api/v1/auth/me', {
          baseURL: apiBaseUrl.value,
          credentials: 'include',
          headers: cookieHeaders()
        })
        user.value = me.data.user
        permissions.value = me.data.permissions
        return true
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode
        // Only a definitive rejection from the backend means the session
        // is over: the refresh cookie was refused (401 — the response also
        // clears the cookies). Everything else is transient — backend
        // restarting under `tsx watch`, laptop waking from sleep, network
        // hiccup, 429 burst, 5xx, timeout — and must never log the user
        // out. That catch-all logout was the main cause of sessions
        // dropping "on their own". One retry, then leave the session as is.
        if (status === 401 || status === 403) {
          await logout()
          return false
        }
        if (import.meta.client && attempt === 0) {
          attempt += 1
          await new Promise(resolve => setTimeout(resolve, 500))
          continue
        }
        return false
      }
    }
  }

  async function fetchUser(): Promise<void> {
    try {
      const response = await $fetch<ApiResponse<MeResponse>>('/api/v1/auth/me', {
        baseURL: apiBaseUrl.value,
        credentials: 'include',
        headers: sessionHeaders()
      })
      user.value = response.data.user
      permissions.value = response.data.permissions
    } catch (error: unknown) {
      const fetchError = error as { statusCode?: number }
      // Only try refresh on 401 (expired token), not on other errors
      if (fetchError.statusCode === 401) {
        // refresh() ends the session itself when the cookies were refused;
        // a transient failure leaves it intact, so no logout here.
        await refresh()
      } else {
        // Log the error but don't logout on non-401 errors
        console.error('Failed to fetch user:', error)
        throw error
      }
    }
  }

  // Initialize user if token exists (works on both server and client).
  // Must never throw: the global auth middleware awaits this on SSR, and
  // an unhandled rejection there crashes the response so the user sees
  // neither the page nor a redirect to /login. On any failure, clear
  // auth state so the middleware can route to /login.
  async function init(): Promise<void> {
    try {
      if (hasSession.value && !user.value) {
        // /me on a 401 (expired access cookie) falls through to refresh.
        await fetchUser()
      }
    } catch {
      user.value = null
      permissions.value = []
    }
  }

  return {
    user: readonly(user),
    permissions: readonly(permissions),
    hasSession,
    isAuthenticated,
    login,
    applyTokens,
    logout,
    refresh,
    fetchUser,
    init
  }
}
