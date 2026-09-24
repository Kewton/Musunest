# Expression grammar (EBNF)

> **Contract piece: expressions.** Part of the AppSpec canonical source (`community.app-spec/v0.2-draft`).
> Read together with:
> - [`rules.md`](./rules.md) — value types, name resolution, limits and counting, reserved words, closed vocabulary, YAML reading
> - `app-spec.schema.json` — declaration structure (written by a separate issue)
> - [`../docs/semantics.md`](../docs/semantics.md) — the meaning of each vocabulary word
>
> Owner decision 2026-09-24 (`workspace/mvp/m1/06-grammar-and-authoring-trial.md` §2.1: structure in JSON Schema,
> **expressions in EBNF**, rules in tables). The implementation this contract is checked against is
> `packages/spec-engine/src/expression.ts`; the parity test is `packages/spec-engine/src/contract-rules.test.ts` (#213).
> **The accepted language is what is written here, not what the parser happens to read** (§5).

## 1. Where an expression is written

An expression is the whole value of one of these string slots.

| Slot | Declaration | Result type the slot requires |
|---|---|---|
| `expression` | `validations[]` | `boolean` |
| `expression` | `computed[]` (row-scoped, with `entity`) | the `type` written there |
| `expression` | `computed[]` with `scope: app` | `number` |
| `when` | `actions[]` | `boolean` |

These look expression-like but are **not** expressions:

- `set` values in `actions[]` — constants only (`rules.md` R-TYPE-13)
- the aggregate keys `sum` / `count` / `avg` / `where` / `groupBy` / `within` / `last` — they name fields, `this`, and periods (`rules.md` R-NAME-09 … R-NAME-12)
- `minIdentity.mode`, view `type`, action `kind`, permission names — plain vocabulary words (`rules.md` R-VOCAB-*)

## 2. Lexemes

The tokens themselves are **ASCII**. A `String` literal may hold any character except `"`. Between tokens, whitespace is ignored:
U+0020 SPACE, U+0009 TAB, U+000A LF, U+000D CR.

| Token | Written as | Regular expression | Notes |
|---|---|---|---|
| `Number` | `1`, `1.5` | `\d+(?:\.\d+)?` | No sign, no exponent (`1e3` is not a number), no leading or trailing dot (`.5`, `1.` are not numbers). Value is the JavaScript `Number` of the text. |
| `String` | `"done"` | `"` *chars-not-quote* `"` | **Double quotes only, no escape sequences.** `\` is an ordinary character; a `"` cannot appear inside. `"done"` has the value `done`. |
| `Name` | `amount` | `[A-Za-z][A-Za-z0-9]*` | First character is an ASCII letter. See `rules.md` R-VOCAB-11 for the name pattern. |
| two-char operator | `>=` `<=` `==` `!=` | — | Matched before the one-char operators. |
| one-char operator | `+` `-` `*` `/` `>` `<` | — | A single `=` is **not** an operator. |
| punctuation | `(` `)` `,` `.` | — | `.` appears only in member access (§5). |

Any other character is not in the alphabet and makes the expression **unreadable**
(`LOGIC_EXPRESSION_INVALID`). This includes `&`, `|`, `!` on its own, `=`, `%`, `#`, `?`, `[`, `]`, `{`, `}`, `'`, `@`, and `~`.

## 3. Syntax

The whole value of the slot (after trimming whitespace) must be a single `Expression`.

```ebnf
(* ── syntax ───────────────────────────────────────────────────────── *)

Expression      = Comparison ;

Comparison      = Additive [ ComparisonOp Additive ] ;          (* at most one comparison operator *)
Additive        = Multiplicative { ( "+" | "-" ) Multiplicative } ;
Multiplicative  = Unary { ( "*" | "/" ) Unary } ;
Unary           = "-" Unary | Primary ;
Primary         = Number | String | Name | Call | "(" Expression ")" ;

Call            = Name "(" [ Expression { "," Expression } ] ")" ;

ComparisonOp    = ">=" | "<=" | "==" | "!=" | ">" | "<" ;

(* ── lexemes (see §2) ─────────────────────────────────────────────── *)

Number          = digit { digit } [ "." digit { digit } ] ;
String          = '"' { character - '"' } '"' ;                  (* no escapes *)
Name            = letter { letter | digit } ;

digit           = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" ;
letter          = "A" | … | "Z" | "a" | … | "z" ;
```

- `Call` is recognised only when a `Name` is immediately followed by `(`. A bare `Name` is a value reference (§4).
- `Name "." Name` (member access) is deliberately **absent** from `Primary`: it is read by the parser only so the rejection can be reported precisely, and is **not writable in this version** (§5).
- Parentheses group; they do **not** add a node or a level of depth (§7 of `rules.md`).

## 4. Precedence and associativity

From loosest (1) to tightest (5). A tighter level binds first.

| Level | Operators | Form | Associativity | Operand type | Result |
|---|---|---|---|---|---|
| 1 (loosest) | `>` `>=` `<` `<=` `==` `!=` | binary | **none** — at most one comparison per level | see `rules.md` R-TYPE-03 … R-TYPE-06 | `boolean` |
| 2 | `+` `-` | binary | **left** | `number` | `number` |
| 3 | `*` `/` | binary | **left** | `number` | `number` |
| 4 | `-` | unary prefix | **right** (may nest: `- -x`) | `number` | `number` |
| 5 (tightest) | `( … )`, `f( … )` | grouping, call | — | — | — |

- **Comparison is non-associative.** `a < b < c` has no reading and is unreadable (`LOGIC_EXPRESSION_INVALID`). To compare a comparison result you must parenthesise it, but a `boolean` is not an operand of any operator, so the type check then rejects it (`rules.md` R-TYPE-07).
- **Arithmetic is left-associative.** `8 - 3 - 2` reads as `(8 - 3) - 2`.
- **Unary `-` binds tighter than `*` `/`**, which bind tighter than `+` `-`, which bind tighter than comparison.
- A **call argument** is a full `Expression`, so `min(1, a > b)` is syntactically well-formed; the type check rejects it (`rules.md` R-TYPE-09).

### Worked examples (values a conforming evaluator returns)

| Expression | Value | What it shows |
|---|---|---|
| `2 + 3 * 4` | `14` | `*` binds tighter than `+` |
| `2 * 3 + 4` | `10` | `*` binds tighter than `+` |
| `8 - 3 - 2` | `3` | `-` is left-associative |
| `20 / 5 / 2` | `2` | `/` is left-associative |
| `-(2 + 3)` | `-5` | parentheses group |
| `-2 + 3` | `1` | unary `-` binds tighter than `+` |
| `2 - -3` | `5` | unary `-` may nest |
| `1 + 1 == 2` | `true` | `+` binds tighter than `==` |
| `2 * 2 >= 4` | `true` | `*` binds tighter than `>=` |
| `1 / 0` | `null` (not a number) | a non-finite result is `null`, never `0` (see `rules.md` R-TYPE-14) |

## 5. Read by the parser but rejected in this version

The parser accepts these so that the rejection can name the actual problem. They are **not** part of the accepted language.

| Construct | Read as | Rejection |
|---|---|---|
| `budget.limit` (a declared entity on the left) | member access | `LOGIC_REFERENCE_OUT_OF_ENTITY` — an expression sees only its own entity without a dot (`rules.md` R-NAME-02) |
| `nosuch.x` (not a declared entity) | member access | `LOGIC_REFERENCE_NOT_FOUND` |
| `round(amount)` | call to an unknown name | `LOGIC_FUNCTION_NOT_ALLOWED` (`rules.md` R-VOCAB-10) |
| `min(1, a > b)` | a call whose argument is a comparison result | `LOGIC_FUNCTION_ARGUMENT_TYPE_MISMATCH` (`rules.md` R-TYPE-09) |
| `(a > b) + 1` | arithmetic on a comparison result | `LOGIC_OPERAND_TYPE_MISMATCH` (`rules.md` R-TYPE-07) |

## 6. Not writable

- **No boolean or null literals.** `true`, `false`, `null` match the `Name` rule, so they are ordinary names: a lone one is unresolvable, and `true + false` parses but fails name resolution (`LOGIC_REFERENCE_NOT_FOUND`). There is no way to write a boolean literal.
- **No boolean operators.** `and`, `or`, `not` are not keywords or operators. `a and b` is unreadable; `not` alone is an ordinary name. There is no way to combine comparisons.
- **No exponent notation, no unary `+`.** `1e3` and `+amount` are unreadable.
- **No string escapes** and no string operations: a string literal can only be compared with `==` / `!=` (`rules.md` R-TYPE-05).
- **`label` is not a name.** A display name never resolves in an expression (`rules.md` R-NAME-07).

## 7. Limits

Length, depth, and node count — with how each is counted, and the just-before / exactly / over points — are in
[`rules.md`](./rules.md) R-LIMIT-01 … R-LIMIT-04.
