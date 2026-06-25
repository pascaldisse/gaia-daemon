interface RoutePlan {
  targets: string[];
}

type RouteResult = { ok: true; plan: RoutePlan } | { ok: false; unknown: string[] };

const MENTION_PATTERN = /@([a-z0-9_-]+)/gi;

export function planMentionRoute(message: string, agentIds: string[], defaultAgent: string): RouteResult {
  const known = new Set(agentIds);
  const mentions: string[] = [];
  const seen = new Set<string>();
  const unknown: string[] = [];
  const unknownSeen = new Set<string>();

  for (const match of message.matchAll(MENTION_PATTERN)) {
    const id = match[1].toLowerCase();
    if (!known.has(id)) {
      if (!unknownSeen.has(id)) {
        unknown.push(id);
        unknownSeen.add(id);
      }
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    mentions.push(id);
  }

  if (unknown.length > 0) return { ok: false, unknown };
  return { ok: true, plan: { targets: mentions.length > 0 ? mentions : [defaultAgent] } };
}
