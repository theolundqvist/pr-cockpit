import { getPr, setAutoMergeArmed } from "./db.ts";
import { getFixerAgent, launchAutofixAgent, launchCustomAgent, launchFixerAgent } from "./agents.ts";
import { maybeRescore } from "./rescorer.ts";
import { agentSettings, CUSTOM_AGENT_ID_PREFIX } from "./settings.ts";
import { prKeyOf } from "./prKey.ts";

const QUIESCENCE_MS = 120_000;
const pendingTimers = new Map<string, Timer>();

export function onPrActivity(repo: string, number: number, knownBefore: boolean): void {
  const key = prKeyOf(repo, number);
  const existing = pendingTimers.get(key);
  if (existing) clearTimeout(existing);
  pendingTimers.set(
    key,
    setTimeout(() => {
      pendingTimers.delete(key);
      dispatch(repo, number, knownBefore).catch((err) => console.error(`activity dispatch failed for ${key}:`, err));
    }, QUIESCENCE_MS),
  );
}

async function dispatch(repo: string, number: number, knownBefore: boolean): Promise<void> {
  for (const agent of agentSettings()) {
    if (!agent.enabled || agent.trigger !== "activity") continue;
    if (agent.id === "rescorer") {
      await maybeRescore(repo, number);
      continue;
    }
    // knownBefore=false is first sight (boot / new PR), not real push activity - launching there would arm every PR at startup
    if (!knownBefore) continue;
    if (agent.id.startsWith(CUSTOM_AGENT_ID_PREFIX) && !agent.prompt_template.trim()) continue;
    const pr = getPr(repo, number);
    // work agents push to the branch - only ever auto-launch on the viewer's own open PRs
    if (!pr || pr.state !== "OPEN" || pr.viewer_is_author !== 1) continue;
    const slot = getFixerAgent(repo, number);
    // killed/gave-up means this PR's agent was explicitly stopped - never auto-relaunch, require a manual re-arm
    if (slot && (slot.state === "running" || slot.state === "killed" || slot.exit_reason === "gave-up")) continue;
    try {
      if (agent.id === "fixer") {
        await launchFixerAgent(repo, number);
        setAutoMergeArmed(repo, number, true);
      } else if (agent.id === "autofix") {
        await launchAutofixAgent(repo, number);
      } else {
        await launchCustomAgent(repo, number, agent.id);
      }
    } catch (err) {
      console.error(`activity launch of ${agent.id} failed for ${repo}#${number}:`, err);
    }
  }
}
