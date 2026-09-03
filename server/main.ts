import { db, failInterruptedMutations } from "./db.ts";
import { recoverRefreshingMutations } from "./mutations.ts";
import { seedSettings } from "./settings.ts";
import { startPoller } from "./poller.ts";
import { startDaemonWatch } from "./daemonWatch.ts";
import { startRelayClient } from "./relayClient.ts";
import { startUpdateCheck } from "./version.ts";
import { startFixerSupervision } from "./agents.ts";
import { startForwarders } from "./forwarders.ts";
import { startWebhooks } from "./webhooks.ts";
import { buildFetchHandler } from "./http.ts";
import { installMockNetworkGuard, isMockGithub, seedMockDatabase } from "./mockGithub.ts";
import { mergeRendererOrigins, startCockpitServer } from "./cockpitServer.ts";
import { ensureOmpInstalled } from "./commitMessage.ts";
import { replicaEnabled, startReplicaSync } from "./replica.ts";
import { captureFatal, startSentry } from "./sentry.ts";
import { startTailscaleServe } from "./tailscaleServe.ts";
import { conflictingSupervisor } from "./supervisor.ts";

const port = Number(Bun.env.COCKPIT_PORT ?? 4820);
const supervisorConflict = conflictingSupervisor(port);
if (supervisorConflict) {
  console.log(`pr-cockpit: ${supervisorConflict} owns port ${port}; unmanaged server will not start`);
  process.exit(0);
}

try {
  installMockNetworkGuard();
  if (!isMockGithub) startSentry();
  seedSettings();
  if (isMockGithub) {
    if (!Bun.env.COCKPIT_DATA_DIR) throw new Error("COCKPIT_MOCK requires an explicit COCKPIT_DATA_DIR");
    seedMockDatabase(db, Bun.env.COCKPIT_DATA_DIR);
  } else if (replicaEnabled()) {
    await startReplicaSync();
  } else {
    failInterruptedMutations();
    await recoverRefreshingMutations();
  }

  const fetchHandler = buildFetchHandler(port);
  // Serve is opt-in and best-effort; a missing binary or failed publish must not block loopback.
  const serve = await startTailscaleServe(port, isMockGithub ? { enabled: false } : {});
  startCockpitServer(port, fetchHandler, mergeRendererOrigins(Bun.env.COCKPIT_ALLOWED_ORIGINS, serve.origin));

  if (!isMockGithub && !replicaEnabled()) {
    startForwarders(port);
    startPoller();
    startDaemonWatch();
    startRelayClient();
    startFixerSupervision();
    void ensureOmpInstalled().catch((error) => console.error("background OMP installation failed:", error));
    startWebhooks();
  }
  if (!isMockGithub) startUpdateCheck();

  if (serve.enabled && serve.error) {
    console.error(`pr-cockpit: Tailscale Serve failed (${serve.error}); loopback server is still running on http://127.0.0.1:${port}`);
  } else if (serve.origin) {
    console.log(`pr-cockpit: Tailscale Serve ${serve.origin} → http://127.0.0.1:${port}`);
  }
  console.log(`pr-cockpit server listening on http://127.0.0.1:${port} (pid ${process.pid})`);
} catch (err) {
  console.error(`pr-cockpit server failed to start on http://127.0.0.1:${port} (pid ${process.pid}):`, err);
  await captureFatal(err);
  process.exit(1);
}
