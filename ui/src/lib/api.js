export async function fetchInbox(archived = false, q = null) {
  const params = new URLSearchParams();
  if (archived) params.set("archived", "1");
  if (q) params.set("q", q);
  const qs = params.toString();
  const res = await fetch(qs ? `/api/inbox?${qs}` : "/api/inbox");
  if (!res.ok) throw new Error(`inbox ${res.status}`);
  return res.json();
}

export async function fetchRecentClosed() {
  const res = await fetch("/api/closed");
  if (!res.ok) throw new Error(`closed ${res.status}`);
  return res.json();
}

export async function fetchAllPrs(repos = []) {
  const params = new URLSearchParams();
  for (const repo of repos) params.append("repo", repo);
  const query = params.toString();
  const res = await fetch(`/api/all-prs${query ? `?${query}` : ""}`);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `all PRs ${res.status}`);
  if (!Array.isArray(body?.prs)) throw new Error("Invalid all PRs response");
  return body;
}

export async function setArchived(repo, number, archived) {
  const res = await fetch("/api/archive", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, number, archived }),
  });
  if (!res.ok) throw new Error(`archive ${res.status}`);
}

export async function reorderPr(repo, number, position) {
  const res = await fetch("/api/inbox/reorder", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, number, position }),
  });
  if (!res.ok) throw new Error(`reorder ${res.status}`);
}

export async function fetchPrDetail(repo, number) {
  const res = await fetch(`/api/pr/${repo}/${number}`);
  if (!res.ok) throw new Error(`detail ${res.status}`);
  return res.json();
}
function actionCommitQuery(sha, prefetch = false) {
  const params = new URLSearchParams();
  if (sha) params.set("sha", sha);
  if (prefetch) params.set("prefetch", "1");
  const query = params.toString();
  return query ? `?${query}` : "";
}

export async function fetchActions(repo, number, sha = null, signal = null) {
  const res = await fetch(`/api/pr/${repo}/${number}/actions${actionCommitQuery(sha)}`, { signal });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `actions ${res.status}`);
  return body;
}
export async function fetchActionGraph(repo, number, sha = null, signal = null) {
  const res = await fetch(`/api/pr/${repo}/${number}/actions/graph${actionCommitQuery(sha)}`, { signal });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `action graph ${res.status}`);
  return body;
}

export async function fetchActionCommits(repo, number, signal = null) {
  const res = await fetch(`/api/pr/${repo}/${number}/actions/commits`, { signal });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `action commits ${res.status}`);
  return body;
}


export async function fetchActionLog(repo, number, jobId, sha = null, signal = null, prefetch = false) {
  const res = await fetch(`/api/pr/${repo}/${number}/actions/jobs/${jobId}/log${actionCommitQuery(sha, prefetch)}`, { signal });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `action log ${res.status}`);
  return body;
}
export async function fetchRepoActions(filters = {}, signal = null) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== "") params.append(key, String(item));
      }
    } else if (value !== null && value !== undefined && value !== "") {
      params.set(key, String(value));
    }
  }
  const query = params.toString();
  const res = await fetch(`/api/actions/runs${query ? `?${query}` : ""}`, { signal });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `actions ${res.status}`);
  return body;
}

export async function rerunFailedActionJobs(repo, runId) {
  const res = await fetch(`/api/actions/runs/${repo}/${runId}/rerun-failed-jobs`, { method: "POST" });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `re-run failed jobs ${res.status}`);
  return body;
}

export async function fetchRepoActionGraph(repo, headSha, signal = null) {
  const params = new URLSearchParams({ repo, headSha });
  const res = await fetch(`/api/actions/graph?${params}`, { signal });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `action graph ${res.status}`);
  return body;
}

export async function fetchRepoActionLog(repo, headSha, jobId, signal = null, prefetch = false) {
  const params = new URLSearchParams({ repo, headSha });
  if (prefetch) params.set("prefetch", "1");
  const res = await fetch(`/api/actions/jobs/${jobId}/log?${params}`, { signal });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `action log ${res.status}`);
  return body;
}



export async function fetchPrCommitStats(repo, number, testPattern, signal = null) {
  const params = new URLSearchParams({ testPattern: testPattern.source });
  const res = await fetch(`/api/pr/${repo}/${number}/commit-stats?${params}`, { signal });
  if (!res.ok) throw new Error(`commit-stats ${res.status}`);
  return res.json();
}

export async function fetchPrDetails(keys) {
  const res = await fetch(`/api/pr-details?keys=${encodeURIComponent(keys.join(","))}`);
  if (!res.ok) throw new Error(`pr-details ${res.status}`);
  return (await res.json()).details;
}

export async function fetchPrDiff(repo, number, range = null, signal = null) {
  try {
    const params = new URLSearchParams();
    if (range?.base) params.set("base", range.base);
    if (range?.head) params.set("head", range.head);
    const qs = params.size ? `?${params}` : "";
    const res = await fetch(`/api/pr/${repo}/${number}/diff${qs}`, { signal });
    if (res.status === 503) {
      return { ok: false, building: true, retryAfterMs: (Number(res.headers.get("retry-after")) || 5) * 1000 };
    }
    if (!res.ok) return { ok: false, building: false };
    return { ok: true, bytes: await res.arrayBuffer() };
  } catch {
    return { ok: false, building: false };
  }
}

export async function fetchConflictFiles(repo, number) {
  const res = await fetch(`/api/pr/${repo}/${number}/conflicts`);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `conflict files ${res.status}`);
  return body.files;
}

export async function fetchMutations(repo, number) {
  const res = await fetch(`/api/mutations?repo=${encodeURIComponent(repo)}&number=${number}`);
  if (!res.ok) throw new Error(`mutations ${res.status}`);
  return (await res.json()).mutations;
}

export async function enqueueMutation(repo, number, payload) {
  const res = await fetch("/api/mutations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, number, payload }),
  });
  if (!res.ok) throw new Error(`enqueue mutation ${res.status}`);
  return res.json();
}

export async function retryMutation(id) {
  const res = await fetch(`/api/mutations/${id}/retry`, { method: "POST" });
  if (!res.ok) throw new Error(`retry mutation ${res.status}`);
}

export async function discardMutation(id) {
  const res = await fetch(`/api/mutations/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`discard mutation ${res.status}`);
}

export async function fetchFileContents(repo, path, sha) {
  const res = await fetch(`/api/file?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}&sha=${sha}`);
  if (!res.ok) throw new Error(`file ${res.status}`);
  return res.json();
}

export async function commitPrFileEdit(repo, number, path, expectedHeadOid, content, message) {
  const res = await fetch("/api/pr-file-edit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, number, path, expectedHeadOid, content, message }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const error = new Error(body?.error || `pr-file-edit ${res.status}`);
    error.code = body?.code;
    error.auth = body?.auth;
    error.status = res.status;
    throw error;
  }
  return body;
}

export async function generateCommitMessage(repo, number, path, hunk) {
  const res = await fetch("/api/commit-message", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, number, path, hunk }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const error = new Error(body?.error || `commit-message ${res.status}`);
    error.code = body?.code;
    throw error;
  }
  return body.message;
}

export async function fetchFileHistory(repo, path, base, symbol = null, baseSha = null) {
  const p = new URLSearchParams({ repo, path, base });
  if (symbol) {
    p.set("symbol", symbol);
    p.set("baseSha", baseSha);
  }
  const res = await fetch(`/api/file-history?${p}`);
  const data = await res.json();
  if (!res.ok) {
    const error = new Error(`file-history ${res.status}`);
    error.code = data.error;
    throw error;
  }
  return data.commits;
}

export async function fetchFileHistoryDiff(repo, sha, path, local = false) {
  const p = new URLSearchParams({ repo, sha, path, ...(local ? { local: "1" } : {}) });
  const res = await fetch(`/api/file-history/diff?${p}`);
  if (!res.ok) throw new Error(`file-history diff ${res.status}`);
  return res.json();
}

export async function repoSearch(repo, sha, headRef, q, signal) {
  const p = new URLSearchParams({ repo, sha, headRef, q });
  const res = await fetch(`/api/repo-search?${p}`, { signal });
  if (!res.ok) throw new Error(`repo-search ${res.status}`);
  return res.json();
}
export async function repoDefinition(repo, sha, headRef, path, symbol, position = null, signal) {
  const p = new URLSearchParams({ repo, sha, headRef, path, symbol });
  if (position) {
    p.set("line", String(position.line));
    p.set("col", String(position.character));
  }
  const res = await fetch(`/api/repo-definition?${p}`, { signal });
  if (!res.ok) throw new Error(`repo-definition ${res.status}`);
  return res.json();
}


export async function repoFiles(repo, sha, headRef) {
  const p = new URLSearchParams({ repo, sha, headRef });
  const res = await fetch(`/api/repo-files?${p}`);
  if (!res.ok) throw new Error(`repo-files ${res.status}`);
  return res.json();
}

export async function repoFile(repo, sha, headRef, path) {
  const p = new URLSearchParams({ repo, sha, headRef, path });
  const res = await fetch(`/api/repo-file?${p}`);
  if (!res.ok) throw new Error(`repo-file ${res.status}`);
  return res.json();
}

export async function fetchPrIndex() {
  const res = await fetch("/api/pr-index");
  if (!res.ok) throw new Error(`pr-index ${res.status}`);
  return (await res.json()).prs;
}

export async function searchPrs(q) {
  const res = await fetch(`/api/search-prs?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(`search ${res.status}`);
  return (await res.json()).results;
}
export async function fetchAuthStatus(scopes = ["repo", "workflow"]) {
  const params = new URLSearchParams({ scopes: scopes.join(",") });
  const res = await fetch(`/api/auth/status?${params}`);
  if (!res.ok) throw new Error(`auth status ${res.status}`);
  return res.json();
}

export async function startGithubSetup(scopes) {
  const res = await fetch("/api/auth/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scopes }),
  });
  if (!res.ok) throw new Error(`auth setup ${res.status}`);
  return res.json();
}


export async function fetchMergedPrAnalytics(repo, base = "staging", days = 180, signal) {
  const params = new URLSearchParams({ repo, base, days: String(days) });
  const res = await fetch(`/api/merged-pr-analytics?${params}`, { signal });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `merged-pr-analytics ${res.status}`);
  return body;
}

// startup has several independent settings readers; identical concurrent GETs
// serialize on chromium's cache lock, so one in-flight request serves them all
let settingsInFlight = null;

export async function fetchSettings() {
  if (!settingsInFlight) {
    settingsInFlight = fetch("/api/settings")
      .then((res) => {
        if (!res.ok) throw new Error(`settings ${res.status}`);
        return res.json();
      })
      .finally(() => {
        settingsInFlight = null;
      });
  }
  return settingsInFlight;
}

export async function saveSettings(patch) {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`settings ${res.status}`);
  return res.json();
}
export async function refreshInbox() {
  const res = await fetch("/api/refresh", { method: "POST" });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `refresh ${res.status}`);
  return body;
}


export async function fetchRelayStatus() {
  const res = await fetch("/api/relay/status");
  if (!res.ok) throw new Error(`relay status ${res.status}`);
  return res.json();
}

export async function fetchRelayCoverage(repos) {
  const query = repos ? `?repos=${encodeURIComponent(repos.join(","))}` : "";
  const res = await fetch(`/api/relay/coverage${query}`);
  if (!res.ok) throw new Error(`relay coverage ${res.status}`);
  return res.json();
}

export async function fetchVersion() {
  const res = await fetch("/api/version");
  if (!res.ok) throw new Error(`version ${res.status}`);
  return res.json();
}

export async function triggerUpdate() {
  const res = await fetch("/api/update", { method: "POST" });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `update ${res.status}`);
}

export async function fetchOnboardingRepos() {
  const res = await fetch("/api/onboarding/repos");
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `onboarding repos ${res.status}`);
  return body;
}

const repoUsersCache = new Map();

export function fetchRepoUsers(repo) {
  if (!repoUsersCache.has(repo)) {
    const p = fetch(`/api/repo-users?repo=${encodeURIComponent(repo)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`repo-users ${res.status}`);
        return res.json();
      })
      .catch((err) => {
        repoUsersCache.delete(repo);
        throw err;
      });
    p.catch(() => {});
    repoUsersCache.set(repo, p);
  }
  return repoUsersCache.get(repo);
}

export async function switchLocalBranch(repo, headRef) {
  const res = await fetch("/api/switch-branch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, headRef }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `switch branch ${res.status}`);
  return body;
}

export async function fetchAgents() {
  const res = await fetch("/api/agents");
  if (!res.ok) throw new Error(`agents ${res.status}`);
  return (await res.json()).agents;
}

export async function killAgent(repo, number) {
  const res = await fetch("/api/agents/kill", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, number }),
  });
  if (!res.ok) throw new Error(`kill agent ${res.status}`);
}

export async function promptAgent(repo, number, instruction) {
  const res = await fetch("/api/agents/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, number, instruction }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `prompt agent ${res.status}`);
}

export async function autofixAgent(repo, number) {
  const res = await fetch("/api/agents/autofix", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, number }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `autofix agent ${res.status}`);
}

export async function customAgent(repo, number, agentId) {
  const res = await fetch("/api/agents/custom", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, number, agentId }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `custom agent ${res.status}`);
}

export async function rescoreAgent(repo, number) {
  const res = await fetch("/api/agents/rescore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo, number }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `rescore agent ${res.status}`);
}

export async function fetchAgentLog(repo, number) {
  const res = await fetch(`/api/agents/log?repo=${encodeURIComponent(repo)}&number=${number}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`agent log ${res.status}`);
  return (await res.json()).log;
}

export async function fetchAgentRuns(repo, number) {
  const res = await fetch(`/api/agents/runs?repo=${encodeURIComponent(repo)}&number=${number}`);
  if (!res.ok) throw new Error(`agent runs ${res.status}`);
  return (await res.json()).runs;
}

export async function fetchAgentRunDetail(id) {
  const res = await fetch(`/api/agents/runs/detail?id=${id}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`agent run detail ${res.status}`);
  return await res.json();
}

export async function fetchQuota() {
  const res = await fetch("/api/quota");
  if (!res.ok) throw new Error(`quota ${res.status}`);
  return await res.json();
}

export async function fetchGithubUsage() {
  const res = await fetch("/api/github-usage");
  if (!res.ok) throw new Error(`github usage ${res.status}`);
  return await res.json();
}
