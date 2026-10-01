/**
 * MT5 account credential store (v13 — frontend MT5 setup).
 *
 * The owner connects their Exness account from the app (Settings → MT5
 * Account). The credentials must survive service restarts (24/7 sandbox /
 * Railway volume) so the manager can auto-reconnect without anyone typing
 * them again — but they are REAL broker credentials, so they are NEVER
 * stored in plain text:
 *
 *   · payload  = AES-256-GCM(json{login,password,server,gateways?})
 *   · key      = SHA-256(traderApiKey() + "|aurum-cred-store-v1")
 *   · file     = data/mt5-credentials.json, mode 0600, in the service's
 *                data/ dir (gitignored; on Railway symlinked to /data
 *                by start-railway.sh → persists on the volume)
 *
 * Key rotation note: the key derives from TRADER_API_KEY (itself derived
 * from APP_PASSWORD when set). If the operator changes APP_PASSWORD the
 * stored blob becomes undecryptable — loadCredentials() then returns null
 * and the user simply re-enters the account in Settings. That is the safe
 * failure mode (a wrong-key decrypt throws GCM auth error → treated as
 * "not configured").
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { traderApiKey } from "./auth";

export interface StoredCredentials {
  login: number;
  password: string;
  server: string;
  /** resolved gateway IPs (from search.mtapi.io) — cached so a boot with
   *  no access to the discovery service can still connect */
  gateways?: string[];
}

const FILE = path.join(process.cwd(), "data", "mt5-credentials.json");

function deriveKey(): Buffer {
  return crypto
    .createHash("sha256")
    .update(traderApiKey() + "|aurum-cred-store-v1")
    .digest();
}

/** Load + decrypt the stored account. Returns null when absent, corrupt,
 *  or encrypted under a different key (post-rotation). NEVER throws. */
export function loadCredentials(): StoredCredentials | null {
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const blob = JSON.parse(raw) as {
      v?: number; alg?: string;
      iv?: string; tag?: string; data?: string;
    };
    if (blob?.v !== 1 || blob.alg !== "aes-256-gcm" || !blob.iv || !blob.tag || !blob.data) {
      return null;
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(), Buffer.from(blob.iv, "base64"));
    decipher.setAuthTag(Buffer.from(blob.tag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(blob.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
    const creds = JSON.parse(plain) as StoredCredentials;
    if (
      typeof creds?.login !== "number" || !Number.isFinite(creds.login) ||
      typeof creds?.password !== "string" || !creds.password ||
      typeof creds?.server !== "string" || !creds.server
    ) {
      return null;
    }
    return creds;
  } catch {
    // missing file, corrupt json, or GCM auth failure (rotated key)
    return null;
  }
}

/** Encrypt + persist. Best-effort: on a read-only fs returns false (the
 *  session still works, it just won't survive a restart). */
export function saveCredentials(creds: StoredCredentials): boolean {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(), iv);
    const data = Buffer.concat([
      cipher.update(JSON.stringify(creds), "utf8"),
      cipher.final(),
    ]);
    const blob = {
      v: 1,
      alg: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(FILE, JSON.stringify(blob), { mode: 0o600 });
    return true;
  } catch (e) {
    console.error("[credentials] save failed (non-fatal):", (e as Error).message);
    return false;
  }
}

/** Wipe the stored account (Settings → "Forget credentials"). */
export function clearCredentials(): boolean {
  try {
    fs.rmSync(FILE, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Masked login for status displays — first 2 + last 2 digits max. */
export function maskLogin(login: number | null | undefined): string | null {
  if (!login || !Number.isFinite(login)) return null;
  const s = String(Math.trunc(login));
  if (s.length <= 4) return `${s.slice(0, 1)}***`;
  return `${s.slice(0, 2)}${"*".repeat(Math.max(3, s.length - 4))}${s.slice(-2)}`;
}
