// Measures Gemini response speed the way Glass uses it (streaming).
// Usage (in the Econ-Bull-Prep folder):  GEMINI_API_KEY=your_key node latency-test.mjs
const key = process.env.GEMINI_API_KEY;
if (!key) { console.error("Set GEMINI_API_KEY first."); process.exit(1); }

const models = ["gemini-3.5-flash-lite", "gemini-3.8-flash"];
const prompt = "In an economics interview: explain the difference between a bull and bear market in two sentences.";

for (const model of models) {
  const times = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );
    if (!res.ok) { console.log(model, "error", res.status, await res.text()); break; }
    const reader = res.body.getReader();
    let first = null;
    while (true) {
      const { done } = await reader.read();
      if (first === null) first = performance.now() - t0;
      if (done) break;
    }
    times.push([first, performance.now() - t0]);
  }
  if (times.length) {
    const avg = (k) => Math.round(times.reduce((s, t) => s + t[k], 0) / times.length);
    console.log(`${model}: first words ~${avg(0)} ms, full answer ~${avg(1)} ms (avg of ${times.length})`);
  }
}
