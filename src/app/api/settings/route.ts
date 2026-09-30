import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/** Generic app settings (locale, theme…). */

export async function GET() {
  const rows = await db.appSetting.findMany();
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return NextResponse.json(out);
}

export async function PUT(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body?.key || typeof body.value !== "string") {
    return NextResponse.json({ error: "key + value required" }, { status: 400 });
  }
  await db.appSetting.upsert({
    where: { key: String(body.key) },
    create: { key: String(body.key), value: String(body.value) },
    update: { value: String(body.value) },
  });
  return NextResponse.json({ ok: true });
}
