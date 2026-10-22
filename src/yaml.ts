// Minimal YAML subset for .luuna/roots/config.yaml (zero deps).
//
// Supported:
//   - Block mappings nested by indentation (spaces only).
//   - Block sequences of scalars (`- item`) and flow sequences (`[a, b]`).
//   - Scalars: "double" / 'single' quoted strings, true/false, null/~,
//     integers, floats, bare strings.
//   - `# comments`, whole-line and trailing (a `#` preceded by whitespace).
//
// Not supported: anchors, tags, block scalars (| >), multi-docs, sequences of
// mappings. Roots config never needs them; the parser throws on what it can't
// read rather than guessing.

export type YamlValue = string | number | boolean | null | YamlValue[] | YamlMap;
export interface YamlMap {
	[key: string]: YamlValue;
}

interface Line {
	no: number;
	indent: number;
	text: string;
}

export class YamlError extends Error {
	constructor(message: string, line?: number) {
		super(line === undefined ? message : `line ${line}: ${message}`);
		this.name = "YamlError";
	}
}

function stripComment(raw: string): string {
	let quote: string | null = null;
	for (let i = 0; i < raw.length; i++) {
		const c = raw[i];
		if (quote) {
			if (c === quote) quote = null;
		} else if (c === '"' || c === "'") {
			quote = c;
		} else if (c === "#" && (i === 0 || raw[i - 1] === " " || raw[i - 1] === "\t")) {
			return raw.slice(0, i);
		}
	}
	return raw;
}

function tokenize(content: string): Line[] {
	const lines: Line[] = [];
	content.split(/\r?\n/).forEach((raw, idx) => {
		const text = stripComment(raw).trimEnd();
		const body = text.trimStart();
		if (body === "") return;
		const indent = text.length - body.length;
		if (text.slice(0, indent).includes("\t")) throw new YamlError("tabs are not allowed", idx + 1);
		lines.push({ no: idx + 1, indent, text: body });
	});
	return lines;
}

/** Index of the `key: value` separator colon, or -1. */
function keyColon(text: string): number {
	let quote: string | null = null;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === quote) quote = null;
		} else if (c === '"' || c === "'") {
			quote = c;
		} else if (c === ":" && (i + 1 === text.length || text[i + 1] === " ")) {
			return i;
		}
	}
	return -1;
}

function unquote(s: string): string {
	if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
		try {
			return JSON.parse(s) as string;
		} catch {
			return s.slice(1, -1);
		}
	}
	if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
		return s.slice(1, -1).replace(/''/g, "'");
	}
	return s;
}

function splitFlow(inner: string): string[] {
	const parts: string[] = [];
	let quote: string | null = null;
	let start = 0;
	for (let i = 0; i < inner.length; i++) {
		const c = inner[i];
		if (quote) {
			if (c === quote) quote = null;
		} else if (c === '"' || c === "'") {
			quote = c;
		} else if (c === ",") {
			parts.push(inner.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(inner.slice(start));
	return parts.map((p) => p.trim()).filter((p) => p !== "");
}

export function parseScalar(s: string): YamlValue {
	if (s.startsWith("[")) {
		if (!s.endsWith("]")) throw new YamlError(`unclosed flow sequence: ${s}`);
		return splitFlow(s.slice(1, -1)).map(parseScalar);
	}
	if (s === "{}") return {};
	if (s.startsWith("{")) throw new YamlError(`flow mappings are not supported: ${s}`);
	if (s.startsWith('"') || s.startsWith("'")) return unquote(s);
	if (s === "true") return true;
	if (s === "false") return false;
	if (s === "null" || s === "~" || s === "") return null;
	if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
	return s;
}

interface Parsed<T> {
	value: T;
	next: number;
}

function parseSequence(lines: Line[], start: number, indent: number): Parsed<YamlValue[]> {
	const out: YamlValue[] = [];
	let i = start;
	for (let line = lines[i]; line && line.indent === indent && line.text.startsWith("-"); ) {
		const rest = line.text.slice(1).trim();
		if (rest === "" || keyColon(rest) !== -1) {
			throw new YamlError("only scalar sequence items are supported", line.no);
		}
		out.push(parseScalar(rest));
		i++;
		line = lines[i];
	}
	return { value: out, next: i };
}

function parseValueBlock(lines: Line[], start: number, parentIndent: number): Parsed<YamlValue> {
	const next = lines[start];
	if (!next || next.indent < parentIndent) return { value: null, next: start };
	const isSeq = next.text.startsWith("-");
	if (next.indent === parentIndent && !isSeq) return { value: null, next: start };
	if (isSeq) return parseSequence(lines, start, next.indent);
	return parseMapping(lines, start, next.indent);
}

function parseMapping(lines: Line[], start: number, indent: number): Parsed<YamlMap> {
	const map: YamlMap = {};
	let i = start;
	for (let line = lines[i]; line && line.indent >= indent; line = lines[i]) {
		if (line.indent > indent) throw new YamlError("unexpected indentation", line.no);
		const colon = keyColon(line.text);
		if (colon === -1) throw new YamlError(`expected "key: value" (got "${line.text}")`, line.no);
		const key = unquote(line.text.slice(0, colon).trim());
		const rest = line.text.slice(colon + 1).trim();
		if (rest !== "") {
			map[key] = parseScalar(rest);
			i++;
			continue;
		}
		const sub = parseValueBlock(lines, i + 1, indent);
		map[key] = sub.value;
		i = sub.next;
	}
	return { value: map, next: i };
}

export function parseYaml(content: string): YamlMap {
	const lines = tokenize(content);
	const first = lines[0];
	if (!first) return {};
	if (first.text.startsWith("-")) throw new YamlError("top-level sequences are not supported");
	const { value, next } = parseMapping(lines, 0, first.indent);
	const leftover = lines[next];
	if (leftover) throw new YamlError("unexpected content", leftover.no);
	return value;
}

function needsQuotes(s: string): boolean {
	if (s === "" || s !== s.trim()) return true;
	if (["true", "false", "null", "~"].includes(s)) return true;
	if (/^-?\d+(\.\d+)?$/.test(s)) return true;
	return /[:#"'[\]{},&*!|>%@`\n]/.test(s) || s.startsWith("-");
}

function emitScalar(v: YamlValue): string {
	if (v === null) return "null";
	if (typeof v === "string") return needsQuotes(v) ? JSON.stringify(v) : v;
	if (Array.isArray(v)) return `[${v.map(emitScalar).join(", ")}]`;
	if (typeof v === "object") throw new YamlError("nested mapping cannot be emitted as a scalar");
	return String(v);
}

function emitMap(map: YamlMap, indent: number): string[] {
	const pad = " ".repeat(indent);
	const lines: string[] = [];
	for (const [k, v] of Object.entries(map)) {
		const key = needsQuotes(k) ? JSON.stringify(k) : k;
		const isMap = v !== null && typeof v === "object" && !Array.isArray(v);
		if (isMap && Object.keys(v).length > 0) {
			lines.push(`${pad}${key}:`, ...emitMap(v, indent + 2));
		} else {
			lines.push(`${pad}${key}: ${isMap ? "{}" : emitScalar(v)}`);
		}
	}
	return lines;
}

export function stringifyYaml(map: YamlMap): string {
	return `${emitMap(map, 0).join("\n")}\n`;
}
