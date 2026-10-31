import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Merge a duplicate entity into its canonical row: repoint every flow
// touching the dropped id, delete flows that would become self-loops,
// then delete the dropped row. Used for e.g. Colgate's OpenAlex funder
// row (openalex:F4320307808) absorbing its institution twin
// (openalex:I4210135004, "Colgate-Palmolive (United States)").

export interface MergeFlow {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
}

export interface MergePlan {
  /** Flow ids to repoint from dropId to keepId. */
  repoint: string[];
  /** Repointed flows that become self-loops and must be deleted. */
  dropSelf: string[];
}

export interface MergedRow {
  id: string;
  name: string;
  source: string;
}

// Pure provenance append (unit-tested): the keep row accumulates every
// dropped row's identity so the popup can show the original companies.
export function mergeProvenance(
  existing: unknown,
  drop: MergedRow,
): MergedRow[] {
  const list = Array.isArray(existing)
    ? (existing as MergedRow[]).filter(
        (r) => r && typeof r.id === "string" && r.id !== drop.id,
      )
    : [];
  return [...list, drop];
}

// Pure planner (unit-tested); the runner below only executes the plan.
export function planMerge(
  flows: MergeFlow[],
  keepId: string,
  dropId: string,
): MergePlan {
  const touching = flows.filter(
    (f) => f.sourceEntityId === dropId || f.targetEntityId === dropId,
  );
  const repoint = touching.map((f) => f.id);
  const dropSelf = touching
    .filter(
      (f) =>
        (f.sourceEntityId === dropId ? keepId : f.sourceEntityId) ===
        (f.targetEntityId === dropId ? keepId : f.targetEntityId),
    )
    .map((f) => f.id);
  return { repoint, dropSelf };
}

export async function runMerge(keepId: string, dropId: string) {
  if (keepId === dropId) {
    throw new Error("[merge] keep and drop ids are identical, refusing");
  }
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  });
  const prisma = new PrismaClient({ adapter });
  try {
    const keep = await prisma.entity.findUnique({ where: { id: keepId } });
    if (!keep) {
      throw new Error(`[merge] canonical row missing: ${keepId}`);
    }
    const drop = await prisma.entity.findUnique({ where: { id: dropId } });
    if (!drop) {
      return { keepId, dropId, status: "drop-missing-noop" as const };
    }
    const flows = await prisma.capitalFlow.findMany({
      where: { OR: [{ sourceEntityId: dropId }, { targetEntityId: dropId }] },
      select: { id: true, sourceEntityId: true, targetEntityId: true },
    });
    const plan = planMerge(flows, keepId, dropId);
    const provenance = mergeProvenance(keep.mergedFrom, {
      id: drop.id,
      name: drop.name,
      source: drop.source,
    });
    await prisma.$transaction([
      prisma.capitalFlow.updateMany({
        where: { sourceEntityId: dropId },
        data: { sourceEntityId: keepId },
      }),
      prisma.capitalFlow.updateMany({
        where: { targetEntityId: dropId },
        data: { targetEntityId: keepId },
      }),
      prisma.capitalFlow.deleteMany({ where: { id: { in: plan.dropSelf } } }),
      prisma.entity.update({
        where: { id: keepId },
        data: { mergedFrom: provenance as unknown as Prisma.InputJsonValue },
      }),
      prisma.entity.delete({ where: { id: dropId } }),
    ]);
    return {
      keepId,
      dropId,
      keptName: keep.name,
      droppedName: drop.name,
      repointed: plan.repoint.length,
      selfLoopsDeleted: plan.dropSelf.length,
    };
  } finally {
    await prisma.$disconnect();
  }
}
