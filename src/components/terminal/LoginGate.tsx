"use client";

/**
 * LoginGate — full-screen auth overlay for password-protected deployments.
 *
 *   GET  /api/auth → { authRequired, authenticated }
 *     · authRequired=false  → deployment is open (sandbox/local): render NOTHING.
 *     · authRequired && !authenticated → overlay covers the whole terminal
 *       (z-[120], above toasts). The shell keeps running underneath — nothing
 *       is unmounted, only covered + dimmed.
 *
 *   POST /api/auth { password } → 200 sets the HttpOnly `aurum_sess` cookie →
 *     brief "Unlocking…" beat → window.location.reload() so socket.io and all
 *     queries reconnect with the fresh cookie. 401 = wrong password,
 *     429 = rate limited (exact server message shown).
 *
 * Global 401 interception: window.fetch is patched ONCE (HMR-safe flag) so any
 * same-origin /api/* 401 dispatches "aurum:401"; the gate then re-checks auth
 * (server-side password rotation). Also re-checks on window focus (expired
 * sessions after sleep). Re-checks are throttled to at most one per 5s. The
 * patched fetch ALWAYS returns the original response untouched.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type AuthStatus = { authRequired?: boolean; authenticated?: boolean };
type AuthReply = { ok?: boolean; error?: string } | null;

const AUTH_401_EVENT = "aurum:401";
const RECHECK_MIN_INTERVAL_MS = 5_000;
const UNLOCK_RELOAD_DELAY_MS = 400;

/** window flag that keeps the fetch patch idempotent across HMR / Strict Mode. */
type PatchedWindow = Window & { __aurumFetchPatched?: boolean };

/** true only for same-origin /api/* requests (string, URL and Request inputs). */
function isSameOriginApiRequest(input: RequestInfo | URL): boolean {
  try {
    const href =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, window.location.href);
    return url.origin === window.location.origin && url.pathname.startsWith("/api/");
  } catch {
    return false;
  }
}

function patchFetchOnce(): void {
  const w = window as PatchedWindow;
  if (w.__aurumFetchPatched) return;
  const original = window.fetch.bind(window);
  const patched: typeof fetch = async (input, init) => {
    const response = await original(input, init);
    if (response.status === 401 && isSameOriginApiRequest(input)) {
      window.dispatchEvent(new CustomEvent(AUTH_401_EVENT));
    }
    return response; // ALWAYS the original response, unchanged
  };
  window.fetch = patched;
  w.__aurumFetchPatched = true;
}

export function LoginGate() {
  const [locked, setLocked] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [unlocking, setUnlocking] = useState(false);

  /** refs mirror state for event listeners (no stale closures, no re-subscribes) */
  const lockedRef = useRef(false);
  const lastCheckRef = useRef(0);
  const inFlightRef = useRef(false);

  const checkAuth = useCallback(async (force = false) => {
    if (inFlightRef.current) return;
    const now = Date.now();
    if (!force && now - lastCheckRef.current < RECHECK_MIN_INTERVAL_MS) return;
    inFlightRef.current = true;
    lastCheckRef.current = now;
    try {
      const res = await fetch("/api/auth", { cache: "no-store" });
      if (!res.ok) return;
      const status = (await res.json()) as AuthStatus;
      const mustLock = Boolean(status.authRequired) && !status.authenticated;
      lockedRef.current = mustLock;
      setLocked(mustLock);
    } catch {
      /* offline / aborted — keep the current gate state */
    } finally {
      inFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    patchFetchOnce();
    void checkAuth(true);
    const maybeRecheck = () => {
      if (!lockedRef.current) void checkAuth();
    };
    window.addEventListener(AUTH_401_EVENT, maybeRecheck);
    window.addEventListener("focus", maybeRecheck);
    return () => {
      window.removeEventListener(AUTH_401_EVENT, maybeRecheck);
      window.removeEventListener("focus", maybeRecheck);
    };
  }, [checkAuth]);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting || unlocking) return;
    if (!password) {
      setError("Enter your password to unlock.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
        cache: "no-store",
      });
      const data = (await res.json().catch(() => null)) as AuthReply;
      if (res.ok && data?.ok) {
        // success → cookie is set; hard reload so the socket feed + queries
        // reconnect with the fresh session
        setUnlocking(true);
        window.setTimeout(() => window.location.reload(), UNLOCK_RELOAD_DELAY_MS);
        return;
      }
      setError(
        data?.error ??
          (res.status === 429
            ? "Too many attempts — try again in a minute."
            : "Wrong password"),
      );
    } catch {
      setError("Network error — check your connection and try again.");
    }
    setSubmitting(false);
  }

  if (!locked) return null;

  const busy = submitting || unlocking;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="aurum-login-title"
      aria-describedby="aurum-login-subtitle"
      className="animate-in fade-in fixed inset-0 z-[120] flex items-center justify-center overflow-y-auto bg-background/95 p-4 backdrop-blur duration-150"
    >
      <Card className="animate-in fade-in zoom-in-95 w-full max-w-sm border-border bg-card shadow-2xl duration-200">
        <CardHeader className="items-center text-center">
          <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl border border-gold/30 bg-gold/10">
            <LockKeyhole className="h-5 w-5 text-gold" aria-hidden="true" />
          </span>
          <CardTitle
            id="aurum-login-title"
            className="text-base font-black tracking-[0.14em] text-foreground"
          >
            AURUM Terminal
          </CardTitle>
          <CardDescription id="aurum-login-subtitle" className="text-xs">
            This deployment is locked — enter your password
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <label htmlFor="aurum-login-password" className="sr-only">
              Password
            </label>
            <Input
              id="aurum-login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              placeholder="Password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "aurum-login-error" : undefined}
              className="h-10"
            />
            <div aria-live="polite" className="min-h-4 text-center">
              {error && (
                <p id="aurum-login-error" className="text-xs font-medium text-destructive">
                  {error}
                </p>
              )}
            </div>
            <Button type="submit" className="h-10 w-full font-bold" disabled={busy}>
              {busy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  {unlocking ? "Unlocking…" : "Verifying…"}
                </>
              ) : (
                "Unlock"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
