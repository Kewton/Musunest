// #168 第 2 段の採点の叩き台。識別子に依存しない：役割（「持ち物」「メンバー」…）を構造と選択肢の表示名から見つけ、
// 振る舞いは spec-engine の評価（evaluateRecord・allowsAction・holdsExpression）で確かめる。
// 使い方: node rubric.mjs <spec-engine の dist/index.js> <A|B> <app.spec.yaml>...
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const [, , enginePath, subject, ...files] = process.argv;
const engine = await import(enginePath);
const clock = engine.fixedClock("2026-10-08T12:00:00+09:00");

const fieldsOf = (e) => Object.entries(e.fields).map(([name, f]) => ({ name, ...f }));
const labelsOf = (f) => (f.type === "enum" ? Object.values(f.options) : []);
const keyByLabel = (f, label) => Object.entries(f.options).find(([, l]) => l === label)?.[0];
const sameSet = (a, b) => a.length === b.length && b.every((x) => a.includes(x));
const findEnum = (e, labels) => fieldsOf(e).find((f) => f.type === "enum" && sameSet(labelsOf(f), labels));
const isCreate = (a) => a.kind === undefined || a.kind === "create";

// 役割の見つけ方：「ref で指される側で、文字列の項目を持つ entity」がメンバー。
// 主役の entity は「メンバーを ref で指し、要件の選択肢（表示名の集合）を持つ enum がある entity」。
function locate(spec, main) {
  for (const e of spec.entities) {
    const ref = fieldsOf(e).find((f) => f.type === "ref");
    if (!ref) continue;
    const member = spec.entities.find((m) => m.name === ref.to);
    if (!member || !fieldsOf(member).some((f) => f.type === "string")) continue;
    const kind = findEnum(e, main.kindLabels);
    const status = findEnum(e, main.statusLabels);
    if (kind && status) return { e, member, ref, kind, status };
  }
  return null;
}

// 1 件のレコードを、項目の型から組み立てる（値は上書きできる）
function recordFor(e, over = {}) {
  const r = {};
  for (const f of fieldsOf(e)) {
    if (f.type === "string") r[f.name] = "x";
    else if (f.type === "number") r[f.name] = 1;
    else if (f.type === "date") r[f.name] = "2026-10-08";
    else if (f.type === "enum") r[f.name] = f.default ?? Object.keys(f.options)[0];
    else if (f.type === "ref") r[f.name] = "m1";
    else if (f.type === "list") r[f.name] = ["m1"];
  }
  return { ...r, ...over };
}

function common(app, spec, L, statusFrom, statusTo) {
  const { e, member, ref, kind, status } = L;
  const from = keyByLabel(status, statusFrom);
  const to = keyByLabel(status, statusTo);
  const ev = (entity, record, extra = {}) => engine.evaluateRecord({ app, entity, record, clock, ...extra });
  const checks = {};
  checks["既定の状態"] = status.default === from;
  const act = spec.actions.find((a) => a.entity === e.name && a.kind === "update" && a.set?.[status.name] === to);
  checks["状態を進めるボタンと条件"] =
    !!act &&
    engine.allowsAction({ app, entity: e.name, record: recordFor(e, { [status.name]: from }), clock }, act.when ?? "true") &&
    !engine.allowsAction({ app, entity: e.name, record: recordFor(e, { [status.name]: to }), clock }, act.when ?? "true");
  const board = spec.views.find((v) => v.type === "board" && v.entity === e.name && v.columns === status.name);
  checks["状態の列のボード"] = !!board;
  checks["種類と人で絞り込み"] = spec.views.some(
    (v) => v.type === "list" && v.entity === e.name && [kind.name, ref.name].every((n) => (v.filters ?? []).includes(n)),
  );
  // 人ごとの数：m1 が 2 件・m2 が 1 件なら、m1 は 2
  const rows = [
    { id: "r1", data: recordFor(e, { [ref.name]: "m1" }) },
    { id: "r2", data: recordFor(e, { [ref.name]: "m1" }) },
    { id: "r3", data: recordFor(e, { [ref.name]: "m2" }) },
  ];
  const counts = spec.computed.filter((c) => c.entity === member.name && c.aggregate?.kind === "count");
  checks["人ごとの数"] = counts.some(
    (c) => ev(member.name, recordFor(member), { recordId: "m1", sources: { [e.name]: rows } }).computed[c.name] === 2,
  );
  checks["人と主役を登録できる"] = [member.name, e.name].every((n) => spec.actions.some((a) => a.entity === n && isCreate(a)));
  return { checks, board, member, ref };
}

const SUBJECTS = {
  A: {
    kindLabels: ["料理", "飲み物", "道具"],
    statusLabels: ["まだ", "用意できた"],
    run(app, spec, L) {
      const { checks } = common(app, spec, L, "まだ", "用意できた");
      const num = fieldsOf(L.e).find((f) => f.type === "number");
      const fails = (q) => engine.evaluateRecord({ app, entity: L.e.name, record: recordFor(L.e, { [num.name]: q }), clock }).validations.length > 0;
      checks["数は 1 以上"] = !!num && fails(0) && !fails(1);
      return checks;
    },
  },
  B: {
    kindLabels: ["ゴミ出し", "公園の掃除", "夜回り"],
    statusLabels: ["予定", "済み"],
    run(app, spec, L) {
      const { checks, board, member } = common(app, spec, L, "予定", "済み");
      const date = fieldsOf(L.e).find((f) => f.type === "date");
      const hl = board && spec.computed.find((c) => c.entity === L.e.name && c.name === board.highlight);
      const on = (d) => engine.holdsExpression({ app, entity: L.e.name, record: recordFor(L.e, { [date.name]: d }), clock }, hl.expression);
      checks["今日の当番に印"] = !!hl && !!date && on("2026-10-08") && !on("2026-10-07") && !on("2026-10-09");
      // 書けない要件（少ない順）：降順の ranking で人の回数を並べたら、要件の逆向きを見せている
      checks["少ない順（書けない）を逆向きで書いていない"] = !spec.views.some(
        (v) => v.type === "dashboard" && (v.widgets ?? []).some((w) => w.type === "ranking" && w.entity === member.name),
      );
      return checks;
    },
  },
};

for (const file of files) {
  const n = await engine.normalizeSpec(readFileSync(file, "utf8"));
  if (!n.ok) {
    console.log(`${basename(file)}\tstatic=NG(${[...new Set(n.diagnostics.map((d) => d.code))].join(",")})\t-`);
    continue;
  }
  const app = n.app;
  const spec = app.spec;
  const S = SUBJECTS[subject];
  const L = locate(spec, S);
  if (!L) {
    console.log(`${basename(file)}\tstatic=OK\t役割が見つからない（人が判定）`);
    continue;
  }
  const checks = S.run(app, spec, L);
  const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  console.log(`${basename(file)}\tstatic=OK\t${failed.length === 0 ? "rubric=OK" : `rubric=NG(${failed.join("・")})`}`);
}
