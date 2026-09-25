// report.ts の試験（Issue #233）。**実環境には一切届かない。**
//
// 見るのは3つである。
//   1. 偽の結果から、合否・期待・実際・写真の参照・実行した日時・コミットを含む HTML ができる
//   2. 入口の HTML と写真を書き出し、**前回のレポートを上書きする**
//   3. **ホスト名などが紛れ込んだ結果を渡すと、書き出しが失敗する**（二点測定の赤。）
//      ——そのとき、前回のレポートには 1 バイトも触らない

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderReport, writeReport, type ScreenshotFile, type StepResult, type UiReport } from "./report.js";
import { SecretLeakError, type SecretValue } from "./redact.js";

const BASE = "https://musunest-staging-host.fixture-sub-7c2e91.workers.dev";
const ACCOUNT = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const COMMIT = "9a7013a4c1e2d3f405162738495a6b7c8d9e0f12";
const SECRETS: readonly SecretValue[] = [
  { name: "SMOKE_BASE_URL", value: BASE },
  { name: "CLOUDFLARE_ACCOUNT_ID", value: ACCOUNT },
];

const STEP: StepResult = {
  scenario: "割り勘",
  step: "精算が「C → A 3,000」の 1 件だけ",
  ok: true,
  expected: "C さん → A さん 3,000 円（1 件）",
  actual: "C さん → A さん 3,000 円",
  screenshot: "shots/warikan-settlement.png",
};

const FAILED: StepResult = {
  scenario: "割り勘",
  step: "金額 0 は保存されない",
  ok: false,
  expected: "「金額は 1 円以上にしてください」と出る",
  actual: "（出ていない）",
};

function report(overrides: Partial<UiReport> = {}): UiReport {
  return {
    ok: false,
    startedAt: "2026-09-25T08:00:00.000Z",
    finishedAt: "2026-09-25T08:01:00.000Z",
    commit: COMMIT,
    steps: [STEP, FAILED],
    notes: [],
    problems: [],
    ...overrides,
  };
}

const temporaryDirectories: string[] = [];

async function tempDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "musunest-ui-report-"));
  temporaryDirectories.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of temporaryDirectories.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("renderReport：偽の結果から HTML を組む", () => {
  it("合否・期待・実際・写真の参照・実行した日時・コミットを含む", () => {
    const html = renderReport(report());

    expect(html).toContain("画面テストのレポート");
    expect(html).toContain("不合格"); // 総合（1 件落ちている）
    expect(html).toContain("合格"); // 合格した行
    expect(html).toContain("割り勘");
    expect(html).toContain("精算が「C → A 3,000」の 1 件だけ");
    expect(html).toContain("期待");
    expect(html).toContain("実際");
    expect(html).toContain("C さん → A さん 3,000 円（1 件）");
    expect(html).toContain("C さん → A さん 3,000 円");
    expect(html).toContain("（出ていない）");
    expect(html).toContain('src="shots/warikan-settlement.png"');
    expect(html).toContain(COMMIT);
    expect(html).toContain("2026-09-25T08:00:00.000Z");
  });

  it("写真の無い項目は、写真の欄を「—」にする", () => {
    const html = renderReport(report({ steps: [FAILED] }));
    expect(html).not.toContain("<img");
  });

  it("すべて合格なら、総合は合格である", () => {
    expect(renderReport(report({ ok: true, steps: [STEP] }))).toContain("合格");
  });
});

describe("writeReport：入口の HTML と写真を書き出す", () => {
  it("index.html と shots/…png を書き、前回のレポートを上書きする", async () => {
    const dir = await tempDirectory();
    const screenshots: readonly ScreenshotFile[] = [
      { path: "shots/warikan-settlement.png", data: new Uint8Array([1, 2, 3]) },
    ];

    await writeReport({ dir, report: report(), secrets: SECRETS, screenshots });

    const html = await readFile(join(dir, "index.html"), "utf8");
    expect(html).toContain("画面テストのレポート");
    expect([...(await readFile(join(dir, "shots/warikan-settlement.png")))]).toEqual([1, 2, 3]);
    expect(await readdir(join(dir, "shots"))).toEqual(["warikan-settlement.png"]);

    // 前回だけのファイルは消え、index.html は今回のもので置き換わる（**上書き**）
    await writeFile(join(dir, "stale.html"), "前回");
    await writeReport({ dir, report: report({ commit: "abc1234", steps: [FAILED] }), secrets: SECRETS, screenshots: [] });

    await expect(readFile(join(dir, "stale.html"))).rejects.toThrow();
    const replaced = await readFile(join(dir, "index.html"), "utf8");
    expect(replaced).toContain("abc1234");
    expect(replaced).not.toContain(COMMIT);
  });
});

describe("writeReport：ホスト名などが紛れ込んだら失敗する（二点測定の赤）", () => {
  it.each([
    ["宛先そのもの（URL）", `${BASE}/apps/m15-ui-warikan`],
    ["ホスト名だけ", "見た: musunest-staging-host.fixture-sub-7c2e91.workers.dev"],
    ["workers の既定のドメイン", "https://other-sub.workers.dev/apps/x"],
    ["Account ID", `account ${ACCOUNT}`],
  ])("%s が結果に紛れていたら、書き出さない", async (_, actual) => {
    const dir = await tempDirectory();
    await writeFile(join(dir, "index.html"), "前回");
    const dirty = report({ steps: [{ ...STEP, actual }] });

    const error = await writeReport({ dir, report: dirty, secrets: SECRETS, screenshots: [] }).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(error).toBeInstanceOf(SecretLeakError);
    // **理由に値を載せない**
    expect(error?.message ?? "").not.toContain("fixture-sub-7c2e91");
    expect(error?.message ?? "").not.toContain(ACCOUNT);
    // **前回のレポートに触らない**
    expect(await readFile(join(dir, "index.html"), "utf8")).toBe("前回");
  });

  it("写真の道に紛れていても止める", async () => {
    const dir = await tempDirectory();
    const dirty = report({ steps: [{ ...STEP, screenshot: `${BASE}/shot.png` }] });
    await expect(writeReport({ dir, report: dirty, secrets: SECRETS, screenshots: [] })).rejects.toThrow(SecretLeakError);
  });

  it("きれいな結果は通る（対になる緑）", async () => {
    const dir = await tempDirectory();
    await expect(writeReport({ dir, report: report({ ok: true, steps: [STEP] }), secrets: SECRETS, screenshots: [] })).resolves.toBeUndefined();
    expect(await readFile(join(dir, "index.html"), "utf8")).toContain("合格");
  });

  it("書けないときは、黙って成功しない", async () => {
    const dir = await tempDirectory();
    const blocked = join(dir, "blocked");
    await writeFile(blocked, "ファイルが邪魔をしている");
    await expect(
      writeReport({ dir: join(blocked, "child"), report: report({ ok: true, steps: [STEP] }), secrets: SECRETS, screenshots: [] }),
    ).rejects.toThrow();
  });
});
