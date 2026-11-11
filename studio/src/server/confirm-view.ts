// 確認の画面の変換（studio-s1.md §4.1・Issue #867 の目的・8）。
//
// 工場の `PlanConfirmationView`（下書きの仕様・差分・了承して除く部分・既定で決めたこと）を、画面の型
// `RunnerConfirmation` へ写す。**表示用の欄には要件 ID・事項 ID・宣言の用語を出さない**——ID は引くための
// 鍵にだけ使い、欄には文（利用者の言葉）を入れる。画面の型（runner.ts）は変えない。
import type {
  PlanAcceptedUnwritable,
  PlanChange,
  PlanDecision,
  PlanPart,
  PlanRequirement,
} from "@musunest/appspec-schema";
import type { PlanConfirmationView } from "@musunest/factory";
import type { RunnerConfirmation } from "./runner.js";

/** 要件の ID から文を引く（無ければ undefined。ID を表示に使わない） */
function requirementText(requirements: readonly PlanRequirement[], id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  return requirements.find((requirement) => requirement.id === id)?.text;
}

/** 部分の ID から部分の文を引く */
function partText(requirements: readonly PlanRequirement[], partId: string): string | undefined {
  for (const requirement of requirements) {
    const part: PlanPart | undefined = requirement.parts.find((candidate) => candidate.id === partId);
    if (part !== undefined) return part.text;
  }
  return undefined;
}

/**
 * 差分 1 件を文にする。`added` は答えの ID からその答えで足した要件を、`changed`・`removed` は
 * 元の要件の ID から要件を引く。引けないときは、ID を出さずに省く。
 */
function changeText(requirements: readonly PlanRequirement[], change: PlanChange): string | undefined {
  if (change.kind === "added") {
    const added = requirements.find(
      (requirement) =>
        requirement.change !== undefined &&
        requirement.change.kind === "added" &&
        requirement.change.answer_id === change.answer_id,
    );
    return added?.text;
  }
  return requirementText(requirements, change.from_requirement_id);
}

/** 差分を 3 つの文の並びに写す（引けないものは省く。ID は出さない） */
function changeTexts(
  requirements: readonly PlanRequirement[],
  changes: readonly PlanChange[],
  kind: PlanChange["kind"],
): string[] {
  const texts: string[] = [];
  for (const change of changes) {
    if (change.kind !== kind) continue;
    const text = changeText(requirements, change);
    if (text !== undefined) texts.push(text);
  }
  return texts;
}

/** 了承して除く部分と代わりの案を、表示用の 2 つの文に写す（引けないものは省く） */
function limitationOf(
  requirements: readonly PlanRequirement[],
  unwritable: PlanAcceptedUnwritable,
): RunnerConfirmation["limitations"][number] | undefined {
  const what = partText(requirements, unwritable.part_id);
  const alternative = requirementText(requirements, unwritable.alternative_id);
  if (what === undefined || alternative === undefined) return undefined;
  return { what, alternative };
}

/** 既定で決めたことを 1 つの文にする（ID は出さない） */
function decidedText(decision: PlanDecision): string {
  return `${decision.subject}: ${decision.value}`;
}

/**
 * 確認の画面に出すものへ写す。**要件 ID・事項 ID・宣言の用語は表示用の欄に入れない**——要件は文だけ、
 * 差分は文だけ、書けないことは部分の文と代わりの案の文、既定で決めたことは事項と値だけである。
 */
export function toRunnerConfirmation(view: PlanConfirmationView): RunnerConfirmation {
  const requirements = view.plan.requirements;
  const limitations: RunnerConfirmation["limitations"][number][] = [];
  for (const unwritable of view.plan.accepted_unwritable) {
    const limitation = limitationOf(requirements, unwritable);
    if (limitation !== undefined) limitations.push(limitation);
  }
  return {
    requirements: requirements.map((requirement) => requirement.text),
    diff: {
      added: changeTexts(requirements, view.diff, "added"),
      changed: changeTexts(requirements, view.diff, "changed"),
      removed: changeTexts(requirements, view.diff, "removed"),
    },
    limitations,
    decided: view.closedByDefault.map(decidedText),
  };
}
