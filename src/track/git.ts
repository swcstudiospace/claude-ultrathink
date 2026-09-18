const SSH_RE = /^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
const HTTPS_RE = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;

export function parseRepoSlug(remoteUrl: string): string | undefined {
	const trimmed = remoteUrl.trim();
	if (!trimmed) return undefined;
	const ssh = SSH_RE.exec(trimmed);
	if (ssh) return `${ssh[2]}/${ssh[3]}`;
	const https = HTTPS_RE.exec(trimmed);
	if (https) return `${https[2]}/${https[3]}`;
	return undefined;
}

export type GitRun = (cmd: string[], cwd: string) => { stdout: string; code: number };

function defaultGitRun(cmd: string[], cwd: string): { stdout: string; code: number } {
	const proc = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
	return { stdout: proc.stdout?.toString() ?? "", code: proc.exitCode ?? 1 };
}

export function resolveRepoSlug(root: string, run: GitRun = defaultGitRun): string | undefined {
	try {
		const result = run(["git", "remote", "get-url", "origin"], root);
		if (result.code !== 0) return undefined;
		return parseRepoSlug(result.stdout);
	} catch {
		return undefined;
	}
}

export function resolveBranch(root: string, run: GitRun = defaultGitRun): string | undefined {
	try {
		const result = run(["git", "branch", "--show-current"], root);
		if (result.code !== 0) return undefined;
		const branch = result.stdout.trim();
		return branch || undefined;
	} catch {
		return undefined;
	}
}
