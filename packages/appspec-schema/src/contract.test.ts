// 契約（`contract/` の全ファイル）の SHA-256 の unit テスト（Issue #213）。
//
// 見るのは 4 つである。
//   1. **同じ中身からは同じ値。** 決まった順（名前の昇順）に混ぜるので、入力の並びにも依らない
//   2. **1 バイト変えると違う値。** 中身の変化が値に現れる（変わらないなら、ハッシュが契約を指していない）
//   3. 名前と長さも混ぜる（改名が値に現れ、名前と中身の境目が紛れない）
//   4. 契約の実物（`contract/` の 3 ファイル）から値が出る。同じ呼び出しは同じ値になる
//
// 二点測定: 契約の実物の 1 バイトを変えた入力で、値が変わることを実測する（成果物側の変異）。
import { describe, expect, it } from "vitest";
import { packageFile } from "./files.js";
import { CONTRACT_DIRECTORY, contractDigest, contractDirectory, contractFiles, contractHash } from "./contract.js";

// tsconfig の types は workers-types だけなので、node:fs の型が無い。このファイルは Node（vitest）で
// 動くので、使う関数の形だけをここで宣言する（index.test.ts・api.test.ts と同じやり方）。
interface NodeFs {
  readFileSync(path: URL, encoding: "utf8"): string;
}
const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const fs = (await importUntyped("node:fs")) as NodeFs;
const readText = (url: URL): string => fs.readFileSync(url, "utf8");

const encoder = new TextEncoder();

describe("契約の SHA-256", () => {
  it("同じ中身からは同じ値になる", async () => {
    const once = await contractDigest([{ path: "rules.md", content: "amount > 0\n" }]);
    const twice = await contractDigest([{ path: "rules.md", content: "amount > 0\n" }]);
    expect(once).toBe(twice);
    expect(once).toMatch(/^[0-9a-f]{64}$/);
  });

  it("1 バイト変えると違う値になる", async () => {
    const base = await contractDigest([{ path: "rules.md", content: "amount > 0" }]);
    const changed = await contractDigest([{ path: "rules.md", content: "amount > 1" }]);
    expect(changed).not.toBe(base);
  });

  it("入力の並びを変えても同じ値になる（並びは名前の昇順に固定する）", async () => {
    const files = [
      { path: "b.md", content: "second" },
      { path: "a.md", content: "first" },
    ];
    const reversed = [...files].reverse();
    expect(await contractDigest(files)).toBe(await contractDigest(reversed));
  });

  it("ファイルの名前も値に混ざる（改名すれば違う値になる）", async () => {
    const original = await contractDigest([{ path: "rules.md", content: "same" }]);
    const renamed = await contractDigest([{ path: "rules.txt", content: "same" }]);
    expect(renamed).not.toBe(original);
  });

  it("名前と長さを混ぜるので、中身の切れ目が紛れない", async () => {
    // 長さを混ぜなければ、`ab` + `c` と `a` + `bc` が同じ並びになってしまう
    const left = await contractDigest([
      { path: "a", content: "ab" },
      { path: "b", content: "c" },
    ]);
    const right = await contractDigest([
      { path: "a", content: "a" },
      { path: "b", content: "bc" },
    ]);
    expect(left).not.toBe(right);
  });

  it("文字列は UTF-8 として読み、同じ中身のバイト列と同じ値になる", async () => {
    const text = "食べ物";
    const asString = await contractDigest([{ path: "x", content: text }]);
    const asBytes = await contractDigest([{ path: "x", content: encoder.encode(text) }]);
    expect(asString).toBe(asBytes);
  });
});

describe("契約の実物（contract/）の SHA-256", () => {
  it("契約のディレクトリのファイルを、決まった順に読む", async () => {
    const files = await contractFiles();
    expect(files.map((file) => file.path)).toEqual([
      "app-spec.schema.json",
      "expression-grammar.md",
      "rules.md",
    ]);
  });

  it("同じ呼び出しからは同じ値になり、読んだファイルのハッシュと一致する", async () => {
    const hash = await contractHash();
    expect(hash).toBe(await contractHash());
    expect(hash).toBe(await contractDigest(await contractFiles()));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("二点測定: 契約の実物の 1 バイトを変えると、値が変わる", async () => {
    const files = await contractFiles();
    const hash = await contractDigest(files);
    const mutated = files.map((file) => {
      if (file.path !== "rules.md") return file;
      const bytes = Uint8Array.from(file.content as Uint8Array);
      bytes[0] = (bytes[0] ?? 0) ^ 0x01;
      return { path: file.path, content: bytes };
    });
    expect(await contractDigest(mutated)).not.toBe(hash);
  });

  it("契約のディレクトリは、パッケージの直下の contract/ を指す", () => {
    expect(CONTRACT_DIRECTORY).toBe("contract");
    expect(contractDirectory().href.endsWith("/contract/")).toBe(true);
  });

  it("契約の SHA-256 を出すコマンドが、package.json にある", () => {
    const pkg = JSON.parse(readText(packageFile("package.json"))) as {
      scripts: Readonly<Record<string, string>>;
    };
    expect(pkg.scripts["contract:hash"]).toContain("contract.ts");
  });
});
