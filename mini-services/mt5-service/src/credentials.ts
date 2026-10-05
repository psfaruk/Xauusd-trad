/**
 * MT5 account credential store (v13 — frontend MT5 setup; hardened in the
 * audit P2 pass: encryption-key lifecycle).
 *
 * The owner connects their Exness account from the app (Settings → MT5
 * Account). The credentials must survive service restarts (24/7 sandbox /
 * Railway volume) so the manager can auto-reconnect without anyone typing
 * them again — but they are REAL broker credentials, so they are NEVER
 * stored in plain text:
 *
 *   · payload  = AES-256-GCM(json{login,password,server,gateways?})
 *   · envelope = {v:1, kv:<keyVersion>, alg, iv, tag, data, savedAt}
 *                — `v` stays 1 (envelope-shape compatibility); `kv` tracks
 *                the KEY version that encrypted the blob
 *   · file     = data/mt5-credentials.json, mode 0600, in the service's
 *                data/ dir (gitignored; on Railway symlinked to /data
 *                by start-railway.sh → persists on the volume)
 *
 * Key lifecycle (audit P2):
 *   · key sources, in precedence order:
 *       1. MT5_CRED_KEY env — a per-deployment encryption key (any string
 *          ≥ 16 chars; SHA-256'd before use as the AES key). On a real
 *          deployment (Railway/K8s) this MUST come from the platform's
 *          secret manager (Railway service variable / K8s Secret) — never
 *          from the repo, a committed file, or a log.
 *       2. fallback: derived from traderApiKey() (the historical scheme).
 *   · key versions (`kv` in the blob, CRED_KEY_VERSION = current):
 *       1 = legacy   key = SHA-256(traderApiKey() + "|aurum-cred-store-v1")
 *           (read-only compatibility — old blobs only, always the legacy
 *            derivation regardless of MT5_CRED_KEY)
 *       2 = current  key = SHA-256(<source material> +
 *           "|aurum-cred-store-v2|" + <"env" | "derived">)
 *     New saves always write the current version; loadCredentials()
 *     transparently re-saves older blobs in place the moment they decrypt.
 *   · rotation: changing MT5_CRED_KEY (or APP_PASSWORD/TRADER_API_KEY when
 *     deriving) invalidates stored blobs. Safe failure by design: a wrong
 *     key makes the GCM decrypt throw → loadCredentials() returns null →
 *     the user simply re-enters the account in Settings. No plaintext ever
 *     hits the disk, so a rotation can never corrupt into a leak.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { traderApiKey, authConfigured } from "./auth";

export interface StoredCredentials {
  login: number;
  password: string;
  server: string;
  /** resolved gateway IPs (from search.mtapi.io) — cached so a boot with
   *  no access to the discovery service can still connect */
  gateways?: string[];
}

/** Current key version — new saves use it, loads upgrade to it. */
const CRED_KEY_VERSION = 2;

/** Legacy (kv 1) domain separator — READ path only. */
const SEP_V1 = "|aurum-cred-store-v1";
/** Current (kv 2) domain separator (suffixed with the key-source label). */
const SEP_V2 = "|aurum-cred-store-v2";

const FILE = path.join(process.cwd(), "data", "mt5-credentials.json");

/** The configured per-deployment key (MT5_CRED_KEY), or null when unset or
 *  too short (< 16 chars — ignored with a one-time warning; a weak key must
 *  never silently become the encryption key). */
function envKey(): string | null {
  const k = process.env.MT5_CRED_KEY;
  if (!k) return null;
  if (k.length >= 16) return k;
  warnShortKey();
  return null;
}

let warnedShortKey = false;
function warnShortKey(): void {
  if (warnedShortKey) return;
  warnedShortKey = true;
  console.error(
    "[credentials] MT5_CRED_KEY is set but shorter than 16 chars — ignoring it and deriving the key from the trader key instead",
  );
}

function sha256(input: string): Buffer {
  return crypto.createHash("sha256").update(input).digest();
}

/** Derive the AES-256 key for a blob's key version.
 *  · kv 1 (legacy): ALWAYS the traderApiKey derivation with the v1
 *    separator — old blobs predate MT5_CRED_KEY.
 *  · kv ≥ 2: MT5_CRED_KEY (label "env") when configured, else
 *    traderApiKey() (label "derived"), with the versioned separator. */
function deriveKey(kv: number): Buffer {
  if (kv <= 1) return sha256(traderApiKey() + SEP_V1);
  const ek = envKey();
  if (ek !== null) return sha256(ek + SEP_V2 + "|env");
  return sha256(traderApiKey() + SEP_V2 + "|derived");
}

interface BlobMeta {
  creds: StoredCredentials;
  /** key version the blob was encrypted with */
  kv: number;
  savedAt: string | null;
}

/** Read + decrypt + validate the stored blob. Returns null when absent,
 *  corrupt, or encrypted under a different key (post-rotation). NEVER
 *  throws. Pure — no re-save side effects. */
function readBlob(): BlobMeta | null {
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const blob = JSON.parse(raw) as {
      v?: number; kv?: number; alg?: string;
      iv?: string; tag?: string; data?: string; savedAt?: string;
    };
    if (blob?.v !== 1 || blob.alg !== "aes-256-gcm" || !blob.iv || !blob.tag || !blob.data) {
      return null;
    }
    const kv = typeof blob.kv === "number" && blob.kv >= 1 ? Math.floor(blob.kv) : 1;
    const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(kv), Buffer.from(blob.iv, "base64"));
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
    return {
      creds,
      kv,
      savedAt: typeof blob.savedAt === "string" ? blob.savedAt : null,
    };
  } catch {
    // missing file, corrupt json, or GCM auth failure (rotated key)
    return null;
  }
}

/** Load + decrypt the stored account. Returns null when absent, corrupt,
 *  or encrypted under a different key (post-rotation). NEVER throws.
 *  A blob from an older key version is transparently re-saved under the
 *  current one the moment it decrypts (in-place upgrade). */
export function loadCredentials(): StoredCredentials | null {
  const m = readBlob();
  if (!m) return null;
  if (m.kv < CRED_KEY_VERSION) saveCredentials(m.creds); // best-effort upgrade
  return m.creds;
}

/** Encrypt + persist. Best-effort: on a read-only fs returns false (the
 *  session still works, it just won't survive a restart). Always writes
 *  the CURRENT key version into `kv` (envelope `v` stays 1). */
export function saveCredentials(creds: StoredCredentials): boolean {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(CRED_KEY_VERSION), iv);
    const data = Buffer.concat([
      cipher.update(JSON.stringify(creds), "utf8"),
      cipher.final(),
    ]);
    const blob = {
      v: 1,                 // envelope shape (unchanged, for compatibility)
      kv: CRED_KEY_VERSION, // key version that encrypted this blob
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

export interface CredentialsStatus {
  /** true when a stored blob exists AND decrypts under the current key */
  configured: boolean;
  /** key version the store currently reads/writes (CRED_KEY_VERSION) */
  keyVersion: number;
  /** where the key material comes from: MT5_CRED_KEY ("env"), a real
   *  trader key ("derived"), or the hard-coded dev key ("dev" — local /
   *  sandbox only, a public deploy must never sit here) */
  keySource: "env" | "derived" | "dev";
  savedAt: string | null;
  loginMasked: string | null;
}

/** Masked diagnostics for /health — ZERO secrets: no passwords, no key
 *  material, no full logins (maskLogin only). Read-only by design: a
 *  health probe must never mutate the credential store. */
export function credentialsStatus(): CredentialsStatus {
  const m = readBlob();
  const keySource: CredentialsStatus["keySource"] =
    envKey() !== null ? "env" : authConfigured() ? "derived" : "dev";
  return {
    configured: m !== null,
    keyVersion: CRED_KEY_VERSION,
    keySource,
    savedAt: m?.savedAt ?? null,
    loginMasked: maskLogin(m?.creds.login),
  };
}
