# デモと振り返り（マイルストーンごと）

> ロードマップの決まり（[`../roadmap.md`](../roadmap.md) §1）：**1 マイルストーンが終わったら、スマホで動かして見せ、何がうまくいき何を学んだかを 5 行で残す。**
> 実機での確認は人が行う（🧑 の Issue）。機械で確かめられる分は、その前に CI と e2e が見ている。
> **staging のオリジンは書かない**（`staging` 環境の Secret `SMOKE_BASE_URL`。`CLAUDE.md`「このリポジトリは public である」）。

---

## M1.1 宣言からフォームと一覧が出る（2026-09-17 合格）

| 項目 | 内容 |
|---|---|
| 着手日 | 2026-09-16（Issue #96〜#105 を起票した日） |
| 完了日 | **2026-09-17** |
| 実装の Issue | #96・#97・#98・#99・#100・#101・#102・#103・#104（9 本すべて merge 済み） |
| デモの Issue | #105（この記録） |
| 見たもの | 見本「支出の記録」（`packages/appspec-schema/samples/expense-log/`）。版 `community.app-spec/v0.2-draft`、原本 SHA `241be2dc…` |
| インスタンス | `m11-demo-expense-log`（staging。`publish` で配置） |
| 端末 | **Android / Chrome**（所有者のスマートフォン） |

### 確かめたこと

| # | 操作 | 結果 |
|---|---|---|
| 1 | staging の `/apps/m11-demo-expense-log` を開く | フォーム 5 項目（description・amount・discount・payer・participants）と「まだ記録がありません」が出た。360px 幅で崩れない |
| 2 | 夕食 6,600 円・割引 600 円・払った人 A・割る人 A/B/C | 一覧に出て、**1 人あたり 2,000 円** |
| 3 | タクシー 3,000 円・割引 0・払った人 B・割る人 A/B/C | **1 人あたり 1,000 円** |
| 4 | 金額 0 で追加 | 断られ、検査名が画面に出る（保存されない） |
| 5 | 再読み込み・PC の別ブラウザ | **2 件とも残っている**（DO に保存されている） |

### 機械で採った証跡（2026-09-17）

staging の host に対する読み取り（URL は出さない）。

```
GET /healthz                                        → 200
GET /api/instances/m11-demo-expense-log/spec        → 200  schemaVersion=community.app-spec/v0.2-draft
GET /api/instances/m11-demo-expense-log/views/expenseList → 200  rows=2
  夕食     amount=6600 discount=600 payer=A participants=[A,B,C]  paidAmount=6000 headcount=3 shareAmount=2000
  タクシー amount=3000 discount=0   payer=B participants=[A,B,C]  paidAmount=3000 headcount=3 shareAmount=1000
```

ブラウザ → host → gateway → data-api → R2 / D1 / DO が staging で通ったことの証跡でもある（#103 の完了条件から引き継いだ宿題）。

### 振り返り（5 行）

1. **宣言 1 枚から、画面・検査・計算・保存まで通った。** 手で書いた YAML が、そのままスマホで動くアプリになった
2. **契約を先に固める順番が効いた。** #96 で型・見本・負例・意味・台帳を揃えたので、後続の 8 本は「その上に積む」だけで済み、解釈の食い違いが出なかった
3. **並列開発の詰まりは、ツールではなく Issue の書き方だった。** `## 対象ファイル` の具体名・素の依存・地の文にパスを書かないという形を守れば、plan は通り dispatch は止まらない
4. **人の手が要ったのは 3 か所**：auto-yes の入れ直し、merge の承認（運用文書）、実機のスマホ確認。ほかは窓口 → 管理 → ワーカーで回った
5. **次に効きそうなこと**：BEHIND の往復は「逐次で回す」か「先に文書 PR を merge する」で減らせる。語彙が増える M1.2 は、1 Issue に語彙 1〜2 個の粒度を守る

### 残っていること（M1.2 以降へ）

- 表示名（`label`）とアプリ名は M1.2（#106）で入る。いまは項目名が英語のまま、タイトルはインスタンス ID
- 採点のシナリオの e2e を staging で回す仕組みは #110（`deploy-staging` の貫通スモークのあと）
- `/api` の CPU 時間の実測と P-7 の判定は #111
