# 02：L2 の宣言の具体例（割り勘・タスク管理・ダッシュボード）

> 状態：**叩き台**（2026-09-15 作成）。D1「サンプルアプリの形」（[`01-integration-strategy.md`](./01-integration-strategy.md) §6）を決めるための具体例として書いた。所有者はこれを見て、**L2 の宣言を手で書く形に決めた**。
> 見本を 3 つ（割り勘・タスク管理・ダッシュボード）にするのも所有者の決定（同 D2・D3）。
> **YAML の書き方は、イメージを掴むための叩き台である。** 正式な形は段階 2（契約を固める）で、見本を実際に動かしながら決める。
> **2026-09-19 追記：正本は `packages/appspec-schema/samples/` にある動く見本である。**
> §3（タスク管理）は、実際に動く見本に合わせて書き直した（#169）。**§2（割り勘）と §4（ダッシュボード）の YAML は叩き台のままで、いまの語彙では書けない書き方を含む**——それぞれの節に差分の表を置いた。
> **この叩き台は、層構造（[`03-spec-layers-and-checker.md`](./03-spec-layers-and-checker.md)）で見直す点がある**：操作の条件（`when`）はロジック層の守りとして扱う（`03` §2.2）。精算は「計算する関数」と「見せる部品」に分ける（`03` §2.3）。

---

## 0. 一言でいうと

- **L2 のアプリは、「何を記録するか・どう計算するか・どう見せるか・誰が触れるか」を 1 枚の YAML（`app.spec.yaml`）に書いたもの**である。コードは書かない。
- 店頭（MUSUNEST）がその YAML を読んで、入力フォーム・一覧・集計・画面を作り、入力を検査して保存する。
- 近いのは、表計算ソフトで「列」と「集計の式」と「グラフ」を決める作業である。それが、そのまま仲間と使えるアプリになる。
- 工場（CommandAgent）が作るのも、この YAML 1 枚だけである。**小さいので検査しやすく、ビルドも要らない。** だから数分で届けられる。

```mermaid
flowchart LR
  REQ["指示<br/>「旅行の割り勘アプリがほしい」"] --> YAML["app.spec.yaml<br/>（宣言 1 枚）"]
  YAML -- "R2 に置いて台帳に登録" --> TENTO["店頭<br/>宣言を読んで画面と保存の仕組みを作る"]
  TENTO --> PHONE["スマホの画面"]
```

M1a では、左端の「指示 → YAML」を人が手で書く。M1b で、そこを工場に任せる。

---

## 1. 宣言の 7 つの欄と、店頭がすること

| 欄 | 書くこと | 店頭がすること |
|---|---|---|
| `entities` | 記録するもの（支出・タスク…）と、その項目（`fields`） | 入力フォームを作る。項目の型を検査して、アプリのデータとして DO に保存する |
| `validations` | 保存してよい条件（金額は 1 円以上、など） | 保存の前に検査する。通らなければ、書いてある文言を画面に出す |
| `computed` | 自動で計算する値（1 人あたりの額、合計、件数…） | 計算して画面に出す（保存はしない） |
| `views` | 画面の種類と、そこに出す項目（一覧・表・ボード・ダッシュボード…） | 画面を作る。1 つの view が 1 つのタブになる |
| `actions` | 利用者が押せる操作（追加・直す・消す・完了にする…） | ボタンを作り、押されたら権限を確かめて実行する |
| `permissions` | 誰が読めるか・書けるか | data-api が強制する |
| `minIdentity` | 使うのに最低限必要な本人確認 | M1 はログインが無いので `anonymous`（URL を知っている人は誰でも使える。README §7.3） |

- 見本では、アプリの表示名を書く `app` 欄も足した（v0.1 には無い）
- `id`・作った日時（`createdAt`）・直した日時は、店頭が自動で付ける。宣言には書かない
- 画面の部品（一覧・ボード・グラフ…）は**店頭が用意する**。宣言は、その中から選んで項目を当てはめるだけである

---

## 2. 見本 1：割り勘

> **2026-09-19 追記（#169）：この YAML は叩き台のままである。** 動く正本は
> [`packages/appspec-schema/samples/warikan/app.spec.yaml`](../../../packages/appspec-schema/samples/warikan/app.spec.yaml) にある。
> **書き直していないのは、割り勘の見本が M1.2 で動いており、この節の役目（なぜこの形にしたか）は果たしているから**である。
> 下の 4 つは**いまの語彙に無い**ので、そのまま書くと静的チェックで落ちる。
>
> | 叩き台の書き方 | いまの語彙 |
> |---|---|
> | `app: { name: ... }` | **無い**（トップレベルは 7 欄で固定） |
> | `label:` | **無い**（画面には識別子がそのまま出る） |
> | `required: true` | **無い**（いまは全項目が必須） |
> | `sort: { by: createdAt, order: desc }` | **無い**（行は登録した順） |

README §0.1 のユーザーシナリオと同じアプリである。

### 2.1 画面のイメージ

```text
旅行の割り勘
 [支出]  [収支]  [精算]              ← views の 3 つがタブになる
─────────────────────────
精算
  C さん → A さん   3,000 円         ← views: settlement（店頭の「精算」部品）
─────────────────────────
 ＋ 支出を入れる                     ← actions: addExpense
```

「支出を入れる」を押すと、`expense` の `fields` からフォームができる。

```text
支出を入れる
  内容        [ 夕食         ]
  金額（円）  [ 6000         ]       ← 0 以下なら「金額は 1 円以上にしてください」
  払った人    ( A さん ▼ )           ← type: ref（メンバーから 1 人選ぶ）
  割る人      [x] A  [x] B  [x] C    ← type: list（メンバーから複数選ぶ）
  [ 保存 ]
```

### 2.2 宣言

```yaml
app:
  name: 旅行の割り勘

entities:
  - name: member
    label: メンバー
    fields:
      name: { type: string, label: 名前, required: true }

  - name: expense
    label: 支出
    fields:
      description:  { type: string, label: 内容, required: true }
      amount:       { type: number, label: 金額（円）, required: true }
      payer:        { type: ref, to: member, label: 払った人, required: true }
      participants: { type: list, of: member, label: 割る人, required: true }

validations:
  - name: positiveAmount
    entity: expense
    expression: amount > 0
    message: 金額は 1 円以上にしてください
  - name: someoneShares
    entity: expense
    expression: len(participants) > 0
    message: 割る人を 1 人以上選んでください

computed:
  # 支出 1 件ごと（v0.1 と同じ書き方）
  - name: shareAmount
    entity: expense
    type: number
    expression: amount / len(participants)

  # メンバーごと（v0.1 では書けない。支出をまたいで集計する）
  - name: paid                 # 払った合計
    entity: member
    type: number
    aggregate: { sum: expense.amount, where: { payer: this } }
  - name: owed                 # 負担する合計
    entity: member
    type: number
    aggregate: { sum: expense.shareAmount, where: { participants: { contains: this } } }
  - name: balance              # 差し引き（プラスなら受け取る）
    entity: member
    type: number
    expression: paid - owed

views:
  - name: expenses
    type: list
    label: 支出
    entity: expense
    show: [description, amount, payer, shareAmount]
    sort: { by: createdAt, order: desc }
  - name: balances
    type: table
    label: 収支
    entity: member
    show: [name, paid, owed, balance]
  - name: settlement
    type: settlement           # 「誰が誰へいくら」を出す、店頭の部品
    label: 精算
    entity: member
    amount: balance

actions:
  - { name: addMember,     entity: member,  kind: create, label: メンバーを足す }
  - { name: addExpense,    entity: expense, kind: create, label: 支出を入れる }
  - { name: editExpense,   entity: expense, kind: update, label: 直す }
  - { name: deleteExpense, entity: expense, kind: delete, label: 消す }

permissions:
  - { name: read,  subject: minIdentity }
  - { name: write, subject: minIdentity }

minIdentity:
  mode: anonymous
```

**「誰が誰へいくら」は、式では書かない。** 送金の組み合わせを探す計算は、決まった形の式（ループが無い）では書けないからである。
そこで、店頭が `settlement` という部品を持ち、宣言は「メンバーごとの差し引き（`balance`）を渡す」とだけ書く。

### 2.3 採点のシナリオ（期待値）

入力：メンバー A・B・C。夕食 6,000 円（A が払い、A・B・C で割る）、タクシー 3,000 円（B が払い、A・B・C で割る）。

| 確かめるもの | 期待値 |
|---|---|
| 夕食の `shareAmount` | 2,000 |
| タクシーの `shareAmount` | 1,000 |
| A さんの `paid` / `owed` / `balance` | 6,000 / 3,000 / +3,000 |
| B さんの `paid` / `owed` / `balance` | 3,000 / 3,000 / 0 |
| C さんの `paid` / `owed` / `balance` | 0 / 3,000 / −3,000 |
| 精算 | **C さん → A さん 3,000 円**（この 1 件だけ） |

### 2.4 v0.1 から足した書き方

- アプリの表示名（`app`）を足した
- 記録するものを 2 つ（`member`・`expense`）にし、`ref` でつないだ（v0.1 の `payer` はただの文字列）
- 項目に `label`（画面の表示名）と `required` を足した
- `computed` に `aggregate`（entity をまたぐ集計）を足した。**CommandAgent の契約で「後で裁定する（QUEUED）」とされている全体参照に当たる**
- `views` に `type`（`list`・`table`・`settlement`）、`actions` に `kind`（`create`・`update`・`delete`）を足した
- `validations` に `message`、`permissions` に `write` を足した

---

## 3. 見本 2：タスク管理

旅行の準備を、3 人で分担して進めるアプリである。

### 3.1 画面のイメージ

```text
旅行の準備
 [ボード]  [一覧]  [メンバー]                 ← views
─────────────────────────
■ 未着手（1）                                 ← columns: status
  しおり作り   B さん  9/10  ⚠ 期限切れ        ← highlight: overdue
    [始める] [完了にする]                     ← actions: start・finish（when で出し分け）
■ 進行中（1）
  宿の予約     A さん  9/20
    [完了にする]
■ 完了（1）
  レンタカー   C さん  9/25
─────────────────────────
 ＋ タスクを足す
```

スマホでは、ボードの列を縦に並べる（描き方は店頭が決める）。

### 3.2 宣言

> **2026-09-19：実際に動く見本に合わせて書き直した（#169）。**
> 正本は [`packages/appspec-schema/samples/task-board/app.spec.yaml`](../../../packages/appspec-schema/samples/task-board/app.spec.yaml) である。
> 叩き台が使おうとして**書けなかった書き方**は §3.5 の表に残した。

```yaml
entities:
  - name: member
    fields:
      name: string

  - name: task
    fields:
      title: string
      status:
        type: enum
        options: { todo: 未着手, doing: 進行中, done: 完了 }
        default: todo
      assignee: { type: ref, to: member }
      due: date
      memo: string

computed:
  # 期限切れ。**Data API が解いて結果を行に載せる**（画面は式を評価しない）
  - name: overdue
    entity: task
    type: boolean
    expression: due < today()
  # 担当しているタスクの数。`this` はこのメンバーのレコードの ID である
  - name: openTasks
    entity: member
    type: number
    aggregate: { count: task, where: { assignee: this } }

views:
  # `columns` が指す選択肢のキーの順に列を作り、`highlight` が指す真偽の計算が真の行に印を付ける
  - name: board
    type: board
    entity: task
    columns: status
    highlight: overdue
  - name: list
    type: list
    entity: task
    show: [title, status, assignee, due]
    filters: [assignee, status]
  - name: members
    type: table
    entity: member
    show: [name, openTasks]

actions:
  - { name: addTask,    entity: task,   kind: create }
  - { name: editTask,   entity: task,   kind: update }
  # 始める（未着手のときだけ）。入力は対象の ID だけである（書く値は `set` が持つ）
  - { name: start,      entity: task,   kind: update, set: { status: doing }, when: status == "todo" }
  # **条件は守りである**——偽の行への操作は Data API が断る（`ACTION_NOT_ALLOWED`）
  - { name: finish,     entity: task,   kind: update, set: { status: done },  when: status != "done" }
  - { name: deleteTask, entity: task,   kind: delete }
  - { name: addMember,  entity: member, kind: create }

validations: []

permissions:
  - { name: read,  subject: minIdentity }
  - { name: write, subject: minIdentity }

minIdentity:
  mode: anonymous
```

「自分の担当だけ見る」は、M1 では書けない。ログインが無く、「自分」が決まらないからである。
M1 は `filters` で担当者を選んで絞り込む。M2 でゲスト参加（名前を選んで参加）が入れば、選んだ名前を「自分」として使える。

### 3.3 採点のシナリオ（期待値）

> **2026-09-19：実際の採点のシナリオに合わせて書き直した（#169）。**
> 正本は [`packages/appspec-schema/samples/task-board/scenario.json`](../../../packages/appspec-schema/samples/task-board/scenario.json) である。

時計を **2026-09-15 12:00（日本時間）に固定**する。入力：メンバー A・B・C。

| タスク | 担当 | 期限 | 状態 |
|---|---|---|---|
| 宿の予約 | A | 2026-09-20 | 進行中（`doing`） |
| しおり作り | B | 2026-09-10 | 未着手（`todo`） |
| レンタカー | C | 2026-09-25 | 完了（`done`） |

**断ることも採点する**（3 件。いずれも保存されない）。

| 送るもの | 断る理由 |
|---|---|
| `status: wip` | **選択肢に無い値**。その項目名を返す |
| `due` が `YYYY-MM-DD` でない | 日付の形でない |
| 存在しない担当の ID | 参照先が無い |

| 確かめるもの | 期待値 |
|---|---|
| ボードの列 | 未着手：しおり作り ／ 進行中：宿の予約 ／ 完了：レンタカー |
| `overdue` | **しおり作り だけ true** |
| `openTasks` | **A 1 ／ B 1 ／ C 1** |

> **`openTasks` は「担当しているタスクの数」であって「未完了の数」ではない。**
> 集計の `where` は `this` との一致と包含しか書けないので、状態で絞れない（§3.5）。
> だから完了済みのレンタカーを持つ C も 1 である。

**「完了にする」を押したあとの状態は、時計を差し込んだ単体テストで見る**（`scenario.json` は初期状態までを見る）。
押すと、しおり作りが「完了」の列へ移り、そのカードから「始める」「完了にする」が消える。

### 3.4 割り勘に無かった書き方

- 選択肢（`enum`）と既定値（`default`）
- 日付（`date`）と、今日の日付（`today()`）
- **真偽を返す計算**（`type: boolean`）と、**式の中の文字列の定数**（`status == "todo"`）
- 決まった値に書き換える操作（`set`）と、ボタンを出す条件（`when`）
- 画面の種類 `board`（`columns`・`highlight`）と `list`、絞り込み（`filters`）

### 3.5 叩き台が使おうとして、書けなかった書き方

**2026-09-19 に #159 で見本を起こしたときに分かった。** 叩き台は 2026-09-15 に、**語彙が 1 つも存在しない時点**で書かれている。

| 叩き台の書き方 | いまの語彙 | どうしたか |
|---|---|---|
| `app: { name: 旅行の準備 }` | **無い**（トップレベルは 7 欄で固定） | 落とした |
| `label:`（entity・項目・一覧・操作） | **無い** | 落とした。**画面には識別子（`title`・`overdue` など）がそのまま出る** |
| `required: true` | **無い** | 落とした。**いまは全項目が必須**なので、表せないのは「任意の項目」のほうである |
| `sort: { by: due, order: asc }` | **無い** | 落とした。行は登録した順である |
| `card: [title, assignee, due]` | **無い** | 落とした。カードは項目を全部出す |
| `due != null and due < today() and status != "done"` | **`and` も `null` も無い** | `due < today()` にした。**完了済みでも期限を過ぎていれば強調される** |
| `where: { status: { not: done } }` | **集計の `where` は `equals` と `contains` だけ** | 「担当している数」にした |

**この表は消さない。** 語彙を足すかどうかの判断材料である（[`04-spec-evolution.md`](./04-spec-evolution.md) §6.1「見本が必要としていて、今の語彙では書けないときだけ足す」）。
2026-09-19 のデモ（[`demos.md`](./demos.md)）で、**`label` が無いために強調の印が `▲ overdue` と出る**ことが実物で確かめられた。

---

## 4. 見本 3：ダッシュボード

> **2026-09-23：実際に動く見本に合わせて書き直した（#184。§3 と同じ手順）。**
> 正本は [`packages/appspec-schema/samples/dashboard/app.spec.yaml`](../../../packages/appspec-schema/samples/dashboard/app.spec.yaml) である。
> 叩き台（2026-09-15）が使おうとして**書けなかった書き方**は §4.6 の表に残した。
> **叩き台の画面は 2 つで、参加者を登録・選択する画面が無かった。** そのため M1.4 のデモで活動を 1 件も入力できず、
> 見本にメンバーの一覧を足した（#200。記録は [`demos.md`](./demos.md) の M1.4）。

### 4.1 前提：何を集計するか

**「このアプリに入れたデータを集計する」ダッシュボードにする**（2026-09-15 所有者が確認）。L2 で書けるのはこれだけだからである。

| 何を集計するか | L2 で書けるか | 扱い |
|---|---|---|
| **このアプリに入れたデータ**（決定） | 書ける | M1a の見本 |
| 同じ仲間の、別のアプリのデータ（割り勘の支出とタスクの進み具合を 1 画面に） | 書けない。アプリをまたいでデータを読む権限の設計が要る | M1 の範囲外 |
| 外のデータ（スプレッドシート、他のサービスの API） | 書けない。外との通信と鍵の管理を店頭が用意する必要がある | MVP の範囲外 |

題材は「サークルの活動記録」にした。練習や試合を記録すると、回数・参加人数・費用が集計される。

### 4.2 画面のイメージ

M1.4 のデモ（2026-09-23・Android / Chrome）で実際に見えた形である。

```text
m14-demo-dashboard
 [dashboard]  [activities]  [members]          ← views（ボタンは view の名前のまま出る）
─────────────────────────
 今月の活動          3 回                      ← widgets: number（scope: app・within: this_month）
 今月の参加（のべ）  6 人
 1 回あたりの参加    2 人                      ← avg。今月が 0 件なら「—」
 今月の費用の平均    3333.3 円                 ← 値は丸めず、画面が小数第 1 位で見せる
─────────────────────────
 月ごとの活動回数                              ← widgets: bar（groups。直近 6 か月・古い順）
   2026-04 … 2026-07  0
   2026-08  1
   2026-09  3
─────────────────────────
 種類の内訳                                    ← widgets: pie（groups。options の順・割合も数字で）
   練習 2（50%）・試合 1（25%）・飲み会 1（25%）
─────────────────────────
 参加の多い活動                                ← widgets: ranking（行ごとの計算の降順・既定 5 件）
   1  日付 2026-08-30  種類 練習    参加人数 4
   2  日付 2026-09-20  種類 練習    参加人数 3
   3  日付 2026-09-21  種類 飲み会  参加人数 2
   4  日付 2026-09-22  種類 試合    参加人数 1
```

- 「今月」は日本時間で決まる。先月（8/30）の活動は数値の部品に入らず、棒の 08 と順位には入る
- 円は `within` を持たないので、**先月の活動も数える**（今月だけの内訳ではない）

### 4.3 宣言

コメントを除いた形である（正本のコメントには、どの Issue がどの語彙を足したかと、書けなかった書き方の表がある）。

```yaml
entities:
  - name: member
    fields:
      name:                 # 名前
        type: string
        label: 名前
  - name: activity
    fields:
      kind:                 # 種類（練習・試合・飲み会）
        type: enum
        label: 種類
        options:
          practice: 練習
          match: 試合
          party: 飲み会
      date:                 # 活動した日（M1.4。`within: this_month` で「今月」に絞る）
        type: date
        label: 日付
      attendees:            # 参加した人（member のレコードの並びを ID で指す）
        type: list
        of: member
        label: 参加した人
      cost:                 # 費用（円）
        type: number
        label: 費用
computed:
  - name: attendeeCount
    entity: activity
    expression: len(attendees)
    type: number
    label: 参加人数
  - name: activityCount
    scope: app
    aggregate:
      count: activity
      where:
        date:
          within: this_month
    type: number
  - name: attendeeTotal
    scope: app
    aggregate:
      sum: activity.attendeeCount
      where:
        date:
          within: this_month
    type: number
  - name: averageAttendees
    scope: app
    aggregate:
      avg: activity.attendeeCount
      where:
        date:
          within: this_month
    type: number
  - name: averageCost
    scope: app
    aggregate:
      avg: activity.cost
      where:
        date:
          within: this_month
    type: number
  - name: activitiesByMonth
    aggregate:
      count: activity
      groupBy:
        month: activity.date
      last: 6
    type: groups
  - name: activitiesByKind
    aggregate:
      count: activity
      groupBy: activity.kind
    type: groups
views:
  - name: dashboard
    type: dashboard
    widgets:
      - type: number
        label: 今月の活動
        value: activityCount
        unit: 回
      - type: number
        label: 今月の参加（のべ）
        value: attendeeTotal
        unit: 人
      - type: number
        label: 1 回あたりの参加
        value: averageAttendees
        unit: 人
      - type: number
        label: 今月の費用の平均
        value: averageCost
        unit: 円
      - type: bar
        label: 月ごとの活動回数
        value: activitiesByMonth
        unit: 回
      - type: pie
        label: 種類の内訳
        value: activitiesByKind
        unit: 回
      - type: ranking
        name: topActivities
        label: 参加の多い活動
        entity: activity
        by: attendeeCount
        show: [date, kind, attendeeCount]
  - name: activities
    type: list
    entity: activity
    show: [kind, attendees, cost, attendeeCount]
  - name: members
    type: list
    entity: member
    show: [name]
actions:
  - name: addMember
    entity: member
    kind: create
  - name: addActivity
    entity: activity
    kind: create
  - name: deleteActivity
    entity: activity
    kind: delete
  - name: deleteMember
    entity: member
    kind: delete
validations: []
permissions:
  - name: read
    subject: minIdentity
  - name: write
    subject: minIdentity
minIdentity:
  mode: anonymous
```

### 4.4 採点のシナリオ（期待値）

正本は [`packages/appspec-schema/samples/dashboard/scenario.json`](../../../packages/appspec-schema/samples/dashboard/scenario.json)。時計を **2026-09-15 12:00（日本時間）に固定**する。入力：メンバー A・B・C。

| 日付 | 種類 | 参加した人 | 費用 | |
|---|---|---|---|---|
| 8/31 | 練習 | A・C | 2,000 | **先月** |
| 9/10 | 練習 | A・B・C | 3,000 | |
| 9/12 | 飲み会 | A・B | 5,000 | |
| 9/14 | 試合 | A | 2,000 | |
| 10/1 | 練習 | A・B | 1,000 | **来月** |

| 確かめるもの | 期待値 |
|---|---|
| 今月の活動 | 3 回（先月と来月は入らない。**「今月」の境目がここで効く**） |
| 今月の参加（のべ） | 6 人 |
| 1 回あたりの参加 | 2 人 |
| 今月の費用の平均 | 10000/3 円（画面は 3333.3） |
| 月ごとの活動回数 | 2026-04〜07 0 ／ 08 1 ／ 09 3（10 月は直近 6 か月の窓の外） |
| 順位 | 練習 3 人 → 先月の練習・飲み会・来月の練習 2 人（登録した順）→ 試合 1 人 |
| **断ること** | 選択肢に無い種類・`YYYY-MM-DD` でない日付・存在しない参加者は、どれも保存されない |

staging の e2e（#183）は、時計に依らない値（行ごとの計算・一覧の形・断ること）だけを見る。
**「今月」が本物の日付で効くことは、人がスマホで確かめた**（M1.4 のデモ）。

### 4.5 ほかの見本に無かった書き方

- アプリ全体の集計（`scope: app`）と平均（`avg`。値の無い行は数えず、0 件なら `null`）
- 見出しごとの集計（`groupBy`・`type: groups`。月は古い順・直近 `last` か月、選択肢は `options` の順）
- 期間の条件（`within: this_month`。日本時間の月初以上・翌月初未満）
- 画面の種類 `dashboard` と、その中の部品（`number`・`bar`・`pie`・`ranking`）、単位（`unit`）

### 4.6 叩き台が使おうとして、書けなかった書き方

**2026-09-23 に #183・#184 で分かった。** §3.5 と同じく、**この表は消さない**（語彙を足すかどうかの判断材料。[`04-spec-evolution.md`](./04-spec-evolution.md) §6.1）。

| 叩き台の書き方 | いまの語彙 | どうしたか |
|---|---|---|
| `app: { name: サークルの活動 }` | **無い**（トップレベルは 7 欄で固定） | 落とした。画面のタイトルはインスタンス ID |
| entity・一覧・操作の `label:` | **項目と計算にだけ**付けられる | 項目と計算にだけ書いた。**一覧の切替のボタンは view の名前のまま出る** |
| `required: true` | **無い**（全項目が必須） | 落とした |
| `cost == null or cost >= 0`（検査の式） | **`null` も `or` も無い** | `validations` を空にした（費用が負でも保存される） |
| `sort: { by: date, order: desc }` | **無い**（行は登録した順） | 落とした |
| `averageAttendees` を式（`… / max(1, …)`）で書く | アプリ全体の値を式では書けない | 集計の `avg` にした（**0 件は「—」**。式の `max(1, …)` は 0 を返してしまい、0 と「求められなかった」を区別できない） |
| 順位を member の `attendance`（参加回数）で並べる | 基準に指せるのは**行ごとの計算だけ**（#182） | activity の `attendeeCount` で並べた。**「誰がよく来るか」ではなく「どの活動に多く来たか」になった** |
| `costThisMonth`（今月の費用の**合計**） | 書ける | **見本は平均（`averageCost`）にしている。** #177 が見本を起こしたときから平均で、合計は一度も書かれていない。**理由の記録が見本に無い**ので、ここに残す |
| `editActivity`（直す） | 書ける（`kind: update`） | 見本に入れていない |
| 画面が 2 つ（ダッシュボード・活動の記録） | — | **参加者を登録・選択する画面が無かった。** #200 でメンバーの一覧を足した |

## 5. 指示を足すと、宣言はどう変わるか

README §0.1 の手順 9「支出にメモ欄を足して」は、割り勘の宣言に **1 行足すだけ**である。

```diff
   - name: expense
     label: 支出
     fields:
       description:  { type: string, label: 内容, required: true }
       amount:       { type: number, label: 金額（円）, required: true }
       payer:        { type: ref, to: member, label: 払った人, required: true }
       participants: { type: list, of: member, label: 割る人, required: true }
+      memo:         { type: string, label: メモ }
```

- 工場が直すのは、この 1 行である。店頭は、新しい宣言を同じアプリに置き直す
- 入力済みの支出は、そのまま残る（メモは空になる）
- 項目を消す・型を変えるときの扱いは、同じリンクのままの差し替え（M2 以降）で決める

---

## 6. 3 つの見本が契約に足すもの

**3 つの見本は、それぞれ違う書き方を契約に持ち込む。** 割り勘だけで契約を固めると、ボードもグラフも入らない。

| 足す書き方 | 割り勘 | タスク管理 | ダッシュボード |
|---|:---:|:---:|:---:|
| 表示名（`label`）・必須（`required`） | ○ | ○ | ○ |
| entity どうしの参照（`ref`・`list of`） | ○ | ○ | ○ |
| entity をまたぐ集計（`aggregate` の `sum`・`count`・`where`） | ○ | ○ | ○ |
| 操作の種類（`kind`） | ○ | ○ | ○ |
| 検査の文言（`message`） | ○ | | ○ |
| 選択肢（`enum`） | | ○ | ○ |
| 既定値（`default`） | | ○ | |
| 日付（`date`）と時刻に依存する値（`today()`・`this_month`） | | ○ | ○ |
| 決まった値への書き換え（`set`）・ボタンの条件（`when`） | | ○ | |
| アプリ全体の集計（`scope: app`・`groupBy`） | | | ○ |
| 画面：`list`・`table` | ○ | ○ | ○ |
| 画面：`settlement` | ○ | | |
| 画面：`board`・絞り込み（`filters`） | | ○ | |
| 画面：`dashboard`（`number`・`bar`・`pie`・`ranking`） | | | ○ |

### 6.1 見本を動かすと決めることになる「実行時の意味」

YAML の形だけでは、答えが 1 つに決まらないものがある。見本を動かすときに決め、契約の文書に書く。

| 決めること | 出てくる見本 | 例 |
|---|---|---|
| 端数 | 割り勘 | 1,000 円を 3 人で割ると 333.33… 円。1 円未満をどうするか、余りを誰が持つか。**金額は整数円に限り、余りは `settle` の中で解く**と決めた（`00` の Q18-5・Q18-6） |
| 精算の組み方 | 割り勘 | 送金の回数を最少にするか。同じ金額の人が複数いるときの順番。**一組ごとに残額で並べ直す**と決めた（`00` の Q18-7） |
| 参照先を消したとき | 割り勘・タスク管理 | 支出に名前が残っているメンバーを消せるか |
| 「今日」「今月」 | タスク管理・ダッシュボード | 日本時間で数えるか。採点では時計を固定する |
| 空のとき | 全部 | 支出が 0 件の精算、費用が空の活動の合計（0 として数えるか） |
| 同じ値の並び | ダッシュボード | 参加回数が同じ B さんと C さんの順番 |

---

## 7. L2 でできないこと

| やりたいこと | L2 で書けない理由 | どうするか |
|---|---|---|
| 外のサービスとやり取りする（天気、カレンダー、決済） | 宣言に、外と通信する欄が無い | MVP の範囲外 |
| 部品に無い画面（自由なデザイン、ゲーム） | 画面は、店頭が持つ部品から選ぶだけ | L3（M5〜M6 以降。`01` §1.1） |
| 部品に無い計算（くじ引き、複雑な割り当て） | 式は決まった形だけ（ループや乱数が無い） | よく使うものは店頭が部品として足す（精算がその例）。それ以外は L3 |

**部品を増やすのは店頭の仕事、部品を選んで組み合わせるのが工場の仕事**、という分担になる。

---

## 8. 工場（CommandAgent）から見ると

- 今の工場は、v0.1 の 7 つの欄と、`computed` の 4 つのキー（`name`・`entity`・`expression`・`type`）しか受け付けない。**それ以外のキーを書くと検査で落ちる**（語彙が閉じている）
- この文書で足した `aggregate`・`scope`・画面の `type` などは、段階 2 で契約として固め、段階 3 で工場の検査と生成の指示に足す
- 工場の golden スイートは、今は割り勘・持ち物・投票の 3 つである。**タスク管理とダッシュボードの要求文は、段階 3 で新しく作って封緘する**
- 各見本の「採点のシナリオ」は、工場の生成物にも同じ入力を入れて、同じ値が出るかを比べるのに使う（`01` §2.3）
