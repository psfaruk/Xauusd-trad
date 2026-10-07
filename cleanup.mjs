// clean test threads via the API
for (const th of ["TEST-PROBE", "TEST-VISION", "TEST-STRESS"]) {
  const r = await fetch(`http://localhost:3000/api/ai/chat?thread=${th}`, { method: "DELETE" });
  console.log(th, "→", r.status);
}
