// Sync sha-pinned git reads, shared by the HTTP process and the AST worker.
const treeCache = new Map<string, string[]>();

export function lsTree(checkout: string, repo: string, sha: string): string[] {
  const key = `${repo}\n${sha}`;
  const cached = treeCache.get(key);
  if (cached) return cached;
  const proc = Bun.spawnSync(["git", "-C", checkout, "ls-tree", "-r", "--name-only", sha], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const paths = proc.stdout.toString().split("\n").filter(Boolean);
  if (proc.success) treeCache.set(key, paths);
  return paths;
}

export function showFile(checkout: string, sha: string, path: string): string | null {
  const proc = Bun.spawnSync(["git", "-C", checkout, "show", `${sha}:${path}`], { stdout: "pipe", stderr: "ignore" });
  return proc.success ? proc.stdout.toString() : null;
}
