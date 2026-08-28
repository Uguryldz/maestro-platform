import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ApiClient } from "../api/client.ts";
import { type LoginResponse, type Session, sessionFromLogin } from "./types.ts";

export type AuthStatus = "loading" | "authenticated" | "anonymous";

export interface AuthValue {
  readonly status: AuthStatus;
  readonly session: Session | null;
  readonly api: ApiClient;
  readonly login: (username: string, password: string) => Promise<void>;
  readonly logout: () => Promise<void>;
  /**
   * Change the caller's own password (first-run bootstrap + M8 self-service).
   * On success the BFF has killed every session of the account — including this
   * one — so this clears the local session and the caller lands back on /login
   * to sign in with the new password.
   */
  readonly changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export interface AuthProviderProps {
  readonly children: ReactNode;
  /** Tests inject a stub fetch; the app uses the real one. */
  readonly fetchImpl?: typeof fetch;
  /** Tests may start already signed in and skip the /auth/session probe. */
  readonly initialSession?: Session | null;
  readonly initialToken?: string | null;
}

/**
 * The bearer is kept in `sessionStorage` so a reload keeps the operator signed
 * in without surviving a tab close. Both helpers are guarded: `sessionStorage`
 * is absent under SSR and can throw in a locked-down browser, and neither case
 * should crash the app — a missing store simply means "no persisted token".
 */
const TOKEN_KEY = "maestro.token";

function readStoredToken(): string | null {
  try {
    return globalThis.sessionStorage?.getItem(TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeStoredToken(token: string | null): void {
  try {
    if (token === null) globalThis.sessionStorage?.removeItem(TOKEN_KEY);
    else globalThis.sessionStorage?.setItem(TOKEN_KEY, token);
  } catch {
    // A store that refuses writes just means no persistence; the in-memory
    // ref still carries the token for this page's lifetime.
  }
}

export function AuthProvider({
  children,
  fetchImpl,
  initialSession,
  initialToken,
}: AuthProviderProps): ReactNode {
  const [session, setSession] = useState<Session | null>(initialSession ?? null);
  const [status, setStatus] = useState<AuthStatus>(
    initialSession !== undefined ? (initialSession === null ? "anonymous" : "authenticated") : "loading",
  );

  // The token lives in a ref, not in React state: the ApiClient reads it on
  // every request through a stable closure, so a re-render must not be required
  // for the next call to carry the right credential.
  //
  // Persistence is `sessionStorage`, NOT `localStorage`: a page reload keeps the
  // operator signed in (the whole point of this change), but the token dies when
  // the tab closes and never outlives the browser session. localStorage would
  // hand an 8-hour bearer to any XSS AND survive a full browser restart; the
  // sessionStorage window is the smaller, deliberate trade.
  const tokenRef = useRef<string | null>(initialToken ?? readStoredToken());

  const clearSession = useCallback(() => {
    tokenRef.current = null;
    writeStoredToken(null);
    setSession(null);
    setStatus("anonymous");
  }, []);

  const api = useMemo(
    () =>
      new ApiClient({
        getToken: () => tokenRef.current,
        onSessionLost: clearSession,
        ...(fetchImpl ? { fetchImpl } : {}),
      }),
    [clearSession, fetchImpl],
  );

  // On boot, if we are holding a token (a page reload keeps none today, but a
  // test or a future persistence strategy may), confirm it is still alive.
  useEffect(() => {
    if (initialSession !== undefined) return;
    if (tokenRef.current === null) {
      setStatus("anonymous");
      return;
    }
    const controller = new AbortController();
    void api
      .get<Session>("/auth/session", { signal: controller.signal })
      .then((next) => {
        setSession(next);
        setStatus("authenticated");
      })
      .catch(() => {
        // An ABORT is not a verdict. This effect aborts its own request on
        // cleanup, and React runs mount→cleanup→mount twice under StrictMode,
        // so the first probe of every cold load rejects with AbortError while
        // the second one is still in flight. Treating that as "no session"
        // flipped status to `anonymous` for the ~30 ms until the real answer
        // arrived — long enough for RequireSession to fire its <Navigate>, which
        // is what bounced an operator with a perfectly valid token from a
        // deep-linked URL to /login. The replacement leaves status at
        // "loading"; the surviving request decides.
        if (controller.signal.aborted) return;
        // A genuinely failed probe means no usable session; onSessionLost
        // already cleared the token.
        setStatus("anonymous");
      });
    return () => controller.abort();
  }, [api, initialSession]);

  const login = useCallback(
    async (username: string, password: string) => {
      const response = await api.post<LoginResponse>("/auth/login", { username, password });
      tokenRef.current = response.token;
      writeStoredToken(response.token);
      setSession(sessionFromLogin(response));
      setStatus("authenticated");
    },
    [api],
  );

  const logout = useCallback(async () => {
    try {
      // Account-wide: the BFF drops every session of this user, not just ours.
      await api.post<void>("/auth/logout");
    } catch {
      // A failed logout must still sign us out locally.
    } finally {
      clearSession();
    }
  }, [api, clearSession]);

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      // A weak new password throws `password_policy` with its violations, and a
      // wrong current password throws `invalid_credentials` — the caller (the
      // change-password screen) renders both. Only a 204 reaches the clear
      // below, at which point every session of the account is already dead
      // server-side, so we drop ours and let RequireSession route to /login.
      await api.post<void>("/auth/change-password", { currentPassword, newPassword });
      clearSession();
    },
    [api, clearSession],
  );

  const value = useMemo<AuthValue>(
    () => ({ status, session, api, login, logout, changePassword }),
    [status, session, api, login, logout, changePassword],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

/** The configured client, for screens that fetch. */
export function useApi(): ApiClient {
  return useAuth().api;
}
