// e2e/src/ui/report.ts — 画面テストの結果を、入口の 1 枚の HTML と画面の写真に書き出す（Issue #233）。
//
// **Playwright の標準のレポートは使わない**（宛先の URL が載るためである。所有者の決定 2026-09-25）。
// 代わりに、項目ごとの 合否・期待・実際・写真・実行した日時とコミットを、この 1 枚に組む。
// 写真はレポートのディレクトリからの**相対の道**で指す（`shots/…png`）——URL を 1 つも載せない。
//
// 書き出す前に **redact.ts の検査を通す**。ホスト名・workers の既定のドメイン・URL・Account ID が
// 紛れ込んでいたら、**何も書かずに失敗する**（前回のレポートを壊さない）。手で直すのではなく、
// 値を出している手順を直して流し直す（`workspace/mvp/m1/ui-report/` は人が読む記録である）。
//
// 前回のレポートは上書きする（所有者の決定。**最新の 1 つだけを git で追跡する**）。

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { assertNoSecrets, type SecretValue } from "./redact.js";

/** レポートの 1 行（1 項目）。**値（URL・ホスト名・資格情報）を入れない** */
export interface StepResult {
  /** 手順の名前（割り勘・タスク管理・ダッシュボード・残るか） */
  readonly scenario: string;
  /** その手順の中の 1 項目 */
  readonly step: string;
  /** 合否 */
  readonly ok: boolean;
  /** 期待 */
  readonly expected: string;
  /** 実際 */
  readonly actual: string;
  /** レポートのディレクトリからの相対の道（`shots/…png`）。無ければ写真は出さない */
  readonly screenshot?: string;
}

/** 1 回の実行の結果。合否は「すべての項目が合格で、問題が 1 つも無い」ことである */
export interface UiReport {
  readonly ok: boolean;
  /** 実行した日時（開始と終了。ISO 8601） */
  readonly startedAt: string;
  readonly finishedAt: string;
  /** 実行したコミット（引けなければ「不明」） */
  readonly commit: string;
  readonly steps: readonly StepResult[];
  /** 人が読む補足。**合否に効かない** */
  readonly notes: readonly string[];
  /** 合否に効く問題（片付けの失敗など）。1 つでもあれば不合格である */
  readonly problems: readonly string[];
}

/** 書き出す写真 1 枚 */
export interface ScreenshotFile {
  /** `StepResult.screenshot` と同じ、レポートからの相対の道 */
  readonly path: string;
  readonly data: Uint8Array;
}

/** 書き出しの失敗（混入・書き込み不能）。**値を持たない** */
export class ReportError extends Error {
  override name = "ReportError";
}

/** HTML に埋める前に、テキストとして安全にする */
const escape = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const verdict = (ok: boolean): string => (ok ? "合格" : "不合格");

const CSS = `body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:16px;line-height:1.5;color:#1a1a1a}
h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:24px}
table{border-collapse:collapse;width:100%;max-width:100%}
th,td{border:1px solid #c9c9c9;padding:6px;text-align:left;vertical-align:top;overflow-wrap:anywhere}
th{background:#f2f2f2}
.ok{color:#1b5e20;font-weight:bold}.ng{color:#b00020;font-weight:bold}
img{max-width:180px;border:1px solid #c9c9c9}
.problems{color:#b00020}dl.meta{display:flex;flex-wrap:wrap;gap:4px 12px}dl.meta dt{font-weight:bold}dl.meta dd{margin:0}`;

/** 手順の名前ごとに、その項目をまとめる（並びは受け取った順のまま） */
function groupsOf(steps: readonly StepResult[]): readonly (readonly [string, readonly StepResult[]])[] {
  const order: string[] = [];
  const groups = new Map<string, StepResult[]>();
  for (const step of steps) {
    const rows = groups.get(step.scenario);
    if (rows === undefined) {
      order.push(step.scenario);
      groups.set(step.scenario, [step]);
    } else {
      rows.push(step);
    }
  }
  return order.map((name) => [name, groups.get(name) ?? []] as const);
}

const cell = (text: string): string => (text === "" ? "—" : escape(text));

function photoCell(step: StepResult): string {
  if (step.screenshot === undefined) return "—";
  const href = escape(step.screenshot);
  return `<a href="${href}"><img src="${href}" alt="${escape(step.step)} の画面" loading="lazy"></a>`;
}

function rowsOf(steps: readonly StepResult[]): string {
  return steps
    .map(
      (step) =>
        `<tr><td>${escape(step.step)}</td><td class="${step.ok ? "ok" : "ng"}">${verdict(step.ok)}</td><td>${cell(
          step.expected,
        )}</td><td>${cell(step.actual)}</td><td>${photoCell(step)}</td></tr>`,
    )
    .join("\n");
}

/** 結果から HTML を組む（**純粋**。書き込みはしない） */
export function renderReport(report: UiReport): string {
  const sections = groupsOf(report.steps)
    .map(
      ([name, steps]) =>
        `<h2>${escape(name)}</h2>\n<table>\n<thead><tr><th>手順</th><th>合否</th><th>期待</th><th>実際</th><th>写真</th></tr></thead>\n<tbody>\n${rowsOf(
          steps,
        )}\n</tbody>\n</table>`,
    )
    .join("\n");
  const problems =
    report.problems.length === 0
      ? ""
      : `<h2 class="problems">問題</h2>\n<ul class="problems">\n${report.problems.map((problem) => `<li>${escape(problem)}</li>`).join("\n")}\n</ul>`;
  const notes =
    report.notes.length === 0
      ? ""
      : `<h2>注記</h2>\n<ul>\n${report.notes.map((note) => `<li>${escape(note)}</li>`).join("\n")}\n</ul>`;
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>画面テストのレポート</title>
<style>${CSS}</style>
</head>
<body>
<h1>画面テストのレポート</h1>
<p>総合: <span class="${report.ok ? "ok" : "ng"}">${verdict(report.ok)}</span></p>
<dl class="meta">
<dt>実行した日時</dt><dd>${escape(report.startedAt)} 〜 ${escape(report.finishedAt)}</dd>
<dt>コミット</dt><dd>${escape(report.commit === "" ? "不明" : report.commit)}</dd>
</dl>
${problems}
${sections}
${notes}
<p>このレポートは機械が書き出す。手で直さない（直すのは、値を出している手順のほうである）。</p>
</body>
</html>
`;
}

/** 検査の対象にする文字列（結果のすべての欄と、写真の道） */
export function textsOf(report: UiReport): readonly string[] {
  const texts = [report.startedAt, report.finishedAt, report.commit, ...report.notes, ...report.problems];
  for (const step of report.steps) {
    texts.push(step.scenario, step.step, step.expected, step.actual);
    if (step.screenshot !== undefined) texts.push(step.screenshot);
  }
  return texts;
}

export interface WriteReportOptions {
  /** レポートのディレクトリ（`workspace/mvp/m1/ui-report/`）。**中身は上書きする** */
  readonly dir: string;
  readonly report: UiReport;
  /** 伏せる値・混入を探す値（宛先のオリジンとホスト、資格情報） */
  readonly secrets: readonly SecretValue[];
  readonly screenshots: readonly ScreenshotFile[];
}

/**
 * レポートを書き出す。順は「組む → 検査する → 前回を消す → 書く」である。
 * **検査で落ちたら、前回のレポートには 1 バイトも触らない。**
 */
export async function writeReport(options: WriteReportOptions): Promise<void> {
  const html = renderReport(options.report);
  const texts = [
    ...textsOf(options.report),
    ...options.screenshots.map((shot) => shot.path),
    html,
  ];
  assertNoSecrets(texts, options.secrets);

  await rm(options.dir, { recursive: true, force: true });
  await mkdir(options.dir, { recursive: true });
  for (const shot of options.screenshots) {
    const target = join(options.dir, shot.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, shot.data);
  }
  try {
    await writeFile(join(options.dir, "index.html"), html, "utf8");
  } catch (e) {
    throw new ReportError(`レポートを書けない（${e instanceof Error ? e.name : typeof e}）`);
  }
}
