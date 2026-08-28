const DEFAULT_SCOPES = ["repo", "workflow"] as const;
const ALLOWED_SCOPES: Record<string, true> = { repo: true, workflow: true };
const GITHUB_DEVICE_URL = "https://github.com/login/device";
const GH_INSTALL_URL = "https://cli.github.com/";

export type GithubAuthState = "ready" | "missing-cli" | "missing-auth" | "missing-scopes" | "authorizing" | "error";

export interface GithubAuthStatus {
  ok: boolean;
  state: GithubAuthState;
  login: string | null;
  error: string | null;
  requiredScopes: string[];
  missingScopes: string[];
  verificationUrl?: string;
  userCode?: string;
}

type AuthorizationAttempt = {
  state: "authorizing" | "error";
  requiredScopes: string[];
  verificationUrl?: string;
  userCode?: string;
  error?: string;
};

type GhAccount = {
  active?: boolean;
  login?: string;
  scopes?: string;
  state?: string;
};

let cachedToken: string | null = null;
let authorization: AuthorizationAttempt | null = null;

function ghExecutable(): string {
  return process.env.COCKPIT_GH_BIN || "gh";
}

function normalizeScopes(scopes: readonly string[] = DEFAULT_SCOPES): string[] {
  return [...new Set(scopes.filter((scope) => ALLOWED_SCOPES[scope]))].sort();
}

function sameScopes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((scope, index) => scope === right[index]);
}

function missingStatus(state: Exclude<GithubAuthState, "ready" | "authorizing" | "error">, requiredScopes: string[], missingScopes: string[], login: string | null): GithubAuthStatus {
  const error = state === "missing-cli"
    ? "GitHub CLI is required."
    : state === "missing-auth"
      ? "Sign in to GitHub."
      : `Allow ${missingScopes.join(" and ")} access.`;
  return { ok: false, state, login, error, requiredScopes, missingScopes };
}

async function runGh(args: string[]): Promise<{ code: number; stdout: string; stderr: string } | null> {
  try {
    const proc = Bun.spawn([ghExecutable(), ...args], { env: process.env, stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch {
    return null;
  }
}

function accountFromStatus(raw: string): GhAccount | null {
  try {
    const parsed = JSON.parse(raw) as { hosts?: Record<string, GhAccount[]> };
    return parsed.hosts?.["github.com"]?.find((account) => account.active && account.state === "success") ?? null;
  } catch {
    return null;
  }
}

async function inspectGithubAuth(requiredScopes: string[]): Promise<GithubAuthStatus> {
  const statusResult = await runGh(["auth", "status", "--hostname", "github.com", "--json", "hosts"]);
  if (!statusResult) return missingStatus("missing-cli", requiredScopes, requiredScopes, null);

  const account = accountFromStatus(statusResult.stdout);
  if (account) {
    const granted = new Set((account.scopes ?? "").split(",").map((scope) => scope.trim()).filter(Boolean));
    const missingScopes = requiredScopes.filter((scope) => !granted.has(scope));
    if (missingScopes.length) return missingStatus("missing-scopes", requiredScopes, missingScopes, account.login ?? null);
    return { ok: true, state: "ready", login: account.login ?? null, error: null, requiredScopes, missingScopes: [] };
  }

  const tokenResult = await runGh(["auth", "token"]);
  if (!tokenResult || tokenResult.code !== 0 || !tokenResult.stdout) {
    return missingStatus("missing-auth", requiredScopes, requiredScopes, null);
  }

  return { ok: true, state: "ready", login: null, error: null, requiredScopes, missingScopes: [] };
}

export async function githubAuthStatus(scopes: readonly string[] = DEFAULT_SCOPES): Promise<GithubAuthStatus> {
  const requiredScopes = normalizeScopes(scopes);
  const status = await inspectGithubAuth(requiredScopes);
  if (status.ok) {
    if (authorization && sameScopes(authorization.requiredScopes, requiredScopes)) authorization = null;
    return status;
  }
  if (!authorization || !sameScopes(authorization.requiredScopes, requiredScopes)) return status;
  if (authorization.state === "error") {
    return { ...status, state: "error", error: authorization.error ?? "GitHub setup failed." };
  }
  return {
    ...status,
    state: "authorizing",
    error: null,
    verificationUrl: authorization.verificationUrl,
    userCode: authorization.userCode,
  };
}

function browserCommand(url: string): string[] | null {
  if (process.env.COCKPIT_BROWSER_BIN) return [process.env.COCKPIT_BROWSER_BIN, url];
  if (process.platform === "darwin") return ["open", url];
  if (process.platform === "linux") return ["xdg-open", url];
  if (process.platform === "win32") return ["cmd", "/c", "start", "", url];
  return null;
}
async function openBrowser(url: string): Promise<void> {
  const command = browserCommand(url);
  if (!command) return;
  try {
    const proc = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    await proc.exited;
  } catch {}
}

function cleanOutput(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
}

function authorizationError(output: string): string {
  const line = cleanOutput(output).split("\n").map((item) => item.trim()).filter(Boolean).at(-1);
  return line ? line.slice(0, 180) : "GitHub setup failed.";
}

async function authorizeGithub(initial: GithubAuthStatus): Promise<void> {
  const requiredScopes = initial.requiredScopes;
  const args = initial.state === "missing-auth"
    ? ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--skip-ssh-key", "--scopes", requiredScopes.join(",")]
    : ["auth", "refresh", "--hostname", "github.com", "--scopes", initial.missingScopes.join(",")];

  let proc;
  try {
    proc = Bun.spawn([ghExecutable(), ...args], {
      env: { ...process.env, GH_BROWSER: process.env.COCKPIT_GH_BROWSER || "/usr/bin/true", NO_COLOR: "1" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    authorization = { state: "error", requiredScopes, error: "GitHub CLI could not start." };
    return;
  }

  let output = "";
  let continued = false;
  const consume = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      output += decoder.decode(chunk);
      const clean = cleanOutput(output);
      const code = clean.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0];
      const url = clean.match(/https:\/\/github\.com\/login\/device\b/)?.[0];
      if (authorization?.state === "authorizing") {
        if (code) authorization.userCode = code;
        if (url) authorization.verificationUrl = url;
      }
      if (!continued && (code || url)) {
        continued = true;
        await openBrowser(url ?? GITHUB_DEVICE_URL);
        proc.stdin.write("\n");
        proc.stdin.end();
      }
    }
  };

  const [code] = await Promise.all([
    proc.exited,
    consume(proc.stdout),
    consume(proc.stderr),
  ]);
  if (code !== 0) {
    authorization = { state: "error", requiredScopes, error: authorizationError(output) };
    return;
  }
  cachedToken = null;
  authorization = null;
}

export async function startGithubSetup(scopes: readonly string[] = DEFAULT_SCOPES): Promise<GithubAuthStatus> {
  if (authorization?.state === "error") authorization = null;
  const requiredScopes = normalizeScopes(scopes);
  const status = await githubAuthStatus(requiredScopes);
  if (status.ok) return status;
  if (status.state === "missing-cli") {
    await openBrowser(GH_INSTALL_URL);
    return status;
  }
  if (authorization?.state === "authorizing") return githubAuthStatus(authorization.requiredScopes);

  authorization = { state: "authorizing", requiredScopes };
  void authorizeGithub(status);
  return { ...status, state: "authorizing", error: null };
}

export async function liveGithubToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  const result = await runGh(["auth", "token"]);
  if (!result || result.code !== 0 || !result.stdout) throw new Error("GitHub CLI is not authenticated");
  cachedToken = result.stdout;
  return cachedToken;
}
