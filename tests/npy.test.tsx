import { describe, expect, it } from "vitest";
import { parseNpyShape } from "../app/lib/npy";

describe("NPY shape parser", () => {
  it("does not turn the trailing comma of a one-dimensional shape into zero", () => {
    expect(parseNpyShape("30678,")).toEqual([30678]);
  });

  it("keeps every dimension of a matrix", () => {
    expect(parseNpyShape("30677, 3")).toEqual([30677, 3]);
  });
});
