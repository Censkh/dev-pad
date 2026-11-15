/* biome-ignore-all lint/suspicious/noTemplateCurlyInString: GitHub expressions are ${{ }} strings. */
import { describe, expect, test } from "bun:test";
import {
  condition,
  type ExpressionContext,
  evaluate,
  evaluateValue,
  interpolate,
  UnknownContextError,
} from "../expressions";

const context = (contexts: ExpressionContext["contexts"], failed = false): ExpressionContext => ({
  contexts,
  status: { success: () => !failed, failure: () => failed, cancelled: () => false },
});

describe("expressions", () => {
  test("compare strings ignoring case and mixed types as numbers, as GitHub does", () => {
    const ctx = context({ github: { ref_name: "Main" } });
    expect(evaluate("github.ref_name == 'main'", ctx)).toBe(true);
    expect(evaluate("'1' == 1", ctx)).toBe(true);
    expect(evaluate("true == 1", ctx)).toBe(true);
    expect(evaluate("'abc' == 0", ctx)).toBe(false);
  });

  test("read hyphenated job outputs and bracketed properties", () => {
    const ctx = context({ needs: { changes: { outputs: { "document-processor": "true" } } } });
    expect(evaluate("needs.changes.outputs.document-processor == 'true'", ctx)).toBe(true);
    expect(evaluate("needs['changes'].outputs['document-processor']", ctx)).toBe("true");
    expect(evaluate("needs.missing.outputs.any", ctx)).toBe(null);
  });

  test("keep a whole expression's type and stringify interpolated parts", () => {
    const ctx = context({
      needs: { changes: { outputs: { checks: '[{"name":"a"},{"name":"b"}]' } } },
    });
    expect(evaluateValue({ include: "${{ fromJSON(needs.changes.outputs.checks) }}" }, ctx)).toEqual({
      include: [{ name: "a" }, { name: "b" }],
    });
    expect(interpolate("Checks (${{ fromJSON(needs.changes.outputs.checks)[1].name }})", ctx)).toBe("Checks (b)");
    expect(interpolate("${{ format('{0}-{{x}}', 3) }}", ctx)).toBe("3-{x}");
  });

  test("a condition without a status function also needs earlier steps to have passed", () => {
    const contexts = { matrix: { sdk: true } };
    expect(condition("matrix.sdk", context(contexts))).toBe(true);
    expect(condition("matrix.sdk", context(contexts, true))).toBe(false);
    expect(condition("failure()", context(contexts, true))).toBe(true);
    expect(condition("${{ always() && matrix.sdk }}", context(contexts, true))).toBe(true);
    expect(condition(undefined, context(contexts, true))).toBe(false);
  });

  test("an unknown context still decides `x && false` but not `x && true`", () => {
    const ctx = context({ runner: { environment: "local" }, matrix: undefined });
    expect(evaluate("matrix.name == 'workers' && runner.environment == 'github-hosted'", ctx)).toBe(false);
    expect(() => evaluate("matrix.name == 'workers' && runner.environment == 'local'", ctx)).toThrow(
      UnknownContextError,
    );
  });

  test("reject functions and contexts without a local implementation", () => {
    expect(() => evaluate("hashFiles('bun.lock')", context({}))).toThrow("hashfiles() has no local implementation");
    expect(() => evaluate("nonsense.value", context({}))).toThrow("Unknown context 'nonsense'");
  });
});
