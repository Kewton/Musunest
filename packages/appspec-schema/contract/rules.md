# Rules (types · names · limits · reserved words · closed vocabulary · YAML reading)

> **Contract piece: rules.** Part of the AppSpec canonical source (`community.app-spec/v0.2-draft`).
> Read together with [`expression-grammar.md`](./expression-grammar.md) (EBNF, precedence, associativity),
> `app-spec.schema.json` (declaration structure, written by a separate issue), and
> [`../docs/semantics.md`](../docs/semantics.md) (the meaning of each vocabulary word).
> Owner decision 2026-09-24 (`workspace/mvp/m1/06-grammar-and-authoring-trial.md` §2.1).
> The implementation these rules are checked against is `packages/spec-engine/src/`; the parity test is
> `packages/spec-engine/src/contract-rules.test.ts` (#213).

## 0. How to read the tables

Every rule below has a **positive**, a **negative**, and a **boundary** expectation. The expectations are the
source for the parity test (#213) — they are written from these rules, **not** generated from the implementation.

**Notation**

| Written | Means |
|---|---|
| `FIXTURE` | the complete declaration in [§1](#1-reference-fixture). Expression, type, and name examples are deltas on it. |
| `MIN` | the smallest valid declaration in [§1](#1-reference-fixture) (all seven sections; empty collections). Structural and YAML examples are deltas on it — it has nothing that a broken key can cascade through. |
| `Γ` | the type environment in [§1](#1-reference-fixture): the name → type mapping an expression is checked in. |
| `set P = V` | the declaration is the stated base (`FIXTURE` unless a case names `MIN`) with the value at path `P` replaced by `V` (paths are explained below). |
| `expr: E ⇒ …` | check the expression string `E` in `Γ`. |
| `expr: E ⇒ type=T` | `E` reads, and its static type is `T`, with no diagnostic. |
| `expr: E ⇒ V` where `V` looks like a code | the static check reports exactly this diagnostic code. |
| `eval: E ⇒ value=V` | evaluating `E` in a record yields `V` (`null` means "could not be computed", never `0`). |
| `yaml: FRAG @ P ⇒ …` | the raw YAML text `FRAG` placed at path `P` of the stated base (`FIXTURE` or `MIN`) yields the named diagnostic. `⏎` is a line break, `·` is one leading space. |
| `OK` | the check passes with **no** diagnostic. |
| a code such as `LOGIC_OPERAND_TYPE_MISMATCH` | the check reports exactly this diagnostic code. |

Each negative is chosen so that it breaks **only its own rule**, so its expectation is the **full set** of codes
reported for that case. (Where a break would cascade — a missing section, a renamed referenced item — the case is
built on `MIN`, which has nothing to cascade through.)

**Path notation** (keys are the `name` of the item, because names are unique within their collection):

```
entities.expense.fields.amount.type
entities.expense.fields.payer.to
views.expenseList.type
computed.paidAmount.expression
validations.positiveAmount.expression
actions.addExpense.kind
permissions.read.name
minIdentity.mode
```

A `set` may also `add`/`remove` an item by name (`add computed.newOne = {…}`), which is written out where it is used.

## 1. Reference fixture

`FIXTURE` is a complete, valid declaration (0 diagnostics). `Γ` is the mapping for the entity `expense`.

```yaml
entities:
  - name: member
    fields:
      name: string
  - name: expense
    fields:
      description: string
      amount: number
      discount: number
      payer:
        type: ref
        to: member
      participants:
        type: list
        of: member
      spentOn: date
      kind:
        type: enum
        options:
          food: 食べ物
          travel: 移動
        default: food
views:
  - name: expenseList
    type: table
    entity: expense
  - name: memberList
    entity: member
  - name: dashboard
    type: dashboard
    widgets:
      - type: number
        value: expenseCount
        unit: 件
actions:
  - name: addExpense
    entity: expense
  - name: editExpense
    entity: expense
    kind: update
validations:
  - name: positiveAmount
    entity: expense
    expression: amount > 0
computed:
  - name: paidAmount
    entity: expense
    type: number
    expression: amount - discount
  - name: headcount
    entity: expense
    type: number
    expression: len(participants)
  - name: overdue
    entity: expense
    type: boolean
    expression: spentOn < today()
  - name: expenseCount
    scope: app
    type: number
    aggregate:
      count: expense
  - name: expenseByKind
    aggregate:
      count: expense
      groupBy: expense.kind
    type: groups
permissions:
  - name: read
    subject: minIdentity
  - name: write
    subject: minIdentity
minIdentity:
  mode: anonymous
```

`MIN` is the smallest valid declaration — every section is present, every collection is empty. Structural and YAML
rules use it so that one broken key does not cascade into other diagnostics.

```yaml
entities: []
views: []
actions: []
validations: []
computed: []
permissions: []
minIdentity:
  mode: anonymous
```

`Γ` (entity `expense`):

| Name | Type | Where from |
|---|---|---|
| `amount`, `discount` | `number` | field |
| `description` | `string` | field |
| `spentOn` | `date` | field |
| `participants` | `list` | field (`list`) |
| `payer` | `string` | field (`ref`; an ID is a string) |
| `kind` | `string` | field (`enum`; a key is a string) |
| `paidAmount`, `headcount` | `number` | computed |
| `overdue` | `boolean` | computed |

In `scope: app` expressions, the only visible names are the app-scope computed values (`expenseCount`).

## 2. Value types (`R-TYPE`)

See [`expression-grammar.md`](./expression-grammar.md) §4 for precedence.

| Rule | Positive (accept → expected) | Negative (reject → expected) | Boundary (edge → expected) |
|---|---|---|---|
| **R-TYPE-01** `+` `-` `*` `/` take two `number`s and produce `number`. | `expr: amount + discount ⇒ type=number` | `expr: description * 2 ⇒ LOGIC_OPERAND_TYPE_MISMATCH` | `expr: 0 * 0 ⇒ type=number` |
| **R-TYPE-02** Unary `-` takes a `number` and produces `number`. | `expr: -amount ⇒ type=number` | `expr: -description ⇒ LOGIC_OPERAND_TYPE_MISMATCH` | `expr: - -amount ⇒ type=number` (it nests) |
| **R-TYPE-03** `>` `>=` `<` `<=` `==` `!=` on two `number`s produce `boolean`. | `expr: amount >= discount ⇒ type=boolean` | `expr: amount >= description ⇒ LOGIC_OPERAND_TYPE_MISMATCH` | `expr: amount == amount ⇒ type=boolean` |
| **R-TYPE-04** The same six operators on two `date`s produce `boolean`. | `expr: spentOn < today() ⇒ type=boolean` | `expr: spentOn < amount ⇒ LOGIC_OPERAND_TYPE_MISMATCH` (date vs number) | `expr: spentOn == today() ⇒ type=boolean` |
| **R-TYPE-05** `string` (also an `enum` key or a `ref` ID) compares with `==` `/` `!=` only, against a `string`. | `expr: kind == "food" ⇒ type=boolean` | `expr: kind < "food" ⇒ LOGIC_OPERAND_TYPE_MISMATCH` (ordered comparison on a string) | `expr: description != "" ⇒ type=boolean` (the empty string is a value) |
| **R-TYPE-06** `list` is not an operand of any operator; use `len`. | `expr: len(participants) > 0 ⇒ type=boolean` | `expr: participants == 1 ⇒ LOGIC_OPERAND_TYPE_MISMATCH` | `expr: len(participants) == 0 ⇒ type=boolean` |
| **R-TYPE-07** `boolean` (a comparison result) is not an operand of any operator. | `set computed.overdue.expression = amount > 0 ⇒ OK` | `expr: (amount > 0) + 1 ⇒ LOGIC_OPERAND_TYPE_MISMATCH` | `expr: (amount > 0) == (discount > 0) ⇒ LOGIC_OPERAND_TYPE_MISMATCH` (booleans are not comparable) |
| **R-TYPE-08** Function signatures: `min`/`max` = 2 `number`s → `number`; `len` = 1 `list` → `number`; `today` = 0 args → `date`. | `expr: max(1, headcount) ⇒ type=number` | `expr: min(amount) ⇒ LOGIC_FUNCTION_ARITY_MISMATCH` | `expr: today() ⇒ type=date` (0 arguments) |
| **R-TYPE-09** A function argument must have the declared type. | `expr: len(participants) ⇒ type=number` | `expr: len(amount) ⇒ LOGIC_FUNCTION_ARGUMENT_TYPE_MISMATCH` | `expr: max(0, 0) ⇒ type=number` |
| **R-TYPE-10** A row-scoped `computed` result type must equal its `type`. | `set computed.paidAmount.type = number ⇒ OK` | `set computed.overdue.type = number ⇒ LOGIC_COMPUTED_TYPE_MISMATCH` | `set computed.overdue.type = boolean ⇒ OK` |
| **R-TYPE-11** A `validation` expression must be `boolean`. | `set validations.positiveAmount.expression = amount == 0 ⇒ OK` | `set validations.positiveAmount.expression = amount ⇒ LOGIC_VALIDATION_NOT_BOOLEAN` | `set validations.positiveAmount.expression = amount >= 0 ⇒ OK` |
| **R-TYPE-12** An `action.when` expression must be `boolean`. | `set actions.addExpense.when = kind == "food" ⇒ OK` | `set actions.addExpense.when = description ⇒ LOGIC_ACTION_WHEN_NOT_BOOLEAN` | `set actions.addExpense.when = kind != "food" ⇒ OK` |
| **R-TYPE-13** A `set` value is a **constant** of the field's type, never an expression. `number` ← a number; `date` ← `YYYY-MM-DD`; `enum` ← a key; `string` ← literal text; `list`/`ref` ← not writable. | `set actions.addExpense.kind = update` + `set actions.addExpense.set = {kind: food} ⇒ OK` | `set actions.addExpense.set = {amount: amount + 1} ⇒ LOGIC_ACTION_SET_NOT_CONSTANT` | `set actions.addExpense.set = {kind: nosuch} ⇒ LOGIC_ACTION_SET_TYPE_MISMATCH` (a key that is not in `options`); `set actions.addExpense.set = {participants: x} ⇒ LOGIC_ACTION_SET_TYPE_MISMATCH` (a `list` cannot be set) |
| **R-TYPE-14** Arithmetic that leaves the finite numbers (divide by zero, overflow) is `null`, never `0`, and a `validation` that is `null` does **not** pass. | `eval: 1 / 2 ⇒ value=0.5` | `eval: 1 / 0 ⇒ value=null` | `eval: 0 / 5 ⇒ value=0` |

## 3. Name resolution (`R-NAME`)

| Rule | Positive (accept → expected) | Negative (reject → expected) | Boundary (edge → expected) |
|---|---|---|---|
| **R-NAME-01** A bare name resolves to a field or computed of the **same** entity. | `set validations.positiveAmount.expression = amount + paidAmount ⇒ OK` | `set validations.positiveAmount.expression = ammount ⇒ LOGIC_REFERENCE_NOT_FOUND` | a name that is a field of **another** entity is not found: `set validations.positiveAmount.expression = name ⇒ LOGIC_REFERENCE_NOT_FOUND` |
| **R-NAME-02** `entity.field` (member access) is **not writable**. | `set computed.paidAmount.expression = paidAmount - discount ⇒ OK` (the same reference without a dot) | `set computed.paidAmount.expression = expense.amount ⇒ LOGIC_REFERENCE_OUT_OF_ENTITY` | when the left side is not a declared entity: `set computed.paidAmount.expression = nosuch.x ⇒ LOGIC_REFERENCE_NOT_FOUND` |
| **R-NAME-03** A computed name must not collide with a field of the same entity. | `set computed.paidAmount.name = total ⇒ OK` | `set computed.paidAmount.name = amount ⇒ LOGIC_COMPUTED_NAME_CONFLICT` | a computed whose name equals another computed of the same entity: `set computed.headcount.name = paidAmount ⇒ LOGIC_COMPUTED_DUPLICATE_NAME` |
| **R-NAME-04** Computed references must not form a cycle (a self-reference counts). | `set computed.headcount.expression = paidAmount ⇒ OK` | `add computed.a = {entity: expense, type: number, expression: b}` + `add computed.b = {entity: expense, type: number, expression: a} ⇒ LOGIC_COMPUTED_CYCLE` | a self-reference: `add computed.loop = {entity: expense, type: number, expression: loop + 1} ⇒ LOGIC_COMPUTED_CYCLE` |
| **R-NAME-05** A constant compared with an `enum` field must be one of its `options` keys. | `set validations.positiveAmount.expression = kind == "food" ⇒ OK` | `set validations.positiveAmount.expression = kind == "todu" ⇒ LOGIC_ENUM_KEY_NOT_FOUND` | both sides compared, one bad key: `set validations.positiveAmount.expression = kind != "food" ⇒ OK`; `set validations.positiveAmount.expression = kind != "nope" ⇒ LOGIC_ENUM_KEY_NOT_FOUND` |
| **R-NAME-06** In `scope: app`, only other app-scope computed values resolve; `.` is not writable. | `add computed.doubleCount = {scope: app, type: number, expression: expenseCount * 2} ⇒ OK` | `add computed.badApp = {scope: app, type: number, expression: paidAmount} ⇒ LOGIC_REFERENCE_NOT_FOUND` (a row-scoped computed is invisible) | `add computed.badApp = {scope: app, type: number, expression: expense.amount} ⇒ LOGIC_REFERENCE_NOT_FOUND` |
| **R-NAME-07** A display name (`label`) is not an identifier; only the `name` resolves. | `set computed.paidAmount.label = 支払額` and reference `paidAmount ⇒ OK` | `set computed.paidAmount.label = total` and reference `total ⇒ LOGIC_REFERENCE_NOT_FOUND` | a `label` equal to a real identifier still resolves by identifier: `set computed.paidAmount.label = amount`, reference `amount ⇒ OK` |
| **R-NAME-08** Names are unique within their collection (entity, field, computed, validation, view, action, permission, ranking widget). | distinct names ⇒ `OK` | `add entities.expense = {fields: {x: string}} ⇒ DATA_ENTITY_DUPLICATE_NAME`; `add entities.expense.fields.amount = number ⇒ DATA_FIELD_DUPLICATE_NAME`; `add computed.paidAmount = {entity: expense, type: number, expression: 1} ⇒ LOGIC_COMPUTED_DUPLICATE_NAME`; `add validations.positiveAmount = {entity: expense, expression: true} ⇒ LOGIC_VALIDATION_DUPLICATE_NAME`; `add views.expenseList = {entity: expense} ⇒ UI_VIEW_DUPLICATE_NAME`; `add actions.addExpense = {entity: expense} ⇒ LOGIC_ACTION_DUPLICATE_NAME`; `add permissions.read = {name: read, subject: minIdentity} ⇒ PERMISSION_DUPLICATE_NAME` | two ranking widgets with the same `name` ⇒ `UI_RANKING_NAME_DUPLICATE` |
| **R-NAME-09** An aggregate target (`sum`/`count`/`avg`) must name a declared entity, and for `sum`/`avg` a number-typed field or computed. | `add computed.sumAmt = {scope: app, type: number, aggregate: {sum: expense.amount}} ⇒ OK` | `add computed.sumAmt = {scope: app, type: number, aggregate: {sum: expence.amount}} ⇒ LOGIC_AGGREGATE_TARGET_NOT_FOUND` | a target that is a string: `add computed.sumText = {scope: app, type: number, aggregate: {sum: expense.description}} ⇒ LOGIC_AGGREGATE_TARGET_NOT_NUMBER` |
| **R-NAME-10** An aggregate `where` compares a source field to `this` (a `ref` with `equals`, a `list of` with `contains`); `this` cannot be used in an `app`-scope aggregate. | `add computed.myExpenses = {entity: member, type: number, aggregate: {count: expense, where: {payer: this}}} ⇒ OK` | `add computed.bad = {entity: member, type: number, aggregate: {count: expense, where: {amount: this}}} ⇒ LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH` | `add computed.badApp = {scope: app, type: number, aggregate: {count: expense, where: {payer: this}}} ⇒ LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH` |
| **R-NAME-11** A `within` condition targets a `date` field and a period name that is in the vocabulary (`this_month`). | `add computed.thisMonth = {scope: app, type: number, aggregate: {count: expense, where: {spentOn: {within: this_month}}}} ⇒ OK` | `add computed.bad = {scope: app, type: number, aggregate: {count: expense, where: {spentOn: {within: last_week}}}} ⇒ LOGIC_AGGREGATE_WHERE_PERIOD_NOT_ALLOWED` | `within` on a non-date field: `add computed.bad = {scope: app, type: number, aggregate: {count: expense, where: {amount: {within: this_month}}}} ⇒ LOGIC_AGGREGATE_WHERE_TYPE_MISMATCH` |
| **R-NAME-12** A `groupBy` target is an `enum` field (per value) or a `date` field (per month), and `last` is only for months. | `add computed.byKind = {type: groups, aggregate: {count: expense, groupBy: expense.kind}} ⇒ OK` | `add computed.byAmount = {type: groups, aggregate: {count: expense, groupBy: expense.amount}} ⇒ LOGIC_AGGREGATE_GROUPBY_NOT_GROUPABLE` | `last` without a month grouping: `add computed.byKind = {type: groups, aggregate: {count: expense, groupBy: expense.kind, last: 3}} ⇒ LOGIC_AGGREGATE_FORM_INVALID` |
| **R-NAME-13** A `ranking` widget's `by` must be a row-scoped number computed **and** be named in `show`. | `set views.dashboard.widgets = [{type: ranking, name: topExpenses, entity: expense, by: paidAmount, show: [description, paidAmount]}] ⇒ OK` | `… by: expenseCount, show: [description] ⇒ UI_RANKING_BY_NOT_ROW_VALUE` | `… by: paidAmount, show: [description] ⇒ UI_RANKING_BY_NOT_SHOWN` |

## 4. Limits and counting (`R-LIMIT`)

The three expression limits are **static-check limits** and are **applied again at evaluation** (R-LIMIT-04).
The counts are exact — a conforming implementation must agree on them.

- **Length** is counted in **UTF-16 code units**: the JavaScript `String.length` of the expression text as written
  (before trimming; spaces count).
- **Depth** counts a leaf (`number`, `string`, `name`) as **1**; `unary`, `binary`, and `call` each count
  `1 + max(child depths)`. Parentheses are **transparent** (no node, no level).
- **Nodes** counts every node **including leaves** as **1**; parentheses add nothing.

In the examples, `pad(E, n)` means the text `E` followed by spaces up to exactly `n` characters, and `deep(k)` is
`min(1, 1)` wrapped in `min(…, 1)` a further `k - 1` times (so `deep(8)` is `min(min(min(min(min(min(min(1, 1), 1), 1), 1), 1), 1), 1)`).
`tree(32)` is a fully balanced `+` tree with 32 leaves and 63 nodes; `-(tree(32))` has 64 nodes.

| Rule | Positive (accept → expected) | Negative (reject → expected) | Boundary (just-before · exactly · over) |
|---|---|---|---|
| **R-LIMIT-01** Expression length must be ≤ **200** UTF-16 code units. | `expr: pad("1 + 1", 200) ⇒ OK` | `expr: pad("1 + 1", 201) ⇒ LOGIC_EXPRESSION_TOO_LONG` | `199 ⇒ OK` · `200 ⇒ OK` · `201 ⇒ LOGIC_EXPRESSION_TOO_LONG` |
| **R-LIMIT-02** AST depth must be ≤ **8**. | `expr: deep(8) ⇒ OK` | `expr: deep(9) ⇒ LOGIC_EXPRESSION_DEPTH_EXCEEDED` | `deep(7) ⇒ OK` · `deep(8) ⇒ OK` · `deep(9) ⇒ LOGIC_EXPRESSION_DEPTH_EXCEEDED` |
| **R-LIMIT-03** AST node count must be ≤ **64**. | `expr: -(tree(32)) ⇒ OK` (exactly 64 nodes) | `expr: 1 + (tree(32)) ⇒ LOGIC_EXPRESSION_NODES_EXCEEDED` (65 nodes) | `tree(32)` (63 nodes) `⇒ OK` · `-(tree(32))` (64 nodes) `⇒ OK` · `1 + (tree(32))` (65 nodes) `⇒ LOGIC_EXPRESSION_NODES_EXCEEDED` |
| **R-LIMIT-04** The three limits are checked again when a value is computed. An over-limit expression is never a success value. | `eval: amount + 1` on a record with `amount = 2` ⇒ `value=3` | an over-limit expression `⇒` its `computed` is `null` and a `validation` using it fails (never `0`, never `true`) | `pad("amount > 0", 200)` (200 exactly) `⇒` evaluates normally |
| **R-LIMIT-05** `groupBy.last` is an integer ≥ **1**, written only with month grouping; omitted means **6**. | `add computed.expenseByMonth = {type: groups, aggregate: {count: expense, groupBy: {month: expense.spentOn}, last: 3}} ⇒ OK` | `… last: 0 ⇒ SHAPE_VALUE_INVALID` | `last: 1 ⇒ OK` (minimum) · omitted `⇒ OK` (default 6) |
| **R-LIMIT-06** A `ranking` widget's `limit` is an integer ≥ **1**; omitted means **5**. | `set views.dashboard.widgets = [{type: ranking, name: top, entity: expense, by: paidAmount, show: [paidAmount], limit: 3}] ⇒ OK` | `… limit: 0 ⇒ SHAPE_VALUE_INVALID` | `limit: 1 ⇒ OK` (minimum) · omitted `⇒ OK` (default 5) |

## 5. Reserved words (`R-RESERVED`)

The store adds `id` and `createdAt` (and updates `updatedAt`) itself. Those three names cannot be used for a field or a computed.

| Rule | Positive (accept → expected) | Negative (reject → expected) | Boundary (edge → expected) |
|---|---|---|---|
| **R-RESERVED-01** A field name must not be `id`, `createdAt`, or `updatedAt`. | `set entities.expense.fields.amount.type = number ⇒ OK` | `set entities.expense.fields.createdAt.type = string ⇒ DATA_FIELD_NAME_RESERVED` | all three are reserved: `id` `createdAt` `updatedAt` each `⇒ DATA_FIELD_NAME_RESERVED`; any other name `⇒ OK` |
| **R-RESERVED-02** A computed name must not be `id`, `createdAt`, or `updatedAt`. | `add computed.total = {entity: expense, type: number, expression: amount} ⇒ OK` | `add computed.updatedAt = {entity: expense, type: number, expression: amount} ⇒ LOGIC_COMPUTED_NAME_RESERVED` | `add computed.id = {entity: expense, type: number, expression: amount} ⇒ LOGIC_COMPUTED_NAME_RESERVED` |

## 6. Closed vocabulary (`R-VOCAB`)

**Every key and every word is from a closed list.** The unknown case is reported, not ignored.

| Rule | Positive (accept → expected) | Negative (reject → expected) | Boundary (edge → expected) |
|---|---|---|---|
| **R-VOCAB-01** An unknown key anywhere is rejected. | `set minIdentity.mode = anonymous ⇒ OK` | `set minIdentity.foo = 1 ⇒ SHAPE_KEY_UNKNOWN` | an unknown **top-level** section: on `MIN`, a mapping `app:` ⇒ `SHAPE_KEY_UNKNOWN` |
| **R-VOCAB-02** A required key or section must be present. | `FIXTURE ⇒ OK` | on `MIN`, removing `entities: []` ⇒ `SHAPE_KEY_MISSING` | on `MIN`, removing `minIdentity:` ⇒ `SHAPE_KEY_MISSING` |
| **R-VOCAB-03** A key must not repeat in one mapping. | distinct keys `⇒ OK` | on `MIN`, a `minIdentity` mapping with `mode` written twice ⇒ `SHAPE_KEY_DUPLICATE` | a repeated top-level section `⇒ SHAPE_KEY_DUPLICATE` |
| **R-VOCAB-04** The document has exactly the seven sections; missing ones are an error, extra ones are unknown. | `MIN ⇒ OK` | on `MIN`, removing `computed: []` ⇒ `SHAPE_KEY_MISSING` | on `MIN`, adding an eighth section `extra:` ⇒ `SHAPE_KEY_UNKNOWN` |
| **R-VOCAB-05** A section with no content is written `[]`. | `set validations = [] ⇒ OK` | a section left without a value (`validations:`) ⇒ `SHAPE_VALUE_INVALID` | a section written as a mapping (not a list) ⇒ `SHAPE_VALUE_INVALID` |
| **R-VOCAB-06** A field type is one of `string`, `number`, `list`, `date` (plus the `ref`/`list of`/`enum` maps). | `set entities.expense.fields.count = number ⇒ OK` | `set entities.expense.fields.amount.type = integer ⇒ DATA_FIELD_TYPE_UNKNOWN` | `boolean` is a **computed** type, not a field type: `set …type = boolean ⇒ DATA_FIELD_TYPE_UNKNOWN` |
| **R-VOCAB-07** An action `kind` is `create`, `update`, or `delete`; **omitting it means `create`**. | `set actions.addExpense.kind = delete ⇒ OK`; `remove actions.addExpense.kind ⇒ OK` (reads as `create`) | `set actions.addExpense.kind = patch ⇒ LOGIC_ACTION_KIND_NOT_ALLOWED` | `create` · `update` · `delete` each `⇒ OK`; anything else `⇒ LOGIC_ACTION_KIND_NOT_ALLOWED` |
| **R-VOCAB-08** A view `type` is `table`, `settlement`, `board`, `list`, or `dashboard`; a widget `type` is `number`, `bar`, `pie`, or `ranking`. | `set views.expenseList.type = table ⇒ OK` | `set views.expenseList.type = button ⇒ SHAPE_KEY_UNKNOWN` | an unknown widget type: `set views.dashboard.widgets = [{type: chart, value: expenseCount}] ⇒ SHAPE_KEY_UNKNOWN` |
| **R-VOCAB-09** Permission words are closed: name `read`/`write`, subject `minIdentity`, mode `anonymous`. | `FIXTURE ⇒ OK` | `set permissions.read.name = admin ⇒ PERMISSION_NAME_NOT_ALLOWED` | `set permissions.read.subject = owner ⇒ PERMISSION_SUBJECT_NOT_ALLOWED`; `set minIdentity.mode = google ⇒ PERMISSION_IDENTITY_MODE_NOT_ALLOWED` |
| **R-VOCAB-10** The only functions are `min`, `max`, `len`, `today`. | `expr: min(1, 2) ⇒ type=number` | `expr: round(amount) ⇒ LOGIC_FUNCTION_NOT_ALLOWED` | a function name used as a value: `expr: today ⇒ LOGIC_REFERENCE_NOT_FOUND` (`today` without `()` is an ordinary name) |
| **R-VOCAB-11** Names match `^[A-Za-z][A-Za-z0-9]*$`. | on `MIN`, an entity named `e1` ⇒ `OK`; a 1-character name `⇒ OK` | on `MIN`, an entity named `1e` ⇒ `SHAPE_NAME_INVALID` | an entity named `_e` or `支出` ⇒ `SHAPE_NAME_INVALID`; a name `a1` ⇒ `OK` |
| **R-VOCAB-12** An `enum` has ≥ 1 key, unique keys, and a `default` (if written) that is one of the keys. | an enum with `options` `a: A` and `default: a` ⇒ `OK` | `options:` with no keys ⇒ `DATA_FIELD_ENUM_OPTIONS_EMPTY`; a duplicate key ⇒ `DATA_FIELD_ENUM_OPTION_KEY_DUPLICATE` | `default: b` where `options` has only `a` ⇒ `DATA_FIELD_ENUM_DEFAULT_NOT_IN_OPTIONS`; exactly one key ⇒ `OK` |
| **R-VOCAB-13** A `ref` / `list of` target must be a declared entity. | `set entities.expense.fields.payer.to = member ⇒ OK` | `set entities.expense.fields.payer.to = menber ⇒ DATA_REF_TARGET_NOT_FOUND` | a bare `list` (no `of`) is a string list with no target: `set entities.expense.fields.participants = list ⇒ OK` |

## 7. YAML reading (`R-YAML`)

The declaration is YAML, but only a small, exact subset is read
(`packages/spec-engine/README.md` §7). **A form outside this subset is rejected, never skipped** — skipping would make
part of a written declaration "not exist" and the check would miss it. Everything that is not one of the accepted forms below is `SHAPE_YAML_INVALID`.

| Rule | Positive (accept → expected) | Negative (reject → expected) | Boundary (edge → expected) |
|---|---|---|---|
| **R-YAML-01** Block mappings (`key: value`, nested by indentation) and block sequences (`- `) are read. | `FIXTURE ⇒ OK` | a top-level sequence instead of a mapping: `yaml: - a @ (document) ⇒ SHAPE_VALUE_INVALID` | indentation must match its block exactly; a line that is neither `key: value` nor `- ` in a mapping `⇒ SHAPE_YAML_INVALID` |
| **R-YAML-02** A one-line sequence `[a, b]` is read. | `set views.expenseList.show = [description, amount] ⇒ OK` | an unclosed sequence: `yaml: show: [description @ views.expenseList ⇒ SHAPE_YAML_INVALID` | `[]` is a valid empty sequence ⇒ `OK` |
| **R-YAML-03** A `#` after whitespace starts a comment to end of line; a `#` elsewhere is a literal. | `yaml: ··mode: anonymous··# comment @ minIdentity ⇒ OK` | a `#` inside a value is kept (not a comment): it stays part of the string and is judged by the vocabulary | a line that is only a comment is ignored `⇒ OK` |
| **R-YAML-04** Scalars may be quoted; `"…"` allows `\n \t \r \" \\`, `'…'` escapes `'` as `''`. | `yaml: ··mode: "anonymous" @ minIdentity ⇒ OK` | an unclosed quote `⇒ SHAPE_YAML_INVALID`; an unsupported escape `yaml: …mode: "a\qb" @ minIdentity ⇒ SHAPE_YAML_INVALID` | the empty string `""` is read as the empty string and then judged by the vocabulary: `mode: ""` ⇒ `SHAPE_VALUE_INVALID` |
| **R-YAML-05** **Every scalar is read as a string.** | `yaml: ··mode: anonymous @ minIdentity ⇒ OK` | `true`/`1`/`2026-01-01` are the **strings** `"true"`/`"1"`/`"2026-01-01"`: `yaml: ··mode: true @ minIdentity ⇒ PERMISSION_IDENTITY_MODE_NOT_ALLOWED` (not a boolean, and not a mode) | a number where a name is expected is the string of digits and fails the name check `⇒ SHAPE_NAME_INVALID` |
| **R-YAML-06** One document; at most one leading `---`. | a single leading `---` `⇒ OK` | a second `--- ⇒ SHAPE_YAML_INVALID`; `... ⇒ SHAPE_YAML_INVALID` | a leading `---` followed immediately by the mapping `⇒ OK` |
| **R-YAML-07** Flow mappings, block scalars, anchors, aliases, and tags are not read. | a block mapping where a nested map is needed `⇒ OK` | `yaml: ··mode: {a: 1} @ minIdentity ⇒ SHAPE_YAML_INVALID`; `yaml: ··mode: \| @ minIdentity ⇒ SHAPE_YAML_INVALID`; `yaml: ··mode: &a anonymous @ minIdentity ⇒ SHAPE_YAML_INVALID`; `yaml: ··mode: *a @ minIdentity ⇒ SHAPE_YAML_INVALID`; `yaml: ··mode: !m anonymous @ minIdentity ⇒ SHAPE_YAML_INVALID` | values starting with `@`, `` ` ``, or `%` `⇒ SHAPE_YAML_INVALID` |
| **R-YAML-08** Indentation uses spaces, not tabs. | space indentation `⇒ OK` | `yaml: minIdentity:⏎Tab(→)mode: anonymous @ (document) ⇒ SHAPE_YAML_INVALID` | any tab in the leading whitespace `⇒ SHAPE_YAML_INVALID` |
| **R-YAML-09** A nested mapping is written on the next line; a value may not contain `: `. | `yaml: ··payer:⏎····type: ref⏎····to: member @ entities.expense.fields ⇒ OK` | `yaml: ··payer: {type: ref} ⇒` the flow form is rejected (R-YAML-07); a scalar containing `: ` such as `yaml: ··description: a: b @ entities.expense.fields ⇒ SHAPE_YAML_INVALID` | a `#` or `:` inside a quoted scalar is kept `⇒ OK` |

## 8. Coverage

- Every rule above has all three columns filled; `R-LIMIT-01` … `R-LIMIT-03` give the just-before / exactly / over points.
- [`expression-grammar.md`](./expression-grammar.md) §4 fixes precedence and associativity; R-LIMIT covers counting.
- The parity test (#213) reads these tables and drives `checkSpec`, `readExpression` / `analyzeExpression`, and the
  evaluator with them. **If a rule and the implementation disagree, stop** — do not change the expectation or the
  implementation to make them match (`workspace/mvp/m1/06-grammar-and-authoring-trial.md` §2.2).
