// #168 第 5 段の採点（rubric v4）。v3（stage4/rubric-v3.mjs）を土台に、題材 C・D・E を足し、2026-10-09 の決定を入れた。
// - 決定①：B の「少ない順」を、降順の ranking の基準に「回数が少ないほど大きい」計算を使って書いたら合格（負の数の列が出るのは ui_note に記録）
// - 決定②：「見られる」は、表・一覧の show に加えて、ダッシュボードの部品（number・bar・pie の value、ranking の by と show）も含める
// - 第 2 段の決定：表示名は要件の言葉のまま。役割（構造と選択肢の表示名）が見つからなければ不合格（人の判定に回さない）
// 名前は見ない。振る舞いは spec-engine の評価器に値を入れて確かめる。時計は 2026-10-08T12:00:00+09:00 に固定。
// 使い方: node rubric-v4.mjs <spec-engine の dist/index.js> <A|B|C|D|E> <app.spec.yaml>...
// 出力（1 ファイル 1 行・タブ区切り）: <ファイル>\t<判定 PASS|FAIL|STATIC_NG>\t<要件ごとの合否>\t<ui_note>
// --json を付けると、1 ファイル 1 行の JSON を出す（run-all.mjs が使う）
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const [enginePath, subject, ...files] = args.filter((a) => a !== "--json");
const engine = await import(enginePath);
const clock = engine.fixedClock("2026-10-08T12:00:00+09:00");
const TODAY = "2026-10-08", YESTERDAY = "2026-10-07", TOMORROW = "2026-10-09";

const fieldsOf = (e) => Object.entries(e.fields).map(([name, f]) => (typeof f === "string" ? { name, type: f } : { name, ...f }));
const labelsOf = (f) => (f.type === "enum" ? Object.values(f.options) : []);
const keyByLabel = (f, label) => Object.entries(f.options).find(([, l]) => l === label)?.[0];
const sameSet = (a, b) => a.length === b.length && b.every((x) => a.includes(x));
const findEnum = (e, labels) => fieldsOf(e).find((f) => f.type === "enum" && sameSet(labelsOf(f), labels));
const isCreate = (a) => a.kind === undefined || a.kind === "create";
const hasString = (e) => fieldsOf(e).some((f) => f.type === "string");
const entityOf = (spec, name) => spec.entities.find((x) => x.name === name);

function recordFor(e, over = {}) {
  const r = {};
  for (const f of fieldsOf(e)) {
    if (f.type === "string") r[f.name] = "x";
    else if (f.type === "number") r[f.name] = 1;
    else if (f.type === "date") r[f.name] = TODAY;
    else if (f.type === "enum") r[f.name] = f.default ?? Object.keys(f.options)[0];
    else if (f.type === "ref") r[f.name] = "m1";
    else if (f.type === "list") r[f.name] = ["m1"];
  }
  return { ...r, ...over };
}

// ── 「見られる」（決定②）：entity の行の計算か、アプリ全体の計算が、どこかの画面に出ているか
const widgetsOf = (spec) => spec.views.filter((v) => v.type === "dashboard").flatMap((v) => v.widgets ?? []);
function shownForEntity(spec, entity, name) {
  if (spec.views.some((v) => (v.type === "table" || v.type === "list" || v.type === "board") && v.entity === entity && (v.show ?? []).includes(name))) return true;
  return widgetsOf(spec).some((w) => w.type === "ranking" && w.entity === entity && (w.by === name || (w.show ?? []).includes(name)));
}
const shownOnDashboard = (spec, name, types) => widgetsOf(spec).some((w) => types.includes(w.type) && w.value === name);

const creatable = (spec, names) => names.every((n) => spec.actions.some((a) => a.entity === n && isCreate(a)));
const ev = (app, entity, record, extra = {}) => engine.evaluateRecord({ app, entity, record, clock, ...extra });
const failsValidation = (app, e, over) => ev(app, e.name, recordFor(e, over)).validations.length > 0;

// メンバーごとの数（count）が、m1 2 件・m2 1 件の入力で m1＝2 を返し、画面に出ているか
function perMemberCount(app, spec, main, member, setMember) {
  const rows = [
    { id: "r1", data: recordFor(main, setMember("m1")) },
    { id: "r2", data: recordFor(main, setMember("m1")) },
    { id: "r3", data: recordFor(main, setMember("m2")) },
  ];
  const valueOf = (c, id) => ev(app, member.name, recordFor(member), { recordId: id, sources: { [main.name]: rows } }).computed[c.name];
  return spec.computed.filter((c) => c.entity === member.name && c.aggregate).find((c) => valueOf(c, "m1") === 2 && valueOf(c, "m2") === 1 && shownForEntity(spec, member.name, c.name));
}

// 状態の enum を持つ題材（A・B・E）に共通：既定の状態・進めるボタンと条件・状態の列のボード
function statusChecks(app, spec, e, status, fromLabel, toLabel) {
  const from = keyByLabel(status, fromLabel), to = keyByLabel(status, toLabel);
  const checks = {};
  checks["登録したときの状態"] = status.default === from;
  const act = spec.actions.find((a) => a.entity === e.name && a.kind === "update" && a.set?.[status.name] === to);
  checks["状態を進めるボタンと条件"] =
    !!act &&
    engine.allowsAction({ app, entity: e.name, record: recordFor(e, { [status.name]: from }), clock }, act.when ?? "true") &&
    !engine.allowsAction({ app, entity: e.name, record: recordFor(e, { [status.name]: to }), clock }, act.when ?? "true");
  const board = spec.views.find((v) => v.type === "board" && v.entity === e.name && v.columns === status.name);
  checks["状態の列のボード"] = !!board;
  return { checks, board };
}

// ── 役割の見つけ方：「ref で指される側で、文字列の項目を持つ entity」がメンバー
function locateAB(spec, kindLabels, statusLabels) {
  for (const e of spec.entities) {
    for (const ref of fieldsOf(e).filter((f) => f.type === "ref")) {
      const member = entityOf(spec, ref.to);
      if (!member || !hasString(member)) continue;
      const kind = findEnum(e, kindLabels), status = findEnum(e, statusLabels);
      if (kind && status) return { e, member, ref, kind, status };
    }
  }
  return null;
}

const SUBJECTS = {
  A: {
    locate: (spec) => locateAB(spec, ["料理", "飲み物", "道具"], ["まだ", "用意できた"]),
    run(app, spec, L) {
      const { checks } = statusChecks(app, spec, L.e, L.status, "まだ", "用意できた");
      checks["人と主役を登録できる"] = creatable(spec, [L.member.name, L.e.name]);
      checks["種類と人で絞り込み"] = spec.views.some((v) => v.type === "list" && v.entity === L.e.name && [L.kind.name, L.ref.name].every((n) => (v.filters ?? []).includes(n)));
      const num = fieldsOf(L.e).find((f) => f.type === "number");
      checks["数は 1 以上"] = !!num && failsValidation(app, L.e, { [num.name]: 0 }) && !failsValidation(app, L.e, { [num.name]: 1 });
      checks["人ごとの数が見られる"] = !!perMemberCount(app, spec, L.e, L.member, (m) => ({ [L.ref.name]: m }));
      return { checks };
    },
  },
  B: {
    locate: (spec) => locateAB(spec, ["ゴミ出し", "公園の掃除", "夜回り"], ["予定", "済み"]),
    run(app, spec, L) {
      const { checks, board } = statusChecks(app, spec, L.e, L.status, "予定", "済み");
      checks["人と主役を登録できる"] = creatable(spec, [L.member.name, L.e.name]);
      checks["種類と人で絞り込み"] = spec.views.some((v) => v.type === "list" && v.entity === L.e.name && [L.kind.name, L.ref.name].every((n) => (v.filters ?? []).includes(n)));
      const date = fieldsOf(L.e).find((f) => f.type === "date");
      const hl = board && spec.computed.find((c) => c.entity === L.e.name && c.name === board.highlight);
      const on = (d) => engine.holdsExpression({ app, entity: L.e.name, record: recordFor(L.e, { [date.name]: d }), clock }, hl.expression);
      checks["今日の当番に印"] = !!hl && !!date && on(TODAY) && !on(YESTERDAY) && !on(TOMORROW);
      checks["人ごとの回数が見られる"] = !!perMemberCount(app, spec, L.e, L.member, (m) => ({ [L.ref.name]: m }));
      // 決定①：メンバーの ranking があるなら、回数の少ない人（m2：1 件）が多い人（m1：2 件）より上に来ること
      const rows = [
        { id: "r1", data: recordFor(L.e, { [L.ref.name]: "m1" }) },
        { id: "r2", data: recordFor(L.e, { [L.ref.name]: "m1" }) },
        { id: "r3", data: recordFor(L.e, { [L.ref.name]: "m2" }) },
      ];
      const byOf = (w, id) => ev(app, L.member.name, recordFor(L.member), { recordId: id, sources: { [L.e.name]: rows } }).computed[w.by];
      const rankings = widgetsOf(spec).filter((w) => w.type === "ranking" && w.entity === L.member.name);
      const wrong = rankings.filter((w) => !(byOf(w, "m2") > byOf(w, "m1")));
      checks["少ない順を逆向きで書いていない"] = wrong.length === 0;
      const written = rankings.length > 0 && wrong.length === 0;
      const note = written && rankings.some((w) => byOf(w, "m1") < 0) ? "少ない順を負の数で書いた（画面に負の数の列が出る）" : "";
      return { checks, written: { 少ない順: written }, note };
    },
  },
  C: {
    locate(spec) {
      for (const e of spec.entities) {
        const method = findEnum(e, ["現金", "振込", "送金アプリ"]);
        if (!method) continue;
        for (const ref of fieldsOf(e).filter((f) => f.type === "ref")) {
          const member = entityOf(spec, ref.to);
          const amount = fieldsOf(e).find((f) => f.type === "number");
          const date = fieldsOf(e).find((f) => f.type === "date");
          if (member && hasString(member) && amount && date) return { e, member, ref, method, amount, date };
        }
      }
      return null;
    },
    run(app, spec, L) {
      const { e, member, ref, method, amount, date } = L;
      const checks = {};
      checks["人と支払いを登録できる"] = creatable(spec, [member.name, e.name]);
      checks["金額は 1 円以上"] = failsValidation(app, e, { [amount.name]: 0 }) && !failsValidation(app, e, { [amount.name]: 1 });
      checks["支払いを直せて消せる"] = spec.actions.some((a) => a.entity === e.name && a.kind === "update") && spec.actions.some((a) => a.entity === e.name && a.kind === "delete");
      const rows = [
        { id: "p1", data: recordFor(e, { [ref.name]: "m1", [amount.name]: 100, [date.name]: "2026-10-05" }) },
        { id: "p2", data: recordFor(e, { [ref.name]: "m2", [amount.name]: 200, [date.name]: "2026-10-01" }) },
        { id: "p3", data: recordFor(e, { [ref.name]: "m1", [amount.name]: 400, [date.name]: "2026-09-20" }) },
      ];
      const sources = { [e.name]: rows };
      const memberValue = (c) => ev(app, member.name, recordFor(member), { recordId: "m1", sources }).computed[c.name];
      checks["人ごとの合計が見られる"] = spec.computed.some((c) => c.entity === member.name && c.aggregate && memberValue(c) === 500 && shownForEntity(spec, member.name, c.name));
      const scope = engine.evaluateScope({ app, clock, sources });
      const scopeShown = (want) => Object.entries(scope).some(([n, v]) => v === want && shownOnDashboard(spec, n, ["number"]));
      checks["今月の集金額（ダッシュボード）"] = scopeShown(300);
      checks["今月の件数（ダッシュボード）"] = scopeShown(2);
      const groups = spec.computed.filter((c) => c.aggregate?.groupBy !== undefined);
      // 正規化後の groupBy は { field, month }（spec-engine の normalizeSpec）
      checks["月ごとの集金のグラフ（直近 6 か月）"] = groups.some((c) => c.aggregate.entity === e.name && c.aggregate.groupBy.field === date.name && c.aggregate.groupBy.month === true && c.aggregate.last === 6 && c.aggregate.kind === "sum" && c.aggregate.name === amount.name && shownOnDashboard(spec, c.name, ["bar"]));
      checks["払い方の内訳"] = groups.some((c) => c.aggregate.entity === e.name && c.aggregate.groupBy.field === method.name && c.aggregate.groupBy.month === false && shownOnDashboard(spec, c.name, ["pie", "bar"]));
      checks["人と払い方で絞り込み"] = spec.views.some((v) => v.type === "list" && v.entity === e.name && [ref.name, method.name].every((n) => (v.filters ?? []).includes(n)));
      return { checks };
    },
  },
  D: {
    locate(spec) {
      for (const e of spec.entities) {
        for (const list of fieldsOf(e).filter((f) => f.type === "list")) {
          const member = entityOf(spec, list.of);
          const capacity = fieldsOf(e).find((f) => f.type === "number");
          const date = fieldsOf(e).find((f) => f.type === "date");
          const place = fieldsOf(e).find((f) => f.type === "string");
          if (member && hasString(member) && capacity && date && place) return { e, member, list, capacity };
        }
      }
      return null;
    },
    run(app, spec, L) {
      const { e, member, list, capacity } = L;
      const checks = {};
      checks["人と試合を登録できる"] = creatable(spec, [member.name, e.name]);
      checks["定員を超えたら登録できない"] = failsValidation(app, e, { [capacity.name]: 2, [list.name]: ["m1", "m2", "m3"] }) && !failsValidation(app, e, { [capacity.name]: 2, [list.name]: ["m1", "m2"] });
      // 定員 0・参加者 0 で落ち、定員 1・参加者 1 で通る（参加者を必須にした宣言でも、定員の検査が無ければ 0・0 を区別できない限界がある。§3）
      checks["定員は 1 人以上"] = failsValidation(app, e, { [capacity.name]: 0, [list.name]: [] }) && !failsValidation(app, e, { [capacity.name]: 1, [list.name]: ["m1"] });
      const game = ev(app, e.name, recordFor(e, { [capacity.name]: 5, [list.name]: ["m1", "m2"] })).computed;
      const shownWith = (want) => Object.entries(game).some(([n, v]) => v === want && shownForEntity(spec, e.name, n));
      checks["参加人数が見られる"] = shownWith(2);
      checks["残りの枠が見られる"] = shownWith(3);
      checks["人ごとの参加回数が見られる"] = !!perMemberCount(app, spec, e, member, (m) => ({ [list.name]: m === "m1" ? ["m1"] : ["m2"] }));
      return { checks };
    },
  },
  E: {
    locate(spec) {
      for (const e of spec.entities) {
        const status = findEnum(e, ["貸出中", "返却済み"]);
        const refs = fieldsOf(e).filter((f) => f.type === "ref").filter((f) => entityOf(spec, f.to) && hasString(entityOf(spec, f.to)));
        const due = fieldsOf(e).find((f) => f.type === "date");
        if (status && refs.length >= 2 && due && new Set(refs.map((r) => r.to)).size >= 2) return { e, status, refs, due };
      }
      return null;
    },
    run(app, spec, L) {
      const { e, status, refs, due } = L;
      const { checks, board } = statusChecks(app, spec, e, status, "貸出中", "返却済み");
      checks["メンバーと備品と貸し出しを登録できる"] = creatable(spec, [...refs.map((r) => r.to), e.name]);
      const hl = board && spec.computed.find((c) => c.entity === e.name && c.name === board.highlight);
      const on = (d) => engine.holdsExpression({ app, entity: e.name, record: recordFor(e, { [due.name]: d }), clock }, hl.expression);
      checks["返す日を過ぎたものに印"] = !!hl && on(YESTERDAY) && !on(TODAY) && !on(TOMORROW);
      for (const r of refs) {
        const target = entityOf(spec, r.to);
        checks[`${target.name} ごとの回数が見られる`] = !!perMemberCount(app, spec, e, target, (m) => ({ [r.name]: m }));
      }
      return { checks };
    },
  },
};

export async function score(file, subjectId) {
  const n = await engine.normalizeSpec(readFileSync(file, "utf8"));
  if (!n.ok) return { file: basename(file), verdict: "STATIC_NG", codes: [...new Set(n.diagnostics.map((d) => d.code))], checks: {}, written: {}, note: "" };
  const app = n.app, spec = app.spec;
  const S = SUBJECTS[subjectId];
  const L = S.locate(spec);
  if (!L) return { file: basename(file), verdict: "FAIL", codes: [], checks: { 役割が見つかる: false }, written: {}, note: "" };
  let out;
  try { out = S.run(app, spec, L); } catch (err) { return { file: basename(file), verdict: "FAIL", codes: [], checks: { 採点中に例外: false }, written: {}, note: String(err.message ?? err).slice(0, 120) }; }
  const failed = Object.entries(out.checks).filter(([, ok]) => !ok).map(([k]) => k);
  return { file: basename(file), verdict: failed.length === 0 ? "PASS" : "FAIL", codes: [], checks: out.checks, written: out.written ?? {}, note: out.note ?? "" };
}

if (subject) {
  for (const file of files) {
    const r = await score(file, subject);
    if (asJson) { console.log(JSON.stringify(r)); continue; }
    const detail = r.verdict === "STATIC_NG" ? r.codes.join(",") : Object.entries(r.checks).map(([k, ok]) => `${ok ? "○" : "×"}${k}`).join(" ");
    console.log(`${r.file}\t${r.verdict}\t${detail}\t${r.note}`);
  }
}
