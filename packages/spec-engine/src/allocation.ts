// 割り勘の端数の決めごと（Q13・Q18-5）の、評価に使う純粋な道具。
// 意味は packages/appspec-schema/docs/semantics.md（「settle」）にある。
//
// **語彙は足さない。** 1 人あたりの額を式（`amount / headcount`）で書くと小数になるので、
// 端数の扱いは宣言ではなく店頭の内部規約（この file）が持つ。宣言の `owed` は基準額の集計のままであり、
// **基準額（ここでいう `base`）と、個人ごとの配賦（余りを誰が負担するか）を混同しない**（Q18-5）。
//
// 決めごと（Q13。2026-09-15 所有者）:
//   1. 1 人あたりの基準額は **1 円未満を切り捨てる**
//   2. `amount - base × 人数` の余りは、**払った人が割る人に入っていれば払った人**が、
//      入っていなければ**割る人のうち登録が最も早い人**が負担する
//   3. 各人の負担の合計は、支出の額と**ちょうど一致する**（余りを 1 円ずつ配るのではない）
//
// **並び順で余りを決めない。** 2 の「登録が最も早い人」は、支出の `participants` に書いた並びではなく、
// **メンバーの登録順**である（採点の受入条件。2026-09-17）。

/** 割り勘の支出 1 件の、評価に要る形（宣言の `settle` が指す項目から読む） */
export interface SettleExpense {
  /** 支出の額（整数円。Q18-6） */
  readonly amount: number;
  /** 払った人の ID */
  readonly payer: string;
  /** 割る人の ID の並び（入力の順。**余りの担当はこの順では決めない**） */
  readonly participants: readonly string[];
}

/** 1 件の支出を割った結果（基準額と、余りの担当と、人ごとの負担） */
export interface Allocation {
  /** 基準額（1 人あたり。1 円未満を切り捨てた額） */
  readonly base: number;
  /** 余り（`amount - base × 人数`）。0 以上、人数未満である */
  readonly remainder: number;
  /** 余りを負担する人（払った人か、割る人のうち登録が最も早い人） */
  readonly bearer: string;
  /** 人ごとの負担（割る人だけ。合計は `amount` に一致する） */
  readonly burden: ReadonlyMap<string, number>;
}

/**
 * 支出 1 件を割る。**割れない入力は `null`** にする（0 に読み替えない）——
 * 割る人が 0 人、額が有限でない、知らない人の ID を指している、のいずれかである。
 * `order` はメンバーの ID → 登録の順（0 から。余りの担当を決めるのに使う）。
 */
export function allocateExpense(
  expense: SettleExpense,
  order: ReadonlyMap<string, number>,
): Allocation | null {
  const { amount, payer, participants } = expense;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return null;
  if (participants.length === 0) return null;
  if (!participants.every((id) => order.has(id))) return null;

  const base = Math.floor(amount / participants.length);
  const remainder = amount - base * participants.length;

  // 余りは払った人（割る人に入っているとき）が持つ。入っていなければ、**登録が最も早い割る人**が持つ
  let bearer = payer;
  if (!participants.includes(payer)) {
    const earliest = participants.reduce((best, id) =>
      (order.get(id) ?? 0) < (order.get(best) ?? 0) ? id : best,
    );
    bearer = earliest;
  }

  const burden = new Map<string, number>(participants.map((id) => [id, base]));
  if (remainder !== 0) burden.set(bearer, base + remainder);
  return { base, remainder, bearer, burden };
}
