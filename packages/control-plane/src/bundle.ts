// 工場の納品物（`commandagent.community-delivery-bundle/v1`）の manifest の照合（Issue #247）。
//
// M1b のゲートの判定 2 は「manifest の SHA-256 が `pins/` と一致する」。Q8 の決定（2026-09-26）で、
// manifest の照合は TypeScript で作り、CI で毎回流す。置き場所は packages/control-plane（publish の
// 前段。Q20 の決めごと 2）。pins の値との比較は呼ぶ側（#248）が行う。
//
// 決めたこと（Issue #247 の本文。v0.1 の golden の納品物 cm4-delivery-bundle-001 の実物による）:
//   - manifest は納品物の直下の JSON（`bundle-manifest.json`）。`schema_version`・`artifact_level`・
//     `expected_verdict`・`files`（`path`・`sha256`・`size_bytes`）・`instrument`（`binary_sha256`・
//     `verification_profile`）・`source_run`・`storage_unit` を持つ
//   - `files` のすべてについて SHA-256 と大きさを照合する。**manifest に無いファイル・manifest に
//     あって無いファイル・値の食い違い**を、それぞれ理由つきで返す
//   - `files` のパスが `..` や絶対パスでディレクトリの外を指したら断る
//   - manifest 自身の SHA-256（ファイルのバイト列）を返す
//   - 単体テストはテストの中で作った小さな納品物で行う。**工場の実物のファイルをリポジトリに持ち込まない**
//
// Node 側でだけファイルを読む。`node:fs`・`node:path` の型はこの package の tsconfig の types
// （workers-types）に無いので、使う関数の形だけをここに宣言し、**動的**に読む
// （packages/appspec-schema/src/contract.ts と同じやり方）。Worker が package の根から import しても、
// この経路は呼ばれない限り動かない。

// ── manifest の形（v1）────────────────────────────────────────────

/** manifest のファイル名。**納品物の直下**に置かれる。 */
export const BUNDLE_MANIFEST_FILE = "bundle-manifest.json" as const;

/** 対応する manifest の版。`schema_version` がこれと違えば断る。 */
export const BUNDLE_MANIFEST_SCHEMA_VERSION = "commandagent.community-delivery-bundle/v1" as const;

/** `files` の 1 項目。納品物の直下からの相対パス（`/` 区切り）と、大きさ・SHA-256。 */
export interface BundleManifestFile {
  readonly path: string;
  readonly sha256: string;
  readonly size_bytes: number;
}

/** manifest が指す検証の道具（offline verifier のバイナリと、使った profile）。 */
export interface BundleManifestInstrument {
  readonly binary_sha256: string;
  readonly verification_profile: string;
}

/** 納品物の manifest（v1）。 */
export interface BundleManifest {
  readonly schema_version: string;
  readonly storage_unit: string;
  readonly source_run: string;
  readonly artifact_level: string;
  readonly expected_verdict: string;
  readonly instrument: BundleManifestInstrument;
  readonly files: readonly BundleManifestFile[];
}

// ── 照合の結果（理由つき）─────────────────────────────────────────

export const BUNDLE_PROBLEM_KINDS = [
  "unsafe_path",
  "missing_file",
  "unexpected_file",
  "size_mismatch",
  "sha256_mismatch",
] as const;
export type BundleProblemKind = (typeof BUNDLE_PROBLEM_KINDS)[number];

/**
 * 照合で見つかった 1 つの食い違い。**呼ぶ側が種類（`kind`）で分けられる**ようにする
 * （`detail` は人が読む補足で、判定には使わない）。
 */
export type BundleProblem =
  | { readonly kind: "unsafe_path"; readonly path: string; readonly detail: string }
  | { readonly kind: "missing_file"; readonly path: string; readonly detail: string }
  | { readonly kind: "unexpected_file"; readonly path: string; readonly detail: string }
  | {
      readonly kind: "size_mismatch";
      readonly path: string;
      readonly detail: string;
      readonly expected_bytes: number;
      readonly actual_bytes: number;
    }
  | {
      readonly kind: "sha256_mismatch";
      readonly path: string;
      readonly detail: string;
      readonly expected_sha256: string;
      readonly actual_sha256: string;
    };

/** 照合の結果。`problems` が空なら合格。`manifestSha256` は manifest 自身のバイト列の SHA-256。 */
export interface BundleManifestVerification {
  /** manifest（`bundle-manifest.json`）のバイト列の SHA-256。小文字の 16 進 64 桁。pins との比較は呼ぶ側 */
  readonly manifestSha256: string;
  /** 読んだ manifest。呼ぶ側が `instrument`・`expected_verdict` などを読める */
  readonly manifest: BundleManifest;
  /** 過不足・値の食い違い・ディレクトリの外を指すパス。空なら合格 */
  readonly problems: readonly BundleProblem[];
}

// ── manifest 自体が使えないときの失敗（理由つき）─────────────────

export const BUNDLE_MANIFEST_ERROR_CODES = [
  "manifest_unreadable",
  "manifest_invalid_json",
  "manifest_schema_mismatch",
  "manifest_malformed",
] as const;
export type BundleManifestErrorCode = (typeof BUNDLE_MANIFEST_ERROR_CODES)[number];

/**
 * manifest 自体が読めない・形が違うときの失敗。**呼ぶ側が例外の文言に依存しない**ようにコードで分ける。
 * ファイル単位の食い違いはここではなく `BundleManifestVerification.problems` で返す。
 */
export class BundleManifestError extends Error {
  readonly code: BundleManifestErrorCode;

  constructor(code: BundleManifestErrorCode, message: string) {
    super(message);
    this.name = "BundleManifestError";
    this.code = code;
  }
}

// ── バイト列の SHA-256（Node でも Worker でも動く）────────────────

const decoder = new TextDecoder();

/** バイト列の SHA-256（小文字の 16 進 64 桁）。`crypto.subtle` を使うので依存を増やさない。 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// ── パスの安全検査 ───────────────────────────────────────────────

/**
 * `files` のパスが、納品物のディレクトリの内側を指す相対パスか。**外を指すものは断る**。
 *   - 空・絶対パス（`/` で始まる・UNC の `\\`・ドライブ文字 `C:`）
 *   - `.`・`..`・空の要素（`a//b`）を含むもの
 * 区切りは `/` と `\` の両方を見る（`..\x` のような書き方も外を指し得るため）。
 */
function isSafeRelativePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/u.test(path)) return false;
  return path.split(/[\\/]/u).every((part) => part !== "" && part !== "." && part !== "..");
}

// ── manifest の読解（形を信用しない）─────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string") throw new BundleManifestError("manifest_malformed", `${field} が文字列でない`);
  return value;
};

function readManifestFile(value: unknown, index: number): BundleManifestFile {
  if (!isRecord(value)) throw new BundleManifestError("manifest_malformed", `files[${index}] が写像でない`);
  const size = value["size_bytes"];
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    throw new BundleManifestError("manifest_malformed", `files[${index}].size_bytes が非負の整数でない`);
  }
  return {
    path: requireString(value["path"], `files[${index}].path`),
    sha256: requireString(value["sha256"], `files[${index}].sha256`),
    size_bytes: size,
  };
}

function readInstrument(value: unknown): BundleManifestInstrument {
  if (!isRecord(value)) throw new BundleManifestError("manifest_malformed", "instrument が写像でない");
  return {
    binary_sha256: requireString(value["binary_sha256"], "instrument.binary_sha256"),
    verification_profile: requireString(value["verification_profile"], "instrument.verification_profile"),
  };
}

/** 読んだ JSON を manifest（v1）として読む。形が違えば `BundleManifestError` にする。 */
function readBundleManifest(value: unknown): BundleManifest {
  if (!isRecord(value)) throw new BundleManifestError("manifest_malformed", "manifest が写像でない");
  const schemaVersion = requireString(value["schema_version"], "schema_version");
  if (schemaVersion !== BUNDLE_MANIFEST_SCHEMA_VERSION) {
    throw new BundleManifestError("manifest_schema_mismatch", `対応しない schema_version: ${schemaVersion}`);
  }
  const files = value["files"];
  if (!Array.isArray(files)) throw new BundleManifestError("manifest_malformed", "files が並びでない");
  return {
    schema_version: schemaVersion,
    storage_unit: requireString(value["storage_unit"], "storage_unit"),
    source_run: requireString(value["source_run"], "source_run"),
    artifact_level: requireString(value["artifact_level"], "artifact_level"),
    expected_verdict: requireString(value["expected_verdict"], "expected_verdict"),
    instrument: readInstrument(value["instrument"]),
    files: files.map(readManifestFile),
  };
}

// ── Node 側（ファイルから読む）────────────────────────────────────
//
// 使う関数の形だけをここに宣言し、動的に読む（packages/appspec-schema/src/contract.ts と同じ）。

interface NodeDirent {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

interface NodeFs {
  readdirSync(path: string, options: { withFileTypes: true }): readonly NodeDirent[];
  readFileSync(path: string): Uint8Array;
}

interface NodePath {
  join(...parts: readonly string[]): string;
}

const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);

async function nodeModules(): Promise<{ readonly fs: NodeFs; readonly path: NodePath }> {
  const [fs, path] = (await Promise.all([importUntyped("node:fs"), importUntyped("node:path")])) as [
    NodeFs,
    NodePath,
  ];
  return { fs, path };
}

/** 納品物の配下の通常ファイルを、直下からの相対 posix パスで再帰的に集める（manifest 自身も含む）。 */
function listBundleFiles(fs: NodeFs, path: NodePath, root: string): readonly string[] {
  const found: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(directory, entry.name), relative);
      else if (entry.isFile()) found.push(relative);
    }
  };
  walk(root, "");
  return found.sort();
}

// ── 公開の入口 ────────────────────────────────────────────────────

/**
 * 納品物のディレクトリを受け取り、`bundle-manifest.json` を読んで、`files` のすべてについて
 * SHA-256 と大きさを照合する。manifest 自身の SHA-256 も返す（pins との比較は呼ぶ側）。
 *
 * manifest 自体が読めない・形が違うときは `BundleManifestError` を投げる。ファイル単位の食い違い
 * （過不足・値の食い違い・ディレクトリの外を指すパス）は、例外にせず `problems` に理由つきで並べる。
 */
export async function verifyBundleManifest(directory: string): Promise<BundleManifestVerification> {
  const { fs, path } = await nodeModules();

  let bytes: Uint8Array;
  try {
    bytes = fs.readFileSync(path.join(directory, BUNDLE_MANIFEST_FILE));
  } catch {
    throw new BundleManifestError(
      "manifest_unreadable",
      `納品物の直下に ${BUNDLE_MANIFEST_FILE} が無い、または読めない`,
    );
  }
  // manifest 自身の SHA-256 は、**ファイルのバイト列**から求める（pins の値と比べるのは呼ぶ側）
  const manifestSha256 = await sha256Hex(bytes);

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    throw new BundleManifestError("manifest_invalid_json", `${BUNDLE_MANIFEST_FILE} が JSON として読めない`);
  }
  const manifest = readBundleManifest(parsed);

  const actualFiles = listBundleFiles(fs, path, directory);
  const actual = new Set(actualFiles);
  const declared = new Set<string>();
  const problems: BundleProblem[] = [];

  for (const entry of manifest.files) {
    if (!isSafeRelativePath(entry.path)) {
      problems.push({ kind: "unsafe_path", path: entry.path, detail: "納品物のディレクトリの外を指すパス" });
      continue;
    }
    declared.add(entry.path);
    if (!actual.has(entry.path)) {
      problems.push({ kind: "missing_file", path: entry.path, detail: "manifest にあるが、納品物に無い" });
      continue;
    }
    const fileBytes = fs.readFileSync(path.join(directory, ...entry.path.split("/")));
    if (fileBytes.byteLength !== entry.size_bytes) {
      problems.push({
        kind: "size_mismatch",
        path: entry.path,
        detail: "大きさが manifest と違う",
        expected_bytes: entry.size_bytes,
        actual_bytes: fileBytes.byteLength,
      });
    }
    const observed = await sha256Hex(fileBytes);
    if (observed !== entry.sha256) {
      problems.push({
        kind: "sha256_mismatch",
        path: entry.path,
        detail: "SHA-256 が manifest と違う",
        expected_sha256: entry.sha256,
        actual_sha256: observed,
      });
    }
  }

  // manifest に無いファイルを返す。**manifest 自身は納品物の一部だが、`files` には数えない**
  // （工場の `community_bundle.py` の inventory が `bundle-manifest.json` を除いて作られる）
  for (const relative of actualFiles) {
    if (relative !== BUNDLE_MANIFEST_FILE && !declared.has(relative)) {
      problems.push({ kind: "unexpected_file", path: relative, detail: "納品物にあるが、manifest に無い" });
    }
  }

  return { manifestSha256, manifest, problems };
}
