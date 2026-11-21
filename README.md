# MUSUNEST

スマホで「こんなアプリがほしい」と伝えると、数分でアプリができて、そのまま仲間と使える——を目指すプロダクトのモノレポです。

**状態：MVP を開発中です。** まだ一般には使えません。今どこにいるかは [ロードマップ](workspace/mvp/roadmap.md) の §3 にあります。

## 構成

TypeScript と Cloudflare Workers で作っています。

| 場所 | 中身 |
|---|---|
| `apps/host` | 画面の入口（SPA のシェルを配る Worker） |
| `apps/gateway` | 認証と権限の検査の入口（Worker） |
| `packages/data-api` | データへの唯一の入口。権限はここだけで強制する（外から直接は届かない内部の Worker） |
| `packages/app-do` | アプリのデータを持つ Durable Object（SQLite） |
| `packages/control-plane` | 利用者・コミュニティ・権限の登録（D1） |
| `packages/appspec-schema` | アプリの宣言の型（正本） |
| `packages/spec-engine` | 宣言の検査と評価 |
| `packages/sdk` | アプリからデータと通知に触れるための SDK |
| `packages/factory` | 指示からアプリの宣言を作る工場 |
| `packages/connector` | 外部との連携（まだ空） |
| `studio/` | 手元で工場を動かす工房（配らない） |
| `e2e/` | 端から端までの試験 |
| `infra/` | Terraform とデプロイの道具 |
| `workspace/` | 設計・計画・計測の記録 |

パッケージの依存の向きは決まっていて、`pnpm lint` が機械的に確かめます（正本は `infra/scripts/dep-graph.mjs`。説明は [CLAUDE.md](CLAUDE.md) の「依存の向き」）。

## 使い方

Node.js 24 以上が要ります。pnpm は corepack が用意します。

```bash
pnpm install
pnpm check    # verify-parity → lint → typecheck → test（PR の前に必ず通す）
pnpm build
```

Terraform のゲートを手元で通すには tfenv が要ります（版は `.terraform-version`）。

## 開発の進め方

- 決まりごとは [CLAUDE.md](CLAUDE.md) にあります（AI のエージェントも人も、まずここを読みます）
- 作業は必ず Issue から始め、PR は squash merge だけです
- Issue ごとに並べて進める手順は [docs/parallel-development.md](docs/parallel-development.md) にあります

## ライセンス

[MIT](LICENSE)
