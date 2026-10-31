import "dotenv/config";
import readline from "node:readline";
import {
  countPendingGeocodes,
  formatDuration,
  runPipeline,
} from "../services/pipeline.js";

// Coordinates only, no AI cost: `npm run coords_populate [--all|--top]`
// geocodes pending entities via GEOCODE_BACKEND ("local" default, or "modal").
// Interactive when a TTY: all N addresses (~hours at 1 req/s) vs the biggest
// Nasdaq-100 (~2 minutes). Non-interactive defaults to top (safe).
async function askScope(pending: number): Promise<"all" | "top"> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(
        `Initial seed run geocodes business addresses via OpenStreetMap Nominatim ` +
          `(max 1 request/second per their Usage Policy).\nGeocode all ${pending} ` +
          `addresses (~${formatDuration(pending * 1.1)}) or only the biggest ` +
          `Nasdaq-100 (~2 minutes)? [all/top] (default: top) `,
        resolve,
      );
    });
    return answer.trim().toLowerCase().startsWith("a") ? "all" : "top";
  } finally {
    rl.close();
  }
}

const args = process.argv.slice(2);
const pending = await countPendingGeocodes();
let scope: "all" | "top";
if (args.includes("--all")) {
  scope = "all";
} else if (args.includes("--top")) {
  scope = "top";
} else if (!process.stdin.isTTY) {
  scope = "top";
  console.log("[coords] non-interactive: defaulting to top 100");
} else {
  scope = await askScope(pending);
}

if (scope === "top") {
  const summary = await runPipeline({
    normalize: false,
    take: 100,
    indexOnly: true,
  });
  console.log(summary);
} else {
  // Loop 500/run until a run places nothing new (skips are cached misses,
  // so re-scans are cheap); the run cap is a backstop, not a target.
  let runs = 0;
  for (;;) {
    const summary = await runPipeline({ normalize: false, take: 500 });
    runs += 1;
    console.log(`[coords] run ${runs}:`, summary);
    if (summary.geocoded === 0 || summary.scanned === 0 || runs >= 500) {
      break;
    }
  }
}
