/** Pure verdict core for the CI required-jobs aggregator. */
export type JobResult = "success" | "skipped" | "failure" | "cancelled" | "" | (string & {});

export interface JobInput {
	readonly name: string;
	readonly required: boolean;
	readonly result: JobResult;
}

export type JobVerdict = "required-pass" | "legit-skip" | "FAIL";

export interface JobReport {
	readonly name: string;
	readonly required: boolean;
	readonly result: JobResult;
	readonly verdict: JobVerdict;
	readonly reason: string;
}

export interface CiRequiredVerdict {
	readonly pass: boolean;
	readonly jobs: ReadonlyArray<JobReport>;
	readonly changesReport: JobReport | null;
}

export const judgeJob = (job: JobInput): JobReport => {
	if (job.required) {
		if (job.result === "success") {
			return {
				...job,
				verdict: "required-pass",
				reason: `${job.name}: should_run=true result=${job.result} → required-pass`,
			};
		}
		return {
			...job,
			verdict: "FAIL",
			reason: `${job.name}: should_run=true result=${job.result || "<empty>"} → FAIL (a should-have-run gating job did not succeed — silent no-op)`,
		};
	}
	if (job.result === "skipped" || job.result === "success") {
		return {
			...job,
			verdict: "legit-skip",
			reason: `${job.name}: should_run=false result=${job.result} → legit-skip`,
		};
	}
	return {
		...job,
		verdict: "FAIL",
		reason: `${job.name}: should_run=false result=${job.result || "<empty>"} → FAIL (not-required job did not pass — unexpected non-success)`,
	};
};

export interface CiRequiredInput {
	readonly changesResult: JobResult;
	readonly jobs: ReadonlyArray<JobInput>;
}

const parseRequired = (value: string | undefined): boolean => value === "true";

export const inputFromEnv = (e: Record<string, string | undefined>): CiRequiredInput => {
	const result = (key: string): JobResult => e[key] ?? "";
	const jobs: ReadonlyArray<JobInput> = [
		{name: "check", required: parseRequired(e.CHECK_REQUIRED), result: result("CHECK_RESULT")},
		{name: "unit", required: parseRequired(e.CHECK_REQUIRED), result: result("UNIT_RESULT")},
		{
			name: "packages-tests",
			required: parseRequired(e.PACKAGES_REQUIRED),
			result: result("PACKAGES_RESULT"),
		},
		{
			name: "actionlint",
			required: parseRequired(e.WORKFLOWS_REQUIRED),
			result: result("ACTIONLINT_RESULT"),
		},
		{
			name: "integration",
			required: parseRequired(e.INTEGRATION_REQUIRED),
			result: result("INTEGRATION_RESULT"),
		},
		{name: "e2e", required: parseRequired(e.E2E_REQUIRED), result: result("E2E_RESULT")},
	];
	return {changesResult: result("CHANGES_RESULT"), jobs};
};

export const judge = (input: CiRequiredInput): CiRequiredVerdict => {
	const jobs = input.jobs.map(judgeJob);
	let changesReport: JobReport | null = null;
	if (input.changesResult !== "success") {
		changesReport = {
			name: "changes",
			required: true,
			result: input.changesResult,
			verdict: "FAIL",
			reason: `changes: result=${input.changesResult || "<empty>"} → FAIL (the required-ness source job did not succeed; cannot trust skip legitimacy — fail closed)`,
		};
	}
	return {pass: changesReport === null && jobs.every((job) => job.verdict !== "FAIL"), jobs, changesReport};
};
