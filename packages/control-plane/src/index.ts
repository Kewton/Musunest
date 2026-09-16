// control-plane（D1 専用）：宣言の登録と、登録の読み書き。
//
// M1.1 で置くのは、宣言（原本の SHA-256 で識別）と、その宣言を使うインスタンスの登録表である（#100）。
// Better Auth / User / Community / Membership / AppGrant は M2 以降。
//
// D1 を実際に触るのは data-api だけ（CLAUDE.md 不変条件）。ここは SQL と引数の束縛、行の読み取りを持ち、
// 実行は注入された RegistryExecutor（src/contract.ts）が行う。公開契約に Cloudflare の型は出さない。
export const PACKAGE_NAME = "@musunest/control-plane" as const;

export * from "./contract.js";
export * from "./registry.js";
