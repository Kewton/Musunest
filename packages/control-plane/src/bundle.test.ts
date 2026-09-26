// 納品物の manifest の照合の受入試験（Issue #247）。
//
// **工場の実物のファイルは使わない。** テストの中で作った小さな納品物（一時ディレクトリ）で、
//   1. manifest のすべてのファイルの SHA-256 と大きさを照合し、manifest 自身の SHA-256 を返す（受入条件 1・3）
//   2. manifest に無いファイル・manifest にあって無いファイル・大きさの食い違い・SHA-256 の食い違いを、
//      それぞれ理由（kind）つきで返す（受入条件 2）
//   3. `..` や絶対パスでディレクトリの外を指すパスを断る（受入条件 2）
//   4. manifest 自体が読めない・形が違うときは、コードつきの例外にする
// を確かめる。
//
// node:fs・node:os・node:path は Node 組み込みで、src の tsconfig の types は workers-types だけなので、
// 使う形だけをここに書いて**動的**に読む（publish.test.ts と同じやり方）。
import { afterEach, describe, expect, it } from "vitest";
import {
  BUNDLE_MANIFEST_FILE,
  BUNDLE_MANIFEST_SCHEMA_VERSION,
  BundleManifestError,
  verifyBundleManifest,
  type BundleManifestFile,
} from "./bundle.js";

// ── Node 組み込みの最小の形 ──────────────────────────────────────

interface FsModule {
  mkdtempSync(prefix: string): string;
  mkdirSync(path: string, options: { readonly recursive: true }): void;
  writeFileSync(path: string, data: string): void;
  rmSync(path: string, options: { readonly recursive: true; readonly force: true }): void;
}
interface OsModule {
  tmpdir(): string;
}
interface PathModule {
  join(...parts: readonly string[]): string;
}

const importUntyped = (specifier: string) => import(/* @vite-ignore */ specifier);
const [{ mkdtempSync, mkdirSync, writeFileSync, rmSync }, { tmpdir }, { join }] = (await Promise.all([
  importUntyped("node:fs"),
  importUntyped("node:os"),
  importUntyped("node:path"),
])) as [FsModule, OsModule, PathModule];

const encoder = new TextEncoder();
const sha256Hex = async (bytes: Uint8Array): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

// ── 一時ディレクトリに小さな納品物を作る道具 ──────────────────────

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function newBundleRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "musunest-bundle-"));
  roots.push(root);
  return root;
}

function writeBundleFile(root: string, relative: string, content: string): void {
  const parts = relative.split("/");
  if (parts.length > 1) mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(join(root, ...parts), content);
}

/** ファイルを書いて、manifest の 1 項目（相対パス・SHA-256・大きさ）を作る */
async function writeEntry(root: string, relative: string, content: string): Promise<BundleManifestFile> {
  const bytes = encoder.encode(content);
  writeBundleFile(root, relative, content);
  return { path: relative, sha256: await sha256Hex(bytes), size_bytes: bytes.byteLength };
}

/** manifest（`bundle-manifest.json`）を書く。書いた本文（バイト列の元）を返す */
function writeManifest(root: string, files: readonly BundleManifestFile[], schemaVersion: string = BUNDLE_MANIFEST_SCHEMA_VERSION): string {
  const manifest = {
    schema_version: schemaVersion,
    storage_unit: "R2_delivery_unit",
    source_run: "e_test_001",
    artifact_level: "L2",
    expected_verdict: "full",
    instrument: { binary_sha256: "b".repeat(64), verification_profile: "community-mini-app" },
    files,
  };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(root, BUNDLE_MANIFEST_FILE), text);
  return text;
}

const kinds = (result: Awaited<ReturnType<typeof verifyBundleManifest>>) => result.problems.map((problem) => problem.kind);

// ── 受入条件 1・3：照合と、manifest 自身の SHA-256 ────────────────

describe("verifyBundleManifest（照合）", () => {
  it("全ファイルの SHA-256 と大きさを照合し、manifest 自身の SHA-256（バイト列）を返す", async () => {
    const root = newBundleRoot();
    const spec = await writeEntry(root, "artifacts/app.spec.yaml", "entities: []\n");
    const summary = await writeEntry(root, "summary.json", '{ "verdict": "full" }\n');
    const manifestText = writeManifest(root, [spec, summary]);

    const result = await verifyBundleManifest(root);

    expect(result.problems).toEqual([]);
    expect(result.manifestSha256).toBe(await sha256Hex(encoder.encode(manifestText)));
    expect(result.manifest.schema_version).toBe(BUNDLE_MANIFEST_SCHEMA_VERSION);
    expect(result.manifest.expected_verdict).toBe("full");
    expect(result.manifest.instrument.verification_profile).toBe("community-mini-app");
    expect(result.manifest.files.map((file) => file.path)).toEqual(["artifacts/app.spec.yaml", "summary.json"]);
  });

  it("manifest 自身は「manifest に無いファイル」に数えない", async () => {
    const root = newBundleRoot();
    const entry = await writeEntry(root, "a.txt", "a\n");
    writeManifest(root, [entry]);

    const result = await verifyBundleManifest(root);

    expect(result.problems).toEqual([]);
  });
});

// ── 受入条件 2：過不足・食い違い・外を指すパス ────────────────────

describe("verifyBundleManifest（食い違いを理由つきで返す）", () => {
  it("manifest に無いファイルを unexpected_file で返す", async () => {
    const root = newBundleRoot();
    const entry = await writeEntry(root, "a.txt", "a\n");
    writeManifest(root, [entry]);
    writeBundleFile(root, "extra.txt", "x\n");

    const result = await verifyBundleManifest(root);

    expect(result.problems).toEqual([{ kind: "unexpected_file", path: "extra.txt", detail: expect.any(String) }]);
  });

  it("manifest にあって無いファイルを missing_file で返す", async () => {
    const root = newBundleRoot();
    writeManifest(root, [{ path: "gone.yaml", sha256: "0".repeat(64), size_bytes: 3 }]);

    const result = await verifyBundleManifest(root);

    expect(result.problems).toEqual([{ kind: "missing_file", path: "gone.yaml", detail: expect.any(String) }]);
  });

  it("大きさの食い違いを size_mismatch で返す（SHA-256 は正しい）", async () => {
    const root = newBundleRoot();
    const bytes = encoder.encode("hello");
    writeBundleFile(root, "a.bin", "hello");
    writeManifest(root, [{ path: "a.bin", sha256: await sha256Hex(bytes), size_bytes: bytes.byteLength + 1 }]);

    const result = await verifyBundleManifest(root);

    expect(result.problems).toEqual([
      {
        kind: "size_mismatch",
        path: "a.bin",
        detail: expect.any(String),
        expected_bytes: 6,
        actual_bytes: 5,
      },
    ]);
  });

  it("SHA-256 の食い違いを sha256_mismatch で返す（大きさは正しい）", async () => {
    const root = newBundleRoot();
    const bytes = encoder.encode("hello");
    writeBundleFile(root, "a.bin", "hello");
    writeManifest(root, [{ path: "a.bin", sha256: "0".repeat(64), size_bytes: bytes.byteLength }]);

    const result = await verifyBundleManifest(root);

    expect(result.problems).toEqual([
      {
        kind: "sha256_mismatch",
        path: "a.bin",
        detail: expect.any(String),
        expected_sha256: "0".repeat(64),
        actual_sha256: await sha256Hex(bytes),
      },
    ]);
  });

  it("`..` と絶対パスを unsafe_path で断る（過不足には数えない）", async () => {
    const root = newBundleRoot();
    const good = await writeEntry(root, "good.txt", "g\n");
    writeManifest(root, [
      good,
      { path: "../escape.yaml", sha256: "0".repeat(64), size_bytes: 0 },
      { path: "/etc/passwd", sha256: "0".repeat(64), size_bytes: 0 },
    ]);

    const result = await verifyBundleManifest(root);

    expect(kinds(result)).toEqual(["unsafe_path", "unsafe_path"]);
    expect(result.problems.map((problem) => problem.path)).toEqual(["../escape.yaml", "/etc/passwd"]);
  });
});

// ── manifest 自体が使えないとき ───────────────────────────────────

async function expectCode(root: string, code: string): Promise<void> {
  const thrown = await verifyBundleManifest(root).catch((error: unknown) => error);
  expect(thrown).toBeInstanceOf(BundleManifestError);
  expect((thrown as BundleManifestError).code).toBe(code);
}

describe("verifyBundleManifest（manifest 自体が使えないとき）", () => {
  it("manifest が無ければ manifest_unreadable", async () => {
    await expectCode(newBundleRoot(), "manifest_unreadable");
  });

  it("manifest が JSON でなければ manifest_invalid_json", async () => {
    const root = newBundleRoot();
    writeBundleFile(root, BUNDLE_MANIFEST_FILE, "{ not json\n");
    await expectCode(root, "manifest_invalid_json");
  });

  it("schema_version が違えば manifest_schema_mismatch", async () => {
    const root = newBundleRoot();
    writeManifest(root, [], "commandagent.community-delivery-bundle/v0");
    await expectCode(root, "manifest_schema_mismatch");
  });

  it("files の形が違えば manifest_malformed", async () => {
    const root = newBundleRoot();
    writeBundleFile(
      root,
      BUNDLE_MANIFEST_FILE,
      `${JSON.stringify({
        schema_version: BUNDLE_MANIFEST_SCHEMA_VERSION,
        storage_unit: "R2_delivery_unit",
        source_run: "e_test_001",
        artifact_level: "L2",
        expected_verdict: "full",
        instrument: { binary_sha256: "b".repeat(64), verification_profile: "community-mini-app" },
        files: [{ path: "a.txt", sha256: "0".repeat(64), size_bytes: "3" }],
      })}\n`,
    );
    await expectCode(root, "manifest_malformed");
  });
});
