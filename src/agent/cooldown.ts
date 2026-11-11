import type { AgentRepository } from './repository';
import type { AgentRepositoryAsync } from '../storage/types';

export async function shouldSkipMarket(
  repo: AgentRepository | AgentRepositoryAsync,
  agentId: string,
  marketId: string,
  postDecisionMinutes: number,
  options: { skipDecisionCooldown?: boolean } = {},
  now: Date = new Date()
): Promise<boolean> {
  const cooldownMinutes = Math.max(0, postDecisionMinutes || 0);
  // Fill-based cooldown (trade recency)
  if (cooldownMinutes > 0) {
    const last = await (repo as any).getLastFillTime(agentId, marketId);
    if (last) {
      const msSince = now.getTime() - last.getTime();
      const threshold = cooldownMinutes * 60 * 1000;
      if (msSince < threshold) return true;
    }
  }

  // Evaluation/decision suppression cooldown
  if (!options.skipDecisionCooldown && cooldownMinutes > 0) {
    const reasons: string[] = await (repo as any).getActiveCooldownReasons(agentId, marketId, now);
    // Ignore discovery-only cooldown here; selection handles discovery suppression.
    const actionable = reasons.filter((r) => r !== 'discovery');
    if (actionable.length > 0) return true;
  }

  return false;
}
