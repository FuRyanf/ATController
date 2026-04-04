import type { SkillInfo } from '../types';

const SKILL_USAGE_STORAGE_KEY = 'claudex:skill-usage';

export interface SkillUsageStats {
  lastUsedAt: number;
  pinned: boolean;
}

export type SkillUsageMap = Record<string, SkillUsageStats>;

function makeSkillUsageKey(workspacePath: string, skillId: string): string {
  return `${workspacePath}::${skillId}`;
}

function normalizeSkillUsageStats(value: unknown): SkillUsageStats | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const lastUsedAt =
    typeof record.lastUsedAt === 'number' && Number.isFinite(record.lastUsedAt) ? Math.max(0, Math.trunc(record.lastUsedAt)) : 0;
  const pinned = record.pinned === true;

  return { lastUsedAt, pinned };
}

export function loadSkillUsageMap(): SkillUsageMap {
  if (typeof window === 'undefined') {
    return {};
  }

  const raw = window.localStorage.getItem(SKILL_USAGE_STORAGE_KEY);
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const normalized: SkillUsageMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!key) {
        continue;
      }
      const stats = normalizeSkillUsageStats(value);
      if (!stats) {
        continue;
      }
      normalized[key] = stats;
    }
    return normalized;
  } catch {
    return {};
  }
}

export function persistSkillUsageMap(map: SkillUsageMap) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const entries = Object.entries(map).filter(([, value]) => value.pinned || value.lastUsedAt > 0);
    if (entries.length === 0) {
      window.localStorage.removeItem(SKILL_USAGE_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(SKILL_USAGE_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // best effort
  }
}

export function getSkillUsageStats(map: SkillUsageMap, workspacePath: string, skillId: string): SkillUsageStats {
  return map[makeSkillUsageKey(workspacePath, skillId)] ?? { lastUsedAt: 0, pinned: false };
}

export function toggleSkillPinned(
  map: SkillUsageMap,
  workspacePath: string,
  skillId: string
): SkillUsageMap {
  const key = makeSkillUsageKey(workspacePath, skillId);
  const current = map[key] ?? { lastUsedAt: 0, pinned: false };
  return {
    ...map,
    [key]: {
      ...current,
      pinned: !current.pinned
    }
  };
}

export function recordSkillUsage(
  map: SkillUsageMap,
  workspacePath: string,
  skillIds: string[],
  nowMs = Date.now()
): SkillUsageMap {
  if (skillIds.length === 0) {
    return map;
  }

  const next = { ...map };
  for (const skillId of skillIds) {
    if (!skillId) {
      continue;
    }
    const key = makeSkillUsageKey(workspacePath, skillId);
    const current = next[key] ?? { lastUsedAt: 0, pinned: false };
    next[key] = {
      ...current,
      lastUsedAt: nowMs
    };
  }
  return next;
}

export function sortSkillsForDisplay(
  skills: SkillInfo[],
  workspacePath: string,
  usageMap: SkillUsageMap
): SkillInfo[] {
  return [...skills].sort((left, right) => {
    const leftUsage = getSkillUsageStats(usageMap, workspacePath, left.id);
    const rightUsage = getSkillUsageStats(usageMap, workspacePath, right.id);

    if (leftUsage.pinned !== rightUsage.pinned) {
      return leftUsage.pinned ? -1 : 1;
    }

    if (leftUsage.lastUsedAt !== rightUsage.lastUsedAt) {
      return rightUsage.lastUsedAt - leftUsage.lastUsedAt;
    }

    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
  });
}

export function matchesSkillSearch(
  skill: Pick<SkillInfo, 'id' | 'name' | 'description'>,
  query: string
): boolean {
  const terms = query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  if (terms.length === 0) {
    return true;
  }

  const haystack = `${skill.name}\n${skill.id}\n${skill.description}`.toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}
