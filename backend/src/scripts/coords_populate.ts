import "dotenv/config";
import readline from "node:readline";
import {
  countFailedGeocodes,
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
// Census repass over LLM-flagged rows only: one batched POST per 500,
// hits written + marked placed, the rest stay failed. Fast (no paced
// queries) and safe to run before the main queue resumes.
if (args.includes("--census-failed")) {
  const failed = await countFailedGeocodes();
  console.log(`[coords] census-failed: ${failed} failed rows queued`);
  let runs = 0;
  for (;;) {
    const summary = await runPipeline({ take: 500, censusFailed: true });
    runs += 1;
    console.log(`[coords] census-failed run ${runs}:`, summary);
    if (summary.scanned === 0 || runs >= 500) {
      break;
    }
  }
  process.exit(0);
}
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

const retryFailed = args.includes("--retry-failed");
console.log(`[coords] pending: ${pending} addresses`);
if (scope === "top") {
  const summary = await runPipeline({
    normalize: false,
    take: 100,
    indexOnly: true,
    retryFailed,
  });
  console.log(summary);
} else {
  // Loop 500/run to the end of the queue. A fruitless FULL batch means its
  // rows are all sticky cached misses, so page past them (skip) instead of
  // quitting — quitting here once stranded ~16k entities behind 500 misses.
  // Progress reshuffles the queue, so restart from the top after any hit.
  let runs = 0;
  let skip = 0;
  for (;;) {
    const summary = await runPipeline({
      normalize: false,
      take: 500,
      skip,
      retryFailed,
    });
    runs += 1;
    console.log(`[coords] run ${runs}:`, summary);
    if (summary.scanned === 0 || runs >= 500) {
      break;
    }
    if (summary.geocoded === 0) {
      if (summary.scanned < 500) {
        break; // tail batch exhausted: nothing left to try
      }
      skip += summary.scanned;
    } else {
      skip = 0;
    }
  }
}
