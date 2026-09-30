import { Mt5WsClient } from "../src/mt5-client";
const LOGIN = Number(process.env.MT5_LOGIN);
const PASSWORD = process.env.MT5_PASSWORD ?? "";
if (!LOGIN || !PASSWORD) {
  console.error("\u2717 set MT5_LOGIN + MT5_PASSWORD env vars first (broker credentials are never hard-coded)");
  process.exit(1);
}
const GATEWAYS = ["47.130.41.116","57.182.183.85","16.79.3.122","18.61.99.175","8.219.172.6","47.236.224.248","47.81.62.132","43.210.112.100","35.154.31.85"];
async function main() {
  let c: Mt5WsClient | null = null;
  for (const gw of GATEWAYS) { try { c = await Mt5WsClient.connect(gw); await c.auth(); await c.login(LOGIN, PASSWORD); break; } catch {} }
  if (!c) { console.log("no conn"); process.exit(1); }
  for (let i = 0; i < 3; i++) {
    const { positions } = await c.positions();
    console.log(`list#${i}: ${positions.length} positions —`, positions.map(p => `${p.symbol}#${p.id}(${p.side},${p.lots})`).join(" "));
    await new Promise(r => setTimeout(r, 1500));
  }
  const { positions } = await c.positions();
  const target = positions.find(p => p.id === 5179749053);
  console.log("5179749053 in live list:", !!target, target ?? "");
  if (positions.length) {
    const earliest = positions.reduce((a,p)=>Math.min(a,p.openTime), Infinity);
    const deals = await c.deals(Math.floor(earliest/1000)-30, 0);
    for (const p of positions) {
      const outs = deals.filter(d => d.positionId === p.id && d.entry === "out");
      const ins = deals.filter(d => d.positionId === p.id && d.entry === "in");
      console.log(`  ${p.symbol}#${p.id}: in-deals=${ins.length} out-deals=${outs.length} (outVol=${outs.reduce((a,d)=>a+d.volume,0)} vs lots=${p.lots})`);
    }
  }
  c.close(); process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
