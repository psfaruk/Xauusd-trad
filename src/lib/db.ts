import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // audit P3.1: query logging is a dev affordance — in production it
    // dumped every poll's SignalRecord write into the logs and added I/O
    // on the hot path. Errors and warnings stay on in every environment.
    log:
      process.env.NODE_ENV === 'development'
        ? ['query', 'error', 'warn']
        : ['error', 'warn'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

// ─────────────────────────────────────────────────────────────────────
// SQLite hardening (audit P3.1) — one-time PRAGMA bootstrap.
//
// The analysis route writes SignalRecords on every poll while other
// requests hold read transactions — under the default rollback journal
// that surfaces as SQLITE_BUSY concurrent-writer errors. Mitigation:
//   · journal_mode=WAL   — readers never block the writer (and vice
//     versa). Persists IN the db file: applied once, it sticks for
//     every future connection.
//   · busy_timeout=5000  — a second writer WAITS up to 5s instead of
//     failing instantly. Per-connection, so best effort with Prisma's
//     pool; DATABASE_URL carries ?connection_limit=1 to keep the pool
//     at a single connection (which also serializes writers).
//   · synchronous=NORMAL — the recommended WAL companion: durable
//     enough for this app, far less fsync churn than FULL.
//
// Idempotent: guarded by a module-level promise, so instrumentation
// (boot) and the first API request share ONE bootstrap run. Each
// statement sits in its own try/catch and only WARNS on failure — a
// PRAGMA must never take the app down (e.g. DATABASE_URL switched to
// Postgres one day: these would be syntax errors there, not crashes).
// ─────────────────────────────────────────────────────────────────────

let sqlitePragmaBootstrap: Promise<void> | null = null

export function ensureSqlitePragmas(): Promise<void> {
  if (!sqlitePragmaBootstrap) {
    sqlitePragmaBootstrap = (async () => {
      // NOTE: $queryRawUnsafe, NOT $executeRawUnsafe — journal_mode and
      // busy_timeout RETURN a result row, and Prisma 6.x rejects
      // result-returning statements from $executeRawUnsafe ("Execute
      // returned results, which is not allowed in SQLite"). Verified
      // against this exact Prisma version: all three statements apply
      // cleanly through $queryRawUnsafe.
      const pragmas: Array<[stmt: string, label: string]> = [
        ['PRAGMA journal_mode=WAL;', 'WAL journal mode'],
        ['PRAGMA busy_timeout=5000;', 'busy_timeout=5000'],
        ['PRAGMA synchronous=NORMAL;', 'synchronous=NORMAL'],
      ]
      for (const [stmt, label] of pragmas) {
        try {
          await db.$queryRawUnsafe(stmt)
        } catch (e) {
          console.warn(
            `[db] SQLite pragma not applied (${label}): ${
              (e as Error).message?.split('\n')[0] ?? e
            }`,
          )
        }
      }
    })()
  }
  return sqlitePragmaBootstrap
}
