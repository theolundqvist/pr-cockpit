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
import { startCockpitServer } from "./cockpitServer.ts";
import { ensureOmpInstalled } from "./commitMessage.ts";
import { replicaEnabled, startReplicaSync } from "./replica.ts";

const port = Number(Bun.env.COCKPIT_PORT ?? 4820);

try {
  installMockNetworkGuard();
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
  startCockpitServer(port, fetchHandler);

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

  console.log(`pr-cockpit server listening on http://127.0.0.1:${port} (pid ${process.pid})`);
} catch (err) {
  console.error(`pr-cockpit server failed to start on http://127.0.0.1:${port} (pid ${process.pid}):`, err);
  process.exit(1);
}
