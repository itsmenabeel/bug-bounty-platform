import { ProgramStatus, ReportStatus } from "@prisma/client";
import { assertTransition } from "../../src/modules/report/report.transition";
import { PROGRAM_TRANSITIONS } from "../../src/shared/constants/programStatus";
import { REPORT_TRANSITIONS } from "../../src/shared/constants/reportStatus";
import { AppError } from "../../src/shared/errors/AppError";

describe("report transition map", () => {
  it("defines every status, and only known targets", () => {
    const all = Object.values(ReportStatus);
    expect(Object.keys(REPORT_TRANSITIONS).sort()).toEqual([...all].sort());
    for (const targets of Object.values(REPORT_TRANSITIONS)) {
      for (const target of targets) expect(all).toContain(target);
    }
  });

  it.each(["DUPLICATE", "REJECTED", "REWARDED"] as const)("%s is terminal", (status) => {
    expect(REPORT_TRANSITIONS[status]).toEqual([]);
  });

  it.each([
    ["NEW", "TRIAGING"],
    ["NEW", "REJECTED"],
    ["NEW", "DUPLICATE"],
    ["TRIAGING", "ACCEPTED"],
    ["TRIAGING", "NEEDS_INFO"],
    ["TRIAGING", "REJECTED"],
    ["TRIAGING", "DUPLICATE"],
    ["NEEDS_INFO", "TRIAGING"],
    ["ACCEPTED", "REWARDED"],
  ] as const)("allows %s -> %s", (from, to) => {
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each([
    ["NEW", "ACCEPTED"],
    ["NEW", "REWARDED"],
    ["TRIAGING", "REWARDED"],
    ["NEEDS_INFO", "ACCEPTED"],
    ["ACCEPTED", "REJECTED"],
    ["ACCEPTED", "TRIAGING"],
    ["REJECTED", "TRIAGING"],
    ["DUPLICATE", "NEW"],
    ["REWARDED", "ACCEPTED"],
  ] as const)("rejects %s -> %s with a 409", (from, to) => {
    try {
      assertTransition(from, to);
      throw new Error("expected assertTransition to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).statusCode).toBe(409);
    }
  });

  it("only ACCEPTED can reach REWARDED", () => {
    const sources = Object.entries(REPORT_TRANSITIONS)
      .filter(([, targets]) => targets.includes("REWARDED"))
      .map(([from]) => from);
    expect(sources).toEqual(["ACCEPTED"]);
  });
});

describe("program transition map", () => {
  it("defines every status", () => {
    expect(Object.keys(PROGRAM_TRANSITIONS).sort()).toEqual(Object.values(ProgramStatus).sort());
  });

  it("never returns to DRAFT and treats CLOSED as terminal", () => {
    for (const targets of Object.values(PROGRAM_TRANSITIONS))
      expect(targets).not.toContain("DRAFT");
    expect(PROGRAM_TRANSITIONS.CLOSED).toEqual([]);
  });

  it("lets an active program pause and resume", () => {
    expect(PROGRAM_TRANSITIONS.ACTIVE).toContain("PAUSED");
    expect(PROGRAM_TRANSITIONS.PAUSED).toContain("ACTIVE");
  });
});
