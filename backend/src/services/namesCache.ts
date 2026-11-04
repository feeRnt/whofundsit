import fs from "node:fs";
import path from "node:path";

// Decision cache for `npm run names:sync`: CIKs the operator declined at
// the interactive prompt are remembered in gitignored
// backend/data/cache/names-sync.json so the next run stops re-asking and
// `--cached` can revisit them. Keyed by CIK string; applied rows vanish
// from `changed` on their own (the DB now matches), stale keys are pruned.
export interface SkippedName {
  old: string;
  want: string;
  at: string;
}

export type SkippedMap = Record<string, SkippedName>;

export function loadSkipped(cacheFile: string): SkippedMap {
  try {
    const raw = fs.readFileSync(cacheFile, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as SkippedMap;
    }
  } catch {
    // Missing or corrupt: start empty, never crash the sync.
  }
  return {};
}

export function saveSkipped(cacheFile: string, skipped: SkippedMap): void {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(skipped, null, 2) + "\n");
}

export interface Partition {
  // In changed, never declined: the normal run targets these.
  fresh: Map<number, string>;
  // In changed AND declined before: `--cached` revisits these.
  revisit: { cik: number; old: string; want: string }[];
  // Declined before but no longer in changed: prune these keys.
  stale: string[];
}

export function partitionChanged(
  changed: Map<number, string>,
  current: Map<number, string>,
  skipped: SkippedMap,
): Partition {
  const fresh = new Map<number, string>();
  const revisit: Partition["revisit"] = [];
  for (const [cik, want] of changed) {
    const prior = skipped[String(cik)];
    if (prior) {
      revisit.push({
        cik,
        old: current.get(cik) ?? prior.old,
        want,
      });
    } else {
      fresh.set(cik, want);
    }
  }
  const stale = Object.keys(skipped).filter((k) => !changed.has(Number(k)));
  return { fresh, revisit, stale };
}
