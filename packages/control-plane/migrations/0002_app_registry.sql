-- Migration number: 0002 	 2026-09-16T00:00:00.000Z
--
-- apps / app_instances … 宣言（app.spec.yaml）と、その宣言を使うインスタンスの登録（#100）。
-- D1 は Control Plane 専用である（CLAUDE.md 不変条件）。アプリの入力レコードや computed は
-- ここに持たない。それは Durable Object（SQLite）にある（workspace/mvp/m1/README.md §4）。
--
-- 前方互換規律（docs/runbook/d1-migration.md §4）に沿った形で書く：
--   - 表を足すだけ。1つ前のコード（_musunest_meta しか使わない data-api の healthz は SELECT 1 だけ）はそのまま動く
--   - 主キーと NOT NULL、created_at の DEFAULT 付き。書く側は主キーと本文だけで足りる
--   - 外部キーは張らない。SQLite の PRAGMA foreign_keys は接続ごとに決まり、
--     「未登録のアプリを指す行を拒否する」は src/registry.ts の INSERT ... WHERE EXISTS で行う（§4.3 の「知らない列・行を拒否しない」書き方と同じ層）
--   - SQL と引数の束縛、行の読み取りは src/registry.ts に集める。読み書きは列名を書く（SELECT * を使わない。§4.3）
--
-- 適用は data-api の設定で行う（CONTROL_DB を binding しているのが data-api だけのため）。
--   pnpm exec wrangler d1 migrations apply CONTROL_DB --env <env> --config packages/data-api/wrangler.jsonc [--local|--remote]

CREATE TABLE IF NOT EXISTS apps (
  source_sha256  TEXT NOT NULL PRIMARY KEY,
  schema_version TEXT NOT NULL,
  source_key     TEXT NOT NULL,
  normalized_key TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS app_instances (
  instance_id   TEXT NOT NULL PRIMARY KEY,
  source_sha256 TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
