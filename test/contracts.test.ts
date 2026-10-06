import { describe, expect, it } from "vitest";
import { parseStrictObject, validateSchema } from "../src/contracts.js";

describe("strict JSON (jsonc-parser syntax, duplicate-key policy)", () => {
	it("rejects duplicate keys: plain, escape-equivalent, nested, equal and different values", () => {
		for (const [text, key] of [
			['{"a":1,"a":1}', "a"],
			['{"a":1,"a":2}', "a"],
			['{"a":1,"\\u0061":2}', "a"],
			['{"\\u0061":1,"a":1}', "a"],
			['{"x":{"b":1,"c":2,"b":1}}', "b"],
			['{"x":[{"k":1},{"k":2,"k":2}]}', "k"],
			['{"caf\\u00e9":1,"café":2}', "café"],
		] as Array<[string, string]>) {
			expect(() => parseStrictObject(text, "doc"), text).toThrow(`doc: duplicate key ${JSON.stringify(key)}`);
		}
	});

	it("rejects comments, trailing commas, trailing data and parse errors", () => {
		for (const [text, pattern] of [
			['{"a":1} // c', /InvalidCommentToken/],
			['/* c */ {"a":1}', /InvalidCommentToken/],
			['{"a":1,}', /PropertyNameExpected|ValueExpected/],
			['{"a":[1,]}', /ValueExpected/],
			['{"a":1} x', /InvalidSymbol|EndOfFileExpected/],
			['{"a":1}{"b":2}', /EndOfFileExpected/],
			['{"a":"\\x"}', /InvalidEscapeCharacter/],
			['{"a":"tab\there"}', /InvalidCharacter/],
			['{"a":01}', /Expected/],
			['{"a":NaN}', /InvalidSymbol|ValueExpected/],
			["", /ValueExpected/],
			['{"a":1', /CloseBraceExpected/],
		] as Array<[string, RegExp]>) {
			expect(() => parseStrictObject(text, "doc"), text).toThrow(pattern);
		}
		expect(() => parseStrictObject("[1]", "doc")).toThrow(/not a JSON object/);
		expect(() => parseStrictObject('"s"', "doc")).toThrow(/not a JSON object/);
	});

	it("accepts valid escapes, valid nesting and the same key in different objects", () => {
		const v = parseStrictObject(
			'{"a":"q\\"\\\\\\/\\b\\f\\n\\r\\t\\u00e9","b":{"a":1,"c":[{"a":1},{"a":2}]},"\\u0062x":[]}\n',
			"doc",
		);
		expect(v).toEqual({ a: 'q"\\/\b\f\n\r\té', b: { a: 1, c: [{ a: 1 }, { a: 2 }] }, bx: [] });
		// The parsed value still goes through schema validation as before.
		expect(
			validateSchema({ type: "object", required: ["a"], properties: { a: { type: "string" } } }, v),
		).toBeUndefined();
		expect(validateSchema({ type: "object", required: ["z"] }, v)).toMatch(/required/);
	});
});
