import { z } from 'zod';

/** Smart-playlist rule definition (spec §3.7). Evaluated on-device from local data. */
export const statusValue = z.enum(['unplayed', 'inProgress', 'played']);

export const smartRuleSchema = z.discriminatedUnion('field', [
  z.object({ field: z.literal('podcast'), op: z.enum(['in', 'notIn']), value: z.array(z.string().max(100)).max(1000) }),
  z.object({ field: z.literal('status'), op: z.literal('is'), value: statusValue }),
  z.object({ field: z.literal('releasedWithin'), op: z.literal('days'), value: z.number().min(0).max(36500) }),
  z.object({ field: z.literal('duration'), op: z.enum(['lt', 'gt']), value: z.number().min(0).max(100000) }),
  z.object({ field: z.literal('downloaded'), op: z.literal('is'), value: z.boolean() }),
  z.object({ field: z.literal('starred'), op: z.literal('is'), value: z.boolean() }),
  z.object({ field: z.literal('title'), op: z.literal('contains'), value: z.string().max(200) }),
]);

export const smartPlaylistDefinitionSchema = z.object({
  name: z.string().min(1).max(120),
  match: z.enum(['all', 'any']),
  rules: z.array(smartRuleSchema).max(50),
  sort: z.object({ field: z.enum(['releasedAt', 'duration', 'title']), dir: z.enum(['asc', 'desc']) }),
  limit: z.number().int().min(1).max(1000).optional(),
  autoDownload: z.boolean().optional(),
});

export type SmartRule = z.infer<typeof smartRuleSchema>;
export type SmartPlaylistDefinition = z.infer<typeof smartPlaylistDefinitionSchema>;

/** The local-database view of an episode that rules are evaluated against. */
export interface EpisodeView {
  id: string;
  podcastId: string;
  title: string;
  /** Milliseconds since epoch. */
  releasedAt: number;
  durationSec: number;
  status: 'unplayed' | 'inProgress' | 'played';
  downloaded: boolean;
  starred: boolean;
}

export function ruleMatches(rule: SmartRule, ep: EpisodeView, now: number): boolean {
  switch (rule.field) {
    case 'podcast':
      return rule.op === 'in' ? rule.value.includes(ep.podcastId) : !rule.value.includes(ep.podcastId);
    case 'status':
      return ep.status === rule.value;
    case 'releasedWithin':
      return ep.releasedAt >= now - rule.value * 86_400_000 && ep.releasedAt <= now;
    case 'duration': {
      const minutes = ep.durationSec / 60;
      return rule.op === 'lt' ? minutes < rule.value : minutes > rule.value;
    }
    case 'downloaded':
      return ep.downloaded === rule.value;
    case 'starred':
      return ep.starred === rule.value;
    case 'title':
      return ep.title.toLowerCase().includes(rule.value.toLowerCase());
  }
}

/**
 * Evaluate a smart playlist. Returns episode ids in order.
 * An empty rule list matches every episode (for both `all` and `any`).
 * Sorting is stable with `id` as the final tiebreaker so every platform agrees.
 */
export function evaluateSmartPlaylist(def: SmartPlaylistDefinition, episodes: EpisodeView[], now: number): string[] {
  const matched = episodes.filter((ep) => {
    if (def.rules.length === 0) return true;
    return def.match === 'all' ? def.rules.every((r) => ruleMatches(r, ep, now)) : def.rules.some((r) => ruleMatches(r, ep, now));
  });
  const dir = def.sort.dir === 'asc' ? 1 : -1;
  matched.sort((a, b) => {
    let c = 0;
    if (def.sort.field === 'title') c = a.title.localeCompare(b.title, 'en', { sensitivity: 'base' });
    else if (def.sort.field === 'duration') c = a.durationSec - b.durationSec;
    else c = a.releasedAt - b.releasedAt;
    if (c !== 0) return c * dir;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return (def.limit ? matched.slice(0, def.limit) : matched).map((e) => e.id);
}

/** Speed resolution (spec §3.3): podcast override, then global default. */
export function resolveSpeed(settings: { defaultSpeed: number; podcastSpeeds: Record<string, number> }, podcastId: string): number {
  const override = settings.podcastSpeeds[podcastId];
  return override !== undefined ? override : settings.defaultSpeed;
}
