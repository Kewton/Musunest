// tarball の再現性と境界を、実際にバイト列を作って確かめる（Issue #229）。
//
// tar は自前で読み直す（自前の writer を信用しない）。ここで見るのは 4 つ：
//   - 2 回続けて作った SHA-256 が一致する（決定性）
//   - 元ファイルの時刻を変えても SHA-256 が変わらない（時刻を読んでいない）
//   - 中身を 1 バイト変えると SHA-256 が変わる（二点測定。空振りでない）
//   - src/・dist/・node_modules/ が入らない（収録の許可リスト）

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PACKAGE_ROOT,
  collectTemplateEntries,
  createTar,
  packTemplate,
  readManifest,
  sha256,
} from "./pack.js";

const MANIFEST = JSON.stringify({
  name: "test-template",
  version: "1.2.3",
  zones: [
    { path: "core", factoryMutable: false, summary: "core" },
    { path: "sdk", factoryMutable: false, summary: "sdk" },
    { path: "app-zone", factoryMutable: true, summary: "app-zone" },
  ],
});

const EXPECTED_FIXTURE_ENTRIES = [
  "README.md",
  "app-zone/README.md",
  "core/README.md",
  "sdk/README.md",
  "template.json",
];

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeAll(root: string, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(root, ...relativePath.split("/"));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}

/** 3 領域・マニフェスト・README と、入ってはいけない src/・dist/・node_modules/ を持つ偽のルート。 */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "musunest-pack-"));
  roots.push(root);
  writeAll(root, {
    "README.md": "# template\n",
    "template.json": MANIFEST,
    "core/README.md": "core\n",
    "sdk/README.md": "sdk\n",
    "app-zone/README.md": "app\n",
    "src/index.ts": "// 入ってはいけない\n",
    "dist/index.js": "// 入ってはいけない\n",
    "node_modules/dep/index.js": "// 入ってはいけない\n",
  });
  return root;
}

/** tar のエントリ名を、ヘッダを自前で読んで返す。 */
function tarEntryNames(tar: Uint8Array): string[] {
  const names: string[] = [];
  const view = new Uint8Array(tar.buffer, tar.byteOffset, tar.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 512 <= view.length) {
    const header = view.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, end: number): string =>
      decoder.decode(header.subarray(start, end)).replace(/\0.*$/s, "");
    const size = Number.parseInt(field(124, 136).trim() || "0", 8);
    const prefix = field(345, 500);
    const name = field(0, 100);
    names.push(prefix === "" ? name : `${prefix}/${name}`);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return names;
}

describe("境界（3 領域・マニフェスト）", () => {
  it("実パッケージに 3 領域の README とマニフェストがある", () => {
    const manifest = readManifest(PACKAGE_ROOT);
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.zones.map((zone) => zone.path)).toEqual(["core", "sdk", "app-zone"]);
    expect(manifest.zones[0]?.factoryMutable).toBe(false);
    expect(manifest.zones[1]?.factoryMutable).toBe(false);
    expect(manifest.zones[2]?.factoryMutable).toBe(true);
    for (const zone of manifest.zones) {
      expect(existsSync(join(PACKAGE_ROOT, zone.path, "README.md")), `${zone.path}/README.md`).toBe(true);
    }
    expect(existsSync(join(PACKAGE_ROOT, "README.md"))).toBe(true);
  });

  it("実パッケージの tarball には 3 領域・マニフェスト・README だけが入る", () => {
    const names = tarEntryNames(createTar(collectTemplateEntries(PACKAGE_ROOT)));
    expect(names).toEqual(["README.md", "app-zone/README.md", "core/README.md", "sdk/README.md", "template.json"]);
  });
});

describe("tarball の再現性", () => {
  it("2 回続けて作った SHA-256 が一致する", () => {
    const root = fixture();
    const first = packTemplate(root);
    const second = packTemplate(root);
    expect(second.sha256).toBe(first.sha256);
    expect(second.bytes.byteLength).toBe(first.bytes.byteLength);
    expect(sha256(second.bytes)).toBe(sha256(first.bytes));
  });

  it("ファイルの時刻を変えても（中身が同じなら）SHA-256 が変わらない", () => {
    const root = fixture();
    const before = packTemplate(root).sha256;
    const target = join(root, "app-zone", "README.md");
    const original = statSync(target).mtimeMs;
    const past = new Date("2001-02-03T04:05:06Z");
    utimesSync(target, past, past);
    expect(statSync(target).mtimeMs, "元ファイルの mtime は実際に変わっている").not.toBe(original);
    expect(packTemplate(root).sha256).toBe(before);
  });

  it("入力の並びを変えても同じバイト列になる", () => {
    const entries = collectTemplateEntries(fixture());
    const forward = createTar(entries);
    const reversed = createTar([...entries].reverse());
    expect(sha256(reversed)).toBe(sha256(forward));
  });
});

describe("二点測定（中身が効いていること）", () => {
  it("中身を 1 バイト変えると SHA-256 が変わる", () => {
    const root = fixture();
    const before = packTemplate(root).sha256;
    // "app\n" → "apq\n"（同じ長さで 1 バイトだけ違う）
    writeFileSync(join(root, "app-zone", "README.md"), "apq\n");
    expect(packTemplate(root).sha256).not.toBe(before);
  });
});

describe("収録の許可リスト", () => {
  it("src/・dist/・node_modules/ が入っていない", () => {
    const names = tarEntryNames(createTar(collectTemplateEntries(fixture())));
    expect(names).toEqual(EXPECTED_FIXTURE_ENTRIES);
    expect(names.some((name) => /^(src|dist|node_modules)\//.test(name))).toBe(false);
  });
});
