import {classifyGuardContent, selectGuardContentCandidates, type GuardContentPolicy} from "../guard-content-probe/guard-content-probe.ts";

export type Classification = {readonly verdict: "trivial" | "non-trivial"; readonly reason: string};

type ChangedFile = {readonly path: string; readonly changedLines: number; readonly addedLines: ReadonlyArray<string>; readonly unsafeMetadata: boolean};

const nonTrivial = (reason: string): Classification => ({verdict: "non-trivial", reason});
const trivial = (reason: string): Classification => ({verdict: "trivial", reason});

/** Parse only the limited, auditable subset of a unified Git diff needed for a conservative decision. */
const parse = (diff: string): ReadonlyArray<ChangedFile> | null => {
	const files: ChangedFile[] = [];
	let current: {path: string; changedLines: number; addedLines: string[]; unsafeMetadata: boolean} | null = null;
	let sawHeader = false;
	const flush = () => {
		if (current !== null) files.push(current);
		current = null;
	};
	for (const line of diff.split("\n")) {
		const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
		if (header !== null) {
			flush();
			sawHeader = true;
			const oldPath = header[1] ?? "";
			const newPath = header[2] ?? "";
			current = {path: newPath === "dev/null" ? oldPath : newPath || oldPath, changedLines: 0, addedLines: [], unsafeMetadata: false};
			continue;
		}
		if (current === null) continue;
		if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch") || line.startsWith("rename from ") || line.startsWith("rename to ") || line.startsWith("new file mode 160000") || line.startsWith("deleted file mode 160000") || line.startsWith("Subproject commit ")) {
			current.unsafeMetadata = true;
			continue;
		}
		if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
		if (line.startsWith("+")) {
			current.changedLines += 1;
			current.addedLines.push(line.slice(1));
		} else if (line.startsWith("-")) current.changedLines += 1;
	}
	flush();
	return sawHeader ? files : null;
};

/** Extract the complete repository-relative changed-file set from the same conservative parser. */
export const changedPathsFromUnifiedDiff = (diff: string): ReadonlyArray<string> | null =>
	parse(diff)?.map((file) => file.path) ?? null;

const matchesProtectedPath = (path: string, patterns: ReadonlyArray<string>): boolean =>
	patterns.some((pattern) => {
		try {
			return new RegExp(pattern).test(path);
		} catch {
			return true;
		}
	});

/**
 * Fail-closed tiny-diff classification. A `trivial` result proves one ordinary text file,
 * no protected-path match, and a repository-owned line budget; every uncertainty routes to full review.
 */
export const classifyTrivialDiff = (
	diff: string,
	maxChangedLines: number,
	protectedPaths: ReadonlyArray<string>,
	guardContentPolicy: GuardContentPolicy | null = null,
): Classification => {
	if (!Number.isInteger(maxChangedLines) || maxChangedLines < 0) return nonTrivial("invalid line budget — default-deny");
	const files = parse(diff);
	if (files === null) return nonTrivial("diff could not be parsed — default-deny");
	if (files.length !== 1) return nonTrivial(`expected exactly one changed file, received ${files.length} — full review required`);
	const file = files[0];
	if (file === undefined) return nonTrivial("no changed file resolved — default-deny");
	if (file.unsafeMetadata) return nonTrivial(`${file.path} has binary, rename, or submodule metadata — full review required`);
	if (matchesProtectedPath(file.path, protectedPaths)) return nonTrivial(`${file.path} matches a repository-protected path — full review required`);
	const candidates = selectGuardContentCandidates([file.path], guardContentPolicy);
	if (!candidates.trusted) return nonTrivial(`${candidates.reason ?? "guard-content policy is unavailable"} — decision-record route cannot be disproved`);
	if (candidates.paths.length > 0) {
		const guard = classifyGuardContent(file.addedLines.join("\n"), guardContentPolicy);
		if (guard.decision === "guard-touching") return nonTrivial(`${file.path} is a guard-touching decision record (${guard.reason}) — never trivial`);
	}
	if (file.changedLines > maxChangedLines) return nonTrivial(`${file.path} changes ${file.changedLines} lines, above ${maxChangedLines} — full review required`);
	if (file.changedLines === 0) return nonTrivial("no text line change was proved — default-deny");
	return trivial(`one unprotected text file with ${file.changedLines} changed lines (budget ${maxChangedLines})`);
};
