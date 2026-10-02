export type DiffLine = { kind: "same" | "add" | "del"; text: string };

// Above this many line pairs the LCS table gets too big, so fall back to
// showing the old text removed and the new text added.
const MAX_CELLS = 4_000_000;

/** Line diff via longest common subsequence. Good enough for permission cards. */
export function diffLines(before: string, after: string): DiffLine[] {
	const a = toLines(before);
	const b = toLines(after);

	// Trim the common prefix and suffix so the table only covers the changed middle.
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}
	const head = a.slice(0, start).map((text): DiffLine => ({ kind: "same", text }));
	const tail = a.slice(endA).map((text): DiffLine => ({ kind: "same", text }));
	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);

	if (midA.length * midB.length > MAX_CELLS) {
		return [
			...head,
			...midA.map((text): DiffLine => ({ kind: "del", text })),
			...midB.map((text): DiffLine => ({ kind: "add", text })),
			...tail,
		];
	}

	// lcs[i][j] = LCS length of midA[i..] and midB[j..].
	const n = midA.length;
	const m = midB.length;
	const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			lcs[i]![j] = midA[i] === midB[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
		}
	}
	const mid: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (midA[i] === midB[j]) {
			mid.push({ kind: "same", text: midA[i++]! });
			j++;
		} else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
			mid.push({ kind: "del", text: midA[i++]! });
		} else {
			mid.push({ kind: "add", text: midB[j++]! });
		}
	}
	while (i < n) mid.push({ kind: "del", text: midA[i++]! });
	while (j < m) mid.push({ kind: "add", text: midB[j++]! });
	return [...head, ...mid, ...tail];
}

// A trailing newline ends the last line rather than starting an empty one.
function toLines(text: string): string[] {
	return text === "" ? [] : text.replace(/\n$/, "").split("\n");
}

/** Drops unchanged lines further than `context` lines from a change, marking gaps with null. */
export function withContext(lines: DiffLine[], context = 3): (DiffLine | null)[] {
	const keep = new Array<boolean>(lines.length).fill(false);
	lines.forEach((line, idx) => {
		if (line.kind === "same") return;
		for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) keep[k] = true;
	});
	const out: (DiffLine | null)[] = [];
	lines.forEach((line, idx) => {
		if (keep[idx]) out.push(line);
		else if (out.at(-1) !== null) out.push(null);
	});
	return out;
}
