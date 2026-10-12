// How the browser gets from a bearer token to a person's login session, and why it must not go the
// other way. A human-only approval is decided only in a dashboard session (username + password); the
// auth gate lets a bearer win over the session cookie, so a browser that holds a token (the one an
// enrollment link hands out) cannot decide it, however logged in the person is. Two small rules keep
// the browser on the session once it has one, and make the way to get one visible:
//
//  - a visible "Sign in" entry in the sidebar while the browser is on a token and a login exists;
//  - an enrollment link opened in a browser that already holds a session is not traded for a token,
//    because the token would push the session aside again.
//
// Pure functions plus one DOM helper; app.js and profile.js wire them in.

/** The status probe's answer says the caller is a logged-in person (the cookie, not a bearer). */
export function holdsSession(status) {
  return !!status && status.authenticated === true && status.method === 'session'
}

/** Offer the Sign in entry: the caller is on a bearer token and a password login exists to switch to. */
export function shouldOfferSignIn(status) {
  return !!status && status.authenticated === true && status.method === 'token' && status.login_available === true
}

/**
 * Trade an enrollment code for a token, unless the browser already holds a session.
 *
 * `probeStatus` must ask WITHOUT the bearer header (it answers for the cookie alone) and `exchange` is the
 * code-for-token call. Resolves to the token, or '' when nothing was traded: no code, a session already
 * held, or a failed exchange. A probe that fails counts as "no session" (the old behaviour: enroll).
 */
export async function enrollUnlessSession({ code, probeStatus, exchange }) {
  if (!code) return ''
  let status = null
  try { status = await probeStatus() } catch { status = null }
  if (holdsSession(status)) return ''
  return exchange(code)
}

/**
 * Show or hide the sidebar Sign in entry for a status answer. The click opens the login overlay; the
 * token is only dropped after a successful login (app.js), so a cancelled attempt locks nobody out.
 */
export function applySignInEntry(status, doc = document, openLogin = () => window.showLoginOverlay?.()) {
  const el = doc.getElementById('navSignIn')
  if (!el) return
  el.hidden = !shouldOfferSignIn(status)
  if (!el.dataset.wired) {
    el.dataset.wired = '1'
    el.addEventListener('click', (e) => { e.preventDefault(); openLogin() })
  }
}
