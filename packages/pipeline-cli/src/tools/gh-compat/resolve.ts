import {execFileSync} from "node:child_process";
import {accessSync, constants, realpathSync} from "node:fs";
import {delimiter, join} from "node:path";

export const isExecutable = (path: string): boolean => {
	try { accessSync(path, constants.X_OK); return true; } catch { return false; }
};

export const fileExists = (path: string): boolean => {
	try { accessSync(path, constants.R_OK); return true; } catch { return false; }
};

/** Locate the real gh without ever selecting the wrapper currently executing. */
export const resolveRealGh = (self: string, configuredPath: string | null): string | null => {
	const explicit = configuredPath ?? process.env.PIPELINE_REAL_GH;
	if (explicit && isExecutable(explicit)) return explicit;
	for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
		const candidate = join(dir, "gh");
		if (!isExecutable(candidate)) continue;
		let resolved = candidate;
		try { resolved = realpathSync(candidate); } catch { /* retain candidate */ }
		if (resolved !== self) return candidate;
	}
	return null;
};

/** Use configured repository identity first; if none is configured, ask the real gh. Never guess a source repository. */
export const resolveRepository = (realGh: string | null, configuredRepository: string | null): string | null => {
	if (configuredRepository !== null) return configuredRepository;
	if (realGh === null) return null;
	try {
		return execFileSync(realGh, ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {encoding: "utf8"}).trim() || null;
	} catch {
		return null;
	}
};
