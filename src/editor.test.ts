import { describe, expect, test } from "bun:test";
import { referenceBuffer, SCISSORS, stripReference } from "./editor.ts";

describe("scissors reference", () => {
	test("text above the scissors is kept; the line and below are dropped", () => {
		const buf = referenceBuffer(["> agent text"]);
		expect(buf.startsWith("\n\n")).toBe(true);
		expect(buf).toContain(SCISSORS);
		expect(stripReference(buf)).toBe("");
		expect(stripReference(`My idea\n\nMore.\n\n${buf}`)).toBe("My idea\n\nMore.\n");
	});

	test("no scissors: text unchanged; trailing spaces on the line still match", () => {
		expect(stripReference("Plain\n")).toBe("Plain\n");
		expect(stripReference(`Mine\n${SCISSORS}  \n> x\n`)).toBe("Mine\n");
	});
});
