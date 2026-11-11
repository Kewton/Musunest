import { parseCliArguments } from "@musunest/factory";
import { describe, expect, it } from "vitest";
import {
  STANDARD_BUILD_EFFORT,
  STANDARD_BUILD_MODEL,
  STANDARD_BUILD_STAGE_EFFORT,
  STANDARD_BUILD_STAGE_MODEL,
  buildFactoryBuildArgs,
  remainingBuildBudgetUsd,
} from "./build-args.js";

const baseInput = {
  requestFile: "/tmp/job/request.txt",
  outDir: "/tmp/job/out",
  planFile: "/tmp/job/plan-result.json",
  planSpentUsd: 0.37,
};

const valueOf = (argv: readonly string[], flag: string): string => {
  const index = argv.indexOf(flag);
  const value = index < 0 ? undefined : argv[index + 1];
  if (value === undefined) throw new Error(`${flag} の値が無い`);
  return value;
};

describe("Build の標準の組", () => {
  it("7 つの旗と予算を、決まった順に並べる", () => {
    const argv = buildFactoryBuildArgs(baseInput);
    expect(argv).toEqual([
      baseInput.requestFile,
      "--out",
      baseInput.outDir,
      "--pipeline",
      "v1.2",
      "--plan-file",
      baseInput.planFile,
      "--model",
      STANDARD_BUILD_MODEL,
      "--effort",
      STANDARD_BUILD_EFFORT,
      "--stage-effort",
      STANDARD_BUILD_STAGE_EFFORT,
      "--stage-model",
      STANDARD_BUILD_STAGE_MODEL,
      "--budget",
      "1.63",
    ]);
    for (const flag of ["--pipeline", "--plan-file", "--model", "--effort", "--stage-effort", "--stage-model", "--budget"]) {
      expect(argv.filter((argument) => argument === flag)).toHaveLength(1);
    }
  });

  it("工場の引数の読み取りが使い方の誤りを返さない", () => {
    const parsed = parseCliArguments(buildFactoryBuildArgs(baseInput));
    expect("error" in parsed).toBe(false);
  });
});

describe("Build に残る予算", () => {
  it("2.00 から Plan の額をセントで引く", () => {
    expect(remainingBuildBudgetUsd(0)).toBe(2);
    expect(remainingBuildBudgetUsd(0.37)).toBe(1.63);
    expect(remainingBuildBudgetUsd(2)).toBe(0);
  });

  it("小数の丸めで 2.00 を超えない", () => {
    for (const spent of [0.1 + 0.2, 0.001, 0.004, 0.005, 0.999, 1.005, 1.999]) {
      const budget = remainingBuildBudgetUsd(spent);
      const roundedSpent = Math.round(spent * 100) / 100;
      expect(budget).toBeLessThanOrEqual(2);
      expect(Number.isInteger(Math.round(budget * 100))).toBe(true);
      expect(budget + roundedSpent).toBeLessThanOrEqual(2);
    }
    expect(remainingBuildBudgetUsd(0.1 + 0.2)).toBe(1.7);
    expect(valueOf(buildFactoryBuildArgs({ ...baseInput, planSpentUsd: 0.1 + 0.2 }), "--budget")).toBe("1.70");
  });
});
