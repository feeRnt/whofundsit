// Wipe interlock for `npm run db:seed`: a fresh demo DB sails through, but
// a populated one (e.g. the maintainer's dev DB) aborts unless the wipe is
// explicit via DEMO_WIPE_OK=1. Pure for testing.
export function wipeRefusal(
  entityCount: number,
  flowCount: number,
  optIn: string | undefined,
): string | null {
  if (entityCount + flowCount > 0 && optIn !== "1") {
    return (
      `refusing to wipe non-empty DB (${entityCount} entities, ${flowCount} flows) — ` +
      "point DATABASE_URL at a fresh database for the demo, or retry with DEMO_WIPE_OK=1"
    );
  }
  return null;
}
