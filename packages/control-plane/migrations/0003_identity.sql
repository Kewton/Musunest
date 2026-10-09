-- Migration number: 0003 	 2026-10-08T00:00:00.000Z
--
-- users / communities / community_memberships / instance_owners … 利用者・Community・所属・
-- インスタンスの持ち主の登録（#259）。ログインした人と、その人が持ち主の Community、その
-- Community の持ち物であるインスタンスを、ここで対応づける。
--
-- 前方互換規律（docs/runbook/d1-migration.md §4）に沿った形で書く：
--   - 表を足すだけ。1つ前のコード（apps / app_instances と _musunest_meta しか使わない
--     data-api の healthz は SELECT 1 だけ）はそのまま動く
--   - 主キーと NOT NULL、created_at の DEFAULT 付き。書く側は主キーと本文だけで足りる
--   - 外部キーは張らない（0002 と同じ規律）。SQLite の PRAGMA foreign_keys は接続ごとに決まるので、
--     「未登録の Community・未登録のインスタンスを指す行を拒否する」は src/identity.ts の
--     INSERT ... WHERE EXISTS で行う
--   - SQL と引数の束縛、行の読み取りは src/identity.ts に集める。読み書きは列名を書く（SELECT * を使わない。§4.3）
--
-- 決定（2026-10-08 所有者）：初めてのログインで Community を 1 人に 1 つ作り、名前は Google の
-- 表示名から付ける。増やすのは M2.3 以降。だから communities.owner_user_id と
-- community_memberships（role = 'owner'）で持ち主を表す。
--
-- 適用は data-api の設定で行う（CONTROL_DB を binding しているのが data-api だけのため）。
--   pnpm exec wrangler d1 migrations apply CONTROL_DB --env <env> --config packages/data-api/wrangler.jsonc [--local|--remote]

CREATE TABLE IF NOT EXISTS users (
  user_id        TEXT NOT NULL PRIMARY KEY,
  google_subject TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS communities (
  community_id  TEXT NOT NULL PRIMARY KEY,
  name          TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS community_memberships (
  community_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  role         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (community_id, user_id)
);

CREATE TABLE IF NOT EXISTS instance_owners (
  instance_id  TEXT NOT NULL PRIMARY KEY,
  community_id TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
