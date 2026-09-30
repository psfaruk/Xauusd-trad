import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/** User drawings CRUD — persisted per symbol + timeframe. */

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbol = url.searchParams.get("symbol") ?? "";
  const timeframe = url.searchParams.get("tf") ?? "";
  if (!symbol || !timeframe) {
    return NextResponse.json({ error: "symbol and tf required" }, { status: 400 });
  }
  const rows = await db.drawing.findMany({
    where: { symbol, timeframe },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({
    drawings: rows.map((r) => ({
      id: r.id,
      symbol: r.symbol,
      timeframe: r.timeframe,
      kind: r.kind,
      points: JSON.parse(r.points),
      style: JSON.parse(r.style || "{}"),
      createdAt: r.createdAt.toISOString(),
    })),
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body?.symbol || !body?.timeframe || !body?.kind || !Array.isArray(body?.points)) {
    return NextResponse.json({ error: "invalid drawing" }, { status: 400 });
  }
  const row = await db.drawing.create({
    data: {
      symbol: String(body.symbol),
      timeframe: String(body.timeframe),
      kind: String(body.kind),
      points: JSON.stringify(body.points),
      style: JSON.stringify(body.style ?? {}),
    },
  });
  return NextResponse.json({
    drawing: {
      id: row.id,
      symbol: row.symbol,
      timeframe: row.timeframe,
      kind: row.kind,
      points: JSON.parse(row.points),
      style: JSON.parse(row.style || "{}"),
      createdAt: row.createdAt.toISOString(),
    },
  });
}

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body?.id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  const data: Record<string, string> = {};
  if (Array.isArray(body.points)) data.points = JSON.stringify(body.points);
  if (body.style) data.style = JSON.stringify(body.style);
  const row = await db.drawing.update({
    where: { id: String(body.id) },
    data,
  });
  return NextResponse.json({ ok: true, id: row.id });
}

export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  const symbol = url.searchParams.get("symbol");
  const timeframe = url.searchParams.get("tf");
  if (id) {
    await db.drawing.delete({ where: { id } }).catch(() => {});
    return NextResponse.json({ ok: true });
  }
  if (symbol && timeframe) {
    await db.drawing.deleteMany({ where: { symbol, timeframe } });
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "id or symbol+tf required" }, { status: 400 });
}
