"use client";

/** SettingsPanel — MT5 account, appearance, language, data diagnostics, about.
 *
 *  v13: the simulator is gone. When MT5 is not connected the whole app runs
 *  offline — the FIRST card here is where the user connects their Exness MT5
 *  account (login / password / server), disconnects it, or forgets the saved
 *  credentials. Everything else is the original Binance-style settings:
 *  full-width rows with label + current value, text-[11px] scale.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { feed, refreshFeedStatus, restUrl, useStatus, useSymbolList } from "@/hooks/useFeed";
import { toast } from "@/hooks/use-toast";
import { useI18n, type Locale } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sun, Moon, MonitorSmartphone, Languages, Database, Info, RefreshCw, LogOut, Loader2,
  Cable, ShieldCheck, ShieldAlert, Unlink, Trash2, AlertTriangle,
} from "lucide-react";

const THEMES = [
  { value: "dark", icon: Moon, key: "themeDark" },
  { value: "light", icon: Sun, key: "themeLight" },
  { value: "system", icon: MonitorSmartphone, key: "themeSystem" },
] as const;

/** Exness MT5 server suggestions for the connect form's datalist. */
const MT5_SERVERS = [
  "Exness-MT5Trial6",
  "Exness-MT5Trial",
  "Exness-MT5Trial2",
  "Exness-MT5Trial3",
  "Exness-MT5Trial5",
  "Exness-MT5Trial7",
  "Exness-MT5Trial8",
  "Exness-MT5Trial15",
  "Exness-MT5Real",
  "Exness-MT5Real2",
  "Exness-MT5Real3",
  "Exness-MT5Real4",
  "Exness-MT5Real5",
  "Exness-MT5Real6",
  "Exness-MT5Real7",
  "Exness-MT5Real8",
  "Exness-MT5Real9",
  "Exness-MT5Real10",
  "Exness-MT5Real11",
  "Exness-MT5Real12",
  "Exness-MT5Real13",
  "Exness-MT5Real14",
  "Exness-MT5Real17",
  "Exness-MT5Real21",
];

/** GET /api/mt5/mt5-account — the fixed backend contract. */
interface Mt5AccountInfo {
  configured: boolean;
  connected: boolean;
  source: string;
  server: string;
  loginMasked: string | null;
  account: { login: number; balance: number; equity: number; currency: string } | null;
  reason: string;
}

export function SettingsPanel() {
  const { theme, setTheme } = useTheme();
  const { locale, setLocale, t } = useI18n();
  const status = useStatus();
  const symbols = useSymbolList();

  /** session state — the logout row only exists when the deployment is locked */
  const [authLocked, setAuthLocked] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  // ── MT5 account card state ──
  const [mt5, setMt5] = useState<Mt5AccountInfo | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [acting, setActing] = useState<"disconnect" | "forget" | null>(null);
  const [mt5Error, setMt5Error] = useState<string | null>(null);
  const [loginField, setLoginField] = useState("");
  const [password, setPassword] = useState("");
  const [server, setServer] = useState("Exness-MT5Trial6");
  const [forgetArmed, setForgetArmed] = useState(false);
  const serverTouched = useRef(false);
  const forgetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadMt5 = useCallback(async () => {
    try {
      const r = await fetch(restUrl("/api/mt5-account"), { cache: "no-store" });
      if (!r.ok) return;
      const d = (await r.json()) as Mt5AccountInfo;
      setMt5(d);
      // prefill the server field with the known/saved server until the user edits it
      if (!serverTouched.current && d.server) setServer(d.server);
    } catch {
      /* stay on the form — the header chip still tells the live truth */
    }
  }, []);

  useEffect(() => {
    void loadMt5();
  }, [loadMt5]);

  // release the 2-step forget confirm timer on unmount
  useEffect(() => () => {
    if (forgetTimer.current) clearTimeout(forgetTimer.current);
  }, []);

  async function handleConnect() {
    if (connecting || acting) return;
    setMt5Error(null);
    setConnecting(true);
    try {
      const r = await feed.postTrader("/api/mt5-connect", {
        login: loginField.trim(),
        password,
        server: server.trim(),
      });
      if (r && r.ok === false) {
        setMt5Error(String(r.error ?? "Connection failed"));
      } else if (r?.ok) {
        toast({
          title: `✅ ${t("mt5ConnectOk")}`,
          description: String(r.server ?? server.trim()),
        });
        setPassword(""); // the password is never kept around after a successful connect
        await loadMt5();
        refreshFeedStatus();
      } else {
        setMt5Error(String(r?.error ?? "Unexpected response"));
      }
    } catch (e) {
      setMt5Error(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect(forget: boolean) {
    if (connecting || acting) return;
    setMt5Error(null);
    setActing(forget ? "forget" : "disconnect");
    try {
      const r = await feed.postTrader("/api/mt5-disconnect", { forget });
      if (r && r.ok === false) {
        setMt5Error(String(r.error ?? "Failed"));
      } else {
        toast({ title: `✅ ${forget ? t("mt5ForgotOk") : t("mt5DisconnectedOk")}` });
        await loadMt5();
        refreshFeedStatus();
      }
    } catch (e) {
      setMt5Error(e instanceof Error ? e.message : String(e));
    } finally {
      setActing(null);
    }
  }

  /** two-step confirm: first tap arms the button for 4s, second tap executes */
  function handleForgetTap() {
    if (connecting || acting) return;
    if (!forgetArmed) {
      setForgetArmed(true);
      if (forgetTimer.current) clearTimeout(forgetTimer.current);
      forgetTimer.current = setTimeout(() => setForgetArmed(false), 4000);
      return;
    }
    if (forgetTimer.current) clearTimeout(forgetTimer.current);
    setForgetArmed(false);
    void handleDisconnect(true);
  }

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { authRequired?: boolean } | null) => {
        if (!cancelled && d) setAuthLocked(Boolean(d.authRequired));
      })
      .catch(() => {
        /* open deployments stay buttonless — nothing to log out of */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await fetch("/api/auth", { method: "DELETE", cache: "no-store" });
    } catch {
      /* best effort — reload anyway */
    }
    window.location.reload(); // re-mounts the shell + LoginGate in locked mode
  }

  // ── MT5 card derived state ──
  // The account payload is the primary source of truth; while it loads (or if
  // it ever fails to answer) the live feed status is the fallback — this card
  // must never contradict the connection badges in the rest of the app.
  const mt5Connected = mt5?.connected ?? (status?.connected ?? false);
  const mt5Pending = connecting || (!mt5 && !mt5Connected && status?.source !== "disconnected");
  const mt5ChipLabel = mt5Connected ? t("live") : mt5Pending ? t("mt5Connecting") : t("mt5Offline");
  const mt5ChipCls = mt5Connected
    ? "border-up/40 bg-up/10 text-up"
    : mt5Pending
      ? "border-amber-500/40 bg-amber-500/10 text-amber-500"
      : "border-red-500/40 bg-red-500/10 text-red-500";
  const cardAccount = mt5?.account ?? (mt5 == null ? status?.account ?? null : null);
  const formReady = loginField.trim() !== "" && password !== "" && server.trim() !== "";

  return (
    <div className="slim-scroll h-full overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
        {/* ── MT5 account ── */}
        <Card className="border-border bg-card">
          <CardHeader className="flex flex-row items-center justify-between border-b border-border py-3">
            <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider">
              <Cable className="h-3.5 w-3.5 text-primary" />
              {t("mt5Account")}
            </CardTitle>
            <span
              title={mt5?.reason}
              className={cn(
                "flex items-center gap-1.5 rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold tracking-wider",
                mt5ChipCls,
              )}
            >
              {mt5Connected ? (
                <ShieldCheck className="h-3 w-3" />
              ) : mt5Pending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <ShieldAlert className="h-3 w-3" />
              )}
              {mt5ChipLabel}
            </span>
          </CardHeader>

          {mt5Connected ? (
            /* ── connected: live account rows + disconnect / forget ── */
            <CardContent className="py-1">
              {[
                [t("server"), mt5?.server || status?.server || "—"],
                [t("balance"), cardAccount ? `${cardAccount.balance.toFixed(2)} ${cardAccount.currency}` : "—"],
                [t("equity"), cardAccount ? cardAccount.equity.toFixed(2) : "—"],
                [t("accountLogin"), mt5?.loginMasked ?? (mt5?.account ? String(mt5.account.login) : "—")],
              ].map(([k, v], i, arr) => (
                <div
                  key={k}
                  className={cn(
                    "flex items-center justify-between py-2 text-[11px]",
                    i < arr.length - 1 && "border-b border-border/60",
                  )}
                >
                  <span className="text-muted-foreground">{k}</span>
                  <span className="tnum font-mono font-semibold text-foreground">{v}</span>
                </div>
              ))}
              {/* v14 AES key-rotation warning — the saved MT5 password is
                  encrypted with a key derived from APP_PASSWORD; rotating it
                  on the host makes the stored credential undecryptable */}
              <div className="flex items-start gap-1.5 border-b border-border/60 py-2 text-[10px] leading-snug text-muted-foreground">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-gold/80" aria-hidden="true" />
                <span>{t("mt5PasswordRotationNote")}</span>
              </div>
              <div className="flex flex-col gap-2 py-3 sm:flex-row">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 flex-1 gap-1.5 text-[11px] font-semibold"
                  onClick={() => void handleDisconnect(false)}
                  disabled={acting !== null || connecting}
                >
                  {acting === "disconnect" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Unlink className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {t("mt5Disconnect")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={cn(
                    "h-8 flex-1 gap-1.5 text-[11px] font-semibold border-red-500/40 text-red-500 hover:bg-red-500/10 hover:text-red-500",
                    forgetArmed && "border-red-500/70 bg-red-500/15",
                  )}
                  onClick={handleForgetTap}
                  disabled={acting !== null || connecting}
                >
                  {acting === "forget" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {forgetArmed ? t("mt5ForgetConfirm") : t("mt5Forget")}
                </Button>
              </div>
            </CardContent>
          ) : (
            /* ── not connected: connect form ── */
            <CardContent className="flex flex-col gap-3 py-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="mt5-login" className="text-[11px] text-muted-foreground">
                    {t("mt5LoginLabel")}
                  </Label>
                  <Input
                    id="mt5-login"
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="12345678"
                    className="h-9 text-xs"
                    value={loginField}
                    onChange={(e) => setLoginField(e.target.value)}
                    disabled={connecting}
                    aria-invalid={!!mt5Error}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="mt5-password" className="text-[11px] text-muted-foreground">
                    {t("mt5PasswordLabel")}
                  </Label>
                  <Input
                    id="mt5-password"
                    type="password"
                    autoComplete="new-password"
                    className="h-9 text-xs"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={connecting}
                    aria-invalid={!!mt5Error}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mt5-server" className="text-[11px] text-muted-foreground">
                  {t("mt5ServerLabel")}
                </Label>
                <Input
                  id="mt5-server"
                  type="text"
                  list="mt5-server-list"
                  className="h-9 text-xs"
                  value={server}
                  onChange={(e) => {
                    serverTouched.current = true;
                    setServer(e.target.value);
                  }}
                  disabled={connecting}
                />
                <datalist id="mt5-server-list">
                  {MT5_SERVERS.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              </div>
              <p className="text-[10px] leading-relaxed text-muted-foreground">{t("mt5AccountNote")}</p>
              {mt5Error && (
                <p className="text-[11px] font-medium text-red-500" role="alert">
                  {mt5Error}
                </p>
              )}
              <Button
                type="button"
                className="h-9 w-full gap-2 text-[11px] font-bold uppercase tracking-wider"
                onClick={() => void handleConnect()}
                disabled={connecting || !formReady}
              >
                {connecting ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                    {t("mt5Connecting")}
                  </>
                ) : (
                  t("mt5Connect")
                )}
              </Button>
            </CardContent>
          )}
        </Card>

        {/* ── appearance ── */}
        <Card className="border-border bg-card">
          <CardHeader className="border-b border-border py-3">
            <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider">
              <Sun className="h-3.5 w-3.5 text-primary" />
              {t("appearance")}
            </CardTitle>
          </CardHeader>
          <CardContent className="py-3">
            <div className="mb-2 text-[11px] text-muted-foreground">{t("themeMode")}</div>
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label={t("themeMode")}>
              {THEMES.map(({ value, icon: Icon, key }) => {
                const active = theme === value;
                return (
                  <button
                    key={value}
                    role="radio"
                    aria-checked={active}
                    onClick={() => setTheme(value)}
                    className={cn(
                      "flex flex-col items-center gap-1.5 rounded-lg border p-3 text-[11px] font-semibold transition-colors",
                      active
                        ? "border-primary bg-primary/15 text-primary"
                        : "border-border bg-background text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {t(key)}
                  </button>
                );
              })}
            </div>

            <div className="mb-2 mt-4 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Languages className="h-3.5 w-3.5" />
              {t("language")}
            </div>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t("language")}>
              {([["en", "English"], ["bn", "বাংলা"]] as [Locale, string][]).map(([v, label]) => {
                const active = locale === v;
                return (
                  <button
                    key={v}
                    role="radio"
                    aria-checked={active}
                    onClick={() => setLocale(v)}
                    className={cn(
                      "rounded-lg border p-2.5 text-[11px] font-semibold transition-colors",
                      active
                        ? "border-primary bg-primary/15 text-primary"
                        : "border-border bg-background text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </CardContent>
        </Card>

        {/* ── data & connection ── */}
        <Card className="border-border bg-card">
          <CardHeader className="border-b border-border py-3">
            <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider">
              <Database className="h-3.5 w-3.5 text-primary" />
              {t("dataConnection")}
            </CardTitle>
          </CardHeader>
          <CardContent className="py-1">
            {[
              [t("dataSource"), status?.source === "mt5" ? "MetaTrader 5 (direct WS)" : status?.source === "disconnected" ? t("mt5Offline") : "—"],
              [t("server"), status?.server ?? "Exness-MT5Trial6"],
              [t("connection"), status?.connected ? t("live") : status?.source === "disconnected" ? t("mt5Offline") : t("connecting")],
              [t("latency"), status?.latencyMs != null ? `${status.latencyMs} ms` : "—"],
              [t("symbolsWatched"), String(symbols.length || "—")],
              [t("serverTime"), status ? `${new Date(status.serverTime * 1000).toISOString().slice(11, 19)} UTC` : "—"],
            ].map(([k, v], i, arr) => (
              <div
                key={k as string}
                className={cn(
                  "flex items-center justify-between py-2 text-[11px]",
                  i < arr.length - 1 && "border-b border-border/60",
                )}
              >
                <span className="text-muted-foreground">{k}</span>
                <span className="tnum font-mono font-semibold text-foreground">{v}</span>
              </div>
            ))}
            <div className="flex items-center gap-2 py-2 text-[10px] text-muted-foreground">
              <RefreshCw className="h-3 w-3" />
              {t("liveSocketNote")}
            </div>
          </CardContent>
        </Card>

        {/* ── about ── */}
        <Card className="border-border bg-card">
          <CardHeader className="border-b border-border py-3">
            <CardTitle className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider">
              <Info className="h-3.5 w-3.5 text-primary" />
              {t("about")}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1.5 py-3 text-[11px] text-muted-foreground">
            <div className="flex items-center justify-between">
              <span>AURUM Terminal</span>
              <span className="font-mono text-foreground">v2.0 · Binance edition</span>
            </div>
            <div className="flex items-center justify-between">
              <span>{t("brainModel")}</span>
              <span className="font-mono text-foreground">GLM (LLM judge)</span>
            </div>
            <div>{t("aboutNote")}</div>

            {authLocked && (
              <div className="mt-2 flex flex-col gap-1.5 border-t border-border/60 pt-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 w-full gap-2 text-[11px] font-semibold text-muted-foreground hover:text-foreground"
                  onClick={handleLogout}
                  disabled={loggingOut}
                >
                  {loggingOut ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {loggingOut ? "Locking…" : "Lock / Log out"}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
