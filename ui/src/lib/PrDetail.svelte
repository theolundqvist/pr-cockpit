<script>
  import { onDestroy, tick, untrack } from "svelte";
  import {
    fetchPrDetail,
    fetchPrDiff,
    commitPrFileEdit,
    generateCommitMessage,
    fetchConflictFiles,
    fetchPrCommitStats,
    fetchMutations,
    enqueueMutation,
    retryMutation,
    discardMutation,
    fetchAgents,
    killAgent,
    fetchAgentLog,
    fetchAgentRuns,
    fetchAgentRunDetail,
    promptAgent,
    autofixAgent,
    customAgent,
    rescoreAgent,
    fetchRepoUsers,
    switchLocalBranch,
    focusTmux,
    tmuxFocusErrorMessage,
  } from "./api.js";
  import { anchorThreads, fileDiffFingerprint } from "./diff.js";
  import { loadDiffDocument } from "./diffDocument.js";
  import { renderMarkdown } from "./markdown.js";
  import { loadPrIndex, prSummary } from "./prIndex.svelte.js";
  import { imageFallback, prKeyOwner, shouldCopyPrCockpitUrl, shouldCopyPrUrl } from "./dom.js";
  import { readLastViewed, writeLastViewed } from "./lastViewed.js";
  import { durationText, relativeTime } from "./time.js";
  import { mermaidDiagrams } from "./mermaid.js";
  import { theme } from "./theme.svelte.js";
  import { setViewerLogin } from "./viewer.svelte.js";
  import { scrollPage, scrollEdge, holdScrollStart, holdScrollRelease, cancelHoldScroll, scrollAnimating } from "./scroll.js";
  import { testMatcher } from "./testPath.js";
  import { prefs } from "./prefs.svelte.js";
  import { timedFlag } from "./timedFlag.svelte.js";
  import { showFlash } from "./flash.svelte.js";
  import Chevron from "./Chevron.svelte";
  import { greptileReviewMeta, greptileStatus, KNOWN_BOT_LOGINS } from "./greptileStatus.js";
  import { prKeyOf } from "./prKey.js";
  import { getDetail, cacheDetail } from "./detailCache.js";
  import { buildChecks, countChecks, summarizeChecks, sectionizeChecks, ciFixPrompt } from "./checks.js";
  import { mergeGate as evalMergeGate, forceMergeAvailable as evalForceMerge } from "./mergeGate.js";
  import { quota } from "./quota.svelte.js";
  import { quotaImpact } from "./quotaImpact.js";
  import ActionsView from "./ActionsView.svelte";
  import QuotaMergeModal from "./QuotaMergeModal.svelte";
  import MergeDecisionDialog from "./MergeDecisionDialog.svelte";
  import ConfirmDialog from "./ConfirmDialog.svelte";
  import SplitButton from "./SplitButton.svelte";
  import DiffView from "./DiffView.svelte";
  import FileHistory from "./FileHistory.svelte";
  import Telescope from "./Telescope.svelte";
  import RangePicker from "./RangePicker.svelte";
  import FileTree from "./FileTree.svelte";
  import Kbd from "./Kbd.svelte";
  import Thread from "./Thread.svelte";
  import MutationBadge from "./MutationBadge.svelte";
  import MutationFailure from "./MutationFailure.svelte";
  import KeyBar from "./KeyBar.svelte";
  import Avatar from "./Avatar.svelte";
  import Reactions from "./Reactions.svelte";
  import UserPicker from "./UserPicker.svelte";
  import CurrentBranchBadge from "./CurrentBranchBadge.svelte";
  const VERDICT_OPTIONS = [
    { value: "APPROVE", label: "Approve", tone: "green" },
    { value: "COMMENT", label: "Comment", tone: "neutral" },
    { value: "REQUEST_CHANGES", label: "Request changes", tone: "red" },
  ];

  let { repo, number, tab, historyPath = null, historySymbol = null, refreshRevision = 0 } = $props();
  let handledRefreshRevision = refreshRevision;

  loadPrIndex();

  let lastG = 0;
  const copied = timedFlag(1200);
  const branchCopied = timedFlag(1200);
  const ciCopied = timedFlag(1200);
  const conflictCopied = timedFlag(1200);

  let pr = $state(null);
  let files = $state([]);
  let diffDocument = null;
  onDestroy(() => diffDocument?.dispose());
  let error = $state(null);
  let showLoading = $state(false);
  let loadingSummary = $derived(prSummary(repo, number));
  let mutations = $state([]);
  let rangeKey = $state("all");
  let sinceAnchor = $state(null);
  let rewriteFallback = $state(false);
  let churnBaseRef = $state(null);
  let diffState = $state("ready");
  let diffNonce = $state(0);
  let pendingCommit = $state(null);
  let localBranchBusy = $state(false);
  let conflictFiles = $state([]);
  let conflictFilesState = $state("idle");
  let conflictFilesError = $state(null);
  let commitFileStats = $state({});
  let loadedCommitStatsKey = "";
  let loadedConflictKey = "";

  const TREE_WIDTH_KEY = "pr-cockpit:file-tree-width";
  const VIEWED_FILES_KEY_PREFIX = "pr-cockpit:viewed-files:";
  const TREE_MIN_WIDTH = 160;
  const TREE_DEFAULT_WIDTH = 250;
  let treeDesiredWidth = $state(Number(localStorage.getItem(TREE_WIDTH_KEY)) || TREE_DEFAULT_WIDTH);
  let treeMaxWidth = $state(600);
  let treeWidth = $derived(Math.min(treeDesiredWidth, treeMaxWidth));

  let activeFetch;
  let loadedKey = null;
  let detailLoadPromise = null;
  let detailRefreshPromise = null;
  let detailRefreshQueued = false;
  let externalEditorBusy = $state(false);
  let preparedEditorKey = null;

  $effect(() => {
    const key = prKeyOf(repo, number);
    if (key === loadedKey) return;
    loadedKey = key;
    const token = {};
    activeFetch = token;
    const cachedDetail = getDetail(key);
    pendingCommit = null;
    pr = cachedDetail;
    if (cachedDetail) setViewerLogin(cachedDetail.viewerLogin);
    showLoading = false;
    const loadingTimer = cachedDetail ? null : setTimeout(() => {
      if (activeFetch === token && !pr && !error) showLoading = true;
    }, 250);
    files = [];
    diffDocument?.dispose();
    diffDocument = null;
    error = null;
    mutations = [];
    fileIndex = 0;
    collapsedFiles = new Set();
    viewedFiles = new Set();
    rangeKey = "all";
    diffState = "ready";
    rewriteFallback = false;
    churnBaseRef = null;
    mergeConfirm = false;
    quotaMergeModal = false;
    forceMergeConfirm = false;
    confirmAction = null;
    mergeMenuOpen = false;
    reviewMenuOpen = false;
    editingTitle = false;
    editingBody = false;
    localBranchBusy = false;
    conflictFiles = [];
    conflictFilesState = "idle";
    conflictFilesError = null;
    loadedConflictKey = "";
    sinceAnchor = readLastViewed(repo, number);
    fetchRepoUsers(repo)
      .then((u) => {
        if (activeFetch === token) repoUsers = u;
      })
      .catch(() => {});
    const detailPending = pendingCommit;
    const detailRequest = fetchPrDetail(repo, number);
    detailLoadPromise = detailRequest;
    detailRequest.then(
      (detail) => {
        if (activeFetch !== token) return;
        if (loadingTimer) clearTimeout(loadingTimer);
        showLoading = false;
        if (!applyAsyncPrDetail(detail, detailPending)) return;
        cacheDetail(key, detail);
        setViewerLogin(pr.viewerLogin);
      },
      (reason) => {
        if (activeFetch !== token) return;
        if (loadingTimer) clearTimeout(loadingTimer);
        showLoading = false;
        if (!pr) error = String(reason);
      },
    ).finally(() => {
      if (detailLoadPromise === detailRequest) detailLoadPromise = null;
    });
    fetchMutations(repo, number)
      .then((next) => {
        if (activeFetch === token) mutations = next;
      })
      .catch(() => {});
    return () => {
      if (loadingTimer) clearTimeout(loadingTimer);
    };
  });

  let commits = $derived(
    (pr?.commitList.nodes ?? [])
      .map((n) => n.commit)
      .filter((c) => c.oid && c.parents?.nodes?.[0]?.oid),
  );

  let anchorDiffers = $derived(!!pr && !!sinceAnchor && sinceAnchor.headSha !== pr.headRefOid);
  let anchorInList = $derived(
    anchorDiffers && (pr.commitList.nodes ?? []).some((n) => n.commit.oid === sinceAnchor.headSha),
  );
  let anchorRewritten = $derived(anchorDiffers && !anchorInList);
  let sinceAvailable = $derived(anchorDiffers && !rewriteFallback);

  let range = $derived.by(() => {
    if (!pr) return null;
    if (rangeKey === "all") return pendingCommit ? { head: pendingCommit.committed } : null;
    if (rangeKey === "since") {
      return sinceAvailable ? { base: sinceAnchor.headSha, head: pr.headRefOid } : null;
    }
    if (rangeKey.startsWith("r")) {
      const [base, head] = rangeKey.slice(1).split(":");
      return base && head ? { base, head } : null;
    }
    const c = commits.find((x) => x.oid === rangeKey.slice(1));
    return c ? { base: c.parents.nodes[0].oid, head: c.oid } : null;
  });

  let commentable = $derived(rangeKey === "all");
  let fileEditable = $derived(!!pr && !pendingCommit && rangeKey === "all" && commentable && pr.state.toUpperCase() === "OPEN");

  function applyAsyncPrDetail(detail, pending) {
    if (pending !== pendingCommit) return false;
    if (pending) {
      if (detail.headRefOid === pending.before) return false;
      pendingCommit = null;
      pr = detail;
      diffNonce++;
      return true;
    }
    pr = detail;
    return true;
  }

  let diffFetch;
  let loadedDiffKey = null;
  let displayedDiffKey = $state(null);
  let buildingKey = "";
  let buildingDeadline = 0;
  const BUILD_CAP_MS = 120_000;
  $effect(() => {
    if (!pr) return;
    const r = range;
    const rewrittenSince = rangeKey === "since" && anchorRewritten;
    const head = pr.headRefOid;
    const baseKey = `${repo}#${number}#${r?.base ?? head}#${r?.head ?? head}`;
    const dkey = `${baseKey}#${diffNonce}`;
    if (dkey === loadedDiffKey) return;
    loadedDiffKey = dkey;
    const token = {};
    diffFetch = token;
    let retryTimer;
    const isSince = rangeKey === "since" && r;
    Promise.all([
      fetchPrDiff(repo, number, r),
      isSince ? fetchPrDiff(repo, number, null) : Promise.resolve(null),
    ]).then(async ([res, prRes]) => {
      if (diffFetch !== token) return;
      if (res.ok) {
        const [document, prDocument] = await Promise.all([
          loadDiffDocument(res.bytes),
          isSince && prRes?.ok ? loadDiffDocument(prRes.bytes) : Promise.resolve(null),
        ]);
        if (diffFetch !== token) {
          document.dispose();
          prDocument?.dispose();
          return;
        }
        let parsed = document.files;
        if (prDocument) {
          const ownPaths = new Set(prDocument.files.map((file) => file.path));
          const own = parsed.filter((file) => ownPaths.has(file.path));
          churnBaseRef = own.length < parsed.length ? pr.baseRefName : null;
          parsed = own;
          prDocument.dispose();
        } else {
          churnBaseRef = null;
        }
        diffDocument?.dispose();
        diffDocument = document;
        syncViewedFiles(parsed);
        displayedDiffKey = dkey;
        files = parsed;
        fileIndex = 0;
        diffState = "ready";
        buildingKey = "";
      } else if (res.building) {
        if (buildingKey !== baseKey) {
          buildingKey = baseKey;
          buildingDeadline = Date.now() + BUILD_CAP_MS;
        }
        if (Date.now() >= buildingDeadline) {
          diffState = "error";
          buildingKey = "";
        } else {
          diffState = "building";
          retryTimer = setTimeout(() => diffNonce++, res.retryAfterMs);
        }
      } else if (rewrittenSince) {
        rangeKey = "all";
        rewriteFallback = true;
      } else {
        files = [];
        diffState = "error";
        buildingKey = "";
      }
    }).catch(() => {
      if (diffFetch !== token) return;
      diffState = "error";
      buildingKey = "";
    });
    return () => clearTimeout(retryTimer);
  });

  function retryDiff() {
    diffState = "building";
    buildingKey = "";
    diffNonce++;
  }

  function warmDiffFile(path, visible) {
    if (visible) return diffDocument?.hydrate(path);
    const document = diffDocument;
    if (!document) return null;
    return document.prefetch(path).catch(() => {
      if (document === diffDocument) diffState = "error";
      return null;
    });
  }

  function releaseDiffFile(path) {
    return diffDocument?.release(path);
  }

  $effect(() => {
    if (!pr) return;
    const head = pr.headRefOid;
    const timer = setTimeout(() => writeLastViewed(repo, number, head), 4000);
    return () => clearTimeout(timer);
  });

  let newCommitCount = $derived.by(() => {
    if (!anchorInList) return 0;
    const oids = (pr.commitList.nodes ?? []).map((n) => n.commit.oid);
    return oids.length - 1 - oids.indexOf(sinceAnchor.headSha);
  });

  function selectCommit(oid) {
    if (!finishFileEdit()) return;
    rangeKey = `c${oid}`;
    goToTab("files");
  }

  function viewSinceChanges() {
    if (!finishFileEdit()) return;
    rangeKey = "since";
    goToTab("files");
  }


  async function refreshMutations() {
    mutations = await fetchMutations(repo, number);
    return mutations;
  }

  async function waitForMutation(kind, detailSettled = null) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const current = await refreshMutations();
      const mutation = current.find((item) => item.kind === kind);
      if (!mutation) {
        for (let detailAttempt = 0; detailAttempt < 20; detailAttempt++) {
          await reloadPr();
          if (!detailSettled || detailSettled()) return;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        showFlash("GitHub updated, but the refreshed PR state is delayed.");
        return;
      }
      if (mutation.state === "failed") return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await refreshMutations();
    showFlash("GitHub auto-merge is still queued; refresh the PR to check its state.");
  }

  async function reloadPr() {
    const token = activeFetch;
    const pending = pendingCommit;
    let detail;
    try {
      detail = await fetchPrDetail(repo, number);
    } catch {
      if (token === activeFetch && pending === pendingCommit) location.hash = "#/";
      return;
    }
    if (token !== activeFetch) return;
    applyAsyncPrDetail(detail, pending);
  }

  async function commitFileEdit(path, expectedHeadOid, content, message) {
    if (!pr) throw new Error("PR is unavailable.");
    const token = activeFetch;
    const result = await commitPrFileEdit(repo, number, path, expectedHeadOid, content, message.trim());
    if (token !== activeFetch || !pr) return result;
    const pending = { before: expectedHeadOid, committed: result.commitOid };
    pendingCommit = pending;
    pr = { ...pr, headRefOid: result.commitOid };
    diffNonce++;
    fetchPrDetail(repo, number).then(
      (detail) => {
        if (token !== activeFetch) return;
        applyAsyncPrDetail(detail, pending);
      },
      () => {
        if (token === activeFetch && pending === pendingCommit) showFlash("File committed, but the PR refresh failed.");
      },
    );
    return result;
  }

  function refreshDetail() {
    if (detailRefreshPromise) {
      detailRefreshQueued = true;
      return detailRefreshPromise;
    }
    const refreshPromise = (async () => {
      do {
        detailRefreshQueued = false;
        await refreshDetailOnce();
      } while (detailRefreshQueued);
    })();
    detailRefreshPromise = refreshPromise;
    refreshPromise.finally(() => {
      if (detailRefreshPromise === refreshPromise) detailRefreshPromise = null;
    });
    return refreshPromise;
  }

  async function refreshDetailOnce() {
    const token = activeFetch;
    const initialLoad = detailLoadPromise;
    if (initialLoad) {
      try {
        await initialLoad;
      } catch {
        // The catch-up request is also the retry when the initial detail load failed.
      }
    }
    if (token !== activeFetch) return;
    const pending = pendingCommit;
    let next;
    try {
      next = await fetchPrDetail(repo, number);
    } catch {
      return;
    }
    if (token !== activeFetch) return;
    if (pending !== pendingCommit) return;
    if (!pending && JSON.stringify(next) === JSON.stringify(pr)) return;
    if (!applyAsyncPrDetail(next, pending)) return;
    cacheDetail(prKeyOf(repo, number), next);
  }

  $effect(() => {
    if (refreshRevision === handledRefreshRevision) return;
    handledRefreshRevision = refreshRevision;
    untrack(() => refreshDetail());
  });

  $effect(() => {
    if (!mutations.some((m) => m.state === "pending")) return;
    const pendingBefore = new Set(mutations.filter((m) => m.state === "pending").map((m) => m.id));
    const timer = setTimeout(async () => {
      const rows = await fetchMutations(repo, number);
      const stillPresent = new Set(rows.map((m) => m.id));
      const anyCompleted = [...pendingBefore].some((id) => !stillPresent.has(id));
      if (anyCompleted) await reloadPr();
      mutations = rows;
    }, 2000);
    return () => clearTimeout(timer);
  });

  async function handleRetry(id) {
    await retryMutation(id);
    await refreshMutations();
  }

  async function handleDiscard(id) {
    await discardMutation(id);
    await refreshMutations();
  }

  let commentDraft = $state("");
  let commentSubmitting = $state(false);
  let pendingComments = $derived(mutations.filter((m) => m.kind === "comment"));
  let pendingInline = $derived(mutations.filter((m) => m.kind === "inline-comment"));

  async function submitInlineComment(comment) {
    await enqueueMutation(repo, number, { kind: "inline-comment", ...comment });
    await refreshMutations();
  }

  async function submitComment() {
    if (commentSubmitting || !commentDraft.trim()) return;
    commentSubmitting = true;
    try {
      await enqueueMutation(repo, number, { kind: "comment", body: commentDraft });
      commentDraft = "";
      await refreshMutations();
    } finally {
      commentSubmitting = false;
    }
  }

  function onCommentKeydown(e) {
    if (e.isComposing || e.shiftKey || e.altKey) return;
    if (!(e.metaKey || e.ctrlKey) || e.key !== "Enter") return;
    e.preventDefault();
    submitComment();
  }

  async function submitReply(rootCommentId, body) {
    await enqueueMutation(repo, number, { kind: "reply-to-thread", rootCommentId, body });
    await refreshMutations();
  }

  async function submitResolve(threadId, currentlyResolved) {
    await enqueueMutation(repo, number, { kind: "resolve-thread", threadId, resolved: !currentlyResolved });
    await refreshMutations();
  }

  let mutationsByThread = $derived.by(() => {
    const map = new Map();
    if (!pr) return map;
    const commentIdToThreadId = new Map();
    for (const t of pr.reviewThreads.nodes) {
      for (const c of t.comments.nodes) {
        if (c.databaseId) commentIdToThreadId.set(c.databaseId, t.id);
      }
    }
    const add = (threadId, m) => {
      if (!map.has(threadId)) map.set(threadId, []);
      map.get(threadId).push(m);
    };
    for (const m of mutations) {
      if (m.kind === "reply-to-thread") {
        const threadId = commentIdToThreadId.get(m.payload.rootCommentId);
        if (threadId) add(threadId, m);
      } else if (m.kind === "resolve-thread") {
        add(m.payload.threadId, m);
      }
    }
    return map;
  });

  function threadProps(thread) {
    return {
      pending: mutationsByThread.get(thread.id) ?? [],
      onReply: (rootCommentId, body) => submitReply(rootCommentId, body),
      onToggleResolve: () => submitResolve(thread.id, thread.isResolved),
      onRetry: handleRetry,
      onDiscard: handleDiscard,
    };
  }

  let editingBody = $state(false);
  let bodyDraft = $state("");
  let editBodyMutation = $derived(mutations.find((m) => m.kind === "edit-body"));
  let displayBody = $derived(editBodyMutation ? editBodyMutation.payload.body : pr?.body);

  function startEditBody() {
    bodyDraft = pr.body;
    editingBody = true;
  }

  async function saveBody() {
    if (!bodyDraft.trim()) return;
    if (bodyDraft === pr.body) {
      editingBody = false;
      return;
    }
    const body = bodyDraft;
    editingBody = false;
    await enqueueMutation(repo, number, { kind: "edit-body", body });
    await refreshMutations();
  }

  function onBodyEditKey(e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      editingBody = false;
    } else if (e.metaKey && e.key === "Enter") {
      e.preventDefault();
      saveBody();
    }
  }

  let editingTitle = $state(false);
  let titleDraft = $state("");
  let editTitleMutation = $derived(mutations.find((m) => m.kind === "edit-title"));
  let displayTitle = $derived(editTitleMutation ? editTitleMutation.payload.title : pr?.title);

  function startEditTitle() {
    titleDraft = displayTitle;
    editingTitle = true;
  }

  function cancelEditTitle() {
    editingTitle = false;
    titleDraft = "";
  }

  async function saveTitle() {
    const title = titleDraft.trim();
    if (!title || editTitleMutation) return;
    if (title === displayTitle) {
      cancelEditTitle();
      return;
    }
    editingTitle = false;
    await enqueueMutation(repo, number, { kind: "edit-title", title });
    await refreshMutations();
  }

  function onTitleEditKey(e) {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      cancelEditTitle();
    }
  }

  function focusAndSelect(node) {
    node.focus();
    node.select();
  }

  let verdictEvent = $state("APPROVE");
  let verdictBody = $state("");
  let verdictSubmitting = $state(false);
  let verdictBodyFocused = $state(false);
  let reviewMenuOpen = $state(false);
  let verdictMutation = $derived(mutations.find((m) => m.kind === "review-verdict"));
  let selectedVerdict = $derived(VERDICT_OPTIONS.find((option) => option.value === verdictEvent) ?? VERDICT_OPTIONS[0]);

  async function submitVerdict() {
    if (verdictSubmitting) return;
    reviewMenuOpen = false;
    verdictSubmitting = true;
    try {
      await enqueueMutation(repo, number, { kind: "review-verdict", event: verdictEvent, body: verdictBody });
      verdictBody = "";
      await refreshMutations();
    } finally {
      verdictSubmitting = false;
    }
  }

  function onVerdictKeydown(e) {
    if (e.isComposing || e.shiftKey || e.altKey) return;
    if (!(e.metaKey || e.ctrlKey) || e.key !== "Enter") return;
    e.preventDefault();
    submitVerdict();
  }

  let mergeMutation = $derived(mutations.find((m) => m.kind === "merge"));
  let mergeMethodLabel = $derived(pr.mergeMethod === "merge" ? "merge commit" : pr.mergeMethod ?? "squash");
  let mergeActionMethodLabel = $derived(pr.mergeMethod === "merge" ? "commit" : pr.mergeMethod ?? "squash");
  let mergeConfirm = $state(false);
  let forceMergeConfirm = $state(false);
  let mergeMenuOpen = $state(false);
  let mergeMethodBusy = $state(false);
  let quotaStatus = $derived(quotaImpact(quota.resources));
  let mergeBlockedByQuota = $derived(quotaStatus.mergeBlocked);
  let quotaMergeModal = $state(false);

  // an empty GitHub pool makes the merge call fail, so ask for confirmation only when
  // Cockpit can actually carry it out and offer GitHub's own merge button otherwise
  function requestMerge(force = false) {
    if (mergeBlockedByQuota) {
      quotaMergeModal = true;
      return;
    }
    mergeMenuOpen = false;
    forceMergeConfirm = force;
    mergeConfirm = !force;
  }

  function cancelMergeDecision() {
    mergeConfirm = false;
    forceMergeConfirm = false;
  }

  async function confirmMergeDecision() {
    const force = forceMergeConfirm;
    cancelMergeDecision();
    await submitMerge(force);
  }

  const mergeMethods = [
    { value: "squash", label: "Squash and merge" },
    { value: "merge", label: "Create a merge commit" },
    { value: "rebase", label: "Rebase and merge" },
  ];

  async function chooseMergeMethod(method) {
    mergeMethodBusy = true;
    try {
      const res = await fetch(`/api/pr/${repo}/${number}/merge-method`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Couldn't save merge method.");
      pr = { ...pr, mergeMethod: body.method, mergeMethodSource: body.source };
      mergeMenuOpen = false;
    } catch (err) {
      mergeFlash.show(err instanceof Error ? err.message : "Couldn't save merge method.");
    } finally {
      mergeMethodBusy = false;
    }
  }

  async function submitMerge(force = false) {
    if (mergeBlockedByQuota) {
      quotaMergeModal = true;
      return;
    }
    await enqueueMutation(repo, number, {
      kind: "merge",
      force,
      baseRef: pr.baseRefName,
      method: pr.mergeMethod ?? "squash",
      source: pr.mergeMethodSource ?? "default",
    });
    await refreshMutations();
  }

  let autoMergeMutation = $derived(mutations.find((m) => m.kind === "auto-merge"));
  let githubAutoMergeMutation = $derived(mutations.find((m) => m.kind === "github-auto-merge"));
  let githubAutoMergeEnabled = $derived(Boolean(pr.autoMergeRequest));
  // one modal serves every plain yes/no confirmation, each entry carrying its own copy and action
  let confirmAction = $state(null);

  function runConfirmAction() {
    const action = confirmAction;
    confirmAction = null;
    action.run();
  }

  function requestClose() {
    confirmAction = { title: `Close #${number}?`, confirmLabel: "Close pull request", danger: true, run: submitClose };
  }

  function requestAutoMerge() {
    const enable = !pr.autoMergeEnabled;
    confirmAction = {
      title: `${enable ? "Arm" : "Disarm"} the auto-merge bot for #${number}?`,
      confirmLabel: enable ? "Arm" : "Disarm",
      run: () => submitAutoMerge(enable),
    };
  }

  function requestAutofix() {
    confirmAction = { title: `Arm the auto-fix agent for #${number}?`, confirmLabel: "Arm agent", run: submitAutofix };
  }

  function requestCiFix() {
    confirmAction = {
      title: "Fix failing CI with an agent?",
      message: `${failingChecks.length} failing check${failingChecks.length === 1 ? "" : "s"} on ${pr.headRefName}`,
      confirmLabel: "Fix with agent",
      run: submitCiFix,
    };
  }

  function requestConflictResolution() {
    confirmAction = {
      title: "Resolve conflicts with an agent?",
      message: `${conflictFiles.length ? `Conflicts in ${conflictFiles.length} file${conflictFiles.length === 1 ? "" : "s"}` : "Repository-level conflict"}, pushed to ${pr.headRefName}`,
      confirmLabel: "Resolve conflicts",
      run: submitConflictResolution,
    };
  }

  function requestCustomAgent(def) {
    confirmAction = {
      title: def.id === "rescorer" ? `Re-score #${number}?` : `Arm the "${def.name || "custom"}" agent for #${number}?`,
      confirmLabel: def.id === "rescorer" ? "Re-score" : "Arm agent",
      run: () => submitCustom(def),
    };
  }

  let keybindAgents = $derived(prefs.agents.filter((a) => a.trigger === "keybind" && a.enabled && a.keybind));
  const runLabel = (run) => (run.agent_id && prefs.agents.find((a) => a.id === run.agent_id)?.name) || run.kind;

  async function submitAutoMerge(enable) {
    await enqueueMutation(repo, number, { kind: "auto-merge", enable });
    await refreshMutations();
    await reloadPr();
    await loadAgent();
  }

  async function submitGithubAutoMerge(enable) {
    const payload = enable
      ? { kind: "github-auto-merge", enable: true, method: pr.mergeMethod ?? "squash" }
      : { kind: "github-auto-merge", enable: false };
    await enqueueMutation(repo, number, payload);
    mergeMenuOpen = false;
    await refreshMutations();
    await waitForMutation("github-auto-merge", () => Boolean(pr.autoMergeRequest) === enable);
  }

  let agent = $state(null);
  let agentLog = $state(null);
  let showAgentLog = $state(false);

  async function loadAgent() {
    try {
      const agents = await fetchAgents();
      agent = agents.find((a) => a.repo === repo && a.number === number) ?? null;
    } catch {
      agent = null;
    }
  }

  async function toggleAgentLog() {
    showAgentLog = !showAgentLog;
    if (showAgentLog) agentLog = await fetchAgentLog(repo, number);
  }

  function requestKillAgent() {
    confirmAction = { title: "Kill the running agent?", confirmLabel: "Kill agent", danger: true, run: killRunningAgent };
  }

  async function killRunningAgent() {
    await killAgent(repo, number);
    await loadAgent();
    if (tab === "agents") await loadAgentRuns();
  }

  let agentRuns = $state([]);
  let selectedRunId = $state(null);
  let runDetail = $state(null);
  let runDetailLoading = $state(false);
  let showRawLog = $state(false);
  let expandedTurns = $state(new Set());

  async function loadAgentRuns() {
    try {
      agentRuns = await fetchAgentRuns(repo, number);
    } catch {
      agentRuns = [];
    }
  }

  async function selectRun(id) {
    selectedRunId = id;
    runDetail = null;
    showRawLog = false;
    expandedTurns = new Set();
    runDetailLoading = true;
    try {
      runDetail = await fetchAgentRunDetail(id);
    } finally {
      runDetailLoading = false;
    }
  }

  // refreshes the open run in place - keeps expanded turns and raw-log toggle, follows the tail only if the user is already there
  async function refreshRunDetail() {
    const id = selectedRunId;
    let detail;
    try {
      detail = await fetchAgentRunDetail(id);
    } catch {
      return;
    }
    if (id !== selectedRunId || tab !== "agents") return;
    const page = document.querySelector(".page");
    const atBottom = page.scrollHeight - page.scrollTop - page.clientHeight < 40;
    runDetail = detail;
    if (atBottom) {
      await tick();
      page.scrollTop = page.scrollHeight;
    }
  }

  function toggleTurnExpanded(i) {
    const next = new Set(expandedTurns);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    expandedTurns = next;
  }

  const TOOL_PRIMARY_KEYS = ["command", "file_path", "content", "pattern", "query", "url", "prompt"];

  function toolPrimaryArg(input) {
    if (!input || typeof input !== "object") return null;
    for (const key of TOOL_PRIMARY_KEYS) {
      if (typeof input[key] === "string" && input[key]) return [key, input[key]];
    }
    return Object.entries(input).find(([, v]) => typeof v === "string" && v) ?? null;
  }

  function toolLabel(turn, primary) {
    let summary = "";
    if (typeof turn.toolInput?.description === "string" && turn.toolInput.description) {
      summary = turn.toolInput.description;
    } else if (primary) {
      const flat = primary[1].replace(/\s+/g, " ").trim();
      summary = flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
    }
    return summary ? `→ ${turn.toolName} — ${summary}` : `→ ${turn.toolName}`;
  }


  function runHealth(run) {
    if (run.state === "running") return "running";
    if (run.state === "killed" || run.state === "died" || run.exit_reason === "gave-up") return "failed";
    if (run.exit_reason === "green" || run.exit_reason === "merged" || run.exit_reason === "done") return "succeeded";
    return "idle";
  }

  function runStateLabel(run) {
    return run.state === "running" ? "running" : (run.exit_reason || run.state);
  }

  const RUN_TONES = { running: "review", failed: "fail", succeeded: "ready", idle: "wait" };

  function runTone(run) {
    return RUN_TONES[runHealth(run)];
  }

  function runTime(run) {
    if (run.state === "running") return relativeTime(run.started_at);
    return run.ended_at ? `${relativeTime(run.ended_at)} · ${durationText(run.started_at, run.ended_at)}` : relativeTime(run.started_at);
  }

  $effect(() => {
    if (tab !== "agents" || !pr) return;
    loadAgentRuns();
    const timer = setInterval(() => {
      loadAgentRuns();
      if (selectedRunId && runDetail?.run.state === "running") refreshRunDetail();
    }, 5000);
    return () => clearInterval(timer);
  });

  let promptOpen = $state(false);
  let promptText = $state("");
  let promptError = $state(null);
  let promptBusy = $state(false);

  async function submitPrompt() {
    const instruction = promptText.trim();
    if (!instruction || promptBusy) return;
    promptBusy = true;
    promptError = null;
    try {
      await promptAgent(repo, number, instruction);
      promptOpen = false;
      promptText = "";
      await loadAgent();
    } catch (e) {
      promptError = e instanceof Error ? e.message : String(e);
    } finally {
      promptBusy = false;
    }
  }

  let autofixBusy = $state(false);
  let autofixError = $state(null);
  let conflictResolveBusy = $state(false);
  let conflictResolveError = $state(null);
  let ciFixBusy = $state(false);
  let ciFixError = $state(null);

  async function submitAutofix() {
    if (autofixBusy || agent?.state === "running" || prIsGreen || mergedState) return;
    autofixBusy = true;
    autofixError = null;
    try {
      await autofixAgent(repo, number);
      await loadAgent();
    } catch (e) {
      autofixError = e instanceof Error ? e.message : String(e);
    } finally {
      autofixBusy = false;
    }
  }

  async function submitConflictResolution() {
    if (conflictResolveBusy || agent?.state === "running" || !hasConflicts) return;
    conflictResolveBusy = true;
    conflictResolveError = null;
    const instruction = conflictFixPrompt();
    try {
      await promptAgent(repo, number, instruction);
      await loadAgent();
      await loadAgentRuns();
    } catch (e) {
      conflictResolveError = e instanceof Error ? e.message : String(e);
    } finally {
      conflictResolveBusy = false;
    }
  }

  async function submitCiFix() {
    if (ciFixBusy || agent?.state === "running" || !pr || !failingChecks.length) return;
    ciFixBusy = true;
    ciFixError = null;
    const instruction = ciFixPrompt({ repo, number, branch: pr.headRefName, checks: failingChecks });
    try {
      await promptAgent(repo, number, instruction);
      await loadAgent();
      await loadAgentRuns();
    } catch (e) {
      ciFixError = e instanceof Error ? e.message : String(e);
    } finally {
      ciFixBusy = false;
    }
  }

  let customBusy = $state(false);
  let customError = $state(null);

  async function submitCustom(agentDef) {
    if (customBusy || (agentDef.id !== "rescorer" && agent?.state === "running")) return;
    customBusy = true;
    customError = null;
    try {
      if (agentDef.id === "rescorer") {
        await rescoreAgent(repo, number);
      } else {
        await customAgent(repo, number, agentDef.id);
        await loadAgent();
      }
    } catch (e) {
      customError = e instanceof Error ? e.message : String(e);
    } finally {
      customBusy = false;
    }
  }

  function onPromptKey(e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      promptOpen = false;
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.stopPropagation();
      e.preventDefault();
      submitPrompt();
    }
  }

  const focusOnMount = (node) => node.focus();

  const sizeToTextOnMount = (node) => {
    node.focus();
    requestAnimationFrame(() => {
      const cap = Math.round(window.innerHeight * 0.7);
      node.style.height = "auto";
      node.style.height = Math.min(cap, Math.max(160, node.scrollHeight)) + "px";
    });
  };

  $effect(() => {
    if (!pr) return;
    loadAgent();
    loadAgentRuns();
  });

  $effect(() => {
    if (!pr?.autoMergeEnabled && agent?.state !== "running") return;
    const timer = setInterval(() => {
      loadAgent();
      if (tab !== "agents") loadAgentRuns();
    }, 5000);
    return () => clearInterval(timer);
  });

  let stateChip = $derived.by(() => {
    if (!pr) return { label: "", tone: "wait" };
    if (pr.isDraft) return { label: "draft", tone: "wait" };
    const s = pr.state.toUpperCase();
    if (s === "MERGED") return { label: "merged", tone: "merged" };
    if (s === "CLOSED") return { label: "closed", tone: "closed" };
    return { label: "open", tone: "ready" };
  });

  let liveState = $derived(!!pr && pr.state.toUpperCase() === "OPEN");
  let mergedState = $derived(!!pr && pr.state.toUpperCase() === "MERGED");
  let canReview = $derived(!mergedState && !pr?.viewerIsAuthor);
  let onLocalBranch = $derived(!!pr && pr.localBranch === pr.headRefName);
  let hasConflicts = $derived(!!pr && (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY"));

  async function loadConflictFiles(key) {
    conflictFilesState = "loading";
    conflictFilesError = null;
    try {
      const next = await fetchConflictFiles(repo, number);
      if (key !== loadedConflictKey) return;
      conflictFiles = next;
      conflictFilesState = "ready";
    } catch (e) {
      if (key !== loadedConflictKey) return;
      conflictFiles = [];
      conflictFilesState = "error";
      conflictFilesError = e instanceof Error ? e.message : String(e);
    }
  }

  $effect(() => {
    const key = hasConflicts ? `${repo}#${number}#${pr.headRefOid}#${pr.baseRefOid ?? pr.baseRefName}` : "";
    if (!key) {
      loadedConflictKey = "";
      conflictFiles = [];
      conflictFilesState = "idle";
      conflictFilesError = null;
      return;
    }
    if (key === loadedConflictKey) return;
    loadedConflictKey = key;
    loadConflictFiles(key);
  });

  $effect(() => {
    const key = pr ? `${repo}#${number}#${pr.headRefOid}#${pr.baseRefOid ?? ""}` : "";
    if (!key) {
      loadedCommitStatsKey = "";
      commitFileStats = {};
      return;
    }
    if (key === loadedCommitStatsKey) return;
    loadedCommitStatsKey = key;
    fetchPrCommitStats(repo, number).then(
      (res) => {
        if (key !== loadedCommitStatsKey) return;
        commitFileStats = res.commits ?? {};
      },
      // the timeline falls back to the per-commit totals GitHub already gave us
      () => {},
    );
  });

  let rollup = $derived(pr?.lastCommit.nodes[0]?.commit.statusCheckRollup ?? null);

  let checks = $derived.by(() => buildChecks(rollup));
  let failingChecks = $derived(checks.filter((check) => check.bucket === "failing"));
  let checkCounts = $derived.by(() => countChecks(checks));
  let checkSummary = $derived(summarizeChecks(checkCounts));
  let checkSections = $derived.by(() => sectionizeChecks(checks));

  let hasFailing = $derived((checkCounts.failing ?? 0) > 0);
  let showSuccessful = $state(false);

  let ci = $derived.by(() => {
    const s = rollup?.state;
    if (s === "SUCCESS") return { icon: "success", tone: "ready", text: "All checks passed" };
    if (s === "FAILURE" || s === "ERROR") return { icon: "failure", tone: "fail", text: "Checks failed" };
    if (s === "PENDING") return { icon: "pending", tone: "wait", text: "Checks running" };
    return { icon: "neutral", tone: "wait", text: "No checks" };
  });

  let ciDetail = $derived.by(() => {
    const total = checks.length;
    const passed = checkCounts.success ?? 0;
    const failing = checkCounts.failing ?? 0;
    const pending = (checkCounts.queued ?? 0) + (checkCounts.expected ?? 0) + (checkCounts.in_progress ?? 0);
    if (rollup?.state === "SUCCESS") return total ? `${total} check${total === 1 ? "" : "s"}` : "Complete";
    if (rollup?.state === "FAILURE" || rollup?.state === "ERROR") {
      return `${failing || 1} failing${passed ? ` · ${passed} passed` : ""}`;
    }
    if (rollup?.state === "PENDING") return `${pending || total} check${(pending || total) === 1 ? "" : "s"} remaining`;
    return "No checks have been reported";
  });

  function copyCiFixPrompt() {
    if (!pr || !failingChecks.length) return;
    const prompt = ciFixPrompt({ repo, number, branch: pr.headRefName, checks: failingChecks });
    navigator.clipboard.writeText(prompt).then(
      () => ciCopied.show(),
      () => showFlash("Couldn't copy the CI fix prompt."),
    );
  }

  function conflictFixPrompt() {
    if (!pr) return "";
    const paths = conflictFiles.length
      ? conflictFiles.map((path) => `- ${path}`).join("\n")
      : "- Git reported a repository-level conflict without individual file paths";
    return `Resolve the merge conflicts on ${repo} PR #${number}.\n\nPR: https://github.com/${repo}/pull/${number}\nBranch: ${pr.headRefName}\nBase: ${pr.baseRefName}\n\nConflicting files:\n${paths}\n\nFetch origin/${pr.baseRefName} and merge it into ${pr.headRefName}. Resolve every conflict faithfully, preserving the intent of both sides. Do not change unrelated code. Run the narrowest relevant validation, commit the merge resolution, and push only to ${pr.headRefName}.`;
  }

  function copyConflictFixPrompt() {
    if (!pr || conflictFilesState !== "ready") return;
    navigator.clipboard.writeText(conflictFixPrompt()).then(
      () => conflictCopied.show(),
      () => showFlash("Couldn't copy the conflict fix prompt."),
    );
  }

  let mergeGate = $derived.by(() => evalMergeGate(pr, rollup?.state ?? null));

  let forceMergeAvailable = $derived.by(() => evalForceMerge(pr, mergeGate));

  let updateMutation = $derived(mutations.find((m) => m.kind === "update-branch"));

  async function submitUpdateBranch() {
    await enqueueMutation(repo, number, { kind: "update-branch" });
    await refreshMutations();
  }

  async function switchToLocalBranch() {
    if (!pr?.localCheckoutPath || localBranchBusy) return;
    localBranchBusy = true;
    try {
      const result = await switchLocalBranch(repo, pr.headRefName);
      pr = { ...pr, localBranch: result.branch };
      showFlash(result.alreadyOnBranch ? `Already on ${pr.headRefName}.` : `Switched ${result.checkoutPath} to ${pr.headRefName}.`);
    } catch (err) {
      showFlash(err instanceof Error ? err.message : "Couldn't switch branches.");
    } finally {
      localBranchBusy = false;
    }
  }

  async function focusTerminal() {
    if (!pr) return;
    try {
      await focusTmux(repo, number);
    } catch (err) {
      showFlash(tmuxFocusErrorMessage(err));
    }
  }

  function editorTargetFromDiff() {
    if (tab !== "files" || files.length === 0) return null;
    const pane = document.querySelector(".diff-pane");
    if (!pane) return null;
    const paneRect = pane.getBoundingClientRect();
    const centerY = paneRect.top + paneRect.height / 2;
    let section = document.querySelector('[id^="diff-file-"]:hover');
    let index = section ? Number(section.id.slice("diff-file-".length)) : -1;
    if (!files[index]) {
      let distance = Infinity;
      for (let i = 0; i < files.length; i++) {
        const candidate = document.getElementById(`diff-file-${i}`);
        if (!candidate) continue;
        const rect = candidate.getBoundingClientRect();
        const candidateDistance = centerY < rect.top ? rect.top - centerY : centerY > rect.bottom ? centerY - rect.bottom : 0;
        if (candidateDistance < distance) {
          section = candidate;
          index = i;
          distance = candidateDistance;
        }
      }
    }
    if (!section || !files[index]) return null;
    let lineElement = section.querySelector(".line[data-new-line]:hover");
    if (!lineElement) {
      let distance = Infinity;
      for (const candidate of section.querySelectorAll(".line[data-new-line]")) {
        const rect = candidate.getBoundingClientRect();
        const candidateDistance = Math.abs(rect.top + rect.height / 2 - centerY);
        if (candidateDistance < distance) {
          lineElement = candidate;
          distance = candidateDistance;
        }
      }
    }
    const line = Number(lineElement?.dataset.newLine);
    return { path: files[index].path, line: Number.isInteger(line) && line > 0 ? line : null };
  }

  function currentEditorTarget() {
    return editorTargetFromDiff() ?? (files[fileIndex] ? { path: files[fileIndex].path, line: null } : null);
  }

  async function openInlineEditor() {
    if (!pr || !fileEditable) {
      showFlash("Inline editing is only available for the current open pull request.");
      return;
    }
    if (tab !== "files") {
      goToTab("files");
      await tick();
    }
    for (let attempt = 0; attempt < 20 && !diffView; attempt++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    if (!diffView || !(await diffView.openEditor(editorTargetFromDiff()))) {
      showFlash("Choose an editable file before opening the inline editor.");
    }
  }

  async function finishExternalEdit(sessionId) {
    const result = await window.cockpitShell?.finishEditor?.(sessionId);
    if (result?.error) showFlash(result.error);
  }

  async function openExternalEditor() {
    if (externalEditorBusy) return;
    if (!pr || !fileEditable) {
      showFlash("External editing is only available for the current open pull request.");
      return;
    }
    if (!window.cockpitShell?.openEditor) {
      showFlash("External editing is only available in the desktop app.");
      return;
    }
    const target = currentEditorTarget();
    if (!target) {
      showFlash("Choose an editable file before opening the external editor.");
      return;
    }
    externalEditorBusy = true;
    let result;
    try {
      result = await window.cockpitShell.openEditor(repo, number, target, pr.headRefOid);
    } catch (error) {
      showFlash(error instanceof Error ? error.message : "Couldn't open the external editor.");
      return;
    } finally {
      externalEditorBusy = false;
    }
    if (result?.error) {
      showFlash(result.error);
      return;
    }
    if (result?.warning) showFlash(result.warning);
    if (!result?.changed) return;
    if (tab !== "files") {
      goToTab("files");
      await tick();
    }
    for (let attempt = 0; attempt < 20 && !diffView; attempt++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    if (!diffView || !(await diffView.reviewExternalEdit(target, result.content, result.sessionId))) {
      await finishExternalEdit(result.sessionId);
      showFlash("Couldn't show the editor changes for this file.");
    }
  }

  $effect(() => {
    if (!fileEditable || !pr?.headRefOid || !window.cockpitShell?.prepareEditor) return;
    const key = `${repo}#${number}@${pr.headRefOid}`;
    if (key === preparedEditorKey) return;
    preparedEditorKey = key;
    void window.cockpitShell.prepareEditor(repo, number, pr.headRefOid);
  });

  function copyBranchName() {
    if (!pr?.headRefName) return;
    navigator.clipboard.writeText(pr.headRefName).then(
      () => branchCopied.show(),
      () => showFlash("Couldn't copy the branch name."),
    );
  }

  let readyMutation = $derived(mutations.find((m) => m.kind === "ready-for-review"));

  async function submitReadyForReview() {
    await enqueueMutation(repo, number, { kind: "ready-for-review" });
    await refreshMutations();
  }

  let closeMutation = $derived(mutations.find((m) => m.kind === "close"));

  async function submitClose() {
    await enqueueMutation(repo, number, { kind: "close" });
    await refreshMutations();
  }

  const mergeFlash = timedFlag(2400);

  let reviewers = $derived.by(() => {
    if (!pr) return [];
    const latest = new Map();
    for (const r of pr.reviews.nodes) {
      if (!r.author) continue;
      if (r.state === "COMMENTED" && latest.has(r.author.login)) continue;
      latest.set(r.author.login, { state: r.state, avatarUrl: r.author.avatarUrl });
    }
    for (const c of pr.comments.nodes) {
      const who = c.author?.login;
      if (who && KNOWN_BOT_LOGINS.has(who) && !latest.has(who)) latest.set(who, { state: "COMMENTED", avatarUrl: c.author.avatarUrl });
    }
    for (const req of pr.reviewRequests.nodes) {
      const who = req.requestedReviewer?.login ?? req.requestedReviewer?.name;
      if (who && !latest.has(who)) latest.set(who, { state: "PENDING", avatarUrl: req.requestedReviewer?.avatarUrl });
    }
    return [...latest.entries()].map(([login, v]) => ({ login, state: v.state, avatarUrl: v.avatarUrl }));
  });

  let greptileMeta = $derived(pr ? greptileReviewMeta(pr) : { confidence: null, reviewedSha: null, unresolvedCount: 0 });
  let greptileState = $derived(pr ? greptileStatus(greptileMeta, pr.headRefOid) : null);
  let greptileRescore = $derived(pr?.greptileRescore ?? null);

  function greptileTitle(status) {
    if (greptileRescore) return `original ${greptileMeta.confidence}/5 by greptile-apps → ${greptileRescore.score}/5 re-scored after fixes`;
    if (status === "stale") return "reviewed before recent pushes - the score may no longer reflect the current state";
    if (status === "addressed") return "reviewed before recent pushes, but every thread that reviewer left is resolved";
    return "Greptile confidence";
  }

  let repoUsers = $state([]);
  let pickerMode = $state(null);
  let rangeOpen = $state(false);
  const peopleFlash = timedFlag(2000);

  let pendingAssign = $derived(mutations.filter((m) => m.kind === "assign"));
  let pendingUnassign = $derived(mutations.filter((m) => m.kind === "unassign"));
  let pendingReviewers = $derived(mutations.filter((m) => m.kind === "request-reviewers"));
  let pendingUnreviewers = $derived(mutations.filter((m) => m.kind === "unrequest-reviewers"));
  let assignedByServer = $derived(new Set((pr?.assignees.nodes ?? []).map((a) => a.login)));
  let requestedByServer = $derived(new Set(reviewers.map((r) => r.login)));
  let assignedLogins = $derived.by(() => {
    const s = new Set(assignedByServer);
    for (const m of pendingAssign) if (m.state !== "failed") for (const login of m.payload.logins) s.add(login);
    for (const m of pendingUnassign) if (m.state !== "failed") for (const login of m.payload.logins) s.delete(login);
    return s;
  });
  let requestedLogins = $derived.by(() => {
    const s = new Set(requestedByServer);
    for (const m of pendingReviewers) if (m.state !== "failed") for (const login of m.payload.logins) s.add(login);
    for (const m of pendingUnreviewers) if (m.state !== "failed") for (const login of m.payload.logins) s.delete(login);
    return s;
  });

  function avatarFor(login) {
    return repoUsers.find((u) => u.login === login)?.avatarUrl ?? null;
  }

  async function submitAssign(login) {
    const kind = assignedLogins.has(login) ? "unassign" : "assign";
    await enqueueMutation(repo, number, { kind, logins: [login] });
    await refreshMutations();
  }

  async function submitRequestReviewer(login) {
    if (!requestedLogins.has(login) && login === pr.author?.login) {
      peopleFlash.show("can't request review from the author");
      return;
    }
    const kind = requestedLogins.has(login) ? "unrequest-reviewers" : "request-reviewers";
    await enqueueMutation(repo, number, { kind, logins: [login] });
    await refreshMutations();
  }

  let timeline = $derived.by(() => {
    if (!pr) return [];
    const events = [];
    for (const c of pr.comments.nodes) {
      events.push({ kind: "comment", id: `comment-${c.id}`, author: c.author?.login, avatarUrl: c.author?.avatarUrl, body: c.body, at: c.createdAt, state: null, reactions: c.reactions });
    }
    for (const r of pr.reviews.nodes) {
      if (!r.submittedAt) continue;
      if (!r.body && r.state === "COMMENTED") continue;
      events.push({ kind: "review", id: `review-${r.id}`, author: r.author?.login, avatarUrl: r.author?.avatarUrl, body: r.body, at: r.submittedAt, state: r.state, reactions: r.reactions });
    }
    for (const t of pr.reviewThreads.nodes) {
      const at = t.comments.nodes[0]?.createdAt;
      if (!at) continue;
      events.push({ kind: "thread", id: `thread-${t.id}`, thread: t, at });
    }
    for (const { commit } of pr.commitList.nodes) {
      events.push({
        kind: "commit",
        id: `commit-${commit.oid}`,
        author: commit.author?.user?.login ?? commit.author?.name ?? null,
        avatarUrl: commit.author?.user?.avatarUrl,
        headline: commit.messageHeadline,
        additions: commit.additions ?? null,
        deletions: commit.deletions ?? null,
        oid: commit.oid,
        parentOid: commit.parents?.nodes?.[0]?.oid ?? null,
        ciState: commit.statusCheckRollup?.state ?? null,
        at: commit.committedDate,
      });
    }
    const orderedEvents = events.sort((a, b) => new Date(a.at) - new Date(b.at));
    const pendingEvents = pendingComments.map((mutation) => ({ kind: "pending-comment", id: `pending-comment-${mutation.id}`, mutation }));
    return prefs.newestCommentsFirst ? [...pendingEvents, ...orderedEvents.reverse()] : [...orderedEvents, ...pendingEvents];
  });
  const FAILED_CI_STATES = new Set(["FAILURE", "ERROR"]);
  const RUNNING_CI_STATES = new Set(["PENDING", "EXPECTED"]);

  function commitCiLabel(state) {
    if (state === "SUCCESS") return "Checks passed";
    if (FAILED_CI_STATES.has(state)) return "Checks failed";
    if (RUNNING_CI_STATES.has(state)) return "Checks running";
    return "No workflow runs";
  }

  let threadSplit = $derived(anchorThreads(files, pr?.reviewThreads.nodes ?? []));
  let unresolvedTotal = $derived(
    (pr?.reviewThreads.nodes ?? []).filter((t) => !t.isResolved).length,
  );
  let prIsGreen = $derived(mergeGate.action === "merge" && unresolvedTotal === 0);
  let autofixDef = $derived(keybindAgents.find((a) => a.id === "autofix"));
  let fixShortcutTarget = $derived.by(() => {
    if (!autofixDef || agent?.state === "running" || mergedState) return null;
    if (failingChecks.length && !ciFixBusy) return "ci";
    if (hasConflicts && conflictFilesState === "ready" && !conflictResolveBusy) return "conflict";
    if (!mergedState && !prIsGreen && !autofixBusy) return "autofix";
    return null;
  });

  const reviewTone = (state) =>
    state === "APPROVED"
      ? "ready"
      : state === "CHANGES_REQUESTED"
        ? "fail"
        : state === "PENDING"
          ? "wait"
          : "review";
  const stateLabel = (state) => state.toLowerCase().replace(/_/g, " ");

  let firstUnresolved = $derived(
    (pr?.reviewThreads.nodes ?? []).find((t) => !t.isResolved) ?? null,
  );
  let fileIndex = $state(0);
  let collapsedFiles = $state(new Set());
  let viewedFiles = $state(new Set());
  let selectedPath = $derived(files[fileIndex]?.path ?? null);

  let testPattern = $derived(testMatcher(prefs.testPathRegex));
  let testFiles = $derived(files.filter((f) => testPattern.test(f.path)));
  let nonTestFiles = $derived(files.filter((f) => !testPattern.test(f.path)));
  let nonTestAdditions = $derived(nonTestFiles.reduce((sum, f) => sum + f.additions, 0));
  let nonTestDeletions = $derived(nonTestFiles.reduce((sum, f) => sum + f.deletions, 0));
  let testsHidden = $derived(testFiles.length > 0 && testFiles.every((f) => collapsedFiles.has(f.path)));
  let treeFiles = $derived(testsHidden ? files.filter((f) => !testPattern.test(f.path)) : files);

  // Counts exclude test files, matching the header's headline numbers. A commit that touched nothing
  // else would read as an empty +0 −0, so it reports its test counts muted instead.
  let commitLineCounts = $derived.by(() => {
    const counts = {};
    for (const [sha, fileList] of Object.entries(commitFileStats)) {
      const totals = { additions: 0, deletions: 0, skippedTests: false, testsOnly: false };
      const tests = { additions: 0, deletions: 0 };
      for (const file of fileList) {
        const bucket = testPattern.test(file.path) ? tests : totals;
        bucket.additions += file.additions;
        bucket.deletions += file.deletions;
        if (bucket === tests) totals.skippedTests = true;
      }
      if (totals.additions === 0 && totals.deletions === 0 && totals.skippedTests) {
        counts[sha] = { additions: tests.additions, deletions: tests.deletions, skippedTests: false, testsOnly: true };
        continue;
      }
      counts[sha] = totals;
    }
    return counts;
  });

  $effect(() => {
    if (tab !== "files" || diffState !== "ready" || treeFiles.length === 0) return;
    const paths = treeFiles.map((file) => file.path);
    requestAnimationFrame(() => {
      const name = document.querySelector(".tree-pane .name");
      if (!name) return;
      const context = document.createElement("canvas").getContext("2d");
      context.font = getComputedStyle(name).font;
      let widest = TREE_MIN_WIDTH;
      for (const path of paths) widest = Math.max(widest, context.measureText(path).width + 96);
      treeMaxWidth = widest;
    });
  });

  function startTreeResize(e) {
    e.preventDefault();
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = treeDesiredWidth;
    function onMove(ev) {
      treeDesiredWidth = Math.max(TREE_MIN_WIDTH, Math.min(treeMaxWidth, startWidth + (ev.clientX - startX)));
    }
    function onUp() {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      localStorage.setItem(TREE_WIDTH_KEY, String(treeDesiredWidth));
    }
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
  }

  let testDefaultAppliedFor = null;
  $effect(() => {
    const key = `${repo}/${number}`;
    if (!prefs.loaded || files.length === 0 || testDefaultAppliedFor === key) return;
    testDefaultAppliedFor = key;
    if (prefs.hideTestsDefault) {
      collapsedFiles = new Set([...collapsedFiles, ...testFiles.map((f) => f.path)]);
    }
  });

  function toggleTests() {
    if (testsHidden) {
      updateViewedFiles(testFiles, false);
    } else {
      collapsedFiles = new Set([...collapsedFiles, ...testFiles.map((f) => f.path)]);
    }
  }

  function viewedFileStorageKey() {
    return `${VIEWED_FILES_KEY_PREFIX}${repo}#${number}`;
  }

  function loadViewedFileRecords() {
    try {
      const records = JSON.parse(localStorage.getItem(viewedFileStorageKey()) ?? "{}");
      return records && typeof records === "object" && !Array.isArray(records) ? records : {};
    } catch {
      return {};
    }
  }

  function saveViewedFileRecords(records) {
    try {
      const key = viewedFileStorageKey();
      if (Object.keys(records).length) localStorage.setItem(key, JSON.stringify(records));
      else localStorage.removeItem(key);
    } catch {
    }
  }

  function syncViewedFiles(nextFiles) {
    const nextCollapsed = new Set(collapsedFiles);
    for (const path of viewedFiles) nextCollapsed.delete(path);
    if (rangeKey !== "all") {
      viewedFiles = new Set();
      collapsedFiles = nextCollapsed;
      return;
    }

    const records = loadViewedFileRecords();
    const nextViewed = new Set();
    const paths = new Set(nextFiles.map((file) => file.path));
    for (const path of Object.keys(records)) {
      if (!paths.has(path)) delete records[path];
    }
    for (const file of nextFiles) {
      const fingerprint = fileDiffFingerprint(file);
      if (records[file.path]?.fingerprint === fingerprint) {
        nextViewed.add(file.path);
        nextCollapsed.add(file.path);
      } else {
        delete records[file.path];
      }
    }
    viewedFiles = nextViewed;
    collapsedFiles = nextCollapsed;
    saveViewedFileRecords(records);
  }

  function updateViewedFiles(targetFiles, viewed) {
    const nextViewed = new Set(viewedFiles);
    const nextCollapsed = new Set(collapsedFiles);
    for (const file of targetFiles) {
      if (viewed) {
        nextViewed.add(file.path);
        nextCollapsed.add(file.path);
      } else {
        nextViewed.delete(file.path);
        nextCollapsed.delete(file.path);
      }
    }
    viewedFiles = nextViewed;
    collapsedFiles = nextCollapsed;

    if (rangeKey !== "all") return;
    const records = loadViewedFileRecords();
    for (const file of targetFiles) {
      if (viewed) records[file.path] = { fingerprint: fileDiffFingerprint(file) };
      else delete records[file.path];
    }
    saveViewedFileRecords(records);
  }

  function setFileViewed(file, viewed) {
    updateViewedFiles([file], viewed);
  }

  function toggleFileCollapse(file) {
    setFileViewed(file, !collapsedFiles.has(file.path));
  }

  function focusTarget(selector) {
    const el = document.querySelector(selector);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.focus();
  }

  function focusWhenReady(selector, tries = 20) {
    const el = document.querySelector(selector);
    if (el) {
      el.scrollIntoView({ block: "center" });
      el.focus();
    } else if (tries > 0) {
      requestAnimationFrame(() => focusWhenReady(selector, tries - 1));
    }
  }

  function revealAnchoredReply(path, replyId, tries = 20) {
    const i = files.findIndex((f) => f.path === path);
    const el = i >= 0 ? document.getElementById(`diff-file-${i}`) : null;
    if (el) {
      el.scrollIntoView({ block: "start" });
      focusWhenReady(`[data-reply-for="${replyId}"]`);
    } else if (tries > 0) {
      requestAnimationFrame(() => revealAnchoredReply(path, replyId, tries - 1));
    }
  }

  function revealReply() {
    if (!firstUnresolved) return;
    const anchored = !threadSplit.unanchored.some((t) => t.id === firstUnresolved.id);
    if (anchored) {
      if (tab !== "files") goToTab("files");
      if (collapsedFiles.has(firstUnresolved.path)) {
        const file = files.find((item) => item.path === firstUnresolved.path);
        if (file) setFileViewed(file, false);
      }
      revealAnchoredReply(firstUnresolved.path, firstUnresolved.id);
    } else {
      if (tab !== "conversation") goToTab("conversation");
      focusWhenReady(`[data-reply-for="${firstUnresolved.id}"]`);
    }
  }

  function scrollToFile(i) {
    const el = document.getElementById(`diff-file-${i}`);
    if (!el) return;
    spyHoldUntil = performance.now() + 400;
    el.scrollIntoView({ block: "start" });
    // estimated placeholder heights (content-visibility) shift as neighbors render; re-align for a few frames
    let frames = 12;
    const page = el.closest(".page");
    const settle = () => {
      if (scrollAnimating(page)) {
        spyHoldUntil = 0;
        return;
      }
      const target = document.getElementById(`diff-file-${i}`);
      if (!target) return;
      target.scrollIntoView({ block: "start" });
      if (--frames > 0) requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
  }

  let spyHoldUntil = 0;

  function fileAtViewportTop(page) {
    const probeY = page.getBoundingClientRect().top + 60;
    let lo = 0;
    let hi = files.length - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const el = document.getElementById(`diff-file-${mid}`);
      if (!el) return -1;
      if (el.getBoundingClientRect().top <= probeY) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  }

  $effect(() => {
    if (tab !== "files") return;
    const page = document.querySelector(".page");
    if (!page) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (performance.now() < spyHoldUntil) return;
        const i = fileAtViewportTop(page);
        if (i >= 0 && i !== fileIndex) fileIndex = i;
      });
    };
    page.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      page.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  });

  function selectFile(i) {
    fileIndex = i;
    scrollToFile(i);
  }

  function selectFileByPath(path) {
    const i = files.findIndex((f) => f.path === path);
    if (i >= 0) selectFile(i);
  }

  function openChangedFile(path) {
    const i = files.findIndex((f) => f.path === path);
    if (i < 0) return;
    fileIndex = i;
    if (tab !== "files") goToTab("files");
    let tries = 20;
    const reveal = () => {
      if (document.getElementById(`diff-file-${i}`)) scrollToFile(i);
      else if (--tries > 0) requestAnimationFrame(reveal);
    };
    requestAnimationFrame(reveal);
  }

  function finishFileEdit() {
    return diffView?.finishFileEdit() ?? true;
  }

  function goToTab(next) {
    if (tab === "files" && next !== "files" && !finishFileEdit()) return false;
    location.hash = next === "conversation" ? `#/pr/${repo}/${number}` : `#/pr/${repo}/${number}/${next}`;
    return true;
  }

  function guardTabNavigation(event, next) {
    if (tab === "files" && next !== "files" && !finishFileEdit()) event.preventDefault();
  }

  function selectRange(key) {
    if (finishFileEdit()) rangeKey = key;
  }

  let telescope = $state(null);
  let diffView = $state(null);
  let telescopeOpen = $state(false);
  let historyOpen = $derived(historyPath !== null);
  let historyFile = $derived(historyPath ? files.find((file) => file.path === historyPath) ?? null : null);
  function openFileHistory(path, symbol = null) {
    if (!finishFileEdit()) return;
    if (rangeKey !== "all") {
      rangeKey = "all";
      files = [];
    }
    const parent = `#/pr/${repo}/${number}/files`;
    const query = symbol ? `?symbol=${encodeURIComponent(symbol)}` : "";
    location.hash = `#/pr/${repo}/${number}/history/${encodeURIComponent(path)}${query}`;
    history.replaceState({ ...history.state, fileHistoryParent: parent }, "");
  }

  function closeFileHistory() {
    const parent = `#/pr/${repo}/${number}/files`;
    if (history.state?.fileHistoryParent === parent) history.back();
    else location.replace(parent);
  }

  $effect(() => {
    let downPressed = false;
    let upPressed = false;
    function onKey(e) {
      const keyOwner = prKeyOwner(e);
      if (keyOwner === "blur") {
        e.target.blur();
        e.preventDefault();
        return;
      }
      if (keyOwner === "typing") return;
      if (e.metaKey && e.key === ",") {
        if (finishFileEdit()) location.hash = "#/settings";
        e.preventDefault();
        return;
      }
      if (e.metaKey && ["1", "2", "3", "4"].includes(e.key)) {
        if (!rangeOpen && !pickerMode && !telescopeOpen) {
          goToTab(e.key === "1" ? "conversation" : e.key === "2" ? "files" : e.key === "3" ? "agents" : "actions");
        }
        e.preventDefault();
        return;
      }
      if (shouldCopyPrUrl(e)) {
        if (pr) {
          navigator.clipboard.writeText(`https://github.com/${repo}/pull/${number}`).then(() => copied.show("copied GitHub PR URL"), () => {});
        }
        e.preventDefault();
        return;
      }
      if (shouldCopyPrCockpitUrl(e)) {
        if (pr) {
          navigator.clipboard.writeText(`prcockpit://pr/${repo}/${number}`).then(() => copied.show("copied PR Cockpit deep link"), () => {});
        }
        e.preventDefault();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        scrollPage(document.querySelector(".page"), e.key === "ArrowDown" ? 1 : -1);
        e.preventDefault();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (pickerMode) {
        if (e.key === "Escape") {
          pickerMode = null;
          e.preventDefault();
        }
        return;
      }
      if (quotaMergeModal) {
        if (e.key === "Escape" || e.key === "Enter") {
          quotaMergeModal = false;
          e.preventDefault();
        }
        return;
      }
      if (rangeOpen) return;
      if (historyOpen) return;
      if (reviewMenuOpen) {
        if (e.key === "Escape") {
          reviewMenuOpen = false;
          e.preventDefault();
        }
        return;
      }
      if (mergeMenuOpen) {
        if (e.key === "Escape") {
          mergeMenuOpen = false;
          e.preventDefault();
        } else if (e.key === "M" && forceMergeAvailable && liveState && !mergeMutation) {
          requestMerge(true);
          e.preventDefault();
        }
        return;
      }
      if (mergeConfirm || forceMergeConfirm || confirmAction) return;
      if (e.key === "Escape") {
        if (tab === "files") goToTab("conversation");
        else if (finishFileEdit()) location.hash = "#/";
        e.preventDefault();
        return;
      }
      const page = document.querySelector(".page");
      if (e.key === "g" && !e.shiftKey) {
        const now = Date.now();
        if (now - lastG < 400) {
          scrollEdge(page, "top");
          lastG = 0;
          e.preventDefault();
        } else lastG = now;
        return;
      }
      if (e.key === "G") {
        scrollEdge(page, "bottom");
        e.preventDefault();
        return;
      }
      if (e.key === "d") {
        goToTab(tab === "files" ? "conversation" : "files");
      } else if (tab === "files" && e.key === "J") {
        selectFile(Math.min(files.length - 1, fileIndex + 1));
      } else if (tab === "files" && e.key === "K") {
        selectFile(Math.max(0, fileIndex - 1));
      } else if (e.key === "j" || e.key === "ArrowDown") {
        downPressed = true;
        holdScrollStart(page, 1);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        upPressed = true;
        holdScrollStart(page, -1);
      } else if (tab === "files" && e.key === "x") {
        toggleTests();
      } else if (tab === "files" && e.key === "h") {
        if (files[fileIndex]) openFileHistory(files[fileIndex].path);
      } else if (e.key === "x") {
        if (liveState && !mergeMutation && !closeMutation) requestClose();
      } else if (tab === "files" && e.key === "c") {
        rangeOpen = true;
      } else if (tab === "conversation" && e.key === "c") {
        focusTarget("#composer-input");
      } else if (tab === "conversation" && e.key === "v" && canReview) {
        focusTarget("#verdict-control");
      } else if (e.key === "r") {
        revealReply();
      } else if (e.key === "e") {
        openInlineEditor();
      } else if (e.key === "E") {
        openExternalEditor();
      } else if (e.key === "m") {
        if (mergeGate.action === "merge" && !mergeMutation) requestMerge();
        else if (mergeGate.reason) mergeFlash.show(mergeGate.reason);
      } else if (e.key === "M") {
        if (forceMergeAvailable && !mergeMutation) requestMerge(true);
      } else if (e.key === "u" && mergeGate.action === "update") {
        if (!updateMutation) submitUpdateBranch();
      } else if (e.key === "s") {
        pickerMode = "assign";
      } else if (e.key === "q") {
        pickerMode = "review";
      } else if (e.key === "o") {
        if (pr) window.open(pr.url, "_blank", "noopener");
      } else if (e.key === "T") {
        focusTerminal();
      } else if (e.key === "p") {
        promptOpen = true;
      } else if (autofixDef?.keybind === e.key && fixShortcutTarget) {
        if (fixShortcutTarget === "ci") requestCiFix();
        else if (fixShortcutTarget === "conflict") requestConflictResolution();
        else requestAutofix();
      } else if (keybindAgents.some((a) => a.keybind === e.key)) {
        const def = keybindAgents.find((a) => a.keybind === e.key);
        if (def.id === "fixer") {
          if (!autoMergeMutation) requestAutoMerge();
        } else if (def.id === "autofix") {
          if (!autofixBusy && agent?.state !== "running" && !prIsGreen && !mergedState) requestAutofix();
        } else if (def.id === "rescorer") {
          if (!customBusy) requestCustomAgent(def);
        } else if (!customBusy && agent?.state !== "running") {
          requestCustomAgent(def);
        }
      } else {
        return;
      }
      e.preventDefault();
    }
    function releaseHold() {
      downPressed = false;
      upPressed = false;
      holdScrollRelease(document.querySelector(".page"));
    }
    function onPointerDown(e) {
      if (!mergeMenuOpen && !reviewMenuOpen) return;
      if (e.target instanceof Element && e.target.closest("[data-split-action]")) return;
      mergeMenuOpen = false;
      reviewMenuOpen = false;
    }
    function onKeyUp(e) {
      if (e.code === "KeyJ" || e.code === "ArrowDown") {
        downPressed = false;
        if (upPressed) holdScrollStart(document.querySelector(".page"), -1);
        else holdScrollRelease(document.querySelector(".page"));
      } else if (e.code === "KeyK" || e.code === "ArrowUp") {
        upPressed = false;
        if (downPressed) holdScrollStart(document.querySelector(".page"), 1);
        else holdScrollRelease(document.querySelector(".page"));
      }
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", releaseHold);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releaseHold);
      window.removeEventListener("pointerdown", onPointerDown);
      cancelHoldScroll(document.querySelector(".page"));
    };
  });

  let mergeKey = $derived(
    mergeGate.action === "update" ? { key: "u", label: "update branch" } : { key: "m", label: "merge" },
  );
  let fixerDef = $derived(keybindAgents.find((a) => a.id === "fixer"));
  let autoMergeKeys = $derived(fixerDef ? [{ key: fixerDef.keybind, label: pr?.autoMergeEnabled ? "disarm bot" : "auto-merge bot" }] : []);
  let agentActionKeys = $derived(
    keybindAgents.flatMap((a) => {
      if (a.id === "fixer") return [];
      if (a.id === "autofix") return agent?.state !== "running" && !prIsGreen && !mergedState ? [{ key: a.keybind, label: "auto-fix" }] : [];
      if (a.id === "rescorer") return [{ key: a.keybind, label: "re-score" }];
      return agent?.state !== "running" ? [{ key: a.keybind, label: a.name || "custom agent" }] : [];
    }),
  );
  let conversationKeys = $derived([
    { key: "d", label: "files" },
    { key: "c", label: "comment" },
    { key: "r", label: "reply" },
    { key: "e", label: "edit inline" },
    { key: "⇧E", label: "editor" },
    ...(canReview ? [{ key: "v", label: "review" }] : []),
    { key: "s", label: "assign" },
    { key: "q", label: "request review" },
    { key: "p", label: "prompt agent" },
    ...agentActionKeys,
    mergeKey,
    { key: "x", label: "close" },
    ...autoMergeKeys,
    { key: "o", label: "github" },
    ...(pr ? [{ key: "⇧T", label: "focus terminal" }] : []),
    { key: "esc", label: "back" },
  ]);
  let filesKeys = $derived([
    { key: "d", label: "conversation" },
    { key: "J / K", label: "file" },
    { key: "c", label: "changes range" },
    { key: "x", label: "hide tests" },
    { key: "h", label: "file history" },
    { key: "r", label: "reply" },
    { key: "e", label: "edit inline" },
    { key: "⇧E", label: "editor" },
    { key: "s", label: "assign" },
    { key: "q", label: "request review" },
    mergeKey,
    ...autoMergeKeys,
    { key: "o", label: "github" },
    ...(pr ? [{ key: "⇧T", label: "focus terminal" }] : []),
    { key: "esc", label: "back" },
  ]);
  let tabKeys = $derived([
    { key: "⌘1 / ⌘2 / ⌘3 / ⌘4", label: "switch tab" },
    { key: "x", label: "close" },
    { key: "o", label: "github" },
    ...(pr ? [{ key: "⇧T", label: "focus terminal" }] : []),
    { key: "esc", label: "back" },
  ]);
</script>

<div class="page">
  {#if error}
    <div class="load">{error}</div>
  {:else if pr}
    <div class="detail-frame" class:conversation-tab={tab === "conversation"} class:files-tab={tab === "files"}>
    <div class="detail" style="--tree-width: {treeWidth}px">
      <header class="pr-head">
        <div class="pr-head-top">
          <div class="pr-title-copy">
            <span class="ui-eyebrow">Pull request #{pr.number}</span>
            {#if editingTitle}
              <form class="pr-title-editor" onsubmit={(e) => { e.preventDefault(); saveTitle(); }}>
                <input
                  class="pr-title-input"
                  aria-label="Pull request title"
                  bind:value={titleDraft}
                  onkeydown={onTitleEditKey}
                  use:focusAndSelect
                />
                <button type="submit" class="title-editor-action title-save" disabled={!titleDraft.trim()} aria-label="Save pull request title" title="Save title">
                  {#if titleDraft.trim()}<Kbd keys="enter" />{/if}
                </button>
                <button type="button" class="title-editor-action" aria-label="Cancel renaming pull request" title="Cancel" onclick={cancelEditTitle}>
                  <Kbd keys="esc" />
                </button>
              </form>
            {:else}
              <div class="pr-title-row">
                <h1>{displayTitle}</h1>
                {#if editTitleMutation}
                  <div class="title-mutation">
                    <MutationBadge state={editTitleMutation.state} pendingLabel="SAVING…" onRetry={() => handleRetry(editTitleMutation.id)} onDiscard={() => handleDiscard(editTitleMutation.id)} />
                    {#if editTitleMutation.error}<span class="mut-error">{editTitleMutation.error}</span>{/if}
                  </div>
                {:else}
                  <button type="button" class="title-rename" aria-label="Rename pull request" title="Rename pull request" onclick={startEditTitle}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z" />
                    </svg>
                  </button>
                {/if}
              </div>
            {/if}
            <div class="sub">
              <span class="chip badge {stateChip.tone}">{stateChip.label}</span>
              <div class="branch-context" aria-label="{pr.headRefName} merges into {pr.baseRefName}">
                {#if pr.baseBranchPrNumber}
                  <a class="branch-name branch-target base-pr-link" href="#/pr/{repo}/{pr.baseBranchPrNumber}">
                    {pr.baseRefName} (#{pr.baseBranchPrNumber})
                  </a>
                {:else}
                  <span class="branch-name branch-target">{pr.baseRefName}</span>
                {/if}
                <span class="branch-arrow" aria-hidden="true">←</span>
                <span class="branch-name branch-source" title={pr.headRefName}>{pr.headRefName}</span>
                {#if onLocalBranch}
                  <CurrentBranchBadge />
                {/if}
                <button
                  type="button"
                  class="branch-action branch-copy"
                  aria-label="Copy branch name"
                  title="Copy branch name"
                  onclick={copyBranchName}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <rect x="9" y="9" width="10" height="10" rx="1.5" />
                    <path d="M15 9V6.5A1.5 1.5 0 0 0 13.5 5h-7A1.5 1.5 0 0 0 5 6.5v7A1.5 1.5 0 0 0 6.5 15H9" />
                  </svg>
                </button>
                {#if !onLocalBranch}
                  <button
                    type="button"
                    class="branch-action branch-switch"
                    disabled={!pr.localCheckoutPath || localBranchBusy}
                    aria-label={localBranchBusy ? "Switching branch" : "Switch branch"}
                    aria-busy={localBranchBusy}
                    title={pr.localCheckoutPath ? `Switch ${pr.localCheckoutPath} to ${pr.headRefName}` : "No local checkout found for this repository"}
                    onclick={switchToLocalBranch}
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <circle cx="6" cy="5" r="2" />
                      <circle cx="18" cy="18" r="2" />
                      <path d="M6 7v3a4 4 0 0 0 4 4h4a4 4 0 0 1 4 4" />
                      <path d="M18 7v4a3 3 0 0 1-3 3h-1" />
                    </svg>
                  </button>
                {/if}
              </div>
              {#if unresolvedTotal > 0}
                <span class="sep">·</span>
                <span class="unres">{unresolvedTotal} unresolved</span>
              {/if}
              {#if liveState && pr.autoMergeEnabled}
                <span class="sep">·</span>
                <span class="chip badge ready">auto-merge bot armed</span>
              {/if}
              {#if liveState && githubAutoMergeEnabled}
                <span class="sep">·</span>
                <span class="chip badge ready">GitHub auto-merge armed</span>
              {/if}
              <span class="sep">·</span>
              <span>{relativeTime(pr.updatedAt)}</span>
              {#if liveState && mergeGate.reason && !pr.isDraft && pr.mergeable !== "CONFLICTING" && pr.mergeStateStatus !== "DIRTY"}
                <span class="sep">·</span>
                <span class="chip badge wait">{mergeGate.reason}</span>
              {/if}
              {#if liveState && mergeGate.note && !pr.isDraft}
                <span class="sep">·</span>
                <span class="chip badge wait">{mergeGate.note}</span>
              {/if}
            </div>
          </div>

          <div class="pr-metrics" aria-label="Pull request change summary">
            <div class="pr-metric">
              <span>Changed</span>
              {#if diffState === "ready"}
                <strong><b class="add">+{nonTestAdditions}</b> <b class="del">−{nonTestDeletions}</b></strong>
                <em><b class="add">+{pr.additions}</b> <b class="del">−{pr.deletions}</b></em>
              {:else}
                <strong><b class="add">+{pr.additions}</b> <b class="del">−{pr.deletions}</b></strong>
              {/if}
            </div>
            <div class="pr-metric">
              <span>Files</span>
              <strong>{pr.changedFiles}</strong>
            </div>
            <div class="pr-metric">
              <span>Commits</span>
              <strong>{pr.commitCount.totalCount}</strong>
            </div>
          </div>
        </div>

        <div class="pr-head-foot">
          <div class="pr-owner">
            <Avatar login={pr.author?.login} url={pr.author?.avatarUrl} size={18} />
            <span>{pr.author?.login ?? "ghost"}</span>
          </div>
          {#if pr.labels.nodes.length}
            <div class="labels">
              {#each pr.labels.nodes as label}
                <span class="label">{label.name}</span>
              {/each}
            </div>
          {/if}
          {#if liveState}
            <div class="ci-summary {ci.tone}" role="status" aria-label={`${ci.text}. ${ciDetail}`}>
              <span class="ci-summary-icon" aria-hidden="true">
                {#if ci.icon === "success"}
                  <svg class="status-success" viewBox="0 0 14 14">
                    <circle cx="7" cy="7" r="6.5"></circle>
                    <path d="m3.9 7.1 2 2 4.25-4.25"></path>
                  </svg>
                {:else if ci.icon === "failure"}
                  <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.25"></circle><path d="m5.5 5.5 5 5m0-5-5 5"></path></svg>
                {:else if ci.icon === "pending"}
                  <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.25"></circle><path d="M8 4.5V8l2.4 1.5"></path></svg>
                {:else}
                  <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.25"></circle><path d="M5.5 8h5"></path></svg>
                {/if}
              </span>
              <span class="ci-summary-label">{ci.text}</span>
              <span class="ci-summary-detail">{ciDetail}</span>
            </div>
          {/if}
        </div>

        {#if liveState && failingChecks.length}
          <section class="ci-failure-alert" aria-label="Failing CI checks">
            <div class="ci-failure-head">
              <span class="ci-failure-icon" aria-hidden="true">
                <svg viewBox="0 0 16 16"><path d="m5.25 5.25 5.5 5.5m0-5.5-5.5 5.5"></path></svg>
              </span>
              <div class="ci-failure-copy">
                <div class="attention-title">
                  <strong>{failingChecks.length} failing check{failingChecks.length === 1 ? "" : "s"}</strong>
                  <span class="attention-chip attention-label">Action required</span>
                </div>
                <span class="attention-description">Open the exact logs below or copy a ready-to-fix prompt.</span>
              </div>
              <div class="ci-failure-actions">
                <button class="ci-copy-button" onclick={copyCiFixPrompt}>
                  {ciCopied.value ? "Copied" : "Copy fix prompt"}
                </button>
                <button
                  class="ci-agent-button shortcut-action"
                  disabled={ciFixBusy || agent?.state === "running"}
                  onclick={requestCiFix}
                >
                  {ciFixBusy ? "Starting…" : agent?.state === "running" ? "Agent running" : "Fix with agent"}
                  {#if fixShortcutTarget === "ci"}<Kbd keys={autofixDef.keybind} />{/if}
                </button>
              </div>
            </div>
            <ul class="ci-failure-list">
              {#each failingChecks as check}
                <li>
                  <span class="ci-failure-check">
                    <strong title={check.name}>{check.name}</strong>
                    {#if check.required}<span class="attention-chip ci-required">Required</span>{/if}
                    <span>{check.status}</span>
                  </span>
                  {#if check.url}
                    <a href={check.url} target="_blank" rel="noreferrer">Open logs ↗</a>
                  {:else}
                    <span class="ci-location">PR checks · use copied command</span>
                  {/if}
                </li>
              {/each}
            </ul>
            {#if ciFixError}<div class="ci-failure-error">{ciFixError}</div>{/if}
          </section>
        {/if}

        {#if liveState && hasConflicts}
          <section class="conflict-alert" aria-label="Merge conflicts">
            <div class="conflict-alert-main">
              <span class="conflict-alert-icon" aria-hidden="true">
                <svg viewBox="0 0 16 16"><path d="M8 4.25v4.5M8 11.5h.01"></path></svg>
              </span>
              <div class="conflict-alert-copy">
                <div class="attention-title">
                  <strong>{conflictFilesState === "ready" && conflictFiles.length ? `Merge conflicts in ${conflictFiles.length} file${conflictFiles.length === 1 ? "" : "s"}` : "Merge conflicts"}</strong>
                  <span class="attention-chip attention-label">Action required</span>
                </div>
                <span class="attention-description">This PR cannot merge until they are resolved.</span>
              </div>
              {#if conflictFilesState === "ready"}
                <div class="conflict-actions">
                  <button class="conflict-copy-button" onclick={copyConflictFixPrompt}>
                    {conflictCopied.value ? "Copied" : "Copy fix prompt"}
                  </button>
                  <button
                    class="conflict-primary shortcut-action"
                    disabled={conflictResolveBusy || agent?.state === "running"}
                    onclick={requestConflictResolution}
                  >
                    {conflictResolveBusy ? "Starting…" : agent?.state === "running" ? "Agent running" : "Fix with agent"}
                    {#if fixShortcutTarget === "conflict"}<Kbd keys={autofixDef.keybind} />{/if}
                  </button>
                </div>
              {/if}
            </div>

            {#if conflictFilesState === "loading"}
              <div class="conflict-alert-note">Finding conflicting files…</div>
            {:else if conflictFilesState === "error"}
              <div class="conflict-alert-error">
                <span>{conflictFilesError}</span>
                <button class="link" onclick={() => loadConflictFiles(loadedConflictKey)}>Retry</button>
              </div>
            {:else if conflictFilesState === "ready"}
              {#if conflictFiles.length}
                <ul class="conflict-file-list mono" aria-label="Conflicting files">
                  {#each conflictFiles as path (path)}
                    <li title={path}>{path}</li>
                  {/each}
                </ul>
              {:else}
                <div class="conflict-alert-note">Repository-level conflict · no individual paths reported</div>
              {/if}
            {/if}
            {#if conflictResolveError}<div class="conflict-alert-error">{conflictResolveError}</div>{/if}
          </section>
        {/if}
      </header>

      {#if anchorInList}
        <button class="since-banner" onclick={viewSinceChanges}>
          {newCommitCount} new commit{newCommitCount === 1 ? "" : "s"} since your last visit — view changes
        </button>
      {:else if anchorRewritten}
        {#if rewriteFallback}
          <div class="since-banner rewritten note">
            branch was rewritten since your last visit — your last-seen commit is no longer available, showing all changes
          </div>
        {:else if rangeKey === "since"}
          <div class="since-banner rewritten note">
            branch was rewritten since your last visit — comparing against your last-seen commit
          </div>
        {:else}
          <button class="since-banner rewritten" onclick={viewSinceChanges}>
            branch was rewritten since your last visit — compare against your last-seen commit
          </button>
        {/if}
      {/if}

      <nav class="tabs">
        <a class="tab" class:active={tab === "conversation"} href="#/pr/{repo}/{number}" onclick={(event) => guardTabNavigation(event, "conversation")}>
          Conversation {#if tab === "files"}<Kbd keys="d" />{/if}
        </a>
        <a class="tab" class:active={tab === "files"} href="#/pr/{repo}/{number}/files">
          Files {#if diffState === "ready"}<span class="tab-count">{treeFiles.length}</span>{/if} {#if tab !== "files"}<Kbd keys="d" />{/if}
        </a>
        <a class="tab" class:active={tab === "agents"} href="#/pr/{repo}/{number}/agents" onclick={(event) => guardTabNavigation(event, "agents")}>
          Agents {#if agent?.state === "running"}<span class="tab-count">1</span>{/if} {#if tab !== "agents"}<Kbd keys="⌘3" />{/if}
        </a>
        <a class="tab" class:active={tab === "actions"} href="#/pr/{repo}/{number}/actions" onclick={(event) => guardTabNavigation(event, "actions")}>
          Actions {#if tab !== "actions"}<Kbd keys="⌘4" />{/if}
        </a>
      </nav>

      {#if tab === "files"}
        <div class="files-layout">
          <div class="files-toolbar">
            <div class="toolbar-left">
              <span class="toolbar-label">Compare</span>
              <RangePicker
                {commits}
                {rangeKey}
                showSince={sinceAvailable}
                sinceLabel="Changes since your last visit"
                onSelect={selectRange}
                bind:open={rangeOpen}
              />
            </div>
            {#if testFiles.length && diffState === "ready"}
              <button class="toolbar-btn shortcut-action" onclick={toggleTests}>
                {testsHidden ? "show" : "hide"} {testFiles.length} test file{testFiles.length > 1 ? "s" : ""} <Kbd keys="x" />
              </button>
            {/if}
          </div>
          <aside class="tree-pane">
            <div class="file-nav-head">
              <span>Changed files</span>
              {#if diffState === "ready"}<span class="fcount">{treeFiles.length}</span>{/if}
            </div>
            <FileTree files={treeFiles} {selectedPath} onSelect={selectFileByPath} />
          </aside>
          <div class="tree-resizer" role="separator" aria-orientation="vertical" onpointerdown={startTreeResize}></div>
          <div class="diff-pane">
            {#if churnBaseRef && rangeKey === "since" && diffState === "ready"}
              <div class="churn-note">Merged in <span class="mono">{churnBaseRef}</span> since your visit — its churn is hidden, showing only this PR's changes</div>
            {/if}
            {#if diffState === "error"}
              <div class="diff-status">
                Couldn’t load this diff.
                <button class="retry-btn" onclick={retryDiff}>Retry</button>
              </div>
            {:else if diffState === "building"}
              <div class="diff-status">Preparing diff…</div>
            {:else if files.length === 0}
              <div class="diff-status">No changes in this range.</div>
            {:else}
              <DiffView
                bind:this={diffView}
                {files}
                onWarmFile={warmDiffFile}
                onReleaseFile={releaseDiffFile}
                anchored={threadSplit.anchored}
                {threadProps}
                collapsed={collapsedFiles}
                onToggleFile={toggleFileCollapse}
                {repo}
                viewed={viewedFiles}
                onToggleViewed={(file) => setFileViewed(file, !viewedFiles.has(file.path))}
                headSha={range?.head ?? pr.headRefOid}
                diffIdentity={displayedDiffKey}
                {pendingInline}
                {commentable}
                onInlineComment={submitInlineComment}
                onRetryMutation={handleRetry}
                onDiscardMutation={handleDiscard}
                base={pr.baseRefName}
                onOpenHistory={openFileHistory}
                historyShortcutPath={files[fileIndex]?.path}
                onLookupDefinition={(symbol, fromPath, position) => telescope?.openDefinition(symbol, fromPath, position)}
                editable={fileEditable}
                onCommitFileEdit={commitFileEdit}
                onGenerateCommitMessage={(path, hunk) => generateCommitMessage(repo, number, path, hunk)}
                onFinishExternalEdit={finishExternalEdit}
                layout={prefs.diffLayout}
              />
            {/if}
          </div>
        </div>
      {:else if tab === "agents"}
        <div class="agents-layout">
          <aside class="runs-pane">
            {#each agentRuns as run (run.id)}
              <button class="run-row" class:active={selectedRunId === run.id} onclick={() => selectRun(run.id)}>
                <div class="run-row-top">
                  <span class="badge {runTone(run)}">{runLabel(run)} {run.state}</span>
                  <span class="run-time">{relativeTime(run.started_at)}</span>
                </div>
                <div class="run-brief">{run.brief}</div>
              </button>
            {:else}
              <div class="side-empty">No agent runs yet</div>
            {/each}
          </aside>
          <div class="run-detail">
            {#if !selectedRunId}
              <div class="side-empty">Select a run</div>
            {:else if runDetailLoading}
              <div class="side-empty">Loading…</div>
            {:else if runDetail}
              <div class="run-detail-head">
                <span class="badge {runTone(runDetail.run)}">{runLabel(runDetail.run)} {runDetail.run.state}</span>
                <span class="run-time">
                  {relativeTime(runDetail.run.started_at)}
                  {#if runDetail.run.ended_at} · ran {durationText(runDetail.run.started_at, runDetail.run.ended_at)}{/if}
                </span>
                {#if runDetail.run.exit_reason}<span class="run-exit">{runDetail.run.exit_reason}</span>{/if}
                {#if runDetail.run.state === "running"}
                  <button class="link" onclick={requestKillAgent}>kill agent</button>
                {/if}
                <button class="link" onclick={() => (showRawLog = !showRawLog)}>{showRawLog ? "hide raw log" : "raw log"}</button>
              </div>
              <div class="run-detail-brief">{runDetail.run.brief}</div>
              {#if showRawLog}
                <pre class="am-log mono">{runDetail.rawLog || "no log"}</pre>
              {:else}
                <div class="run-turns">
                  {#each runDetail.turns as turn, i (i)}
                    {#if turn.kind === "text"}
                      <div class="turn turn-text mono">{turn.text}</div>
                    {:else if turn.kind === "tool"}
                      {@const primary = toolPrimaryArg(turn.toolInput)}
                      <div class="turn turn-tool mono">
                        <button class="turn-toggle" onclick={() => toggleTurnExpanded(i)}>
                          <span class="turn-line">{toolLabel(turn, primary)}</span>
                        </button>
                        {#if expandedTurns.has(i)}
                          {#if primary}<pre class="turn-tool-input">{primary[1]}</pre>{/if}
                          {#each Object.entries(turn.toolInput ?? {}).filter(([k]) => k !== "description" && k !== primary?.[0]) as [key, value] (key)}
                            <div class="turn-tool-arg">{key}: {typeof value === "string" ? value : JSON.stringify(value)}</div>
                          {/each}
                        {/if}
                      </div>
                    {:else}
                      <div class="turn turn-result mono" class:err={turn.isError}>
                        <button class="turn-toggle" onclick={() => toggleTurnExpanded(i)}>
                          <span class="turn-line">← {turn.text}</span>
                        </button>
                        {#if expandedTurns.has(i)}
                          <pre class="turn-result-full">{turn.text}</pre>
                        {/if}
                      </div>
                    {/if}
                  {/each}
                </div>
              {/if}
            {:else}
              <div class="side-empty">Couldn’t load this run</div>
            {/if}
          </div>
        </div>
      {:else if tab === "actions"}
        <ActionsView {repo} {number} headSha={pr.headRefOid} />
      {:else}
        <div class="cols">
        <div class="left">
          {#if pr.body}
            <section class="card body-card">
              {#if editingBody}
                <div class="composer body-editor">
                  <textarea bind:value={bodyDraft} onkeydown={onBodyEditKey} use:sizeToTextOnMount></textarea>
                  <div class="body-editor-actions">
                    <span class="body-editor-hint">⌘⏎ to save</span>
                    <button class="link shortcut-action" disabled={!bodyDraft.trim()} onclick={saveBody}>
                      save {#if bodyDraft.trim()}<Kbd keys={["cmd", "enter"]} />{/if}
                    </button>
                    <span class="body-editor-dot">·</span>
                    <button class="link shortcut-action" onclick={() => (editingBody = false)}>cancel <Kbd keys="esc" /></button>
                  </div>
                </div>
              {:else}
                {#if !editBodyMutation}
                  <button class="link body-edit shortcut-action" onclick={startEditBody}>Edit <Kbd keys={["shift", "e"]} /></button>
                {/if}
                <div class="md" use:imageFallback use:mermaidDiagrams={theme.name + "" + displayBody}>{@html renderMarkdown(displayBody)}</div>
                {#if editBodyMutation}
                  <div class="body-mut">
                    <MutationBadge state={editBodyMutation.state} onRetry={() => handleRetry(editBodyMutation.id)} onDiscard={() => handleDiscard(editBodyMutation.id)} />
                    {#if editBodyMutation.error}<span class="mut-error">{editBodyMutation.error}</span>{/if}
                  </div>
                {/if}
                <Reactions reactions={pr.reactions} />
              {/if}
            </section>
          {/if}

          {#snippet commentComposer(atTop = false)}
            <div class="composer" class:composer-top={atTop}>
              <textarea id="composer-input" placeholder="Leave a comment…" bind:value={commentDraft} onkeydown={onCommentKeydown}></textarea>
              <button class="btn shortcut-action" disabled={!commentDraft.trim() || commentSubmitting} onclick={submitComment}>
                {commentSubmitting ? "Posting…" : "Comment"}
                {#if commentDraft.trim() && !commentSubmitting}<Kbd keys={["cmd", "enter"]} />{/if}
              </button>
            </div>
          {/snippet}

          <section class="block">
            <h2 class="block-title">Conversation</h2>
            {#if prefs.newestCommentsFirst}
              {@render commentComposer(true)}
            {/if}
            {#each timeline as event (event.id)}
              {#if event.kind === "commit"}
                {@const lines = commitLineCounts[event.oid] ?? (event.additions === null ? null : { additions: event.additions, deletions: event.deletions, skippedTests: false, testsOnly: false })}
                {@const when = relativeTime(event.at)}
                <div class="commit-row" class:clickable={event.parentOid}>
                  <button
                    class="commit-row-main"
                    disabled={!event.parentOid}
                    title={event.parentOid ? "View this commit's changes" : ""}
                    onclick={() => selectCommit(event.oid)}
                  >
                    <span class="commit-glyph"></span>
                    <Avatar login={event.author} url={event.avatarUrl} size={16} />
                    <span class="commit-headline">{event.headline}</span>
                    <span
                      class="commit-lines"
                      class:tests-only={lines?.testsOnly}
                      title={lines?.testsOnly ? "Only test files changed" : lines?.skippedTests ? "Lines changed outside test files" : "Lines changed"}
                    >
                      {#if lines}
                        <b class="add">+{lines.additions}</b><b class="del">−{lines.deletions}</b>
                      {/if}
                    </span>
                  </button>
                  <a
                    class="commit-ci"
                    class:pass={event.ciState === "SUCCESS"}
                    class:fail={FAILED_CI_STATES.has(event.ciState)}
                    class:running={RUNNING_CI_STATES.has(event.ciState)}
                    class:neutral={!event.ciState}
                    href="https://github.com/{repo}/commit/{event.oid}/checks"
                    target="_blank"
                    rel="noreferrer"
                    aria-label="{commitCiLabel(event.ciState)} for {event.oid.slice(0, 7)}. View workflow runs"
                    title="{commitCiLabel(event.ciState)} · View workflow runs for {event.oid.slice(0, 7)}"
                  >
                    {#if event.ciState === "SUCCESS"}
                      <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5"></circle><path d="m4.8 8 2 2 4.4-4.4"></path></svg>
                    {:else if FAILED_CI_STATES.has(event.ciState)}
                      <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5"></circle><path d="m5.5 5.5 5 5m0-5-5 5"></path></svg>
                    {:else if RUNNING_CI_STATES.has(event.ciState)}
                      <span class="commit-ci-dot" aria-hidden="true"></span>
                    {:else}
                      <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.5"></circle><path d="M5.5 8h5"></path></svg>
                    {/if}
                  </a>
                  <button
                    class="when commit-when"
                    disabled={!event.parentOid}
                    title={event.parentOid ? "View this commit's changes" : ""}
                    aria-label="View changes from {when} ago"
                    onclick={() => selectCommit(event.oid)}
                  >
                    {when}
                  </button>
                </div>
              {:else if event.kind === "thread"}
                <Thread thread={event.thread} {...threadProps(event.thread)} />
              {:else if event.kind === "pending-comment"}
                <div class="event">
                  <div class="event-head">
                    <span class="author">you</span>
                    <MutationBadge state={event.mutation.state} onRetry={() => handleRetry(event.mutation.id)} onDiscard={() => handleDiscard(event.mutation.id)} />
                  </div>
                  <div class="event-body">
                    <div class="md">{@html renderMarkdown(event.mutation.payload.body)}</div>
                  </div>
                </div>
              {:else}
                <div
                  class="event"
                  class:activity-event={event.kind === "review" && !event.body && !event.reactions?.length}
                  class:greptile-event={event.author === "greptile-apps"}
                >
                  <div class="event-head">
                    <Avatar login={event.author} url={event.avatarUrl} />
                    <span class="author">{event.author ?? "ghost"}</span>
                    {#if event.kind === "review"}
                      <span class="verdict badge {reviewTone(event.state)}">{stateLabel(event.state)}</span>
                    {/if}
                    <span class="when">{relativeTime(event.at)}</span>
                  </div>
                  {#if event.body || event.reactions?.length}
                    <div class="event-body">
                      {#if event.body}
                      <div class="md" use:imageFallback use:mermaidDiagrams={theme.name + " " + event.body}>{@html renderMarkdown(event.body)}</div>
                      {/if}
                      <Reactions reactions={event.reactions} />
                    </div>
                  {/if}
                </div>
              {/if}
            {/each}
            {#if !prefs.newestCommentsFirst}
              {@render commentComposer()}
            {/if}
          </section>

        </div>

        <aside class="right">
          {#if liveState}
            <div class="side-block">
              <h3 class="side-title">Actions</h3>
              <div class="actions">
                {#snippet mergeControl(enabled)}
                  <SplitButton
                    tone={enabled && mergeBlockedByQuota ? "blocked" : "green"}
                    open={mergeMenuOpen}
                    mainDisabled={!enabled}
                    optionsLabel="Merge options"
                    onMain={() => requestMerge()}
                    onToggle={() => ((reviewMenuOpen = false), (mergeMenuOpen = !mergeMenuOpen))}
                  >
                    {#snippet main()}
                      <svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true">
                        <circle cx="6" cy="6" r="2.5"></circle>
                        <circle cx="18" cy="18" r="2.5"></circle>
                        <path d="M6 8.5V13a5 5 0 0 0 5 5h4.5"></path>
                      </svg>
                      <span>Merge</span>
                      <span class="action-method">{mergeActionMethodLabel}</span>
                      {#if enabled}<Kbd keys="m" />{/if}
                    {/snippet}
                    {#snippet menu()}
                      <div class="merge-menu" role="menu">
                        {#each mergeMethods as method}
                          <button
                            role="menuitemradio"
                            aria-checked={pr.mergeMethod === method.value}
                            class:active={pr.mergeMethod === method.value}
                            disabled={mergeMethodBusy}
                            onclick={() => chooseMergeMethod(method.value)}
                          >
                            <span>{method.label}</span>
                            {#if pr.mergeMethod === method.value}
                              <svg class="menu-check" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7"></path></svg>
                            {/if}
                          </button>
                        {/each}
                        <div class="merge-menu-separator"></div>
                        {#if githubAutoMergeMutation?.state === "pending"}
                          <button role="menuitem" disabled>
                            {githubAutoMergeEnabled ? "Disabling GitHub auto-merge…" : "Enabling GitHub auto-merge…"}
                          </button>
                        {:else if githubAutoMergeMutation?.state !== "failed"}
                          <button role="menuitem" onclick={() => submitGithubAutoMerge(!githubAutoMergeEnabled)}>
                            <span class="merge-menu-label">
                              <svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true">
                                <path d="M20 7v5h-5"></path>
                                <path d="M4 17v-5h5"></path>
                                <path d="M6.1 8.5A7 7 0 0 1 18.8 10M17.9 15.5A7 7 0 0 1 5.2 14"></path>
                              </svg>
                              <span>{githubAutoMergeEnabled ? "Disable GitHub auto-merge" : "Enable GitHub auto-merge"}</span>
                            </span>
                          </button>
                        {/if}
                        {#if forceMergeAvailable && mergeGate.action !== "merge" && !mergeMutation}
                          <div class="merge-menu-separator"></div>
                          <button
                            role="menuitem"
                            class="danger"
                            onclick={() => {
                              mergeMenuOpen = false;
                              requestMerge(true);
                            }}
                          >
                            <span>Force merge now</span>
                            <Kbd keys="M" />
                          </button>
                        {/if}
                      </div>
                    {/snippet}
                  </SplitButton>
                {/snippet}
                {#if pr.isDraft}
                  {#if readyMutation?.state === "pending"}
                    <button class="merge-btn" disabled>marking ready…</button>
                  {:else if readyMutation?.state === "failed"}
                    <MutationFailure
                      action="mark ready for review"
                      error={readyMutation.error}
                      onRetry={() => handleRetry(readyMutation.id)}
                      onDiscard={() => handleDiscard(readyMutation.id)}
                    />
                  {:else}
                    <button class="merge-btn" onclick={submitReadyForReview}>ready for review</button>
                  {/if}
                {:else if mergeGate.action === "merge" || mergeMutation}
                  {#if mergeMutation?.state === "pending"}
                    <button class="merge-btn" disabled>merging…</button>
                  {:else if mergeMutation?.state === "failed"}
                    <MutationFailure
                      action="merge"
                      error={mergeMutation.error}
                      onRetry={() => handleRetry(mergeMutation.id)}
                      onDiscard={() => handleDiscard(mergeMutation.id)}
                    />
                  {:else}
                    {@render mergeControl(true)}
                  {/if}
                {:else if mergeGate.action === "update" || updateMutation}
                  {#if updateMutation?.state === "pending"}
                    <button class="merge-btn update-action" disabled>updating…</button>
                  {:else if updateMutation?.state === "failed"}
                    <MutationFailure
                      action="update branch"
                      error={updateMutation.error}
                      onRetry={() => handleRetry(updateMutation.id)}
                      onDiscard={() => handleDiscard(updateMutation.id)}
                    />
                  {:else}
                    <button class="merge-btn update-action shortcut-action" onclick={submitUpdateBranch}>update branch <Kbd keys="u" /></button>
                  {/if}
                {/if}
                {#if !pr.isDraft && mergeGate.action !== "merge" && !mergeMutation}
                  {@render mergeControl(false)}
                {/if}
                {#if !pr.isDraft && githubAutoMergeMutation?.state === "pending"}
                  <span class="action-note">{githubAutoMergeEnabled ? "Disabling GitHub auto-merge…" : "Enabling GitHub auto-merge…"}</span>
                {:else if !pr.isDraft && githubAutoMergeMutation?.state === "failed"}
                  <MutationFailure
                    action="GitHub auto-merge"
                    error={githubAutoMergeMutation.error}
                    onRetry={() => handleRetry(githubAutoMergeMutation.id)}
                    onDiscard={() => handleDiscard(githubAutoMergeMutation.id)}
                  />
                {/if}
                {#if !mergeMutation}
                  {#if closeMutation?.state === "pending"}
                    <button class="merge-btn" disabled>closing…</button>
                  {:else if closeMutation?.state === "failed"}
                    <MutationFailure
                      action="close pull request"
                      error={closeMutation.error}
                      onRetry={() => handleRetry(closeMutation.id)}
                      onDiscard={() => handleDiscard(closeMutation.id)}
                    />
                  {:else}
                    <button class="merge-btn fail close-action" onclick={requestClose}>
                      <svg class="action-icon" viewBox="0 0 24 24" aria-hidden="true">
                        <circle cx="12" cy="12" r="8.5"></circle>
                        <path d="m9 9 6 6m0-6-6 6"></path>
                      </svg>
                      <span>Close pull request</span>
                      {#if tab !== "files"}<Kbd keys="x" />{/if}
                    </button>
                  {/if}
                {/if}
              </div>
            </div>
          {/if}
          {#if agentRuns.length || (!prIsGreen && !mergedState)}
            <div class="side-block">
              <h3 class="side-title">Agents</h3>
              {#if !prIsGreen && !mergedState}
                <button class="btn wide shortcut-action" disabled={autofixBusy || agent?.state === "running"} onclick={requestAutofix}>
                  {autofixBusy ? "Starting…" : "Auto-fix"}
                  {#if fixShortcutTarget === "autofix"}
                    <Kbd keys={autofixDef.keybind} />
                  {/if}
                </button>
              {/if}
              {#if autofixError}<span class="mut-error">{autofixError}</span>{/if}
              {#if customError}<span class="mut-error">{customError}</span>{/if}
              {#if agentRuns.length}
                <div class="agent-list">
                  {#each agentRuns as run (run.id)}
                    <a
                      class="agent-item {runHealth(run)}"
                      href="#/pr/{repo}/{number}/agents"
                      title={run.brief}
                      onclick={() => selectRun(run.id)}
                    >
                      <span class="agent-kind">{runLabel(run)}</span>
                      <span class="agent-state">{runStateLabel(run)}</span>
                      <span class="agent-time">{runTime(run)}</span>
                    </a>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
          {#if pr.autoMergeEnabled || agent?.kind === "fixer" || autoMergeMutation || githubAutoMergeEnabled || githubAutoMergeMutation}
            <div class="side-block">
              <h3 class="side-title">Auto-merge</h3>
              {#if githubAutoMergeEnabled || githubAutoMergeMutation}
                <div class="am-row">
                  <span class="badge {githubAutoMergeEnabled ? 'ready' : 'wait'}">GitHub {githubAutoMergeEnabled ? "armed" : "updating"}</span>
                  {#if pr.autoMergeRequest?.mergeMethod}<span class="am-time">{pr.autoMergeRequest.mergeMethod.toLowerCase()}</span>{/if}
                </div>
              {/if}
              {#if autoMergeMutation}
                <div class="am-mut">
                  <MutationBadge
                    state={autoMergeMutation.state}
                    onRetry={() => handleRetry(autoMergeMutation.id)}
                    onDiscard={() => handleDiscard(autoMergeMutation.id)}
                  />
                  {#if autoMergeMutation.error}<span class="mut-error">{autoMergeMutation.error}</span>{/if}
                </div>
              {/if}
              {#if pr.autoMergeEnabled || agent?.kind === "fixer"}
              <div class="am-row">
                <span class="badge {pr.autoMergeEnabled ? 'ready' : 'wait'}">bot {pr.autoMergeEnabled ? "armed" : "off"}</span>
                {#if agent?.kind === "fixer"}
                  <span class="badge {agent.state === 'running' ? 'review' : agent.state === 'killed' ? 'fail' : 'wait'}">
                    agent {agent.state}
                  </span>
                  <span class="am-time">{relativeTime(agent.started_at)}</span>
                {/if}
              </div>
              {#if agent?.kind === "fixer"}
                <div class="am-actions">
                  <button class="link" onclick={toggleAgentLog}>{showAgentLog ? "hide log" : "view log"}</button>
                  {#if agent.state === "running"}
                    <button class="link" onclick={requestKillAgent}>kill agent</button>
                  {/if}
                </div>
                {#if showAgentLog}
                  <pre class="am-log mono">{agentLog ?? "no log yet"}</pre>
                {/if}
              {:else}
                <div class="side-empty">No fixer agent</div>
              {/if}
              {/if}
            </div>
          {/if}
          {#if canReview}
            <div class="side-block">
              <h3 class="side-title">Review</h3>
              {#if verdictMutation}
                <div class="verdict-badge">
                  <MutationBadge
                    state={verdictMutation.state}
                    onRetry={() => handleRetry(verdictMutation.id)}
                    onDiscard={() => handleDiscard(verdictMutation.id)}
                  />
                </div>
              {/if}
              <div class="verdict-body-wrap">
                <textarea
                  id="verdict-control"
                  class="verdict-body"
                  placeholder="Optional body…"
                  bind:value={verdictBody}
                  onkeydown={onVerdictKeydown}
                  onfocus={() => (verdictBodyFocused = true)}
                  onblur={() => (verdictBodyFocused = false)}
                ></textarea>
                {#if tab === "conversation"}<span class="verdict-key"><Kbd keys="v" /></span>{/if}
              </div>
              <SplitButton
                tone={selectedVerdict.tone}
                open={reviewMenuOpen}
                mainDisabled={verdictSubmitting}
                caretDisabled={verdictSubmitting}
                optionsLabel="Review options"
                onMain={submitVerdict}
                onToggle={() => ((mergeMenuOpen = false), (reviewMenuOpen = !reviewMenuOpen))}
              >
                {#snippet main()}
                  <span>{verdictSubmitting ? "Submitting…" : selectedVerdict.label}</span>
                  {#if !verdictSubmitting && verdictBodyFocused}<Kbd keys={["cmd", "enter"]} />{/if}
                {/snippet}
                {#snippet menu()}
                  <div class="merge-menu review-menu" role="menu">
                    {#each VERDICT_OPTIONS as option}
                      {#if option.value !== verdictEvent}
                        <button
                          role="menuitem"
                          class:danger={option.tone === "red"}
                          onclick={() => ((verdictEvent = option.value), (reviewMenuOpen = false))}
                        >
                          {option.label}
                        </button>
                      {/if}
                    {/each}
                  </div>
                {/snippet}
              </SplitButton>
            </div>
          {/if}

          <div class="side-block">
            <h3 class="side-title">Reviewers <span class="side-key"><Kbd keys="q" /></span></h3>
            {#if reviewers.length || pendingReviewers.length}
              {#each reviewers as reviewer}
                <div class="reviewer">
                  <Avatar login={reviewer.login} url={reviewer.avatarUrl} size={16} />
                  <span class="badge {reviewTone(reviewer.state)}">{stateLabel(reviewer.state)}</span>
                  <span class="reviewer-login" title={reviewer.login}>{reviewer.login}</span>
                  {#if reviewer.login === "greptile-apps" && greptileMeta.confidence != null}
                    <span
                      class="greptile"
                      class:stale={!greptileRescore && greptileState === "stale"}
                      class:addressed={!greptileRescore && greptileState === "addressed"}
                      class:rescored={!!greptileRescore}
                      title={greptileTitle(greptileState)}
                    >
                      {greptileRescore ? greptileRescore.score : greptileMeta.confidence}/5{#if greptileRescore} · rescored{:else if greptileState} · {greptileState}{/if}
                    </span>
                  {:else if reviewer.login !== "greptile-apps" && pr.reviewerScores?.[reviewer.login]}
                    {@const rs = pr.reviewerScores[reviewer.login]}
                    {#if rs.score != null}
                      <span
                        class="greptile"
                        class:stale={rs.stale}
                        title={rs.stale ? "reviewed before recent pushes - the score may no longer reflect the current state" : (rs.basis ?? "parsed review score")}
                      >{rs.score}/5{#if rs.stale} · stale{/if}</span>
                    {:else}
                      <span class="greptile unscored" title="no quality verdict found in this review">no verdict</span>
                    {/if}
                  {/if}
                </div>
              {/each}
              {#each pendingReviewers as m}
                {#each m.payload.logins.filter((l) => !requestedByServer.has(l)) as login (login)}
                  <div class="reviewer pending-person">
                    <Avatar {login} url={avatarFor(login)} size={16} />
                    <span>{login}</span>
                    <MutationBadge state={m.state} onRetry={() => handleRetry(m.id)} onDiscard={() => handleDiscard(m.id)} />
                  </div>
                {/each}
              {/each}
            {:else}
              <div class="side-empty">None</div>
            {/if}
          </div>

          <div class="side-block">
            <h3 class="side-title">Assignees <span class="side-key"><Kbd keys="s" /></span></h3>
            {#if pr.assignees.nodes.length || pendingAssign.length}
              {#each pr.assignees.nodes as assignee}
                <div class="reviewer">
                  <Avatar login={assignee.login} url={avatarFor(assignee.login)} size={16} />
                  <span>{assignee.login}</span>
                </div>
              {/each}
              {#each pendingAssign as m}
                {#each m.payload.logins.filter((l) => !assignedByServer.has(l)) as login (login)}
                  <div class="reviewer pending-person">
                    <Avatar {login} url={avatarFor(login)} size={16} />
                    <span>{login}</span>
                    <MutationBadge state={m.state} onRetry={() => handleRetry(m.id)} onDiscard={() => handleDiscard(m.id)} />
                  </div>
                {/each}
              {/each}
            {:else}
              <div class="side-empty">None</div>
            {/if}
          </div>

          <div class="side-block">
            <h3 class="side-title">Checks <span class="dim">{checks.length}</span></h3>
            {#if checks.length}
              {#if checkSummary}
                <div class="check-summary">{checkSummary}</div>
              {/if}
              {#each checkSections as { section, rows }}
                {@const collapsible = section === "successful" && hasFailing}
                {@const collapsed = collapsible && !showSuccessful}
                {#if collapsible}
                  <button class="check-sec-head" onclick={() => (showSuccessful = !showSuccessful)}>
                    <Chevron direction={showSuccessful ? "down" : "right"} size={12} />{rows.length} {section}
                  </button>
                {:else}
                  <div class="check-sec-head static">{rows.length} {section}</div>
                {/if}
                {#if !collapsed}
                  {#each rows as check}
                    <svelte:element
                      this={check.url ? "a" : "div"}
                      href={check.url}
                      target="_blank"
                      rel="noreferrer"
                      class="check"
                    >
                      <span class="check-row">
                        <span class="check-dot {check.dot}"></span>
                        <span class="check-name">{check.name}</span>
                        {#if check.required}<span class="check-req">required</span>{/if}
                      </span>
                      {#if check.status}<span class="check-status">{check.status}</span>{/if}
                    </svelte:element>
                  {/each}
                {/if}
              {/each}
            {:else}
              <div class="side-empty">None</div>
            {/if}
          </div>
        </aside>
        </div>
      {/if}
    </div>
    </div>

    {#if pickerMode}
      <UserPicker
        title={pickerMode === "assign" ? "Assign" : "Reviewers"}
        users={repoUsers}
        current={pickerMode === "assign" ? assignedLogins : requestedLogins}
        onPick={pickerMode === "assign" ? submitAssign : submitRequestReviewer}
        onClose={() => (pickerMode = null)}
      />
    {/if}

    {#if quotaMergeModal}
      <QuotaMergeModal url={pr.url} impact={quotaStatus} onClose={() => (quotaMergeModal = false)} />
    {/if}

    {#if promptOpen}
      <div class="prompt-overlay" role="presentation" onclick={() => (promptOpen = false)}>
        <div class="prompt-box" role="dialog" aria-modal="true" aria-label={`Agent prompt for pull request #${number}`} tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
          <div class="prompt-head">
            <span class="prompt-title">Agent prompt</span>
            <span class="prompt-pr">#{number}</span>
          </div>
          <textarea
            class="prompt-input"
            bind:value={promptText}
            onkeydown={onPromptKey}
            use:focusOnMount
            disabled={promptBusy}
            placeholder="What should change?"
            spellcheck="false"
          ></textarea>
          {#if promptError}<div class="prompt-error">{promptError}</div>{/if}
          <div class="prompt-footer">
            <span class="prompt-newline"><Kbd keys={["shift", "enter"]} /> newline</span>
            <div class="prompt-actions">
              <button class="prompt-button" type="button" onclick={() => (promptOpen = false)}>Cancel <Kbd keys="esc" /></button>
              <button class="prompt-button primary" type="button" disabled={!promptText.trim() || promptBusy} onclick={submitPrompt}>
                {promptBusy ? "Launching…" : "Launch"}
                {#if !promptBusy}<Kbd keys="enter" />{/if}
              </button>
            </div>
          </div>
        </div>
      </div>
    {/if}

    {#if mergeConfirm || forceMergeConfirm}
      <MergeDecisionDialog
        {number}
        headRef={pr.headRefName}
        baseRef={pr.baseRefName}
        methodLabel={mergeMethodLabel}
        force={forceMergeConfirm}
        onConfirm={confirmMergeDecision}
        onCancel={cancelMergeDecision}
      />
    {/if}

    {#if confirmAction}
      <ConfirmDialog
        title={confirmAction.title}
        confirmLabel={confirmAction.confirmLabel}
        danger={Boolean(confirmAction.danger)}
        detail={confirmAction.message ? confirmMessage : null}
        onConfirm={runConfirmAction}
        onCancel={() => (confirmAction = null)}
      />
      {#snippet confirmMessage()}{confirmAction.message}{/snippet}
    {/if}

    {#if peopleFlash.value}
      <div class="keybar merge-flash">{peopleFlash.value}</div>
    {:else if mergeFlash.value}
      <div class="keybar merge-flash">{mergeFlash.value}</div>
    {:else if branchCopied.value}
      <div class="keybar copied-flash">Copied branch name</div>
    {:else if copied.value}
      <div class="keybar copied-flash">{copied.value}</div>
    {:else}
      <KeyBar keys={tab === "files" ? filesKeys : tab === "agents" || tab === "actions" ? tabKeys : conversationKeys} />
    {/if}

    <Telescope bind:this={telescope} {repo} headSha={pr.headRefOid} headRef={pr.headRefName} {testsHidden} changedFiles={files} onOpenChangedFile={openChangedFile} onOpenHistory={openFileHistory} bind:open={telescopeOpen} />
    <FileHistory
      {repo}
      path={historyPath}
      symbol={historySymbol}
      base={pr.baseRefName}
      baseSha={pr.baseRefOid}
      open={historyOpen}
      currentFile={historyFile}
      currentPr={{ number, title: pr.title, author: pr.author?.login ?? "ghost", date: pr.updatedAt, sha: pr.headRefOid }}
      layout={prefs.diffLayout}
      onClose={closeFileHistory}
    />
  {:else if showLoading}
    <div class="detail-frame loading-frame" class:conversation-tab={tab === "conversation"} class:files-tab={tab === "files"} aria-busy="true">
      <div class="detail loading-detail" style="--tree-width: {treeWidth}px">
        {#if loadingSummary}
          <header class="pr-head loading-head">
            <div class="pr-head-top">
              <div class="pr-title-copy">
                <span class="ui-eyebrow">Pull request #{number}</span>
                <div class="pr-title-row"><h1>{loadingSummary.title}</h1></div>
                <div class="sub loading-sub">
                  <span class="chip badge wait">{loadingSummary.isDraft ? "DRAFT" : loadingSummary.state}</span>
                </div>
              </div>
              <div class="pr-metrics loading-layout-reserve" aria-hidden="true">
                <div class="pr-metric"><span>Changed</span><strong>+0 −0</strong><em>+0 −0</em></div>
                <div class="pr-metric"><span>Files</span><strong>0</strong></div>
                <div class="pr-metric"><span>Commits</span><strong>0</strong></div>
              </div>
            </div>
            <div class="pr-head-foot">
              <div class="pr-owner">
                <Avatar login={loadingSummary.author} size={18} />
                <span>{loadingSummary.author}</span>
              </div>
              <div class="labels loading-layout-reserve" aria-hidden="true"><span class="label">label</span></div>
              <div class="ci-summary loading-layout-reserve" aria-hidden="true"><span>CI status</span></div>
            </div>
          </header>
        {/if}
        <div class="loading-status" role="status" aria-live="polite">
          <span class="loading-spinner" aria-hidden="true"></span>
          <span>Fetching live GitHub details…</span>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .page {
    height: var(--general-height);
    overflow-y: auto;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding: 0 24px 32px;
  }
  .detail-frame {
    width: 100%;
  }
  .detail-frame > .detail {
    margin-inline: auto;
  }
  .load {
    color: var(--text-dim);
    font-family: var(--sans);
    padding-top: 80px;
  }
  .detail {
    width: 100%;
    max-width: 1120px;
    padding: 32px 0 48px;
  }
  .prompt-overlay {
    position: fixed;
    inset: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--overlay-bg);
  }
  .prompt-box {
    width: min(520px, calc(var(--general-width) - 48px));
    background: var(--panel-raised);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
  }
  .prompt-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 12px;
  }
  .prompt-title {
    color: var(--text);
    font-size: 16px;
    font-weight: 650;
    letter-spacing: -0.01em;
  }
  .prompt-pr {
    color: var(--text-faint);
    font-family: var(--mono);
    font-size: 12px;
  }
  .prompt-input {
    width: 100%;
    box-sizing: border-box;
    min-height: 88px;
    resize: vertical;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-size: 13px;
    line-height: 1.5;
    padding: 10px 12px;
  }
  .prompt-input:focus {
    outline: none;
    border-color: var(--link);
    box-shadow: 0 0 0 3px var(--link-bg);
  }
  .prompt-input:disabled {
    opacity: 0.5;
  }
  .prompt-error {
    color: var(--fail);
    font-size: 12px;
    margin-top: 8px;
  }
  .prompt-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 12px;
  }
  .prompt-newline {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--text-faint);
    font-size: 11px;
  }
  .prompt-actions {
    display: flex;
    gap: 8px;
  }
  .prompt-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 32px;
    padding: 0 13px;
    border: 0;
    border-radius: 999px;
    background: var(--surface);
    box-shadow: var(--shadow-control-outlined);
    color: var(--text);
    font-family: var(--sans);
    font-size: 14px;
    font-weight: 500;
  }
  .prompt-button.primary {
    background: var(--link);
    box-shadow: var(--shadow-control-filled);
    color: var(--on-brand);
  }
  .prompt-button:disabled {
    opacity: 0.45;
  }
  .copied-flash {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    height: 38px;
    display: flex;
    align-items: center;
    padding: 0 24px;
    background: var(--overlay-bg);
    border-top: 2px solid var(--link);
    backdrop-filter: blur(8px);
    z-index: 20;
    font-size: 12.5px;
    color: var(--text);
  }
  .merge-flash {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    height: 38px;
    display: flex;
    align-items: center;
    padding: 0 24px;
    background: var(--overlay-bg);
    border-top: 2px solid var(--review);
    backdrop-filter: blur(8px);
    z-index: 20;
    font-size: 12.5px;
    color: var(--text);
  }
  .mut-error {
    color: var(--fail);
    font-size: 11.5px;
    margin-left: 6px;
  }
  .own-pr-note {
    font-size: 11.5px;
    color: var(--text-faint);
    margin-bottom: 10px;
    line-height: 1.4;
  }
  .pr-head {
    border-bottom: 1px solid var(--border);
    padding-bottom: 20px;
    margin-bottom: 24px;
  }
  h1 {
    font-size: 22px;
    font-weight: 600;
    margin: 0 0 12px;
    letter-spacing: -0.01em;
  }
  .sub {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    font-size: 12.5px;
    color: var(--text-dim);
  }
  .chip {
    text-transform: uppercase;
  }
  .sub .num {
    color: var(--text-dim);
  }
  .sub .sep {
    color: var(--meta-sep);
  }
  .branch-arrow {
    color: var(--text-faint);
  }
  .base-pr-link {
    color: inherit;
    text-decoration: none;
  }
  .base-pr-link:hover {
    text-decoration: underline;
  }
  .ci.ready {
    color: var(--ready);
  }
  .ci.fail {
    color: var(--fail);
  }
  .ci.wait {
    color: var(--text-faint);
  }
  .unres {
    color: var(--review);
  }
  .merge-btn {
    background: var(--ready-bg);
    border: 1px solid var(--ready);
    border-radius: 6px;
    color: var(--ready);
    font-family: var(--sans);
    font-size: 12px;
    padding: 3px 10px;
    cursor: pointer;
  }
  .merge-btn:hover:not(:disabled) {
    filter: brightness(1.15);
  }
  .merge-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .merge-btn.fail {
    background: var(--fail-bg);
    border-color: var(--fail);
    color: var(--fail);
  }
  .merge-btn.blocked {
    background: var(--wait-bg);
    border-color: var(--fail);
    color: var(--fail);
  }
  .actions {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .actions .merge-btn {
    width: 100%;
    padding: 6px 12px;
  }
  .merge-menu {
    position: absolute;
    top: calc(100% + 4px);
    right: 0;
    z-index: 20;
    min-width: 220px;
    padding: 6px;
    border: 1px solid var(--border-soft);
    border-radius: var(--radius-md);
    background: var(--panel);
    box-shadow: var(--shadow-dialog);
  }
  .merge-menu button {
    display: flex;
    align-items: center;
    width: 100%;
    justify-content: space-between;
    gap: 10px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text);
    font: inherit;
    padding: 8px 9px;
    cursor: pointer;
    text-align: left;
  }
  .merge-menu button:hover,
  .merge-menu button.active {
    background: var(--surface);
  }
  .merge-menu-label {
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .menu-check {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .merge-menu-separator {
    height: 1px;
    margin: 4px;
    background: var(--border);
  }
  .merge-menu button.danger {
    color: var(--fail);
  }
  .action-note {
    color: var(--text-dim);
    font-size: 11.5px;
  }
  .labels {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 12px;
  }
  .label {
    font-size: 11px;
    color: var(--text-dim);
    background: var(--panel-raised);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 1px 9px;
  }
  .since-banner {
    display: block;
    width: 100%;
    text-align: left;
    background: var(--link-bg);
    border: 1px solid var(--link);
    border-radius: 8px;
    color: var(--link);
    font-size: 12.5px;
    padding: 8px 14px;
    margin-bottom: 20px;
    cursor: pointer;
  }
  .since-banner:hover {
    background: var(--link-bg-hover);
  }
  .since-banner.rewritten {
    background: var(--panel-raised);
    border-color: var(--border);
    color: var(--text-dim);
  }
  .since-banner.rewritten:hover {
    border-color: var(--text-faint);
    color: var(--text);
  }
  .since-banner.note {
    cursor: default;
  }
  .since-banner.note:hover {
    border-color: var(--border);
    color: var(--text-dim);
  }
  .churn-note {
    font-size: 11.5px;
    color: var(--text-faint);
    padding: 6px 2px 10px;
  }
  .tabs {
    display: flex;
    gap: 4px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 24px;
  }
  .tab {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12.5px;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    color: var(--text-faint);
    text-decoration: none;
    padding: 8px 14px;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .tab:hover {
    color: var(--text-dim);
  }
  .tab.active {
    color: var(--text);
    border-bottom-color: var(--review);
  }
  .tab-count {
    color: var(--text-faint);
    margin-left: 2px;
  }
  .files-layout {
    display: grid;
    grid-template-columns: minmax(160px, min(var(--tree-width), 35%)) 6px minmax(0, 1fr);
    min-width: 0;
    gap: 0;
    align-items: start;
  }
  .tree-pane {
    grid-column: 1;
    grid-row: 2;
    position: sticky;
    top: 24px;
    align-self: start;
    min-width: 0;
    max-width: 100%;
    max-height: calc(var(--general-height) - 140px);
    overflow-y: auto;
    overflow-x: hidden;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--panel);
    padding: 8px;
  }
  .tree-resizer {
    grid-column: 2;
    grid-row: 2;
    align-self: stretch;
    min-width: 6px;
    width: 6px;
    cursor: col-resize;
  }
  .tree-resizer:hover {
    background: var(--panel-raised);
  }
  .diff-pane {
    grid-column: 3;
    grid-row: 2;
    min-width: 0;
    max-width: 100%;
    padding-left: 12px;
  }
  .agents-layout {
    display: grid;
    grid-template-columns: minmax(0, min(280px, 45%)) minmax(0, 1fr);
    gap: 20px;
    align-items: start;
  }
  .runs-pane {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .run-row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    text-align: left;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel);
    cursor: pointer;
  }
  .run-row.active {
    border-color: var(--text-dim);
  }
  .run-row-top {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
  }
  .run-time {
    color: var(--text-faint);
    font-size: 11px;
  }
  .run-brief {
    width: 100%;
    min-width: 0;
    font-size: 11px;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .run-detail {
    min-width: 0;
  }
  .run-detail-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin-bottom: 10px;
  }
  .run-exit {
    font-size: 11px;
    color: var(--text-faint);
  }
  .run-detail-brief {
    font-size: 12px;
    color: var(--text);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    margin-bottom: 12px;
  }
  .run-turns {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .turn {
    font-size: 12px;
    padding: 6px 8px;
    border-radius: 6px;
    min-width: 0;
  }
  .turn-text {
    color: var(--text);
    background: var(--panel);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .turn-line {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .turn-tool {
    display: block;
    width: calc(100% - 14px);
    color: var(--text-dim);
    background: var(--panel-raised);
    border: 1px solid var(--border);
    font-size: 11px;
    margin-left: 14px;
  }
  .turn-toggle {
    display: block;
    width: 100%;
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .turn-tool-input {
    margin: 6px 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 11px;
    color: var(--text);
    user-select: text;
  }
  .turn-tool-arg {
    margin-top: 4px;
    font-size: 11px;
    color: var(--text-faint);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }
  .turn-result {
    display: block;
    width: calc(100% - 14px);
    color: var(--text-dim);
    background: var(--panel);
    font-size: 11px;
    margin-left: 14px;
  }
  .turn-result.err {
    color: var(--fail);
  }
  .turn-result-full {
    margin: 6px 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }
  .files-toolbar {
    grid-column: 3;
    grid-row: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 0 0 14px 12px;
  }
  .toolbar-left {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }
  .diff-status {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 20px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel);
    color: var(--text-dim);
    font-size: 12.5px;
  }
  .retry-btn {
    background: var(--panel-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-family: var(--sans);
    font-size: 12px;
    padding: 4px 12px;
    cursor: pointer;
  }
  .retry-btn:hover {
    border-color: var(--text-faint);
  }
  .toolbar-btn {
    background: var(--panel-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-dim);
    font-family: var(--sans);
    font-size: 12px;
    padding: 4px 10px;
    cursor: pointer;
  }
  .toolbar-btn:hover {
    color: var(--text);
    border-color: var(--text-faint);
  }
  .cols {
    display: grid;
    grid-template-columns: minmax(0, 816px) 260px;
    gap: 28px;
    align-items: start;
  }
  .left {
    min-width: 0;
  }
  .card {
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--panel);
    padding: 16px 18px;
    margin-bottom: 28px;
  }
  .body-card {
    position: relative;
  }
  .body-mut {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
  }
  .body-card .body-edit {
    float: right;
    min-height: 28px;
    margin: -4px -4px 4px 10px;
    padding: 0 8px;
    border: 0;
    border-radius: 6px;
    background: var(--surface);
    color: var(--text-dim);
    font-family: var(--sans);
    font-size: 11px;
    text-decoration: none;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.12s ease;
  }
  .body-card:hover .body-edit,
  .body-edit:focus-visible {
    opacity: 1;
  }
  .body-editor .link {
    padding: 0;
    border: none;
    background: none;
    color: var(--text-dim);
    font-family: var(--sans);
    font-size: 11px;
    text-decoration: underline;
    cursor: pointer;
  }
  .body-card .body-edit:hover:not(:disabled) {
    background: var(--surface-hover);
    color: var(--text);
  }
  .body-editor .link:hover {
    color: var(--text);
  }
  .card .body-editor {
    margin-top: 0;
    flex-direction: column;
    gap: 0;
  }
  .card .body-editor textarea {
    flex: none;
    min-height: 160px;
  }
  .body-editor-actions {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
  }
  .body-editor-hint {
    color: var(--text-faint);
    font-size: 11px;
    margin-right: auto;
  }
  .body-editor-dot {
    color: var(--text-faint);
    font-size: 11px;
  }
  .body-editor .link:disabled {
    opacity: 0.4;
    cursor: default;
    text-decoration: none;
  }
  .block {
    margin-bottom: 30px;
  }
  .block-title {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-dim);
    margin: 0 0 14px;
  }
  .side-title .dim {
    color: var(--text-faint);
    font-weight: 400;
    margin-left: 4px;
  }
  .event {
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--panel);
    margin-bottom: 12px;
    overflow: hidden;
  }
  .event-head {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
    padding: 7px 14px;
    background: var(--panel-raised);
    border-bottom: 1px solid var(--border);
  }
  .event-body {
    padding: 12px 14px;
  }
  .commit-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 3px 14px;
    margin-bottom: 4px;
    font-size: 12px;
    color: var(--text-dim);
    background: none;
    border: none;
    text-align: left;
    cursor: default;
  }
  .commit-row-main {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 0;
    padding: 0;
    color: inherit;
    font: inherit;
    background: none;
    border: 0;
    text-align: left;
    cursor: default;
  }
  .commit-row.clickable {
    cursor: pointer;
    border-radius: 6px;
  }
  .commit-row.clickable .commit-row-main {
    cursor: pointer;
  }
  .commit-row.clickable:hover {
    background: var(--hunk-hover);
  }
  .commit-glyph {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    border: 2px solid var(--text-faint);
    background: var(--panel);
  }
  .commit-headline {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
  }
  .commit-lines {
    flex: none;
    display: flex;
    gap: 6px;
    justify-content: flex-end;
    min-width: 92px;
    font-family: var(--mono);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .commit-lines .add {
    color: var(--ready);
  }
  .commit-lines .del {
    color: var(--fail);
  }
  .commit-lines.tests-only .add,
  .commit-lines.tests-only .del {
    color: var(--text-faint);
  }
  .commit-ci {
    display: inline-flex;
    flex: none;
    width: 15px;
    height: 15px;
  }
  .commit-ci svg {
    width: 100%;
    height: 100%;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .commit-ci.pass {
    color: var(--ready);
  }
  .commit-ci.fail {
    color: var(--fail);
  }
  .commit-ci.running {
    color: var(--review);
  }
  .commit-ci.neutral {
    color: var(--text-faint);
  }
  .commit-ci-dot {
    width: 8px;
    height: 8px;
    margin: auto;
    border-radius: 50%;
    background: currentColor;
  }
  .commit-ci:hover {
    filter: brightness(1.15);
  }
  .commit-row .when {
    flex: none;
    min-width: 30px;
    padding: 0;
    color: var(--text-faint);
    font: inherit;
    font-size: 11px;
    text-align: right;
    background: none;
    border: 0;
    opacity: 1;
  }
  .commit-row.clickable .commit-when {
    cursor: pointer;
  }
  .event-head .author {
    color: var(--text);
    font-weight: 600;
  }
  .event-head .when {
    color: var(--text-faint);
  }
  .composer {
    display: flex;
    gap: 10px;
    margin-top: 20px;
  }
  .composer.composer-top {
    margin-top: 0;
    margin-bottom: 20px;
  }
  .composer textarea {
    flex: 1;
    min-width: 0;
    resize: vertical;
    height: 36px;
    min-height: 36px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    font-size: 13px;
    padding: 7px 12px;
  }
  .composer textarea::-webkit-resizer {
    opacity: 0;
  }
  .composer textarea:focus {
    outline: none;
    border-color: var(--text-faint);
  }
  .btn {
    flex: none;
    align-self: flex-end;
    background: var(--panel-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-size: 12.5px;
    padding: 8px 16px;
    cursor: pointer;
  }
  .btn:hover:not(:disabled) {
    border-color: var(--text-faint);
  }
  .btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .btn.wide {
    align-self: stretch;
    width: 100%;
  }
  .right {
    position: sticky;
    top: 32px;
    display: flex;
    flex-direction: column;
    gap: 24px;
  }
  .side-block {
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--panel);
    padding: 14px;
  }
  .side-title {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-dim);
    margin: 0 0 12px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .side-key {
    margin-left: auto;
    display: inline-flex;
  }
  .agent-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 8px;
  }
  .agent-item {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 4px 8px;
    border: 1px solid var(--border);
    border-left: 3px solid var(--wait);
    border-radius: 6px;
    background: var(--panel-raised);
    font-size: 11px;
    color: var(--text-dim);
    text-decoration: none;
  }
  .agent-item:hover {
    background: var(--panel);
  }
  .agent-item.running {
    border-left-color: var(--review);
  }
  .agent-item.succeeded {
    border-left-color: var(--ready);
  }
  .agent-item.failed {
    border-left-color: var(--fail);
  }
  .agent-kind {
    flex: none;
    font-weight: 600;
    color: var(--text);
  }
  .agent-state {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent-item.running .agent-state {
    color: var(--review);
  }
  .agent-item.succeeded .agent-state {
    color: var(--ready);
  }
  .agent-item.failed .agent-state {
    color: var(--fail);
  }
  .agent-time {
    flex: none;
    margin-left: auto;
    color: var(--text-faint);
  }
  .reviewer {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
    color: var(--text-dim);
    padding: 3px 0;
    min-width: 0;
  }
  .reviewer.pending-person {
    opacity: 0.7;
  }
  .reviewer-login {
    min-width: 0;
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .greptile {
    flex: none;
    margin-left: auto;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-dim);
    background: var(--panel-raised);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1px 6px;
  }
  .greptile.stale {
    color: var(--text-faint);
    opacity: 0.6;
  }
  .greptile.addressed {
    color: var(--ready);
    border-color: var(--ready);
    opacity: 0.85;
  }
  .greptile.rescored {
    color: var(--ready);
    border-color: var(--ready);
    font-weight: 600;
  }
  .greptile.unscored {
    color: var(--text-faint);
    opacity: 0.6;
  }
  .check-summary {
    font-size: 11.5px;
    color: var(--text-dim);
    line-height: 1.5;
    margin-bottom: 8px;
  }
  .check-sec-head {
    display: flex;
    align-items: center;
    gap: 5px;
    width: 100%;
    font-family: var(--sans);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
    background: none;
    border: none;
    text-align: left;
    padding: 8px 0 3px;
    cursor: pointer;
  }
  .check-sec-head.static {
    cursor: default;
  }
  button.check-sec-head:hover {
    color: var(--text-dim);
  }
  .check {
    display: flex;
    flex-direction: column;
    gap: 1px;
    font-size: 12px;
    color: var(--text-dim);
    padding: 3px 0;
    text-decoration: none;
  }
  .check-row {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  a.check:hover .check-name {
    color: var(--text);
    text-decoration: underline;
  }
  .check-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .check-req {
    flex: none;
    font-size: 9px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--review);
    background: var(--review-bg);
    border-radius: 3px;
    padding: 0 4px;
  }
  .check-status {
    margin-left: 15px;
    font-size: 11px;
    color: var(--text-faint);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .check-dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--wait);
  }
  .check-dot.ok {
    background: var(--ready);
  }
  .check-dot.bad {
    background: var(--fail);
  }
  .check-dot.run {
    background: var(--review);
  }
  .side-empty {
    color: var(--text-faint);
    font-size: 12px;
  }
  .am-mut {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 10px;
    font-size: 12px;
  }
  .am-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px;
    font-size: 12px;
  }
  .am-time {
    color: var(--text-faint);
  }
  .am-actions {
    display: flex;
    gap: 12px;
    margin-top: 10px;
  }
  .am-actions .link {
    background: none;
    border: none;
    color: var(--text-dim);
    font-family: var(--sans);
    font-size: 11px;
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
  }
  .am-actions .link:hover {
    color: var(--text);
  }
  .am-log {
    margin: 10px 0 0;
    padding: 8px;
    max-height: 220px;
    overflow: auto;
    background: var(--panel-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 11px;
    line-height: 1.5;
    color: var(--text-dim);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .verdict-badge {
    margin-bottom: 8px;
    font-family: var(--sans);
    font-size: 11px;
  }

  /* Shared detail primitives: one strong header surface, then calm working space. */
  .page {
    height: 100%;
    overflow-y: auto;
    padding: 0 32px 88px;
  }
  .detail {
    max-width: 1320px;
    padding: 24px 0 64px;
  }
  .load {
    padding-top: 104px;
  }
  .loading-detail {
    width: 100%;
  }
  .loading-head {
    min-height: 0;
  }
  .loading-sub {
    min-height: 28px;
  }
  .loading-layout-reserve {
    visibility: hidden;
    pointer-events: none;
  }
  .loading-status {
    display: flex;
    min-height: 96px;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: var(--text-dim);
    font-size: 12px;
  }
  .loading-spinner {
    width: 14px;
    height: 14px;
    flex: none;
    border: 2px solid var(--border);
    border-top-color: var(--link);
    border-radius: 50%;
    animation: loading-spin 700ms linear infinite;
  }
  @keyframes loading-spin {
    to { transform: rotate(360deg); }
  }
  @media (prefers-reduced-motion: reduce) {
    .loading-spinner {
      animation: none;
    }
  }
  .pr-head {
    padding: 22px;
    margin-bottom: 20px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 14px;
    box-shadow: var(--shadow-xs);
  }
  .pr-head-top {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    gap: 24px;
  }
  .pr-title-copy {
    min-width: 0;
  }
  .pr-title-copy .ui-eyebrow {
    margin-bottom: 5px;
  }
  h1 {
    font-family: var(--sans);
    font-size: 28px;
    font-weight: 650;
    line-height: 1.15;
    letter-spacing: -0.037em;
    margin-bottom: 12px;
  }
  .pr-title-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    min-width: 0;
  }
  .pr-title-row h1 {
    min-width: 0;
  }
  .title-rename,
  .title-editor-action {
    flex: 0 0 auto;
    display: inline-grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--text-faint);
  }
  .title-rename {
    margin-top: 1px;
    opacity: 0;
  }
  .title-rename svg,
  .title-editor-action svg {
    width: 15px;
    height: 15px;
  }
  .pr-title-row:hover .title-rename,
  .title-rename:focus-visible {
    opacity: 1;
  }
  .title-rename:hover,
  .title-editor-action:hover {
    background: var(--surface);
    color: var(--text);
  }
  .pr-title-editor {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: -4px 0 8px;
  }
  .pr-title-input {
    min-width: 0;
    flex: 1 1 auto;
    height: 38px;
    box-sizing: border-box;
    padding: 5px 9px;
    border: 1px solid var(--link);
    border-radius: 8px;
    background: var(--bg);
    color: var(--text);
    font-family: var(--sans);
    font-size: 22px;
    font-weight: 650;
    line-height: 1.15;
    letter-spacing: -0.025em;
  }
  .pr-title-input:focus {
    outline: 2px solid color-mix(in srgb, var(--link) 24%, transparent);
    outline-offset: 1px;
  }
  .title-save {
    color: var(--ready);
  }
  .title-mutation {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 28px;
  }
  .sub {
    font-size: 12px;
    column-gap: 8px;
    row-gap: 12px;
  }
  .branch-context {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    max-width: 100%;
    min-height: 28px;
    padding: 0;
    overflow: visible;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--text-dim);
  }
  .branch-target,
  .branch-source {
    min-width: 0;
    padding: 0;
  }
  .branch-target {
    flex: 0 0 auto;
    max-width: 20ch;
    color: var(--text-dim);
    font-weight: 500;
  }
  .branch-source {
    flex: 0 1 auto;
    max-width: 32ch;
  }
  .branch-name {
    min-width: 0;
    overflow: hidden;
    color: var(--text);
    font-size: 11px;
    font-weight: 600;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .branch-arrow {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: auto;
    padding: 0 2px;
    color: var(--text-faint);
  }
  .branch-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-dim);
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease, transform 120ms ease;
  }
  .branch-action svg {
    width: 15px;
    height: 15px;
  }
  .branch-copy {
    margin-left: 2px;
  }
  .branch-switch:disabled {
    color: var(--text-faint);
    cursor: default;
  }
  @media (hover: hover) and (pointer: fine) {
    .branch-action:hover:not(:disabled) {
      background: color-mix(in srgb, var(--text) 6%, transparent);
      color: var(--text);
    }
  }
  .branch-action:active:not(:disabled) {
    transform: scale(0.99);
  }
  .pr-metrics {
    display: grid;
    grid-template-columns: repeat(3, minmax(72px, auto));
    gap: 7px;
  }
  .pr-metric {
    min-width: 76px;
    padding: 9px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--panel) 84%, transparent);
  }
  .pr-metric span {
    display: block;
    margin-bottom: 4px;
    color: var(--text-faint);
    font-size: 10px;
    line-height: 1;
  }
  .pr-metric strong {
    display: block;
    color: var(--text);
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
    line-height: 1.1;
    white-space: nowrap;
  }
  .pr-metric em {
    display: block;
    margin-top: 2px;
    color: var(--text-faint);
    font-family: var(--mono);
    font-size: 10px;
    font-style: normal;
    line-height: 1.2;
    white-space: nowrap;
  }
  .pr-metric b {
    font-weight: inherit;
  }
  .pr-metric .add { color: var(--ready); }
  .pr-metric .del { color: var(--fail); }
  .pr-head-foot {
    display: flex;
    align-items: center;
    min-height: 28px;
    gap: 12px;
    margin-top: 16px;
    padding-top: 12px;
    border-top: 1px solid var(--border-soft);
  }
  .ci-summary {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 28px;
    margin-left: auto;
    padding: 0 10px 0 7px;
    border: 0;
    border-radius: 999px;
    background: var(--surface);
    color: var(--text-dim);
    box-shadow: var(--shadow-control-hairline);
    font-size: 12px;
    white-space: nowrap;
  }
  .ci-summary-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 16px;
    height: 16px;
    color: var(--text-faint);
  }
  .ci-summary.ready .ci-summary-icon {
    color: var(--ready);
  }
  .ci-summary.fail .ci-summary-icon {
    color: var(--native-red);
  }
  .ci-summary-icon svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .ci-summary-icon .status-success circle {
    fill: currentColor;
    stroke: none;
  }
  .ci-summary-icon .status-success path {
    stroke: var(--native-on-accent);
    stroke-width: 1.4;
  }
  .ci-summary-label {
    color: var(--text);
    font-size: 12px;
    font-weight: 400;
  }
  .ci-summary-detail {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    color: var(--text-faint);
    font-size: 10.5px;
  }
  .ci-summary-detail::before {
    width: 2px;
    height: 2px;
    border-radius: 50%;
    background: currentColor;
    content: "";
  }
  .ci-failure-alert {
    margin-top: 12px;
    border: 0;
    border-radius: var(--radius-lg);
    background: var(--panel);
    box-shadow: var(--shadow-surface);
    overflow: hidden;
  }
  .ci-failure-head {
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: 46px;
    padding: 8px 12px;
  }
  .ci-failure-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--fail-bg);
    color: color-mix(in srgb, var(--fail) 78%, var(--text-dim));
    box-shadow: none;
  }
  .ci-failure-icon svg,
  .conflict-alert-icon svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .ci-failure-copy {
    display: flex;
    align-items: baseline;
    flex: 1 1 auto;
    min-width: 0;
    gap: 7px;
  }
  .ci-failure-copy strong {
    flex: none;
    color: var(--text);
    font-size: 12.5px;
    font-weight: 650;
  }
  .ci-failure-copy span {
    color: var(--text-dim);
    font-size: 10.5px;
  }
  .attention-title {
    display: flex;
    align-items: center;
    flex: none;
    min-width: 0;
    gap: 6px;
  }
  .attention-title .attention-chip,
  .ci-failure-check .attention-chip {
    flex: none;
    padding: 2px 6px;
    border-radius: 999px;
    font-size: 9px;
    font-weight: 400;
    letter-spacing: 0;
    line-height: 1.25;
    text-transform: none;
  }
  .ci-failure-copy .attention-label,
  .conflict-alert-copy .attention-label {
    background: var(--fail-bg);
    color: var(--fail);
  }
  .ci-copy-button,
  .conflict-copy-button {
    flex: none;
    min-width: 112px;
    min-height: 28px;
    padding: 0 10px;
    border: 0;
    border-radius: 7px;
    background: var(--surface);
    color: var(--text-dim);
    font-family: var(--sans);
    font-size: 11px;
    font-weight: 650;
    text-align: center;
    cursor: pointer;
    transition: transform 120ms var(--ease-out), background 120ms ease;
  }
  @media (hover: hover) and (pointer: fine) {
    .ci-copy-button:hover,
    .conflict-copy-button:hover {
      background: var(--surface-hover);
      color: var(--text);
    }
  }
  .ci-copy-button:active,
  .conflict-copy-button:active {
    transform: scale(0.99);
  }
  .ci-failure-actions {
    display: flex;
    flex: none;
    gap: 6px;
  }
  .ci-agent-button {
    min-height: 28px;
    padding: 0 10px;
    border: 0;
    border-radius: 7px;
    background: var(--native-accent);
    color: var(--on-brand);
    font-family: var(--sans);
    font-size: 11px;
    font-weight: 650;
    cursor: pointer;
    box-shadow: var(--shadow-control-filled);
    transition: transform 120ms var(--ease-out), background-color 120ms ease;
  }
  @media (hover: hover) and (pointer: fine) {
    .ci-agent-button:hover:not(:disabled) {
      background: var(--brand-hover);
    }
  }
  .ci-agent-button:active:not(:disabled) {
    transform: scale(0.99);
  }
  .ci-agent-button:disabled {
    cursor: default;
    opacity: 0.58;
  }
  .ci-failure-list {
    display: flex;
    flex-direction: column;
    list-style: none;
    margin: 0;
    padding: 0 12px 9px 43px;
  }
  .ci-failure-list li {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: 10px;
    min-height: 27px;
    border-top: 1px solid var(--border-soft);
    font-size: 10px;
  }
  .ci-failure-check {
    display: flex;
    align-items: center;
    flex: 1 1 auto;
    min-width: 0;
    gap: 6px;
    color: var(--text-faint);
  }
  .ci-failure-check strong {
    min-width: 0;
    overflow: hidden;
    color: var(--text);
    font-size: 11px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ci-required {
    background: var(--review-bg);
    color: var(--review);
  }
  .ci-failure-list a,
  .ci-location {
    flex: none;
    color: var(--link);
    font-size: 10px;
    text-decoration: none;
  }
  .ci-failure-list a:hover {
    text-decoration: underline;
  }
  .ci-failure-error {
    padding: 0 12px 9px 43px;
    color: var(--fail);
    font-size: 10px;
  }
  .conflict-alert {
    margin-top: 12px;
    border: 0;
    border-radius: var(--radius-lg);
    background: var(--panel);
    box-shadow: var(--shadow-surface);
    overflow: hidden;
  }
  .conflict-alert-main {
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: 46px;
    padding: 8px 12px;
  }
  .conflict-alert-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    background: var(--fail-bg);
    color: color-mix(in srgb, var(--fail) 78%, var(--text-dim));
    box-shadow: none;
  }
  .conflict-alert-copy {
    display: flex;
    align-items: baseline;
    flex: 1 1 auto;
    min-width: 0;
    gap: 7px;
  }
  .conflict-alert-copy strong {
    flex: none;
    color: var(--text);
    font-size: 12.5px;
    font-weight: 650;
  }
  .conflict-alert-copy span {
    min-width: 0;
    color: var(--text-dim);
    font-size: 10.5px;
  }
  .conflict-actions {
    display: flex;
    flex: none;
    gap: 6px;
  }
  .conflict-primary {
    flex: none;
    min-height: 28px;
    padding: 0 11px;
    border: 0;
    border-radius: 7px;
    background: var(--native-accent);
    color: var(--on-brand);
    font-family: var(--sans);
    font-size: 11px;
    font-weight: 650;
    cursor: pointer;
    box-shadow: var(--shadow-control-filled);
    transition: transform 120ms var(--ease-out), background-color 120ms ease;
  }
  @media (hover: hover) and (pointer: fine) {
    .conflict-primary:hover:not(:disabled) {
      background: var(--brand-hover);
    }
  }
  .conflict-primary:active:not(:disabled) {
    transform: scale(0.99);
  }
  .conflict-primary:disabled {
    opacity: 0.58;
    cursor: default;
  }
  .conflict-file-list {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    max-height: 74px;
    overflow-y: auto;
    list-style: none;
    margin: 0;
    padding: 0 12px 9px 43px;
  }
  .conflict-file-list li {
    max-width: 100%;
    padding: 2px 6px;
    border: 1px solid var(--border-soft);
    border-radius: 5px;
    background: color-mix(in srgb, var(--panel) 82%, transparent);
    color: var(--text-dim);
    font-size: 9.5px;
    line-height: 1.2;
    overflow-wrap: anywhere;
  }
  .conflict-alert-note,
  .conflict-alert-error {
    margin: 0;
    padding: 0 12px 10px 43px;
    color: var(--text-dim);
    font-size: 9.5px;
    line-height: 1.4;
  }
  .conflict-alert-error {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--fail);
  }
  .pr-owner {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    flex: none;
    color: var(--text-dim);
    font-size: 11px;
  }
  .label {
    padding: 3px 9px;
    border-radius: 999px;
    background: var(--surface);
  }
  .labels {
    margin-top: 0;
  }
  .merge-btn {
    min-height: 28px;
    padding: 4px 11px;
    background: var(--ready);
    border-color: var(--ready);
    border-radius: 7px;
    color: var(--on-ready);
    font-family: var(--sans);
    font-weight: 600;
    box-shadow: 0 1px 1px color-mix(in srgb, var(--ready) 22%, transparent);
  }
  .merge-btn.fail {
    background: var(--fail-bg);
    border-color: color-mix(in srgb, var(--fail) 45%, var(--border));
    color: var(--fail);
    box-shadow: none;
  }
  .merge-btn.blocked {
    background: var(--fail-bg);
    border-color: var(--fail);
    color: var(--fail);
    box-shadow: none;
  }
  .since-banner {
    min-height: 40px;
    padding: 9px 14px;
    border-color: transparent;
    border-radius: 10px;
    color: var(--link);
    background: var(--link-bg);
  }
  .tabs {
    display: inline-flex;
    width: fit-content;
    gap: 2px;
    padding: 3px;
    margin: 0 0 26px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
  }
  .tab {
    display: inline-flex;
    align-items: center;
    min-height: 28px;
    margin: 0;
    padding: 0 10px;
    border: 1px solid transparent;
    border-radius: 7px;
    color: var(--text-dim);
    font-family: var(--sans);
    font-size: 12px;
    font-weight: 500;
    letter-spacing: -0.005em;
    text-transform: none;
  }
  @media (hover: hover) and (pointer: fine) {
    .tab:hover {
      color: var(--text);
      background: var(--panel);
    }
  }
  .tab.active {
    color: var(--text);
    background: var(--panel);
    border-color: var(--border);
    border-bottom-color: var(--border);
    box-shadow: var(--shadow-xs);
  }
  .cols {
    grid-template-columns: minmax(0, 1fr) minmax(248px, 278px);
    gap: 26px;
  }
  .right {
    top: 28px;
    gap: 16px;
  }
  .card,
  .side-block,
  .event,
  .run-row,
  .diff-status {
    background: var(--panel);
    border-radius: 12px;
    box-shadow: var(--shadow-xs);
  }
  .card {
    padding: 18px 20px;
    margin-bottom: 24px;
  }
  .side-block {
    padding: 16px;
  }
  .event {
    border-radius: 10px;
    margin-bottom: 10px;
  }
  .event-head {
    padding: 9px 14px;
    background: var(--surface);
  }
  .block {
    margin-bottom: 26px;
  }
  .block-title,
  .side-title {
    font-family: var(--sans);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.01em;
    text-transform: none;
    color: var(--text-dim);
  }
  .composer textarea,
  .prompt-input,
  .verdict-body {
    background: var(--panel);
    border-color: var(--border);
    border-radius: 8px;
  }
  .composer textarea:focus,
  .prompt-input:focus,
  .verdict-body:focus,
  .verdict-select:focus {
    border-color: var(--link);
    box-shadow: 0 0 0 3px var(--focus-ring);
  }
  .btn,
  .retry-btn,
  .toolbar-btn,
  .cbtn,
  .resolve-btn {
    min-height: 28px;
    background: var(--panel);
    border-color: var(--border);
    border-radius: 7px;
    color: var(--text);
    box-shadow: var(--shadow-xs);
  }
  @media (hover: hover) and (pointer: fine) {
    .btn:hover:not(:disabled),
    .retry-btn:hover,
    .toolbar-btn:hover,
    .cbtn:hover:not(:disabled),
    .resolve-btn:hover:not(:disabled) {
      background: var(--surface);
      border-color: var(--border-hover);
    }
  }
  .tree-pane {
    background: var(--surface);
    border-radius: 12px;
  }
  .prompt-overlay {
    background: color-mix(in srgb, var(--text) 20%, transparent);
    backdrop-filter: blur(4px);
  }
  .prompt-box {
    background: var(--panel);
    border-radius: 14px;
    box-shadow: var(--shadow-dialog);
  }
  .copied-flash,
  .merge-flash {
    left: var(--app-rail-width, 0px);
    height: 44px;
    padding-inline: max(
      var(--app-content-gutter, 24px),
      calc((100% - var(--app-content-max-width, 1320px)) / 2)
    );
    background: var(--overlay-bg);
    border-top: 1px solid var(--border);
    backdrop-filter: blur(18px) saturate(160%);
  }
  .detail-frame.files-tab > .detail {
    max-width: none;
    --files-content-left: calc(max(160px, min(var(--tree-width), 35%)) + 18px);
  }
  .detail-frame.files-tab .pr-head,
  .detail-frame.files-tab .since-banner {
    width: calc(100% - var(--files-content-left));
    margin-left: var(--files-content-left);
  }
  .detail-frame.files-tab .tabs {
    margin-left: var(--files-content-left);
  }
  @media (max-width: 940px) {
    .detail-frame.files-tab > .detail {
      --files-content-left: 0px;
    }
    .files-layout {
      grid-template-columns: minmax(0, 1fr);
      gap: 12px;
    }
    .files-toolbar,
    .tree-pane,
    .diff-pane {
      grid-column: 1;
      grid-row: auto;
    }
    .files-toolbar {
      margin-left: 0;
    }
    .tree-pane {
      position: static;
      max-height: 220px;
    }
    .tree-resizer {
      display: none;
    }
    .diff-pane {
      padding-left: 0;
    }
  }
  @media (max-width: 940px) {
    .page {
      padding-inline: 22px;
    }
    .pr-head-top {
      grid-template-columns: 1fr;
    }
    .pr-metrics {
      grid-template-columns: repeat(3, minmax(0, 1fr));
      width: 100%;
    }
    .cols {
      grid-template-columns: 1fr;
    }
    .right {
      position: static;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 660px) {
    .page {
      padding-inline: 14px;
    }
    .detail {
      padding-top: 16px;
    }
    .pr-head {
      padding: 18px;
    }
    h1 {
      font-size: 24px;
    }
    .pr-head-foot {
      align-items: flex-start;
      flex-direction: column;
    }
    .branch-context {
      width: 100%;
    }
    .branch-source {
      flex: 1 1 auto;
    }
    .branch-name {
      max-width: none;
    }
    .branch-switch {
      flex: none;
    }
    .ci-summary {
      margin-left: 0;
    }
    .ci-summary-detail {
      display: none;
    }
    .ci-failure-head {
      display: grid;
      grid-template-columns: 22px minmax(0, 1fr);
      align-items: flex-start;
      column-gap: 9px;
      row-gap: 7px;
      padding: 9px 10px;
    }
    .ci-failure-copy {
      align-items: flex-start;
      flex-direction: column;
      grid-column: 2;
      gap: 1px;
    }
    .ci-failure-actions {
      grid-column: 2;
      width: 100%;
      margin-left: 0;
    }
    .ci-copy-button,
    .ci-agent-button {
      flex: 1 1 0;
    }
    .ci-failure-list {
      padding: 0 10px 8px 39px;
    }
    .ci-failure-error {
      padding: 0 10px 8px 39px;
    }
    .ci-failure-list li {
      align-items: flex-start;
      flex-direction: column;
      gap: 2px;
      padding: 6px 0;
    }
    .ci-failure-check {
      width: 100%;
    }
    .conflict-alert-main {
      display: grid;
      grid-template-columns: 22px minmax(0, 1fr);
      align-items: flex-start;
      column-gap: 9px;
      row-gap: 7px;
      padding: 9px 10px;
    }
    .conflict-alert-copy {
      align-items: flex-start;
      flex-direction: column;
      grid-column: 2;
      gap: 1px;
    }
    .conflict-actions {
      grid-column: 2;
      width: 100%;
      margin-left: 0;
    }
    .conflict-copy-button,
    .conflict-primary {
      flex: 1 1 0;
    }
    .conflict-file-list,
    .conflict-alert-note,
    .conflict-alert-error {
      margin-left: 0;
      padding-right: 10px;
      padding-left: 39px;
    }
    .right {
      grid-template-columns: 1fr;
    }
  }

  /* Scape Desktop visual language: the PR is the surface, not a stack of cards. */
  .page {
    padding: 0 32px 88px;
  }
  .detail {
    padding-top: 18px;
  }
  .pr-head {
    padding: 10px 0 22px;
    margin-bottom: 14px;
    border: 0;
    border-bottom: 1px solid var(--border-soft);
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }
  .pr-head-top {
    gap: 32px;
  }
  h1,
  .pr-title-row h1 {
    margin-bottom: 10px;
    font-size: 24px;
    font-weight: 500;
    line-height: 30px;
    letter-spacing: -0.025em;
  }
  .sub {
    font-family: var(--sans);
    font-size: 12px;
    line-height: 16px;
  }
  .branch-name {
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 500;
  }
  .pr-metrics {
    display: flex;
    gap: 0;
    padding: 12px 0;
    border-radius: var(--radius-lg);
    background: var(--panel);
    box-shadow: var(--shadow-surface);
  }
  .pr-metric {
    min-width: 76px;
    padding: 2px 14px;
    border: 0;
    border-left: 1px solid var(--border-soft);
    border-radius: 0;
    background: transparent;
  }
  .pr-metric span {
    margin-bottom: 3px;
    font-size: 12px;
    line-height: 16px;
  }
  .pr-metric strong {
    font-size: 12px;
    line-height: 16px;
  }
  .pr-head-foot {
    margin-top: 14px;
    padding-top: 12px;
    border-top-color: var(--border-soft);
  }
  .ci-summary {
    gap: 8px;
    min-height: 32px;
    padding-inline: 11px;
    border: 0;
    border-radius: 999px;
    font-size: 13px;
    box-shadow: var(--shadow-xs);
  }
  .ci-summary-icon {
    width: 14px;
    height: 14px;
  }
  .ci-summary-icon svg {
    display: block;
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .ci-summary-label {
    font-size: 13px;
    font-weight: 400;
    letter-spacing: 0;
  }
  .ci-summary-detail {
    margin-left: 1px;
    color: var(--text-faint);
    font-size: 12px;
    font-weight: 400;
    letter-spacing: -0.003em;
  }
  .ci-summary.fail .ci-summary-icon {
    color: color-mix(in srgb, var(--fail) 72%, var(--text-dim));
  }
  .ci-summary.fail {
    box-shadow: 0 0 0 0.5px color-mix(in srgb, var(--fail) 34%, transparent), var(--shadow-control-filled);
  }
  .ci-summary.fail .ci-summary-detail {
    color: color-mix(in srgb, var(--fail) 78%, var(--text-dim));
  }
  .tabs {
    display: inline-flex;
    width: fit-content;
    gap: 4px;
    margin: 0 0 26px;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
  }
  .tab {
    display: inline-flex;
    min-height: 32px;
    align-items: center;
    gap: 6px;
    padding: 0 12px;
    border: 0;
    border-radius: 999px;
    background: var(--panel);
    box-shadow: var(--shadow-control-outlined);
    color: var(--text);
    font-size: 14px;
    font-weight: 500;
    line-height: 20px;
    transition: background-color 140ms ease, box-shadow 140ms ease, transform 140ms var(--ease-out);
  }
  .tab.active {
    border: 0;
    background: var(--surface);
    box-shadow: var(--shadow-control-selected);
  }
  .tab:active {
    transform: scale(0.99);
  }
  .tab-count {
    display: inline-flex;
    min-width: 20px;
    height: 20px;
    align-items: center;
    justify-content: center;
    margin: 0;
    padding: 0 6px;
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-control-hairline);
    color: var(--text-dim);
    font-size: 11px;
    line-height: 1;
  }
  @media (hover: hover) and (pointer: fine) {
    .tab:hover {
      background: var(--surface);
    }
  }
  .cols {
    grid-template-columns: minmax(0, 1fr) minmax(240px, 264px);
    gap: 32px;
  }
  .right {
    gap: 0;
  }
  .card {
    margin-bottom: 24px;
    padding: 18px;
    border: 0;
    border-radius: var(--radius-lg);
    background: color-mix(in srgb, var(--panel) 88%, var(--surface));
    box-shadow: var(--shadow-surface);
  }
  .side-block {
    margin: 0 0 12px;
    padding: 14px;
    border: 0;
    border-radius: var(--radius-lg);
    background: color-mix(in srgb, var(--panel) 88%, var(--surface));
    box-shadow: var(--shadow-surface);
  }
  .side-block + .side-block {
    padding-top: 14px;
  }
  .block-title,
  .side-title {
    font-size: 14px;
    font-weight: 500;
    line-height: 20px;
    letter-spacing: 0;
  }
  .event,
  .run-row,
  .diff-status {
    border-color: var(--border);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--panel) 88%, var(--surface));
  }
  .event:not(.activity-event),
  .run-row,
  .diff-status {
    box-shadow: var(--shadow-surface);
  }
  .event-head {
    background: color-mix(in srgb, var(--surface) 56%, transparent);
  }
  .event {
    margin-bottom: 8px;
    overflow: hidden;
    border-color: var(--border);
    border-radius: 10px;
    background: color-mix(in srgb, var(--panel) 88%, var(--surface));
  }
  .event-head {
    min-height: 40px;
    padding: 8px 12px;
    border-bottom: 0;
    background: transparent;
    font-family: var(--sans);
  }
  .event-head .author {
    font-size: 13px;
    font-weight: 600;
  }
  .event-head .when {
    font-size: 12px;
  }
  .event-body {
    padding: 0 14px 14px 38px;
  }
  .event.activity-event {
    margin-bottom: 2px;
    overflow: visible;
    border: 0;
    border-radius: 0;
    background: transparent;
  }
  .activity-event .event-head {
    min-height: 34px;
    padding: 5px 4px;
  }
  .activity-event .verdict {
    margin-left: 2px;
  }
  .event.greptile-event {
    border-color: color-mix(in srgb, var(--ready) 14%, var(--border-soft));
    background: color-mix(in srgb, var(--ready-bg) 34%, var(--panel));
  }
  .greptile-event .event-head {
    padding-bottom: 6px;
  }
  .greptile-event .event-body {
    padding-top: 0;
    padding-bottom: 16px;
  }
  .greptile-event :global(.md) {
    color: var(--text-dim);
    font-size: 13.5px;
    line-height: 1.65;
  }
  .greptile-event :global(.md h1),
  .greptile-event :global(.md h2),
  .greptile-event :global(.md h3) {
    margin: 12px 0 7px;
    padding: 0;
    border: 0;
    font-size: 14px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .greptile-event :global(.md h1:first-child),
  .greptile-event :global(.md h2:first-child),
  .greptile-event :global(.md h3:first-child) {
    margin-top: 0;
  }
  .greptile-event :global(.md p) {
    margin-bottom: 8px;
  }
  .greptile-event :global(.md ul),
  .greptile-event :global(.md ol) {
    margin: 7px 0 10px;
    padding-left: 19px;
  }
  .greptile-event :global(.md li) {
    margin: 2px 0;
  }
  .label {
    border-radius: var(--radius-sm);
  }
  .btn,
  .retry-btn,
  .cbtn,
  .resolve-btn,
  .merge-btn {
    min-height: 32px;
    padding-inline: 13px;
    border: 0;
    border-radius: 999px;
    background: var(--panel);
    box-shadow: var(--shadow-control-outlined);
    font-family: var(--sans);
    font-size: 14px;
    font-weight: 500;
  }
  .shortcut-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
  }
  .btn:disabled,
  .retry-btn:disabled,
  .cbtn:disabled,
  .resolve-btn:disabled,
  .merge-btn:disabled {
    background: var(--disabled-bg);
    box-shadow: none;
    color: var(--disabled-fg);
    opacity: 1;
  }
  .toolbar-btn {
    min-height: 28px;
    padding: 0 10px;
    border: 0;
    border-radius: 999px;
    background: transparent;
    box-shadow: none;
    color: var(--text-dim);
    font-family: var(--sans);
    font-size: 12px;
    font-weight: 500;
  }
  .merge-btn {
    background: var(--link);
    color: var(--on-brand);
    box-shadow: var(--shadow-control-filled);
  }
  .merge-btn:disabled {
    background: var(--brand-disabled);
    color: var(--on-brand);
  }
  .composer .btn {
    height: 36px;
    background: var(--link);
    box-shadow: var(--shadow-control-filled);
    color: var(--on-brand);
  }
  .composer .btn:disabled {
    background: var(--brand-disabled);
    box-shadow: none;
    color: var(--on-brand);
  }
  .close-action {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
  }
  .action-icon {
    width: 14px;
    height: 14px;
    flex: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .action-method {
    font-size: 12px;
    font-weight: 450;
    opacity: 0.78;
    text-transform: capitalize;
  }
  .merge-btn.fail {
    border: 0;
    background: var(--panel);
    box-shadow: var(--shadow-control-outlined);
    color: var(--fail);
  }
  .merge-btn.update-action {
    background: var(--panel);
    box-shadow: var(--shadow-control-outlined);
    color: var(--text);
  }
  .merge-btn.update-action:disabled {
    background: var(--disabled-bg);
    box-shadow: none;
    color: var(--disabled-fg);
  }
  .merge-btn.blocked {
    border: 0;
    background: var(--fail-bg);
    box-shadow: none;
    color: var(--fail);
  }
  .link {
    min-height: 28px;
    padding: 0 10px;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--text);
    font-family: var(--sans);
    font-size: 12px;
    font-weight: 500;
  }
  .link.danger {
    color: var(--fail);
  }
  @media (hover: hover) and (pointer: fine) {
    .btn:hover:not(:disabled),
    .retry-btn:hover:not(:disabled),
    .cbtn:hover:not(:disabled),
    .resolve-btn:hover:not(:disabled) {
      background: var(--surface);
      border-color: transparent;
    }
    .merge-btn:hover:not(:disabled) {
      background: var(--brand-hover);
      filter: none;
    }
    .composer .btn:hover:not(:disabled) {
      background: var(--brand-hover);
    }
    .merge-btn.fail:hover:not(:disabled) {
      background: color-mix(in srgb, var(--fail-bg) 38%, var(--panel));
    }
    .merge-btn.update-action:hover:not(:disabled) {
      background: var(--surface);
    }
    .merge-btn.blocked:hover:not(:disabled) {
      background: color-mix(in srgb, var(--fail-bg) 72%, var(--fail) 12%);
    }
    .toolbar-btn:hover,
    .link:hover:not(:disabled) {
      background: var(--ghost-hover);
      border-color: transparent;
      color: var(--text);
    }
    .link.danger:hover:not(:disabled) {
      background: var(--fail-bg);
      color: var(--fail);
    }
  }
  .btn:active:not(:disabled),
  .retry-btn:active:not(:disabled),
  .cbtn:active:not(:disabled),
  .resolve-btn:active:not(:disabled),
  .merge-btn:active:not(:disabled) {
    transform: scale(0.99);
  }
  .ci-copy-button,
  .conflict-copy-button,
  .ci-agent-button,
  .conflict-primary {
    min-height: 28px;
    padding: 0 10px;
    border: 0;
    border-radius: 999px;
    font-family: var(--sans);
    font-size: 12px;
    font-weight: 500;
  }
  .ci-copy-button,
  .conflict-copy-button {
    background: color-mix(in srgb, var(--fail-bg) 78%, var(--panel));
    box-shadow: 0 0 0 0.5px color-mix(in srgb, var(--fail) 28%, transparent);
    color: var(--fail);
  }
  .ci-agent-button {
    background: var(--fail);
    box-shadow: var(--shadow-control-filled);
    color: var(--on-brand);
  }
  .conflict-primary {
    background: var(--native-accent);
    box-shadow: var(--shadow-control-filled);
    color: var(--on-brand);
  }
  @media (hover: hover) and (pointer: fine) {
    .ci-copy-button:hover,
    .conflict-copy-button:hover {
      background: color-mix(in srgb, var(--fail-bg) 78%, var(--fail) 10%);
      color: var(--fail);
    }
    .ci-agent-button:hover:not(:disabled) {
      background: color-mix(in srgb, var(--fail) 88%, black);
    }
    .conflict-primary:hover:not(:disabled) {
      background: var(--brand-hover);
    }
  }
  .verdict-body,
  .composer textarea,
  .prompt-input {
    border-color: transparent;
    border-radius: var(--radius-sm);
    background: var(--surface);
    font-family: var(--sans);
    font-size: 14px;
  }
  .verdict-body-wrap {
    position: relative;
    margin-bottom: 8px;
  }
  .verdict-body {
    width: 100%;
    resize: vertical;
    color: var(--text);
    height: 58px;
    min-height: 58px;
    margin: 0;
    padding: 8px 42px 8px 12px;
    border: 0;
    border-radius: var(--radius-md);
    background: var(--panel);
    box-shadow: var(--shadow-control-outlined);
  }
  .verdict-body::-webkit-resizer {
    opacity: 0;
  }
  .verdict-key {
    position: absolute;
    top: 10px;
    right: 10px;
    display: inline-flex;
    pointer-events: none;
  }
  .review-menu {
    min-width: 180px;
  }
  .detail-frame.files-tab > .detail {
    --files-content-left: 0px;
  }
  .detail-frame.files-tab .pr-head,
  .detail-frame.files-tab .since-banner,
  .detail-frame.files-tab .tabs {
    width: 100%;
    margin-left: 0;
  }
  .files-layout {
    grid-template-columns: clamp(220px, var(--tree-width), 300px) 6px minmax(0, 1fr);
  }
  .files-toolbar {
    grid-column: 1 / -1;
    min-height: 41px;
    margin: 0 0 18px;
    padding: 0 0 12px;
    border-bottom: 1px solid var(--border-soft);
  }
  .toolbar-left {
    gap: 10px;
  }
  .toolbar-label {
    color: var(--text-dim);
    font-size: 12px;
    font-weight: 500;
    line-height: 16px;
  }
  .tree-pane {
    padding: 0 18px 0 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }
  .file-nav-head {
    display: flex;
    min-height: 32px;
    align-items: center;
    justify-content: space-between;
    padding: 0 8px 8px;
    color: var(--text);
    font-family: var(--sans);
    font-size: 14px;
    font-weight: 500;
    line-height: 20px;
  }
  .file-nav-head .fcount {
    display: inline-flex;
    min-width: 20px;
    height: 20px;
    align-items: center;
    justify-content: center;
    padding: 0 6px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--surface-hover) 50%, transparent);
    color: var(--text-dim);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }
  .tree-resizer {
    position: relative;
    background: linear-gradient(to right, transparent 2px, var(--border-soft) 2px, var(--border-soft) 3px, transparent 3px);
  }
  .diff-pane {
    padding-left: 20px;
  }
  .detail-frame.files-tab .pr-head,
  .detail-frame.files-tab .since-banner,
  .detail-frame.files-tab .tabs {
    width: calc(100% - var(--files-content-left));
  }
  @media (max-width: 940px) {
    .files-layout {
      grid-template-columns: minmax(0, 1fr);
    }
    .files-toolbar,
    .tree-pane,
    .diff-pane {
      grid-column: 1;
    }
    .tree-pane {
      max-height: 240px;
      padding: 0 0 18px;
      border-bottom: 1px solid var(--border-soft);
    }
    .diff-pane {
      padding-left: 0;
    }
    .cols {
      grid-template-columns: 1fr;
    }
    .pr-metrics {
      width: 100%;
    }
    .right {
      position: static;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 24px 32px;
    }
  }
  @media (max-width: 660px) {
    .page {
      padding-inline: 14px;
    }
    .pr-head {
      padding: 8px 0 18px;
    }
    .pr-metric {
      padding-inline: 10px;
    }
    .right {
      grid-template-columns: 1fr;
    }
  }
</style>
