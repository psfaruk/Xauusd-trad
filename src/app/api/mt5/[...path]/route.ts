import { NextResponse } from "next/server";
import { traderApiKey } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * v12.1 — same-origin REST proxy to the mt5-service.
 *
 * WHY THIS EXISTS: the browser used to call the microservice directly via
 * `/api/candles?…&XTransformPort=3031`, relying on the gateway to forward.
 * That works on Railway (Caddy whitelist) — but the sandbox preview edge
 * routes every `/api/*` to the Next.js app, so the chart's history
 * bootstrap 404'd in EVERY real preview session (see dev.log — candles
 * never returned 200 once). A same-origin proxy works through ANY edge:
 *
 *   browser → /api/mt5/candles?…  (this route, session-gated by middleware)
 *           → 127.0.0.1:3031/api/candles  (+ x-trader-key attached)
 *
 * Security properties:
 *   · PATH WHITELIST — only the endpoints the UI legitimately needs; this
 *     can never become an open proxy into the service.
 *   · The trader key is attached SERVER-SIDE — the browser never sees it.
 *   · When APP_PASSWORD is set, src/middleware.ts already required a valid
 *     session before this handler even runs (the audit's Critical #1).
 *   · The session cookie is forwarded too — mt5-service re-validates it,
 *     so both doors check every call.
 */

const MT5_URL = process.env.MT5_SERVICE_URL ?? "http://127.0.0.1:3031";

/** First path segments the browser may reach on the mt5-service. */
const ALLOWED = new Set([
  "candles", // chart history bootstrap
  "quote", // live quote snapshot
  "symbols", // symbol list / digits / spread
  "ticks", // tick history (delta strips)
  "flow", // order-flow read
  "ai-chart", // what the AI brain "sees" (auto drawings)
  "status", // connection/broker status
  "history", // deal history
  "trader", // trading brain state + actions (GET/POST sub-paths)
]);

async function proxy(req: Request, method: "GET" | "POST"): Promise<Response> {
  const url = new URL(req.url);
  // Next.js catch-all params are in the URL path — /api/mt5/<seg>/<sub…>
  const rest = url.pathname.replace(/^\/api\/mt5\/?/, "");
  const segs = rest.split("/").filter(Boolean);
  if (!segs.length || !ALLOWED.has(segs[0])) {
    return NextResponse.json(
      { error: `mt5-service endpoint not allowed: /${segs.join("/")}` },
      { status: 403 },
    );
  }
  const target = `${MT5_URL}/api/${segs.map(encodeURIComponent).join("/")}${url.search}`;

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Cache-Control": "no-store",
  };
  // forward the browser's session cookie (mt5-service re-validates it)
  const cookie = req.headers.get("cookie");
  if (cookie) headers.Cookie = cookie;
  // server-to-server trader key (never exposed to the browser)
  const key = traderApiKey();
  if (key) headers["x-trader-key"] = key;

  let body: string | undefined;
  if (method === "POST") {
    body = await req.text();
    const ct = req.headers.get("content-type");
    if (ct) headers["Content-Type"] = ct;
  }

  try {
    const res = await fetch(target, {
      method,
      headers,
      ...(body != null ? { body } : {}),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: {
        "Content-Type": res.headers.get("content-type") ?? "application/json",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "mt5-service unreachable";
    return NextResponse.json({ error: `mt5-service: ${msg}` }, { status: 502 });
  }
}

export async function GET(req: Request) {
  return proxy(req, "GET");
}

export async function POST(req: Request) {
  return proxy(req, "POST");
}
