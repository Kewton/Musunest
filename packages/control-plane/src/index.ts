// control-plane（D1 専用）：宣言の登録と、登録の読み書き。publish の中身も持つ（#101）。
//
// M1.1 で置くのは、宣言（原本の SHA-256 で識別）と、その宣言を使うインスタンスの登録表（#100）と、
// 検査 → 正規化 → R2 → D1 の publish（#101）である。M2.1 で、利用者・Community・所属・
// インスタンスの持ち主の登録表（#259）を足した（src/identity.ts）。
//
// D1 を実際に触るのは data-api だけ（CLAUDE.md 不変条件）。ここは SQL と引数の束縛、行の読み取りを持ち、
// 実行は注入された RegistryExecutor（src/contract.ts）が行う。R2 への書き込みは注入された SpecWriter が行う。
// 公開契約に Cloudflare の型は出さない。
export const PACKAGE_NAME = "@musunest/control-plane" as const;

export * from "./bundle.js";
export * from "./bundle-publish.js";
export * from "./contract.js";
export * from "./headless.js";
export * from "./identity.js";
export * from "./publish.js";
export * from "./registry.js";
