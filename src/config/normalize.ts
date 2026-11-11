export function flattenRuntimeConfig(raw: any): any {
  if (!raw || typeof raw !== 'object') return raw;
  const grouped = raw as any;
  const usesGrouped =
    grouped.discovery &&
    grouped.discovery.keywords &&
    grouped.llm &&
    grouped.decision &&
    grouped.presentation &&
    grouped.observability;
  if (!usesGrouped) return raw;
  const keywords = grouped.discovery.keywords ?? {};
  const search = keywords.search ?? {};
  const flattened: any = {
    discovery: { shared: grouped.discovery.shared ?? true },
    includeKeywords: keywords.include ?? [],
    includeOnly: keywords.includeOnly ?? false,
    skipCooldownForKeywords: keywords.skipCooldown ?? true,
    bonusConfidence: keywords.bonusConfidence ?? 0,
    excludeTags: keywords.excludeTags ?? [],
    keywordSearchLimitPerType: search.limitPerType ?? grouped.keywordSearchLimitPerType ?? 8,
    keywordSearchPageMax: search.pageMax ?? grouped.keywordSearchPageMax ?? 5,
    keywordSearchSort: search.sort ?? grouped.keywordSearchSort ?? 'trending',
    polling: grouped.discovery.polling ?? grouped.polling,
    cooldowns: grouped.discovery.cooldowns ?? grouped.cooldowns ?? {},
    marketData: grouped.discovery.marketData ?? grouped.marketData,
    researchProfiles: grouped.llm.profiles ?? grouped.researchProfiles,
    research: grouped.llm.research ?? grouped.research,
    tradeEvaluation: grouped.decision.tradeEvaluation ?? grouped.tradeEvaluation,
    fees: grouped.decision.fees ?? grouped.fees,
    risk: grouped.decision.risk ?? grouped.risk,
    exits: grouped.decision.exits ?? grouped.exits,
    execution: grouped.execution ?? {},
    portfolio: grouped.portfolio?.balances ?? grouped.portfolio,
    marksRefresher: grouped.portfolio?.marks ?? grouped.marksRefresher,
    portfolioHistory: grouped.portfolio?.history ?? grouped.portfolioHistory,
    ui: grouped.presentation?.ui ?? grouped.ui,
    charts: grouped.presentation?.charts ?? grouped.charts,
    evaluations: grouped.presentation?.evaluations ?? grouped.evaluations,
    http: grouped.observability?.http ?? grouped.http,
    logging: grouped.observability?.logging ?? grouped.logging
  };
  if (grouped.agent) flattened.agent = grouped.agent;
  if (grouped.prompts) flattened.prompts = grouped.prompts;
  else if (grouped.llm?.prompts) flattened.prompts = grouped.llm.prompts;
  return flattened;
}
