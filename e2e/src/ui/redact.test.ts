// redact.ts の試験（Issue #233）。**実環境には一切届かない。**
//
// 見るのは3つである。
//   1. URL・workers の既定のドメイン・渡された値・Account ID の形 を、**値を出さずに**見つける
//   2. commit の 40 桁や SHA-256 の 64 桁を、Account ID と**誤らない**（誤検知で窓口の実行を止めない）
//   3. 伏せ字は、値・ドメイン・URL・Account ID を出力から消す

import { describe, expect, it } from "vitest";
import { REDACTED, SecretLeakError, assertNoSecrets, findLeaks, redactLine, type SecretValue } from "./redact.js";

/** workers.dev のホスト名を使う（ログ・レポートに出ていないことを見る） */
const BASE = "https://musunest-staging-host.fixture-sub-7c2e91.workers.dev";
const TOKEN = "fixture-ci-token-3b7a9f2e";
const ACCOUNT = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
/** git の commit は 16 進 40 桁。**Account ID（32 桁）と誤ってはならない** */
const COMMIT = "9a7013a4c1e2d3f405162738495a6b7c8d9e0f12";

const SECRETS: readonly SecretValue[] = [
  { name: "SMOKE_BASE_URL", value: BASE },
  { name: "SMOKE_PROBE_TOKEN", value: TOKEN },
  { name: "CLOUDFLARE_ACCOUNT_ID", value: ACCOUNT },
];

describe("findLeaks：混入を、値を出さずに見つける", () => {
  it.each([
    ["宛先そのもの", BASE, "SMOKE_BASE_URL の値"],
    ["URL の形", "https://example.invalid/apps/x", "URL"],
    ["workers の既定のドメイン", "host staging-host.abc.workers.dev を見た", "workers の既定のドメイン"],
    ["Account ID の形", `account ${ACCOUNT}`, "Account ID の形（16 進 32 桁）"],
    ["渡された資格情報の値", `token ${TOKEN}`, "SMOKE_PROBE_TOKEN の値"],
  ])("%s を見つける", (_, text, reason) => {
    expect(findLeaks([text], SECRETS)).toContain(reason);
  });

  it("見つけた理由に、値そのものを載せない", () => {
    const reasons = findLeaks([`${BASE} ${ACCOUNT} ${TOKEN}`], SECRETS);
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) {
      expect(reason).not.toContain("fixture-sub-7c2e91");
      expect(reason).not.toContain(ACCOUNT);
      expect(reason).not.toContain(TOKEN);
    }
  });

  it("commit の 40 桁と SHA-256 の 64 桁を、Account ID と誤らない", () => {
    expect(findLeaks([COMMIT, "f".repeat(64)], SECRETS)).toEqual([]);
  });

  it("画面から読んだ普通の文は、混入と見なさない", () => {
    expect(
      findLeaks(["C さん → A さん 3,000 円", "2026-09-25T08:00:00.000Z", "shots/warikan-settlement.png"], SECRETS),
    ).toEqual([]);
  });
});

describe("redactLine：出力を伏せる", () => {
  it("値・URL・Account ID を消す", () => {
    const line = `${BASE}/apps/m15-ui-warikan token ${TOKEN} account ${ACCOUNT}`;
    const out = redactLine(line, [BASE, TOKEN]);

    expect(out).not.toContain("workers.dev");
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(ACCOUNT);
    expect(out).toContain(REDACTED);
  });

  it("短い値は置き換えない（普通の文字列に当たらない）", () => {
    expect(redactLine("A と B と C", ["A", "B"])).toBe("A と B と C");
  });
});

describe("assertNoSecrets：書き出す前に止める", () => {
  it("混入があれば SecretLeakError。理由に値を載せない", () => {
    const call = (): void => assertNoSecrets([`見た: ${BASE}`], SECRETS);
    expect(call).toThrow(SecretLeakError);
    expect(call).toThrow(/SMOKE_BASE_URL/);
    expect(() => assertNoSecrets([`${BASE}`], SECRETS)).toThrow(/SMOKE_BASE_URL の値/);
  });

  it("きれいな文は通す", () => {
    expect(() => assertNoSecrets(["割り勘: 合格", COMMIT], SECRETS)).not.toThrow();
  });
});
