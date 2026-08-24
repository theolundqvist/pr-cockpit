<script module>
  // survives the inbox unmounting into a PR view: esc back restores the cursor to that PR
  let restoreKey = null;
</script>

<script>
  import { untrack } from "svelte";
  import { fetchInbox, fetchRecentClosed, fetchPrDetails, setArchived, focusTmux, tmuxFocusErrorMessage, saveSettings, reorderPr, fetchSettings, fetchRelayStatus, fetchRelayCoverage, autofixAgent, customAgent, rescoreAgent } from "./api.js";
  import { cacheDetail, cachedHeadSha } from "./detailCache.js";
  import { filterPrs, countMatches, wantsHistory } from "./prFilter.js";
  import { relativeTime } from "./time.js";
  import { classify, GROUP_ORDER, GROUP_TITLES } from "./whoseMove.js";
  import { mergeGate } from "./mergeGate.js";
  import { prefs } from "./prefs.svelte.js";
  import { isTypingTarget, shouldCopyPrUrl } from "./dom.js";
  import { scrollEdge } from "./scroll.js";
  import KeyBar from "./KeyBar.svelte";
  import Avatar from "./Avatar.svelte";
  import UpdateButton from "./UpdateButton.svelte";
  import { timedFlag } from "./timedFlag.svelte.js";
  import { prKey } from "./prKey.js";
  import { showFlash } from "./flash.svelte.js";
  import CurrentBranchBadge from "./CurrentBranchBadge.svelte";
  import Kbd from "./Kbd.svelte";

  let { refreshRevision = 0, pollCompletedAt = null, onFindPr = () => {} } = $props();
  let handledRefreshRevision = refreshRevision;

  let prs = $state([]);
  let viewerLogin = $state(null);
  let error = $state(null);
  let loaded = $state(false);
  let lastPollAt = $state(null);
  let selected = $state(0);
  let multiAnchor = $state(null);
  const bulkAutofixFlash = timedFlag(3000);
  let autofixConfirm = $state(false);
  let autofixConfirmCount = $state(0);
  let customConfirm = $state(null);

  let keybindAgents = $derived(prefs.agents.filter((a) => a.trigger === "keybind" && a.enabled && a.keybind));
  let lastG = 0;
  let filterOpen = $state(false);
  let filterQuery = $state("");
  let filterInput;
  const copied = timedFlag(1200);
  let inboxSeq = 0;
  let archivedSeq = 0;
  let lastMouseX = -1;
  let lastMouseY = -1;
  function trackMouse(e) {
    lastMouseX = e.screenX;
    lastMouseY = e.screenY;
  }
  function onRowHover(e, index) {
    if (e.screenX !== lastMouseX || e.screenY !== lastMouseY) selected = index;
  }
  let showArchived = $state(false);
  let archivedPrs = $state([]);
  let view = $state("open");
  let closedPrs = $state([]);
  let closedLoaded = $state(false);
  let closedSeq = 0;
  let undo = $state(null);
  const archiveFlash = timedFlag(4000, () => (undo = null));
  let savedViews = $state([]);
  let pollIntervalS = $state(180);
  const inboxMountedAt = Date.now();

  async function loadViews() {
    try {
      const settings = await fetchSettings();
      savedViews = JSON.parse(settings.saved_views || "[]");
      pollIntervalS = Number.isFinite(settings.poll_interval_s) ? settings.poll_interval_s : 180;
    } catch {
      savedViews = [];
    }
  }

  async function persistViews(views) {
    savedViews = views;
    await saveSettings({ saved_views: JSON.stringify(views) }).catch(() => {});
  }

  function applyView(query) {
    filterQuery = query;
    filterOpen = true;
    selected = 0;
  }

  function saveCurrentView() {
    const query = filterQuery.trim();
    if (!query) return;
    const name = window.prompt("Name this view", query)?.trim();
    if (!name) return;
    persistViews([...savedViews.filter((v) => v.name !== name), { name, query }]);
  }

  function deleteView(name) {
    persistViews(savedViews.filter((v) => v.name !== name));
  }

  function openFilter() {
    filterOpen = true;
    queueMicrotask(() => {
      filterInput?.focus();
      filterInput?.select();
    });
  }

  function closeFilter() {
    filterOpen = false;
    filterQuery = "";
    selected = 0;
    filterInput?.blur();
  }

  let syncing = $derived(loaded && prs.length === 0 && lastPollAt === null);

  // relay pushes bump the server row's head sha, so a mismatch re-warms the cache and the instant paint on open is fresh
  function warmDetails(rows) {
    const keys = rows.filter((pr) => cachedHeadSha(prKey(pr)) !== pr.headSha).map(prKey);
    if (!keys.length) return;
    fetchPrDetails(keys)
      .then((details) => {
        for (const [key, detail] of Object.entries(details)) cacheDetail(key, detail);
      })
      .catch(console.error);
  }

  async function loadInbox() {
    const seq = ++inboxSeq;
    try {
      const res = await fetchInbox();
      if (seq !== inboxSeq) return;
      const selectedKey = ordered[selected] ? prKey(ordered[selected]) : null;
      prs = res.prs;
      viewerLogin = res.viewerLogin ?? null;
      lastPollAt = res.lastPollAt;
      loaded = true;
      error = null;
      // a background poll can reorder the list mid-navigation; keep the same PR selected, not the same index
      if (restoreKey !== null) {
        const idx = ordered.findIndex((pr) => prKey(pr) === restoreKey);
        restoreKey = null;
        if (idx >= 0) {
          selected = idx;
          scrollSelectedIntoView();
        }
      } else if (selectedKey !== null) {
        const idx = ordered.findIndex((pr) => prKey(pr) === selectedKey);
        if (idx >= 0) selected = idx;
      }
      warmDetails(res.prs);
    } catch (e) {
      if (seq === inboxSeq) error = String(e);
    }
  }

  let relayOkAt = $state(null);
  let relayCovered = $state(false);

  async function loadRelayLive() {
    try {
      const status = await fetchRelayStatus();
      if (!status.url) {
        relayOkAt = null;
        relayCovered = false;
        return;
      }
      const coverage = await fetchRelayCoverage();
      relayOkAt = status.lastOkAt;
      relayCovered = coverage.repos !== null && Object.values(coverage.repos).some(Boolean);
    } catch {
      relayOkAt = null;
      relayCovered = false;
    }
  }

  $effect(() => {
    loadInbox();
    loadViews();
    loadRelayLive();
  });

  $effect(() => {
    if (refreshRevision === handledRefreshRevision) return;
    handledRefreshRevision = refreshRevision;
    untrack(() => {
      loadInbox();
      loadRelayLive();
      if (view === "closed") loadClosed();
    });
  });
  $effect(() => {
    if (pollCompletedAt) lastPollAt = pollCompletedAt;
  });

  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  let relayLive = $derived(relayOkAt !== null && now - relayOkAt < 30000 && relayCovered);

  let syncDelayed = $derived.by(() => {
    const lastSync = lastPollAt === null ? inboxMountedAt : new Date(lastPollAt).getTime();
    return loaded && now - lastSync > Math.max(120000, pollIntervalS * 2000);
  });

  let syncAge = $derived.by(() => {
    if (lastPollAt === null) return "not completed yet";
    const secs = Math.max(0, Math.round((now - new Date(lastPollAt).getTime()) / 1000));
    if (secs < 10) return "just now";
    if (secs < 60) return `${secs} seconds ago`;
    if (secs < 3600) return `${Math.floor(secs / 60)} minutes ago`;
    return `${Math.floor(secs / 3600)} hours ago`;
  });

  let pollCadence = $derived(pollIntervalS < 120 ? `${pollIntervalS} seconds` : `${Math.round(pollIntervalS / 60)} minutes`);

  let syncLabel = $derived(lastPollAt === null && !syncDelayed ? "Syncing" : syncDelayed ? "Sync delayed" : relayLive ? "Online" : "Synced");

  let syncTitle = $derived.by(() => {
    if (lastPollAt === null) return syncDelayed ? "The first sync is taking longer than expected." : "Completing the first sync…";
    if (syncDelayed) return `Last synced ${syncAge}. Expected about every ${pollCadence}.`;
    if (relayLive) return `Live updates are online. Last full sync completed ${syncAge}.`;
    return `Last synced ${syncAge}.`;
  });

  async function loadArchived() {
    const seq = ++archivedSeq;
    try {
      const res = await fetchInbox(true);
      if (seq === archivedSeq) {
        archivedPrs = res.prs;
        warmDetails(res.prs);
      }
    } catch {
      if (seq === archivedSeq) archivedPrs = [];
    }
  }


  async function archive(pr, archived) {
    await setArchived(pr.repo, pr.number, archived);
    await loadInbox();
    if (showArchived) await loadArchived();
  }

  function toggleArchived() {
    showArchived = !showArchived;
    if (showArchived) loadArchived();
  }

  async function loadClosed() {
    const seq = ++closedSeq;
    try {
      const res = await fetchRecentClosed();
      if (seq !== closedSeq) return;
      // a merge landing mid-navigation prepends a row; keep the same PR selected, not the same index
      const selectedKey = view === "closed" && ordered[selected] ? prKey(ordered[selected]) : null;
      closedPrs = res.prs;
      if (selectedKey !== null) {
        const idx = closedPrs.findIndex((pr) => prKey(pr) === selectedKey);
        if (idx >= 0) selected = idx;
      }
    } catch {
      if (seq === closedSeq) closedPrs = [];
    } finally {
      if (seq === closedSeq) closedLoaded = true;
    }
  }

  function showView(next) {
    if (view === next) return;
    view = next;
    selected = 0;
    multiAnchor = null;
    if (next === "closed") loadClosed();
  }

  let closedSummary = $derived.by(() => {
    let merged = 0;
    let closed = 0;
    const repos = new Set();
    for (const pr of closedPrs) {
      if (pr.state === "MERGED") merged++;
      else closed++;
      repos.add(pr.repo);
    }
    return { merged, closed, repos: repos.size };
  });

  // state:closed / state:merged queries reach pr_index history, which only the server can merge — fetch (debounced) instead of filtering the open inbox locally
  let historyPrs = $state([]);
  let historyQuery = $state("");
  let historyLoading = $state(false);
  let historySeq = 0;

  $effect(() => {
    const q = filterQuery.trim();
    if (!wantsHistory(q)) {
      historyLoading = false;
      return;
    }
    historyLoading = true;
    const seq = ++historySeq;
    const timer = setTimeout(async () => {
      try {
        const res = await fetchInbox(false, q);
        if (seq !== historySeq) return;
        historyPrs = res.prs;
        historyQuery = q;
      } catch {
        if (seq === historySeq) historyPrs = [];
      } finally {
        if (seq === historySeq) historyLoading = false;
      }
    }, 250);
    return () => clearTimeout(timer);
  });

  let historyActive = $derived(wantsHistory(filterQuery) && historyQuery === filterQuery.trim() && !historyLoading);
  let filteredPrs = $derived(wantsHistory(filterQuery) ? (historyQuery === filterQuery.trim() ? historyPrs : []) : filterPrs(prs, filterQuery, showArchived));
  let activeView = $derived(savedViews.find((v) => v.query === filterQuery.trim())?.name ?? null);

  // history views can't be counted from the open inbox; show the live count only while applied, else a placeholder
  function viewCount(v) {
    if (wantsHistory(v.query)) return activeView === v.name && historyActive ? historyPrs.length : "–";
    return countMatches(prs, v.query, showArchived);
  }

  let headCount = $derived.by(() => {
    if (!filterQuery.trim()) return `${prs.length} open`;
    if (wantsHistory(filterQuery)) return historyActive ? `${filteredPrs.length} found` : "searching…";
    return `${filteredPrs.length}/${prs.length} open`;
  });

  let queueSummary = $derived.by(() => {
    const counts = { ready: 0, yours: 0, waiting: 0 };
    const repos = new Set();
    for (const pr of filteredPrs) {
      const group = classify(pr, viewerLogin).group;
      if (group in counts) counts[group]++;
      repos.add(pr.repo);
    }
    return { ...counts, repos: repos.size };
  });

  const TRUNK_MIN_BASE_COUNT = 3;

  // a branch that's the base of many open PRs is trunk, even if a release PR's head equals it
  let trunkRefs = $derived.by(() => {
    const counts = new Map();
    for (const pr of filteredPrs) {
      const key = `${pr.repo}:${pr.baseRef}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return new Set([...counts].filter(([, n]) => n >= TRUNK_MIN_BASE_COUNT).map(([key]) => key));
  });

  let stack = $derived.by(() => {
    const byHead = new Map(filteredPrs.map((pr) => [`${pr.repo}:${pr.headRef}`, pr]));
    const parentOf = (pr) => {
      if (trunkRefs.has(`${pr.repo}:${pr.baseRef}`)) return null;
      return byHead.get(`${pr.repo}:${pr.baseRef}`) ?? null;
    };
    const info = new Map();
    for (const pr of filteredPrs) {
      const parent = parentOf(pr);
      info.set(prKey(pr), { parent, indent: parent ? 1 : 0 });
    }
    return info;
  });

  // walks up to the topmost ancestor still in the list; that PR's status places the whole stack
  function topUnit(pr) {
    let cur = pr;
    const visited = new Set();
    for (;;) {
      visited.add(prKey(cur));
      const parent = stack.get(prKey(cur))?.parent;
      if (!parent || visited.has(prKey(parent))) return cur;
      cur = parent;
    }
  }

  function orderGroup(rows) {
    const inGroup = new Set(rows.map(prKey));
    const childrenOf = new Map();
    const topUnits = [];
    for (const pr of rows) {
      const parent = stack.get(prKey(pr)).parent;
      if (parent && inGroup.has(prKey(parent))) {
        (childrenOf.get(prKey(parent)) ?? childrenOf.set(prKey(parent), []).get(prKey(parent))).push(pr);
      } else {
        topUnits.push(pr);
      }
    }
    const subtree = (pr) => {
      const out = [pr];
      for (const child of childrenOf.get(prKey(pr)) ?? []) out.push(...subtree(child));
      return out;
    };
    const unranked = topUnits.filter((pr) => pr.rank == null);
    const ranked = topUnits.filter((pr) => pr.rank != null).sort((a, b) => a.rank - b.rank);
    const items = [];
    for (const pr of unranked) for (const p of subtree(pr)) items.push({ pr: p });
    if (ranked.length > 0) items.push({ divider: true });
    for (const pr of ranked) for (const p of subtree(pr)) items.push({ pr: p });
    return { units: [...unranked, ...ranked], unrankedCount: unranked.length, items };
  }

  let groups = $derived.by(() => {
    const buckets = new Map();
    for (const pr of filteredPrs) {
      const id = classify(topUnit(pr), viewerLogin).group;
      if (!buckets.has(id)) buckets.set(id, []);
      buckets.get(id).push(pr);
    }
    return GROUP_ORDER.filter((id) => buckets.has(id)).map((id) => {
      const { units, unrankedCount, items } = orderGroup(buckets.get(id));
      return { id, title: GROUP_TITLES[id], units, unrankedCount, items };
    });
  });

  let openOrdered = $derived(groups.flatMap((g) => g.items.filter((i) => i.pr).map((i) => i.pr)));

  let dragKey = $state(null);
  let dropHint = $state(null);

  async function applyRank(pr, position) {
    const target = prs.find((p) => prKey(p) === prKey(pr));
    if (target) {
      target.rank = position;
      prs = [...prs];
    }
    try {
      await reorderPr(pr.repo, pr.number, position);
    } catch {}
    loadInbox();
  }

  function onDragStart(e, pr) {
    dragKey = prKey(pr);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragKey);
  }

  function onDragEnd() {
    dragKey = null;
    dropHint = null;
  }

  function onDragOverRow(e, pr) {
    if (!dragKey || prKey(pr) === dragKey) return;
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    const before = e.clientY - r.top < r.height / 2;
    dropHint = { key: prKey(pr), before };
  }

  function dropAt(dragged, group, insertIndex) {
    const rest = group.units.filter((p) => prKey(p) !== prKey(dragged));
    const u = rest.filter((p) => p.rank == null).length;
    if (insertIndex < u) {
      applyRank(dragged, null);
      return;
    }
    const ranked = rest.filter((p) => p.rank != null);
    const k = insertIndex - u;
    const L = ranked[k - 1];
    const R = ranked[k];
    let pos;
    if (L && R) pos = (L.rank + R.rank) / 2;
    else if (R) pos = R.rank - 1;
    else if (L) pos = L.rank + 1;
    else pos = 0;
    applyRank(dragged, pos);
  }

  function onDropRow(e, overPr) {
    e.preventDefault();
    const draggedKey = dragKey;
    dragKey = null;
    dropHint = null;
    if (!draggedKey) return;
    const r = e.currentTarget.getBoundingClientRect();
    const before = e.clientY - r.top < r.height / 2;
    const group = groups.find((g) => g.id === classify(topUnit(overPr), viewerLogin).group);
    if (!group) return;
    const dragged = group.units.find((p) => prKey(p) === draggedKey);
    if (!dragged) return;
    const overUnit = topUnit(overPr);
    const rest = group.units.filter((p) => prKey(p) !== draggedKey);
    const j = rest.findIndex((p) => prKey(p) === prKey(overUnit));
    if (j < 0) return;
    dropAt(dragged, group, before ? j : j + 1);
  }

  function onDropDivider(e, group) {
    e.preventDefault();
    const draggedKey = dragKey;
    dragKey = null;
    dropHint = null;
    const dragged = group.units.find((p) => prKey(p) === draggedKey);
    if (!dragged) return;
    const rest = group.units.filter((p) => prKey(p) !== draggedKey);
    dropAt(dragged, group, rest.filter((p) => p.rank == null).length);
  }

  function onDropUnrank(e, group) {
    e.preventDefault();
    const draggedKey = dragKey;
    dragKey = null;
    dropHint = null;
    const dragged = group.units.find((p) => prKey(p) === draggedKey);
    if (dragged) applyRank(dragged, null);
  }

  let dragGroupId = $derived.by(() => {
    if (!dragKey) return null;
    const pr = prs.find((p) => prKey(p) === dragKey);
    return pr ? classify(topUnit(pr), viewerLogin).group : null;
  });
  let ordered = $derived(view === "closed" ? closedPrs : showArchived ? [...openOrdered, ...archivedPrs] : openOrdered);
  let archivedSet = $derived(new Set(archivedPrs.map((pr) => prKey(pr))));
  const isArchived = (pr) => archivedSet.has(prKey(pr));

  $effect(() => {
    if (selected > ordered.length - 1) selected = Math.max(0, ordered.length - 1);
  });

  let keyBarKeys = $derived.by(() => {
    const pr = ordered[selected];
    const keys = [
      { key: "j / k", label: "move" },
      { key: "⏎", label: "open" },
    ];
    if (view === "closed") {
      keys.push({ key: "o", label: "github" });
      keys.push({ key: "C", label: "back to open" });
      return keys;
    }
    if (pr) keys.push({ key: "e", label: isArchived(pr) ? "unarchive" : "archive" });
    keys.push({ key: "A", label: showArchived ? "hide archived" : "archived" });
    keys.push({ key: "C", label: "recently merged" });
    if (pr) {
      for (const a of keybindAgents) {
        if (a.id === "fixer") continue;
        if (a.id === "autofix") keys.push({ key: a.keybind, label: multiRange ? "autofix selected" : "autofix" });
        else if (a.id === "rescorer") keys.push({ key: a.keybind, label: "re-score" });
        else if (pr.fixerAgentState !== "running") keys.push({ key: a.keybind, label: a.name || "custom agent" });
      }
    }
    keys.push({ key: "⇧J / ⇧K", label: "select range" });
    keys.push({ key: "o", label: "github" });
    if (pr) keys.push({ key: "⇧T", label: "focus terminal" });
    return keys;
  });

  function scrollSelectedIntoView() {
    requestAnimationFrame(() => {
      document.querySelector(".inbox .row.selected")?.scrollIntoView({ block: "nearest" });
    });
  }

  function openGithub(pr) {
    window.open(`https://github.com/${pr.repo}/pull/${pr.number}`, "_blank", "noopener");
  }

  async function focusTerminal(pr) {
    try {
      await focusTmux(pr.repo, pr.number);
    } catch (err) {
      showFlash(tmuxFocusErrorMessage(err));
    }
  }

  let multiRange = $derived(multiAnchor === null ? null : { lo: Math.min(multiAnchor, selected), hi: Math.max(multiAnchor, selected) });

  function autofixIneligible(pr) {
    if (pr.fixerAgentState === "running") return true;
    const gate = mergeGate(pr, pr.ciStatus);
    return gate.action === "merge" && pr.unresolvedCount === 0;
  }

  function openAutofixConfirm() {
    const range = multiRange ?? { lo: selected, hi: selected };
    const targets = ordered.slice(range.lo, range.hi + 1);
    if (!targets.length) return;
    const eligible = targets.filter((pr) => !autofixIneligible(pr));
    if (!eligible.length) {
      multiAnchor = null;
      bulkAutofixFlash.show(targets.length === 1 ? "already green or running — nothing to autofix" : `all ${targets.length} selected already green or running — nothing to autofix`);
      return;
    }
    autofixConfirmCount = eligible.length;
    autofixConfirm = true;
  }

  async function submitBulkAutofix() {
    const range = multiRange ?? { lo: selected, hi: selected };
    const targets = ordered.slice(range.lo, range.hi + 1);
    multiAnchor = null;
    if (!targets.length) return;
    const eligible = targets.filter((pr) => !autofixIneligible(pr));
    const skipped = targets.length - eligible.length;
    if (!eligible.length) {
      bulkAutofixFlash.show(targets.length === 1 ? "already green or running — nothing to autofix" : `all ${targets.length} selected already green or running — nothing to autofix`);
      return;
    }
    await Promise.allSettled(eligible.map((pr) => autofixAgent(pr.repo, pr.number)));
    bulkAutofixFlash.show(eligible.length === 1 && skipped === 0 ? "autofix armed" : `autofix armed on ${eligible.length}${skipped ? ` · ${skipped} skipped` : ""}`);
    loadInbox();
  }

  async function submitCustom(def) {
    const pr = ordered[selected];
    if (!pr) return;
    try {
      if (def.id === "rescorer") {
        await rescoreAgent(pr.repo, pr.number);
        bulkAutofixFlash.show("re-score started");
      } else {
        await customAgent(pr.repo, pr.number, def.id);
        bulkAutofixFlash.show(`${def.name || "custom agent"} armed`);
      }
    } catch (e) {
      bulkAutofixFlash.show(e instanceof Error ? e.message : String(e));
    }
    loadInbox();
  }

  $effect(() => {
    function onKey(e) {
      if (e.metaKey && e.key === ",") {
        location.hash = "#/settings";
        e.preventDefault();
        return;
      }
      if (shouldCopyPrUrl(e)) {
        const pr = ordered[selected];
        if (pr) {
          navigator.clipboard.writeText(`https://github.com/${pr.repo}/pull/${pr.number}`).then(() => copied.show("copied GitHub PR URL"), () => {});
        }
        e.preventDefault();
        return;
      }
      if (e.metaKey && e.key.toLowerCase() === "f") {
        openFilter();
        e.preventDefault();
        return;
      }
      if (e.key === "Escape" && filterOpen) {
        closeFilter();
        e.preventDefault();
        return;
      }
      if (e.key === "Escape" && multiAnchor !== null) {
        multiAnchor = null;
        e.preventDefault();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      if (e.key === "/") {
        openFilter();
        e.preventDefault();
        return;
      }
      if (e.key >= "1" && e.key <= "9" && savedViews[Number(e.key) - 1]) {
        applyView(savedViews[Number(e.key) - 1].query);
        e.preventDefault();
        return;
      }
      if (autofixConfirm) {
        if (e.key === "Enter") submitBulkAutofix();
        autofixConfirm = false;
        e.preventDefault();
        return;
      }
      if (customConfirm) {
        if (e.key === "Enter") submitCustom(customConfirm);
        customConfirm = null;
        e.preventDefault();
        return;
      }
      const pr = ordered[selected];
      if (e.key === "g" && !e.shiftKey) {
        const now = Date.now();
        if (now - lastG < 400) {
          selected = 0;
          scrollEdge(document.querySelector(".page"), "top");
          lastG = 0;
          e.preventDefault();
        } else lastG = now;
        return;
      }
      if (e.key === "G") {
        selected = ordered.length - 1;
        scrollEdge(document.querySelector(".page"), "bottom");
        e.preventDefault();
        return;
      }
      if (e.key === "J" || (e.shiftKey && e.key === "ArrowDown")) {
        if (multiAnchor === null) multiAnchor = selected;
        selected = Math.min(ordered.length - 1, selected + 1);
        scrollSelectedIntoView();
      } else if (e.key === "K" || (e.shiftKey && e.key === "ArrowUp")) {
        if (multiAnchor === null) multiAnchor = selected;
        selected = Math.max(0, selected - 1);
        scrollSelectedIntoView();
      } else if (e.key === "j" || e.key === "ArrowDown") {
        multiAnchor = null;
        selected = Math.min(ordered.length - 1, selected + 1);
        scrollSelectedIntoView();
      } else if (e.key === "k" || e.key === "ArrowUp") {
        multiAnchor = null;
        selected = Math.max(0, selected - 1);
        scrollSelectedIntoView();
      } else if (e.key === "Enter") {
        if (pr) {
          restoreKey = prKey(pr);
          location.hash = `#/pr/${pr.repo}/${pr.number}`;
        }
      } else if (e.key === "o") {
        if (pr) openGithub(pr);
      } else if (view === "open" && e.key === "T") {
        if (pr) focusTerminal(pr);
      } else if (view === "open" && keybindAgents.some((a) => a.id !== "fixer" && a.keybind === e.key)) {
        const def = keybindAgents.find((a) => a.id !== "fixer" && a.keybind === e.key);
        if (def.id === "autofix") openAutofixConfirm();
        else if (def.id === "rescorer") {
          if (pr) customConfirm = def;
        } else if (pr && pr.fixerAgentState !== "running") customConfirm = def;
      } else if (view === "open" && e.key === "e") {
        if (pr && isArchived(pr)) {
          archive(pr, false);
        } else if (pr) {
          archive(pr, true);
          undo = { repo: pr.repo, number: pr.number };
          archiveFlash.show();
        }
      } else if (view === "open" && e.key === "z") {
        if (undo) {
          archive(undo, false);
          undo = null;
          archiveFlash.clear();
        }
      } else if (view === "open" && e.key === "A") {
        toggleArchived();
      } else if (e.key === "C") {
        showView(view === "closed" ? "open" : "closed");
      } else {
        return;
      }
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const repoTail = (repo) => repo.split("/")[1] ?? repo;

  function greptileTitle(status) {
    if (status === "stale") return "reviewed before recent pushes - the score may no longer reflect the current state";
    if (status === "addressed") return "reviewed before recent pushes, but every thread that reviewer left is resolved";
    return "Greptile confidence";
  }

  function greptileChipTitle(pr) {
    if (pr.greptileRescore) return `original ${pr.greptileConfidence}/5 by greptile-apps → ${pr.greptileRescore.score}/5 re-scored after fixes`;
    return greptileTitle(pr.greptileStatus);
  }
</script>

<div class="page">
  <div class="inbox" onmousemove={trackMouse}>
    <header class="head">
      <div class="head-copy">
        <span class="ui-eyebrow">Workspace</span>
        <span class="head-title">Review queue</span>
      </div>
      <span class="head-right">
        <UpdateButton />
        <span
          class="sync-status"
          class:healthy={!syncDelayed && lastPollAt !== null}
          class:delayed={syncDelayed}
          title={syncTitle}
        >
          <span class="sync-dot" aria-hidden="true"></span>
          <strong>{syncLabel}</strong>
        </span>
      </span>
    </header>

    <section class="queue-overview" aria-label="Review queue summary">
      {#if view === "closed"}
        <div class="queue-copy">
          <span class="ui-eyebrow">Recently finished</span>
          <h1>{closedLoaded ? `${closedPrs.length} done` : "loading…"}</h1>
          <p>
            {#if closedSummary.repos}
              Newest merge or close first, across {closedSummary.repos} repositor{closedSummary.repos === 1 ? "y" : "ies"}.
            {:else}
              Pull requests you were part of land here once they merge or close.
            {/if}
          </p>
        </div>
        <div class="queue-metrics two" aria-label="Finished counts">
          <div class="queue-metric merged">
            <span>Merged</span>
            <strong>{closedSummary.merged}</strong>
          </div>
          <div class="queue-metric closed">
            <span>Closed</span>
            <strong>{closedSummary.closed}</strong>
          </div>
        </div>
      {:else}
        <div class="queue-copy">
          <span class="ui-eyebrow">Pull requests</span>
          <h1>{headCount}</h1>
          <p>
            {#if queueSummary.repos}
              Sorted around the next decision across {queueSummary.repos} repositor{queueSummary.repos === 1 ? "y" : "ies"}.
            {:else}
              Your pull-request workspace will appear here.
            {/if}
          </p>
        </div>
        <div class="queue-metrics" aria-label="Queue counts">
          <div class="queue-metric ready">
            <span>Ready</span>
            <strong>{queueSummary.ready}</strong>
          </div>
          <div class="queue-metric review">
            <span>Your move</span>
            <strong>{queueSummary.yours}</strong>
          </div>
          <div class="queue-metric wait">
            <span>Waiting</span>
            <strong>{queueSummary.waiting}</strong>
          </div>
        </div>
      {/if}
    </section>

    <div class="view-tabs" role="tablist" aria-label="List view">
      <button class="view-tab" role="tab" aria-selected={view === "open"} class:active={view === "open"} onclick={() => showView("open")}>
        Open<span class="view-tab-count">{prs.length}</span>
      </button>
      <button class="view-tab" role="tab" aria-selected={view === "closed"} class:active={view === "closed"} onclick={() => showView("closed")}>
        Recently merged<kbd>C</kbd>
      </button>
    </div>

    {#if filterOpen && view === "open"}
      <div class="filter-row">
        <span class="filter-icon">/</span>
        <input
          bind:this={filterInput}
          bind:value={filterQuery}
          oninput={() => (selected = 0)}
          onkeydown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              const pr = ordered[selected];
              if (pr) {
                restoreKey = prKey(pr);
                location.hash = `#/pr/${pr.repo}/${pr.number}`;
              }
            }
          }}
          placeholder="filter — text, or author: state: is: repo: base: review:"
          spellcheck="false"
          autocomplete="off"
        />
        <span class="filter-hint">esc to clear</span>
      </div>
    {/if}

    {#snippet row(pr)}
      {@const status = classify(pr, viewerLogin)}
      {@const index = ordered.indexOf(pr)}
      {@const info = stack.get(prKey(pr))}
      {@const statsDiffer = pr.additions !== pr.rawAdditions || pr.deletions !== pr.rawDeletions}
      <a
        class="row {status.tone}"
        class:selected={index === selected}
        class:multi-selected={multiRange && index >= multiRange.lo && index <= multiRange.hi}
        class:archived-row={isArchived(pr)}
        class:stack-child={info?.indent}
        class:dragging={dragKey === prKey(pr)}
        class:drop-before={dropHint?.key === prKey(pr) && dropHint.before}
        class:drop-after={dropHint?.key === prKey(pr) && !dropHint.before}
        href="#/pr/{pr.repo}/{pr.number}"
        draggable={!info?.indent && !isArchived(pr)}
        ondragstart={(e) => onDragStart(e, pr)}
        ondragend={onDragEnd}
        ondragover={(e) => onDragOverRow(e, pr)}
        ondrop={(e) => onDropRow(e, pr)}
        onmouseenter={(e) => onRowHover(e, index)}
        onclick={() => (restoreKey = prKey(pr))}
      >
        {#if info?.indent}<span class="stack-glyph" aria-hidden="true">└</span>{/if}
        <span class="row-avatar">
          <Avatar login={pr.author} url={`https://github.com/${pr.author}.png?size=64`} size={30} />
        </span>
        <span class="row-badge-slot"><span class="row-badge badge {status.tone}">{status.label}</span></span>
        <div class="row-main">
          <div class="row-title">{pr.title}</div>
          <div class="row-meta mono">
            <span class="num">#{pr.number}</span>
            <span class="sep">·</span>
            <span>{repoTail(pr.repo)}</span>
            <span class="sep">·</span>
            <span class="branch">{pr.baseRef} <span class="arrow">←</span> {pr.headRef}</span>
            {#if pr.localBranch === pr.headRef}
              <CurrentBranchBadge />
            {/if}
            <span class="sep">·</span>
            <span class="add" title={statsDiffer ? `+${pr.rawAdditions} including tests` : undefined}>+{pr.additions}</span>
            <span class="del" title={statsDiffer ? `−${pr.rawDeletions} including tests` : undefined}>−{pr.deletions}</span>
            {#if pr.unresolvedCount > 0}
              <span class="sep">·</span>
              <span class="threads">{pr.unresolvedCount} unresolved</span>
            {/if}
          </div>
        </div>
        {#if pr.reviewScore != null}
          {@const fromGreptile = pr.reviewScore === (pr.greptileRescore ? pr.greptileRescore.score : pr.greptileConfidence)}
          <span
            class="greptile"
            class:stale={(fromGreptile && !pr.greptileRescore && pr.greptileStatus === "stale") || (!fromGreptile && pr.reviewScoreStale)}
            class:addressed={fromGreptile && !pr.greptileRescore && pr.greptileStatus === "addressed"}
            class:rescored={fromGreptile && !!pr.greptileRescore}
            title={fromGreptile ? greptileChipTitle(pr) : pr.reviewScoreStale ? "lowest reviewer score — reviewed before recent pushes, may be out of date" : "lowest reviewer score"}
          >
            {pr.reviewScore}/5
          </span>
        {/if}
        <span class="row-age mono">{relativeTime(pr.updatedAt)}</span>
      </a>
    {/snippet}

    {#snippet groupBody(group)}
      {#if dragGroupId === group.id && group.unrankedCount === 0}
        <div
          class="unrank-zone"
          class:drop-active={dropHint?.key === "unrank:" + group.id}
          role="button"
          tabindex="-1"
          ondragover={(e) => {
            e.preventDefault();
            dropHint = { key: "unrank:" + group.id };
          }}
          ondrop={(e) => onDropUnrank(e, group)}
        >
          Drop here to unpin
        </div>
      {/if}
      {#each group.items as item (item.divider ? group.id + ":div" : prKey(item.pr))}
        {#if item.divider}
          <div
            class="rank-divider"
            class:drop-active={dropHint?.key === "div:" + group.id}
            role="separator"
            ondragover={(e) => {
              if (dragKey) {
                e.preventDefault();
                dropHint = { key: "div:" + group.id, before: false };
              }
            }}
            ondrop={(e) => onDropDivider(e, group)}
          >
            <span class="rank-divider-label">Pinned</span>
          </div>
        {:else}
          {@render row(item.pr)}
        {/if}
      {/each}
    {/snippet}

    {#snippet closedRow(pr)}
      {@const status = classify(pr, viewerLogin)}
      {@const index = ordered.indexOf(pr)}
      <a
        class="row {status.tone}"
        class:selected={index === selected}
        href="#/pr/{pr.repo}/{pr.number}"
        onmouseenter={(e) => onRowHover(e, index)}
      >
        <span class="row-avatar">
          <Avatar login={pr.author} url={`https://github.com/${pr.author}.png?size=64`} size={30} />
        </span>
        <span class="row-badge-slot"><span class="row-badge badge {status.tone}">{status.label}</span></span>
        <div class="row-main">
          <div class="row-title">{pr.title}</div>
          <div class="row-meta mono">
            <span class="num">#{pr.number}</span>
            <span class="sep">·</span>
            <span>{repoTail(pr.repo)}</span>
            <span class="sep">·</span>
            <span>{pr.author}</span>
          </div>
        </div>
        <span class="row-age mono" title={pr.terminalAt}>{relativeTime(pr.terminalAt)}</span>
      </a>
    {/snippet}

    <div class="inbox-layout">
      <div class="queue-list">
        {#if view === "closed"}
          {#if !closedLoaded}
            <div class="empty">Loading recent merges…</div>
          {:else if closedPrs.length === 0}
            <div class="empty">Nothing merged or closed yet</div>
          {/if}
          <section class="queue-group">
            <div class="group-body">
              {#each closedPrs as pr (prKey(pr))}{@render closedRow(pr)}{/each}
            </div>
          </section>
        {:else}
          {#if error}
            <div class="empty">{error}</div>
          {:else if syncing}
            <div class="empty">Syncing with GitHub…</div>
          {:else if loaded && prs.length === 0}
            <div class="empty">No open pull requests</div>
          {:else if wantsHistory(filterQuery) && !historyActive}
            <div class="empty">Searching history…</div>
          {:else if filterQuery && filteredPrs.length === 0}
            <div class="empty">No matches for “{filterQuery}”</div>
          {/if}

          {#each groups as group (group.id)}
            {@const groupCount = group.items.filter((item) => item.pr).length}
            <section class="queue-group">
              <div class="group-label">
                <span>{group.title}</span>
                <span class="group-count">{groupCount}</span>
              </div>
              <div class="group-body">{@render groupBody(group)}</div>
            </section>
          {/each}

          {#if showArchived}
            <section class="queue-group archived-group">
              <div class="group-label archived-label"><span>Archived</span><span class="group-count">{archivedPrs.length}</span></div>
              <div class="group-body">
                {#if archivedPrs.length === 0}
                  <div class="empty">Nothing archived</div>
                {/if}
                {#each archivedPrs as pr (prKey(pr))}{@render row(pr)}{/each}
              </div>
            </section>
          {/if}
        {/if}
      </div>

      <aside class="queue-sidecar">
        <section class="side-panel quick-actions-panel">
          <div class="side-panel-head"><span>Quick actions</span></div>
          <button class="quick-action" type="button" onclick={onFindPr}>
            <span class="quick-action-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" fill="none">
                <circle cx="8.75" cy="8.75" r="4.75"></circle>
                <path d="m12.25 12.25 3.5 3.5"></path>
              </svg>
            </span>
            <span class="quick-action-label">Find a pull request</span>
            <span class="quick-action-shortcut"><Kbd keys={["cmd", "k"]} label="Command K" /></span>
          </button>
          {#if view === "open"}
            <button class="quick-action" type="button" onclick={openFilter}>
              <span class="quick-action-icon" aria-hidden="true">
                <svg viewBox="0 0 20 20" fill="none">
                  <path d="M3.25 5.25h13.5M5.75 10h8.5M8.25 14.75h3.5"></path>
                </svg>
              </span>
              <span class="quick-action-label">Filter this queue</span>
              <span class="quick-action-shortcut"><Kbd keys="/" label="Slash" /></span>
            </button>
            <button class="quick-action" type="button" onclick={toggleArchived}>
              <span class="quick-action-icon" aria-hidden="true">
                <svg viewBox="0 0 20 20" fill="none">
                  <path d="M4.25 7.25v8.5h11.5v-8.5M3.5 4.25h13v3h-13zM8 10.25h4"></path>
                </svg>
              </span>
              <span class="quick-action-label">{showArchived ? "Hide archived" : "Show archived"}</span>
              <span class="quick-action-shortcut"><Kbd keys="a" label="A" /></span>
            </button>
          {/if}
        </section>

        {#if loaded && prs.length > 0 && savedViews.length > 0}
          <section class="side-panel saved-views">
            <div class="side-panel-head"><span>Saved views</span></div>
            <div class="view-item" class:active={!filterQuery.trim()}>
              <button class="view-apply" onclick={() => (filterQuery = "")}>
                <span class="view-name">All</span>
                <span class="view-count">{prs.length}</span>
              </button>
            </div>
            {#each savedViews as v, i (v.name)}
              <div class="view-item" class:active={activeView === v.name}>
                <button class="view-apply" onclick={() => applyView(v.query)}>
                  {#if i < 9}<span class="view-key mono">{i + 1}</span>{/if}
                  <span class="view-name" title={v.query}>{v.name}</span>
                  <span class="view-count">{viewCount(v)}</span>
                </button>
                <button class="view-del" title="Delete view" aria-label="Delete view" onclick={() => deleteView(v.name)}>×</button>
              </div>
            {/each}
            {#if filterQuery.trim() && !activeView}
              <button class="view-save" onclick={saveCurrentView}>+ Save current filter</button>
            {/if}
          </section>
        {/if}
      </aside>
    </div>
  </div>
</div>

{#if autofixConfirm}
  <div class="copied-flash">Arm auto-fix on {autofixConfirmCount} PR{autofixConfirmCount > 1 ? "s" : ""}? <kbd>enter</kbd> confirm · <kbd>esc</kbd> cancel</div>
{:else if customConfirm}
  <div class="copied-flash">{customConfirm.id === "rescorer" ? "Re-score this PR?" : `Arm "${customConfirm.name || "custom"}" agent on this PR?`} <kbd>enter</kbd> confirm · <kbd>esc</kbd> cancel</div>
{:else if copied.value}
  <div class="copied-flash">{copied.value}</div>
{:else if archiveFlash.value}
  <div class="copied-flash">Archived — <kbd>z</kbd> to undo</div>
{:else if bulkAutofixFlash.value}
  <div class="copied-flash">{bulkAutofixFlash.value}</div>
{:else}
  <KeyBar keys={keyBarKeys} />
{/if}

<style>
  .page {
    height: var(--general-height);
    overflow-y: auto;
    padding: 40px 24px 0;
    display: flex;
    align-items: flex-start;
    gap: 24px;
  }
  .inbox {
    flex: 1;
    min-width: 0;
    max-width: 820px;
    margin: 0 auto;
    padding-bottom: 96px;
  }
  .views-rail {
    position: sticky;
    top: 0;
    flex: 0 0 176px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-bottom: 40px;
  }
  .rail-head {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-faint);
    padding: 2px 8px 8px;
  }
  .view-item {
    display: flex;
    align-items: center;
    border-radius: 7px;
  }
  .view-item.active {
    background: var(--panel);
  }
  .view-item:hover {
    background: var(--panel);
  }
  .view-apply {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 6px 8px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-dim);
    font: inherit;
    font-size: 13px;
    text-align: left;
  }
  .view-item.active .view-apply {
    color: var(--text);
  }
  .view-key {
    flex: 0 0 auto;
    font-size: 10px;
    color: var(--text-faint);
    width: 10px;
  }
  .view-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .view-count {
    flex: 0 0 auto;
    font-size: 11px;
    color: var(--text-faint);
  }
  .view-del {
    flex: 0 0 auto;
    padding: 0 8px;
    background: none;
    border: none;
    cursor: pointer;
    color: var(--text-faint);
    font-size: 15px;
    line-height: 1;
    opacity: 0;
  }
  .view-item:hover .view-del {
    opacity: 1;
  }
  .view-del:hover {
    color: var(--fail);
  }
  .view-save {
    margin-top: 6px;
    padding: 6px 8px;
    background: none;
    border: 1px dashed var(--border);
    border-radius: 7px;
    cursor: pointer;
    color: var(--text-faint);
    font-size: 11px;
    text-align: left;
  }
  .view-save:hover {
    color: var(--text-dim);
    border-color: var(--text-faint);
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 0 4px 14px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 6px;
  }
  .head-title {
    font-family: var(--sans);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-dim);
  }
  .head-title .dot {
    color: var(--text-faint);
    margin: 0 4px;
  }
  .head-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .sync-status {
    display: inline-flex;
    align-items: center;
    min-height: 32px;
    gap: 6px;
    padding: 0 10px;
    border-radius: 999px;
    background: var(--surface);
    box-shadow: var(--shadow-control-hairline);
    color: var(--text-dim);
    font: 12px/16px var(--sans);
  }
  .sync-status strong {
    color: var(--text);
    font-weight: 500;
  }
  .sync-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--wait);
  }
  .sync-status.healthy .sync-dot {
    background: var(--ready);
  }
  .sync-status.delayed .sync-dot {
    background: var(--review);
  }
  .head-count {
    font-family: var(--sans);
    font-size: 12px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .empty {
    padding: 48px 4px;
    text-align: center;
    color: var(--text-faint);
    font-size: 13px;
  }
  .filter-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    margin: 4px 0 2px;
    background: var(--panel-raised);
    border: 1px solid var(--border);
    border-radius: 7px;
  }
  .filter-icon {
    color: var(--text-faint);
    font-size: 13px;
  }
  .filter-row input {
    flex: 1;
    background: none;
    border: none;
    outline: none;
    color: var(--text);
    font-family: var(--mono);
    font-size: 13px;
  }
  .filter-hint {
    color: var(--text-faint);
    font-size: 11px;
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
  .group-label {
    font-family: var(--sans);
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--text-faint);
    padding: 18px 4px 6px;
  }
  .archived-label {
    color: var(--text-faint);
    opacity: 0.7;
  }
  .archived-row {
    opacity: 0.5;
  }
  .archived-row.selected {
    opacity: 0.8;
  }
  .copied-flash kbd {
    font-family: var(--sans);
    font-size: 11px;
    font-weight: 500;
    padding: 0 6px;
    margin: 0 2px;
    background: color-mix(in srgb, var(--surface-hover) 50%, transparent);
    border: 0;
    border-radius: 6px;
    color: color-mix(in srgb, var(--text-dim) 80%, transparent);
  }
  .row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    padding: 11px 12px 11px 10px;
    border-radius: 8px;
    text-decoration: none;
    color: inherit;
    border-left: 2px solid transparent;
    transition: background 0.08s ease;
  }
  .row.stack-child {
    margin-left: 26px;
  }
  .stack-glyph {
    flex: none;
    color: var(--text-faint);
    align-self: center;
    user-select: none;
  }
  .row .stack-glyph {
    width: 14px;
    margin-left: -8px;
  }
  .row.dragging {
    opacity: 0.4;
  }
  .row.drop-before {
    box-shadow: inset 0 2px 0 var(--link);
  }
  .row.drop-after {
    box-shadow: inset 0 -2px 0 var(--link);
  }
  .rank-divider {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 6px 6px;
  }
  .rank-divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--border);
  }
  .rank-divider-label {
    font-size: 9.5px;
    font-weight: 600;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .rank-divider.drop-active::after {
    background: var(--link);
  }
  .rank-divider.drop-active .rank-divider-label {
    color: var(--link);
  }
  .unrank-zone {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 12px;
    margin: 2px 0;
    font-size: 10.5px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--text-faint);
    border: 1px dashed var(--border);
    border-radius: 8px;
  }
  .unrank-zone.drop-active {
    border-color: var(--link);
    color: var(--link);
    background: var(--link-bg);
  }
  .row.selected {
    background: var(--panel-raised);
    border-left-color: var(--review);
  }
  .row.fail.selected {
    border-left-color: var(--fail);
  }
  .row.ready.selected {
    border-left-color: var(--ready);
  }
  .row.wait.selected {
    border-left-color: var(--wait);
  }
  .row.merged.selected {
    border-left-color: var(--merged);
  }
  .row.closed.selected {
    border-left-color: var(--closed);
  }
  .row.multi-selected {
    background: var(--link-bg);
  }
  .row-avatar {
    flex: none;
    display: flex;
    margin-top: 1px;
  }
  .row-badge {
    flex: none;
    margin-top: 1px;
    min-width: 74px;
    justify-content: center;
  }
  .row-main {
    flex: 1;
    min-width: 0;
  }
  .row-title {
    font-size: 14.5px;
    font-weight: 500;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-meta {
    font-size: 12px;
    color: var(--text-faint);
    margin-top: 3px;
    display: flex;
    align-items: center;
    gap: 6px;
    overflow: hidden;
    white-space: nowrap;
  }
  .row-meta .num {
    color: var(--text-dim);
  }
  .row-meta .sep {
    color: var(--meta-sep);
  }
  .row-meta .branch {
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row-meta .arrow {
    color: var(--text-faint);
  }
  .row-meta .add {
    color: var(--ready);
  }
  .row-meta .del {
    color: var(--fail);
  }
  .row-meta .threads {
    color: var(--review);
  }
  .greptile {
    flex: none;
    margin-top: 1px;
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
  .row-age {
    flex: none;
    font-size: 12px;
    color: var(--text-faint);
    margin-top: 2px;
  }

  /* Workspace composition: the queue becomes a clear working surface instead
     of a single narrow column floating in an empty desktop window. */
  .page {
    height: 100%;
    overflow-y: auto;
    display: block;
    padding: 20px 32px 76px;
  }
  .inbox {
    width: 100%;
    max-width: 1320px;
    margin: 0 auto;
    padding-bottom: 20px;
  }
  .head {
    position: sticky;
    top: -20px;
    z-index: 4;
    align-items: center;
    min-height: 70px;
    padding: 20px 2px 14px;
    margin: -20px 0 18px;
    background: var(--overlay-bg);
    border-bottom: 1px solid var(--border-soft);
    backdrop-filter: blur(18px) saturate(160%);
  }
  .head-copy {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .head .ui-eyebrow {
    font-size: 10px;
  }
  .head-title {
    font-family: var(--sans);
    font-size: 19px;
    font-weight: 650;
    letter-spacing: -0.025em;
    text-transform: none;
    color: var(--text);
  }
  .head-right {
    gap: 8px;
  }
  .queue-overview {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 24px;
    margin-bottom: 16px;
    padding: 20px 22px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-xs);
  }
  .queue-copy {
    min-width: 0;
  }
  .queue-copy h1 {
    margin: 3px 0 4px;
    color: var(--text);
    font-size: 28px;
    font-weight: 650;
    line-height: 1.08;
    letter-spacing: -0.038em;
  }
  .queue-copy p {
    margin: 0;
    color: var(--text-dim);
    font-size: 12px;
    line-height: 1.45;
  }
  .queue-metrics {
    display: grid;
    grid-template-columns: repeat(3, minmax(68px, 1fr));
    gap: 8px;
  }
  .queue-metric {
    min-width: 72px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: color-mix(in srgb, var(--panel) 82%, transparent);
  }
  .queue-metric span {
    display: block;
    margin-bottom: 3px;
    color: var(--text-faint);
    font-size: 10.5px;
    line-height: 1;
  }
  .queue-metric strong {
    display: block;
    color: var(--text);
    font-size: 18px;
    font-weight: 650;
    letter-spacing: -0.025em;
    line-height: 1;
  }
  .queue-metric.ready strong { color: var(--ready); }
  .queue-metric.review strong { color: var(--review); }
  .queue-metric.merged strong { color: var(--merged); }
  .queue-metric.closed strong { color: var(--closed); }
  .queue-metric.wait strong { color: var(--text-dim); }
  .queue-metrics.two {
    grid-template-columns: repeat(2, minmax(68px, 1fr));
  }
  .view-tabs {
    display: flex;
    gap: 4px;
    margin: 0 0 16px;
    padding: 3px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-xs);
  }
  .view-tab {
    display: flex;
    align-items: center;
    gap: 7px;
    min-height: 28px;
    padding: 0 11px;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-dim);
    font-family: var(--sans);
    font-size: 12px;
    font-weight: 600;
  }
  .view-tab.active {
    background: var(--surface);
    color: var(--text);
  }
  .view-tab kbd,
  .view-tab-count {
    color: color-mix(in srgb, var(--text-dim) 80%, transparent);
    font-family: var(--sans);
    font-size: 11px;
    font-weight: 500;
  }
  @media (hover: hover) and (pointer: fine) {
    .view-tab:hover {
      color: var(--text);
    }
  }
  .filter-row {
    min-height: 40px;
    padding: 7px 12px;
    margin: 0 0 16px;
    background: var(--panel);
    border-color: var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-xs);
  }
  .filter-row:focus-within {
    background: var(--panel);
    border-color: var(--link);
    box-shadow: 0 0 0 3px var(--focus-ring);
  }
  .inbox-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 236px;
    align-items: start;
    gap: 20px;
  }
  .queue-list {
    min-width: 0;
  }
  .queue-sidecar {
    position: sticky;
    top: 78px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .side-panel {
    padding: 12px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-xs);
  }
  .side-panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 20px;
    padding: 0 3px 8px;
    color: var(--text-dim);
    font-size: 11px;
    font-weight: 650;
    letter-spacing: -0.005em;
  }
  .quick-action {
    display: flex;
    align-items: center;
    width: 100%;
    min-height: 31px;
    gap: 8px;
    padding: 4px;
    border: none;
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-dim);
    font-family: var(--sans);
    font-size: 11.5px;
    text-align: left;
  }
  .quick-action-icon {
    display: grid;
    flex: none;
    width: 20px;
    height: 20px;
    place-items: center;
    border-radius: 5px;
    background: var(--surface);
    color: var(--text-faint);
    font-family: var(--sans);
    font-size: 10px;
  }
  @media (hover: hover) and (pointer: fine) {
    .quick-action:hover {
      background: var(--surface);
      color: var(--text);
    }
  }
  .saved-views {
    padding-bottom: 10px;
  }
  .view-item {
    display: flex;
    align-items: center;
    border-radius: var(--radius-sm);
  }
  .view-item.active {
    background: var(--surface);
  }
  .view-item:hover {
    background: var(--surface);
  }
  .view-apply {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 29px;
    padding: 0 7px;
    border: none;
    background: none;
    color: var(--text-dim);
    font-family: var(--sans);
    font-size: 11.5px;
    text-align: left;
  }
  .view-item.active .view-apply {
    color: var(--text);
    font-weight: 600;
  }
  .view-key,
  .view-count {
    color: var(--text-faint);
    font-size: 9.5px;
  }
  .view-key { width: 9px; }
  .view-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .view-del {
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    border-radius: 5px;
    background: none;
    color: var(--text-faint);
    font-size: 15px;
    line-height: 1;
    opacity: 0;
  }
  .view-item:hover .view-del,
  .view-del:focus-visible {
    opacity: 1;
  }
  .view-del:hover { color: var(--fail); }
  .view-save {
    width: 100%;
    min-height: 28px;
    margin-top: 7px;
    padding: 0 7px;
    border: 1px dashed var(--border-hover);
    border-radius: var(--radius-sm);
    background: none;
    color: var(--text-faint);
    font-size: 10px;
    text-align: left;
  }
  .queue-group {
    margin-bottom: 14px;
    overflow: hidden;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-xs);
  }
  .group-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 38px;
    padding: 0 14px;
    border-bottom: 1px solid var(--border-soft);
    background: var(--surface);
    color: var(--text-dim);
    font-family: var(--sans);
    font-size: 11.5px;
    font-weight: 650;
    letter-spacing: -0.005em;
    text-transform: none;
  }
  .group-count {
    display: inline-grid;
    min-width: 20px;
    height: 20px;
    place-items: center;
    border-radius: 999px;
    background: var(--panel);
    color: var(--text-faint);
    font-family: var(--sans);
    font-size: 10px;
    font-weight: 500;
  }
  .archived-group { opacity: 0.8; }
  .archived-label { color: var(--text-faint); }
  .row {
    position: relative;
    gap: 13px;
    min-height: 62px;
    padding: 12px 14px;
    border: 0;
    border-bottom: 1px solid var(--border-soft);
    border-radius: 0;
    transition: background-color 140ms ease, color 140ms ease;
  }
  .group-body > .row:last-child { border-bottom: none; }
  .row.stack-child {
    margin-left: 26px;
    border-left: 1px solid var(--border-soft);
  }
  @media (hover: hover) and (pointer: fine) {
    .row:hover {
      border-color: var(--border-soft);
      background: var(--surface);
    }
  }
  .row.selected {
    border-color: var(--border-soft);
    background: color-mix(in srgb, var(--link-bg) 48%, var(--panel));
    box-shadow: none;
  }
  .row.selected::before {
    content: "";
    position: absolute;
    top: 10px;
    bottom: 10px;
    left: 0;
    width: 3px;
    border-radius: 0 999px 999px 0;
    background: var(--review);
  }
  .row.fail.selected::before { background: var(--fail); }
  .row.ready.selected::before { background: var(--ready); }
  .row.wait.selected::before { background: var(--wait); }
  .row.merged.selected::before { background: var(--merged); }
  .row.closed.selected::before { background: var(--closed); }
  .row.multi-selected {
    border-color: var(--border-soft);
    background: var(--link-bg);
  }
  .row-badge {
    min-width: 78px;
    margin-top: 2px;
  }
  .row-title {
    font-size: 14.5px;
    font-weight: 620;
    letter-spacing: -0.014em;
  }
  .row-meta {
    margin-top: 4px;
    font-size: 11px;
    letter-spacing: -0.01em;
  }
  .greptile {
    border-color: var(--border);
    border-radius: 999px;
    padding: 2px 8px;
  }
  .rank-divider {
    margin: 0;
    padding: 9px 14px;
    background: var(--panel);
  }
  .unrank-zone {
    margin: 10px 12px;
  }
  .empty {
    margin-bottom: 14px;
    padding: 36px 18px;
    background: var(--panel);
    border: 1px dashed var(--border-hover);
    border-radius: var(--radius-lg);
  }
  .copied-flash {
    left: var(--app-rail-width, 0px);
    height: 44px;
    padding-inline: max(
      var(--app-content-gutter, 24px),
      calc((100% - var(--app-content-max-width, 1320px)) / 2)
    );
    background: var(--overlay-bg);
    border-top: 1px solid var(--border);
    box-shadow: 0 -1px 0 rgb(0 0 0 / 0.02);
    backdrop-filter: blur(18px) saturate(160%);
  }
  @media (max-width: 1120px) {
    .inbox-layout {
      grid-template-columns: 1fr;
    }
    .queue-sidecar {
      position: static;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      align-items: start;
    }
    .saved-views {
      grid-column: 1 / -1;
    }
  }
  @media (max-width: 720px) {
    .page {
      padding: 16px 14px 70px;
    }
    .head {
      top: -16px;
      min-height: 62px;
      padding-top: 16px;
      margin-top: -16px;
    }
    .queue-overview {
      grid-template-columns: 1fr;
      gap: 16px;
      padding: 18px;
    }
    .queue-metrics {
      width: 100%;
    }
    .queue-sidecar {
      grid-template-columns: 1fr;
    }
    .row-badge-slot {
      display: none;
    }
    .saved-views {
      grid-column: auto;
    }
    .row-badge-slot {
      display: none;
    }
    .row-meta .branch,
    .row-meta .branch + .sep {
      display: none;
    }
  }

  /* Scape Desktop visual language: hierarchy and rows carry the layout. */
  .page {
    padding: 18px 32px 76px;
  }
  .head {
    top: -18px;
    min-height: 70px;
    padding: 18px 0 14px;
    margin: -18px 0 8px;
    border-bottom-color: var(--border-soft);
    background: linear-gradient(to bottom, var(--bg) 74%, color-mix(in srgb, var(--bg) 84%, transparent));
    backdrop-filter: blur(14px);
  }
  .head-copy {
    gap: 0;
  }
  .head .ui-eyebrow {
    font-size: 12px;
  }
  .head-title {
    font-size: 24px;
    font-weight: 500;
    line-height: 30px;
    letter-spacing: -0.025em;
  }
  .queue-overview {
    gap: 32px;
    margin: 0 0 18px;
    padding: 18px 20px;
    border: 0;
    border-radius: var(--radius-lg);
    background: var(--panel);
    box-shadow: var(--shadow-surface);
  }
  .queue-copy h1 {
    margin: 2px 0 3px;
    font-size: 24px;
    font-weight: 500;
    line-height: 30px;
    letter-spacing: -0.025em;
  }
  .queue-copy p {
    color: var(--text-dim);
    font-size: 14px;
    line-height: 20px;
  }
  .queue-metrics,
  .queue-metrics.two {
    display: flex;
    gap: 0;
  }
  .queue-metric {
    min-width: 82px;
    padding: 2px 16px;
    border: 0;
    border-left: 1px solid var(--border-soft);
    border-radius: 0;
    background: transparent;
  }
  .queue-metric span {
    margin-bottom: 4px;
    font-size: 12px;
    line-height: 16px;
  }
  .queue-metric strong {
    font-size: 16px;
    font-weight: 600;
    line-height: 20px;
    letter-spacing: 0;
  }
  .view-tabs {
    display: inline-flex;
    width: fit-content;
    gap: 4px;
    margin: 0 0 20px;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }
  .view-tab {
    min-height: 32px;
    padding: 0 12px;
    border: 0;
    border-radius: 999px;
    background: var(--panel);
    box-shadow: var(--shadow-control-outlined);
    color: var(--text);
    font-size: 14px;
    font-weight: 500;
    transition: background-color 140ms ease, box-shadow 140ms ease, transform 140ms var(--ease-out);
  }
  .view-tab.active {
    background: var(--surface);
    box-shadow: var(--shadow-control-selected);
    color: var(--text);
  }
  .view-tab:active {
    transform: scale(0.99);
  }
  .view-tab-count {
    display: inline-flex;
    min-width: 20px;
    height: 20px;
    align-items: center;
    justify-content: center;
    padding: 0 6px;
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-control-hairline);
    color: var(--text-dim);
    font-size: 11px;
    line-height: 1;
  }
  .filter-row {
    min-height: 36px;
    margin-bottom: 18px;
    background: var(--surface);
    border-color: transparent;
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-control-outlined);
  }
  @media (hover: hover) and (pointer: fine) {
    .view-tab:hover {
      background: var(--surface);
      color: var(--text);
    }
  }
  .inbox-layout {
    grid-template-columns: minmax(0, 1fr) 220px;
    gap: 28px;
  }
  .queue-group {
    margin-bottom: 24px;
    overflow: visible;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }
  .group-label {
    min-height: 32px;
    padding: 0 12px;
    border-bottom: 1px solid var(--border-soft);
    background: transparent;
    color: var(--text-dim);
    font-size: 12px;
    font-weight: 500;
    line-height: 16px;
  }
  .group-count {
    display: inline;
    min-width: 0;
    height: auto;
    border-radius: 0;
    background: transparent;
    color: var(--text-faint);
    font-size: 12px;
  }
  .row {
    min-height: 60px;
    padding: 10px 12px;
    border-bottom-color: var(--border-soft);
  }
  .row-title {
    font-size: 14px;
    font-weight: 500;
    line-height: 20px;
    letter-spacing: 0;
  }
  .row-meta {
    margin-top: 2px;
    font-size: 12px;
    line-height: 16px;
    letter-spacing: 0;
  }
  .row.selected {
    background: var(--link-bg);
  }
  .row.selected::before {
    top: 0;
    bottom: 0;
    width: 2px;
    border-radius: 0;
    background: var(--link);
  }
  .row-badge {
    min-width: 0;
    margin-top: 0;
    justify-content: flex-start;
  }
  .row-badge-slot {
    display: flex;
    flex: 0 0 88px;
    align-items: flex-start;
    margin-top: 2px;
  }
  .greptile {
    border: 0;
    border-radius: var(--radius-sm);
    background: var(--surface);
    box-shadow: none;
  }
  .rank-divider {
    padding: 8px 12px;
    background: transparent;
  }
  .queue-sidecar {
    top: 72px;
    gap: 24px;
    margin-top: -4px;
  }
  .side-panel {
    padding: 0 0 16px;
    border: 0;
    border-bottom: 1px solid var(--border-soft);
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }
  .quick-actions-panel {
    border-bottom: 0;
  }
  .side-panel-head {
    min-height: 28px;
    padding: 0 10px 8px;
    font-size: 12px;
    font-weight: 600;
    line-height: 16px;
  }
  .quick-action {
    min-height: 36px;
    gap: 8px;
    padding: 0 6px;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    color: var(--text);
  }
  .quick-action-icon {
    width: 20px;
    height: 20px;
    background: transparent;
    color: var(--text-dim);
  }
  .quick-action-icon svg {
    width: 18px;
    height: 18px;
    overflow: visible;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .quick-action-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .quick-action-shortcut {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    min-width: 44px;
    margin-left: auto;
    opacity: 0.72;
    transition: opacity 140ms ease;
  }
  @media (hover: hover) and (pointer: fine) {
    .quick-action:hover {
      background: var(--surface-hover);
    }
    .quick-action:hover .quick-action-shortcut {
      opacity: 1;
    }
  }
  .empty {
    padding: 36px 18px;
    border: 0;
    border-bottom: 1px solid var(--border-soft);
    border-radius: 0;
    background: transparent;
  }
  @media (max-width: 1120px) {
    .inbox-layout {
      grid-template-columns: 1fr;
    }
    .queue-sidecar {
      position: static;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      align-items: start;
    }
    .saved-views {
      grid-column: 1 / -1;
    }
  }
  @media (max-width: 720px) {
    .page {
      padding: 14px 14px 70px;
    }
    .head {
      top: -14px;
      margin-top: -14px;
      padding-top: 14px;
    }
    .queue-overview {
      gap: 16px;
      padding-inline: 0;
    }
    .queue-metric {
      padding-inline: 12px;
    }
    .queue-sidecar {
      grid-template-columns: 1fr;
    }
    .saved-views {
      grid-column: auto;
    }
  }
</style>
