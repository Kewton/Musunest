// テンプレートの tarball を、同じ入力から同じバイト列で作る（Issue #229）。
//
// 依存は Node の標準ライブラリだけである（Issue 本文「依存を足さない」）。
// 再現性のために、次の 5 つを固定する：
//   1. 収録するファイル … 3 領域（template.json の zones）・マニフェスト・パッケージ README だけ。
//                         src/・dist/・node_modules/ は入れない
//   2. 並び順           … tar の path をバイト順に昇順（入力の並びに依らない）
//   3. 所有者・権限      … uid=0 / gid=0 / mode=0644
//   4. 時刻             … tar の mtime=0（元ファイルの mtime を読まない）
//   5. gzip のヘッダ時刻 … MTIME=0（zlib の既定。圧縮のヘッダも固定する）
//
// これで「2 回続けて作ると同じ SHA-256」「元ファイルの時刻を変えても同じ SHA-256」
// 「中身を 1 バイト変えると違う SHA-256」が成り立つ。

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const SOURCE_DIRECTORY = dirname(fileURLToPath(import.meta.url));

/** このパッケージのルート（`src/` の親）。`dist/` から実行しても同じ場所を指す。 */
export const PACKAGE_ROOT = resolve(SOURCE_DIRECTORY, "..");

/** tar のヘッダに固定して書く値。再現性のための唯一の出所。 */
export const FIXED_MTIME = 0;
export const FIXED_MODE = "0000644";
export const FIXED_UUID_OWNER = "0000000";

const MANIFEST_FILE = "template.json";
const PACKAGE_README = "README.md";
const BLOCK_SIZE = 512;

export type TemplateZone = {
  readonly path: string;
  readonly factoryMutable: boolean;
  readonly summary: string;
};

export type TemplateManifest = {
  readonly name: string;
  readonly version: string;
  readonly zones: readonly TemplateZone[];
};

export type PackEntry = {
  /** パッケージのルートからの相対パス（区切りは `/`）。 */
  readonly path: string;
  readonly content: Buffer;
};

export type PackResult = {
  /** 出力するファイル名（`<name>-<version>.tar.gz`）。 */
  readonly fileName: string;
  readonly bytes: Buffer;
  readonly sha256: string;
};

/** マニフェストを読む。領域の一覧と版の正本である。 */
export function readManifest(root: string = PACKAGE_ROOT): TemplateManifest {
  return JSON.parse(readFileSync(join(root, MANIFEST_FILE), "utf8")) as TemplateManifest;
}

/** `dir`（ルート相対の posix パス）の下のファイルを、ルート相対の posix パスで再帰的に集める。 */
function listFiles(root: string, dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const path = posix.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listFiles(root, path));
    } else if (entry.isFile()) {
      found.push(path);
    }
  }
  return found;
}

/**
 * 収録するファイルを集める。**許可したものだけを入れる**（拒否リストに頼らない）。
 * だから `src/`・`dist/`・`node_modules/` は、たとえ存在しても入らない。
 */
export function collectTemplateEntries(root: string = PACKAGE_ROOT): PackEntry[] {
  const manifest = readManifest(root);
  const paths = [PACKAGE_README, MANIFEST_FILE];
  for (const zone of manifest.zones) {
    if (zone.path === "" || zone.path.includes("/") || zone.path.startsWith(".")) {
      throw new Error(`template.json の領域名が不正: ${JSON.stringify(zone.path)}`);
    }
    paths.push(...listFiles(root, zone.path));
  }
  return paths.map((path) => ({
    path,
    content: readFileSync(join(root, ...path.split(posix.sep))),
  }));
}

/** ustar のヘッダに収まるよう、長いパスを prefix と name に割る。 */
function splitName(path: string): { readonly prefix: string; readonly name: string } {
  if (Buffer.byteLength(path, "utf8") <= 100) return { prefix: "", name: path };
  const slash = path.lastIndexOf("/");
  if (slash < 0) throw new Error(`tar のヘッダに収まらないパス: ${path}`);
  const prefix = path.slice(0, slash);
  const name = path.slice(slash + 1);
  if (Buffer.byteLength(prefix, "utf8") > 155 || Buffer.byteLength(name, "utf8") > 100) {
    throw new Error(`tar のヘッダに収まらないパス: ${path}`);
  }
  return { prefix, name };
}

/** 512 バイトの ustar ヘッダを 1 つ作る。時刻・所有者・権限は固定値である。 */
function createHeader(path: string, size: number): Buffer {
  const header = Buffer.alloc(BLOCK_SIZE);
  const { prefix, name } = splitName(path);
  header.write(name, 0, 100, "utf8");
  header.write(FIXED_MODE, 100, 8, "latin1");
  header.write(FIXED_UUID_OWNER, 108, 8, "latin1");
  header.write(FIXED_UUID_OWNER, 116, 8, "latin1");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "latin1");
  header.write(`${FIXED_MTIME.toString(8).padStart(11, "0")}\0`, 136, 12, "latin1");
  header.write("        ", 148, 8, "latin1");
  header.write("0", 156, 1, "latin1");
  header.write("ustar\0", 257, 6, "latin1");
  header.write("00", 263, 2, "latin1");
  if (prefix !== "") header.write(prefix, 345, 155, "utf8");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
  return header;
}

/** エントリを tar に並べる。**入力の並びに依らず**、path のバイト順に昇順に並べる。 */
export function createTar(entries: readonly PackEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")),
  );
  const blocks: Buffer[] = [];
  for (const entry of sorted) {
    blocks.push(createHeader(entry.path, entry.content.length), entry.content);
    const padding = (BLOCK_SIZE - (entry.content.length % BLOCK_SIZE)) % BLOCK_SIZE;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(BLOCK_SIZE * 2));
  return Buffer.concat(blocks);
}

/** エントリから gzip 圧縮した tarball を作る。同じ入力なら同じバイト列になる。 */
export function createTarball(entries: readonly PackEntry[]): Buffer {
  return gzipSync(createTar(entries), { level: 9 });
}

export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** パッケージのルートから tarball を作り、ファイル名と SHA-256 を返す。 */
export function packTemplate(root: string = PACKAGE_ROOT): PackResult {
  const manifest = readManifest(root);
  const bytes = createTarball(collectTemplateEntries(root));
  return {
    fileName: `${manifest.name}-${manifest.version}.tar.gz`,
    bytes,
    sha256: sha256(bytes),
  };
}

/** tarball を `dist/` の下へ書く（`dist/` は追跡しない）。 */
export function writeTarball(
  root: string = PACKAGE_ROOT,
  outDir: string = join(root, "dist"),
): { readonly path: string; readonly sha256: string } {
  const result = packTemplate(root);
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, result.fileName);
  writeFileSync(path, result.bytes);
  return { path, sha256: result.sha256 };
}

/** CLI。tarball を `dist/` へ書き、SHA-256 を標準出力に出す。 */
export function main(root: string = PACKAGE_ROOT): void {
  const result = writeTarball(root);
  process.stderr.write(`wrote ${relative(process.cwd(), result.path)}\n`);
  process.stdout.write(`${result.sha256}\n`);
}

/** このファイルが入口として起動されたか（テストや import のときは走らせない）。 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(entry).href === import.meta.url;
}

if (isEntryPoint()) {
  main();
}
