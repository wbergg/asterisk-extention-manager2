import { describe, expect, it } from "vitest";

import { buttonProblem } from "../src/model/sccp/button.js";

/** Mirrors sccp-rs config/parsing/button.rs — exact arity, known options. */
describe("buttonProblem", () => {
  const lines = new Set(["1006"]);

  it("accepts a full line button", () => {
    expect(
      buttonProblem(
        "line",
        ["1006", "label=1006", "caller_name=Wbergs Desk", "caller_number=1006", "ring=normal", "privacy=no"],
        lines,
      ),
    ).toBeNull();
  });

  it("rejects a line that is not an SCCP line on the PBX", () => {
    expect(buttonProblem("line", ["2001"], lines)).toMatch(/not an SCCP extension/);
  });

  it("checks syntax only when no line set is given", () => {
    expect(buttonProblem("line", ["2001"])).toBeNull();
  });

  it.each([
    [["1006", "lable=x"], /unknown line option "lable"/],
    [["1006", "label"], /key=value/],
    [["1006", "ring=loud"], /ring must be/],
    [["1006", "privacy=maybe"], /privacy must be/],
    [["1006", "label=a", "Label=b"], /more than once/],
  ])("rejects line options %j", (args, msg) => {
    expect(buttonProblem("line", args, lines)).toMatch(msg);
  });

  it("enforces exact BLF arity and hint syntax", () => {
    expect(buttonProblem("blf", ["fozzie", "2001", "2001@aem-internal"])).toBeNull();
    expect(buttonProblem("blf", ["fozzie", "2001", "2001@aem-internal", "x"])).toMatch(/exactly/);
    expect(buttonProblem("blf", ["fozzie", "2001", "2001"])).toMatch(/extension@context/);
    expect(buttonProblem("blf", ["fozzie", "2001", "2001@a@b"])).toMatch(/extension@context/);
  });

  it("allows speed_dial with an optional hint", () => {
    expect(buttonProblem("speed_dial", ["Conference Room", "9002"])).toBeNull();
    expect(buttonProblem("speed_dial", ["a", "1", "1@ctx"])).toBeNull();
    expect(buttonProblem("speed_dial", ["a"])).toMatch(/label, number/);
    expect(buttonProblem("speed_dial", ["a", "1", "nohint"])).toMatch(/extension@context/);
  });

  it("validates feature names, addons and argument-less kinds", () => {
    expect(buttonProblem("feature", ["DND", "donotdisturb"])).toBeNull();
    expect(buttonProblem("feature", ["X", "teleport"])).toMatch(/unknown feature/);
    expect(buttonProblem("addon", ["1", "7914"])).toBeNull();
    expect(buttonProblem("addon", ["57", "7914"])).toMatch(/1-56/);
    expect(buttonProblem("empty", [])).toBeNull();
    expect(buttonProblem("empty", ["x"])).toMatch(/no arguments/);
  });
});
