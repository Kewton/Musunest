// 契約（`contract/` の全ファイル）の SHA-256 を求める（Issue #213）。
//
// 契約は**文法の正本**である——構造は JSON Schema、式は EBNF、規則は表（`workspace/mvp/m1/06-grammar-and-authoring-trial.md` §2.1）。
// 3 つのファイルを別々の版として扱うと、どれが今の版かを言えなくなる。**1 つの値で契約全体を指す。**
// M1a のゲート判定 6 は、この値を契約全体に対して取る（`06` §2.2）。
//
// 決めごと:
//   1. **ファイルの並びは名前の昇順に固定する。** 並びが実行ごとに変われば、同じ契約が別の値になる
//   2. **名前と中身の両方を混ぜる。** 名前を混ぜなければ、改名が値に現れない。長さを混ぜるので、
//      名前と中身の境目が中身の文字と紛れない（`ab` + `c` と `a` + `bc` が同じ値にならない）
//   3. **中身の 1 バイトが変われば値は変わる。** 同じ中身からは同じ値になる（SHA-256）
//   4. **Worker ではファイルを読まない。** 契約をファイルから読むのは Node 側（手元と CI のコマンド）
//      だけである（`files.ts` と同じ理由）。だから `node:fs` は、呼ばれたときにだけ動的に読む

/** 契約の一部である 1 つのファイル。`path` は `contract/` からの相対パスである */
export interface ContractFile {
  /** `contract/` からの相対パス（並びを決める鍵であり、値にも混ざる） */
  readonly path: string;
  /** 中身。文字列は UTF-8 として読む（原本のバイト列を渡してもよい） */
  readonly content: string | Uint8Array;
}

/** 契約のファイルを置くディレクトリ（パッケージの直下からの相対パス） */
export const CONTRACT_DIRECTORY = "contract" as const;

const encoder = new TextEncoder();

/** 32 ビットの長さを、big-endian の 4 バイトで書く */
function lengthBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, length, false);
  return bytes;
}

function contentBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? encoder.encode(content) : content;
}

function joinBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

const byPath = (a: ContractFile, b: ContractFile): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

/** 決まった順（名前の昇順）に並べた契約のファイル。入力の並びに依らない */
export function orderContractFiles(files: readonly ContractFile[]): readonly ContractFile[] {
  return [...files].sort(byPath);
}

/** 小文字の 16 進 64 桁にする */
function hexOf(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/**
 * 契約のファイルから、1 つの SHA-256（小文字の 16 進 64 桁）を求める。
 * **同じ中身からは同じ値**になり、**1 バイト変えると違う値**になる（決めごと 1〜3）。
 * `crypto.subtle` を使うので、Node でも Worker でも動く（依存を増やさない）。
 */
export async function contractDigest(files: readonly ContractFile[]): Promise<string> {
  const parts: Uint8Array[] = [];
  for (const file of orderContractFiles(files)) {
    const path = encoder.encode(file.path);
    const content = contentBytes(file.content);
    parts.push(lengthBytes(path.byteLength), path, lengthBytes(content.byteLength), content);
  }
  const digest = await crypto.subtle.digest("SHA-256", joinBytes(parts));
  return hexOf(new Uint8Array(digest));
}

// ── Node 側（ファイルから読む） ──────────────────────────────────
//
// 契約のファイルの場所は、このファイルの 1 つ上がパッケージの直下である（src/ からでも dist/ からでも同じ）。
// `node:fs` の型は、この package の tsconfig の types（workers-types）に無いので、使う関数の形だけを
// ここで宣言し、**動的**に読む（`files.ts`・unit テストと同じやり方）。

interface NodeDirent {
  readonly name: string;
  isFile(): boolean;
}

interface NodeFs {
  readdirSync(path: URL, options: { withFileTypes: true }): readonly NodeDirent[];
  readFileSync(path: URL): Uint8Array;
}

const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);

async function nodeFs(): Promise<NodeFs> {
  return (await importUntyped("node:fs")) as NodeFs;
}

function selfUrl(): string {
  return (import.meta as ImportMeta & { url: string }).url;
}

/** 契約のディレクトリの場所。このファイル（src/ か dist/）の 1 つ上がパッケージの直下である */
export function contractDirectory(): URL {
  return new URL(`../${CONTRACT_DIRECTORY}/`, selfUrl());
}

/**
 * 契約のディレクトリを読んで、決まった順（名前の昇順）のファイルにする。
 * 隠しファイル（`.DS_Store` など）は契約の一部ではないので数えない。
 */
export async function contractFiles(directory: URL = contractDirectory()): Promise<readonly ContractFile[]> {
  const fs = await nodeFs();
  const names = fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
  return names.map((name) => ({ path: name, content: fs.readFileSync(new URL(name, directory)) }));
}

/** 契約のディレクトリの SHA-256（コマンドがこれを出す） */
export async function contractHash(directory: URL = contractDirectory()): Promise<string> {
  return contractDigest(await contractFiles(directory));
}

// ── コマンド（`pnpm --filter @musunest/appspec-schema contract:hash`） ──────
//
// このファイルが入口として起動されたときだけ走る。**import したときは走らせない**——
// Worker が package の根（index.ts）から読み込んでも、`process` が無ければ何も起きない。

const runtime = globalThis as unknown as {
  readonly process?: {
    readonly argv: readonly string[];
    readonly stdout: { write(text: string): void };
  };
};

function isEntryPoint(): boolean {
  const entry = runtime.process?.argv[1];
  if (entry === undefined) return false;
  return selfUrl().endsWith(entry);
}

async function main(): Promise<void> {
  if (!isEntryPoint()) return;
  runtime.process?.stdout.write(`${await contractHash()}\n`);
}

void main();
