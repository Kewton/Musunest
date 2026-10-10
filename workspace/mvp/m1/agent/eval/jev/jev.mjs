// 最小の JEV クライアント。鍵は環境変数 JEV_API_KEY だけから読む
export async function ask(state, questions, model = "jev-1.13.0") {
  for (let i = 0; i < 5; i++) {
    const r = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.JEV_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ state, model, questions }),
    });
    if (r.status === 429 || r.status === 529) { await new Promise((s) => setTimeout(s, 1000 * 2 ** i)); continue; }
    const j = await r.json();
    if (!r.ok) throw new Error(r.status + " " + JSON.stringify(j).slice(0, 400));
    return j;
  }
  throw new Error("retries exhausted");
}
