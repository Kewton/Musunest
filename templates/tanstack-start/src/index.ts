// テンプレート。M1 で中身
// M0 では中身を持たない。依存の向きだけを固定する（01-repo-bootstrap.md §3.2）。
// M1 で core/・sdk/・app-zone/ の境界と、決定的な tarball を作るコマンドを持つ（Issue #229）。

export const PACKAGE_NAME = "@musunest/template-tanstack-start" as const;

export * from "./pack.js";
