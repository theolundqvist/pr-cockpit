const fs = require("fs");
const path = require("path");

let recording = false;

async function recordPerformanceProfile(window, serverOrigin, seconds = 20) {
  if (recording) throw new Error("A performance recording is already active");
  if (!window || window.isDestroyed()) throw new Error("Open the main window before recording");
  recording = true;
  const contents = window.webContents;
  const debuggerSession = contents.debugger;
  let attached = false;
  let observing = false;
  try {
    if (debuggerSession.isAttached()) throw new Error("Close DevTools before recording a performance profile");
    debuggerSession.attach("1.3");
    attached = true;
    await debuggerSession.sendCommand("Profiler.enable");
    await debuggerSession.sendCommand("Performance.enable");
    const start = await debuggerSession.sendCommand("Performance.getMetrics");
    await contents.executeJavaScript(`(() => {
      window.__cockpitProfileTasks = [];
      window.__cockpitProfileObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) window.__cockpitProfileTasks.push({startTime: entry.startTime, duration: entry.duration});
      });
      window.__cockpitProfileObserver.observe({type: 'longtask'});
    })()`);
    observing = true;
    await debuggerSession.sendCommand("Profiler.start");
    const response = await fetch(`${serverOrigin}/api/debug/profile?seconds=${seconds}`, { method: "POST" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Server profiling failed");
    const { profile } = await debuggerSession.sendCommand("Profiler.stop");
    const end = await debuggerSession.sendCommand("Performance.getMetrics");
    const longTasks = await contents.executeJavaScript(`(() => {
      const observer = window.__cockpitProfileObserver;
      for (const entry of observer.takeRecords()) window.__cockpitProfileTasks.push({startTime: entry.startTime, duration: entry.duration});
      observer.disconnect();
      const tasks = window.__cockpitProfileTasks;
      delete window.__cockpitProfileObserver;
      delete window.__cockpitProfileTasks;
      return tasks;
    })()`);
    observing = false;
    const metrics = (result) => Object.fromEntries(result.metrics.filter(x => ["JSHeapUsedSize", "JSHeapTotalSize", "Nodes"].includes(x.name)).map(x => [x.name, x.value]));
    const times = new Map();
    for (let i = 0; i < profile.samples.length; i++) times.set(profile.samples[i], (times.get(profile.samples[i]) || 0) + profile.timeDeltas[i] / 1000);
    const top = profile.nodes.map(x => ({ name: x.callFrame.functionName || "(anonymous)", url: x.callFrame.url, selfMs: times.get(x.id) || 0 })).sort((a, b) => b.selfMs - a.selfMs).slice(0, 15);
    fs.writeFileSync(path.join(result.directory, "renderer.cpuprofile"), JSON.stringify(profile));
    const summaryPath = path.join(result.directory, "summary.json");
    const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    summary.renderer = { start: metrics(start), end: metrics(end), longTasks: { count: longTasks.length, totalMs: longTasks.reduce((sum, task) => sum + task.duration, 0), samples: longTasks }, topFunctions: top };
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    const markdownPath = path.join(result.directory, "summary.md");
    const markdown = fs.readFileSync(markdownPath, "utf8").replace(/CLI records the server only;[^\n]+\n/, "");
    fs.writeFileSync(markdownPath, markdown + `\n## Renderer\n\n${longTasks.length} long tasks; ${summary.renderer.longTasks.totalMs.toFixed(1)} ms total. Heap ${summary.renderer.start.JSHeapUsedSize} → ${summary.renderer.end.JSHeapUsedSize} bytes; DOM nodes ${summary.renderer.start.Nodes} → ${summary.renderer.end.Nodes}.\n\n${top.map(x => `- ${x.selfMs.toFixed(1)} ms: ${x.name} (${x.url})`).join("\n")}\n`);
    return result.directory;
  } finally {
    if (observing && !contents.isDestroyed()) await contents.executeJavaScript("window.__cockpitProfileObserver?.disconnect(); delete window.__cockpitProfileObserver; delete window.__cockpitProfileTasks;").catch(() => {});
    if (attached && !contents.isDestroyed()) debuggerSession.detach();
    recording = false;
  }
}

module.exports = { recordPerformanceProfile };
