import axios from "axios";
import {
  apiLog,
  modalProxyHeaders,
  MODAL_PROXY_ENV_HINT,
  userAgentFromEnv,
} from "./httpCache.js";

// LLM address formalization (dead-lines consumer, step 1 of the adopted
// pipeline): deformed address -> Llama on Modal -> structured fields ->
// Census batch (US) / Nominatim (foreign) -> exact coords. The LLM only
// PARSES; it never invents coordinates. Standalone by design: this module
// writes nothing — no DB, no cache files, no dead-lines — callers decide
// what to persist after the geocoders verify the parse.

export interface FormalizedAddress {
  houseNumber: string | null;
  street: string | null;
  city: string | null;
  stateOrRegion: string | null;
  postalCode: string | null;
  country: string | null;
  countryCode: string | null;
}

export interface FormalizeResult {
  original: string;
  address: FormalizedAddress;
  confidence: number | null;
  // Human-readable notes from the model (what it stripped/assumed).
  notes: string;
  // Machine cause when the address cannot be formalized, else null:
  // po-box | missing-house-number | missing-postal-code |
  // ambiguous-country | registrant-name-not-address | multi-address |
  // llm-call-failed | llm-unparsable-output | other
  failureCause: string | null;
}

const EMPTY: FormalizedAddress = {
  houseNumber: null,
  street: null,
  city: null,
  stateOrRegion: null,
  postalCode: null,
  country: null,
  countryCode: null,
};

export function formalizePrompt(text: string): string {
  return (
    "Parse this postal address into fields. Reply with ONLY a JSON object: " +
    '{"houseNumber": string|null, "street": string|null, "city": string|null, ' +
    '"stateOrRegion": string|null, "postalCode": string|null, ' +
    '"country": string|null, "countryCode": string|null, ' +
    '"confidence": number, "notes": string, "failureCause": string|null}. ' +
    "Rules: never invent a house number, postal code, or coordinates; drop " +
    "suite/floor/unit designators into notes; expand nothing you are unsure " +
    "of. When the text cannot be formalized (PO box, registrant name with " +
    "no address, missing house number, ambiguous country), set the fields " +
    "you cannot support to null, confidence low, failureCause to one of " +
    "po-box, missing-house-number, missing-postal-code, ambiguous-country, " +
    "registrant-name-not-address, multi-address, other, and explain the " +
    `cause in notes. Address: ${text}`
  );
}

// Retry prompt for pass N>1: the model sees what failed and why, and is
// told the consumer is Nominatim (no match = try a different segmentation).
export function formalizeRetryPrompt(
  original: string,
  prevTried: string | null,
  prevCause: string | null,
  pass: number,
): string {
  return (
    `Attempt ${pass}: a previous parse of this address FAILED on Nominatim ` +
    "(OpenStreetMap's geocoder returned no match), so segment it differently. " +
    "Reply with ONLY a JSON object: " +
    '{"houseNumber": string|null, "street": string|null, "city": string|null, ' +
    '"stateOrRegion": string|null, "postalCode": string|null, ' +
    '"country": string|null, "countryCode": string|null, ' +
    '"confidence": number, "notes": string, "failureCause": string|null}. ' +
    "Rules: never invent a house number, postal code, or coordinates; try " +
    "alternate readings (a different street/city split, expand abbreviations, " +
    "drop registrant prefixes like C/O); explain the new reading in notes. " +
    (prevTried ? `Previous attempt sent to Nominatim: ${prevTried}. ` : "") +
    (prevCause ? `Previous failure cause: ${prevCause}. ` : "") +
    `Original address: ${original}`
  );
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

// Validate one model reply (object or fenced/raw string). Never throws:
// bad output becomes a failureCause the caller can count and inspect.
export function parseFormalizeResponse(raw: unknown, original: string): FormalizeResult {
  let doc: Record<string, unknown> | null = null;
  if (typeof raw === "string") {
    const cleaned = raw.replace(/```json|```/g, "").trim();
    try {
      const parsed: unknown = JSON.parse(cleaned);
      if (typeof parsed === "object" && parsed !== null) {
        doc = parsed as Record<string, unknown>;
      }
    } catch {
      doc = null;
    }
  } else if (typeof raw === "object" && raw !== null) {
    doc = raw as Record<string, unknown>;
  }
  if (!doc) {
    return {
      original,
      address: { ...EMPTY },
      confidence: null,
      notes: `unparsable model output: ${String(raw).slice(0, 200)}`,
      failureCause: "llm-unparsable-output",
    };
  }
  const conf = doc.confidence;
  return {
    original,
    address: {
      houseNumber: str(doc.houseNumber),
      street: str(doc.street),
      city: str(doc.city),
      stateOrRegion: str(doc.stateOrRegion),
      postalCode: str(doc.postalCode),
      country: str(doc.country),
      countryCode: str(doc.countryCode)?.toUpperCase() ?? null,
    },
    confidence:
      typeof conf === "number" && Number.isFinite(conf)
        ? Math.min(1, Math.max(0, conf))
        : null,
    notes: str(doc.notes) ?? "",
    failureCause: str(doc.failureCause),
  };
}

export type FormalizeCaller = (text: string) => Promise<unknown>;

// OpenAI-chat contract (stock vLLM server): system rules + full address
// prompt as user, reply must be the fields JSON object.
// MODAL_FORMALIZE_URL holds the server base (https://....modal.direct);
// the client appends /v1/chat/completions. Same proxy-token auth as
// before: servers require it unless deployed unauthenticated.
const FORMALIZE_CHAT_PATH = "/v1/chat/completions";
const FORMALIZE_CHAT_MODEL_FALLBACK = "meta-models/Muse-Glimmer-30B";
const FORMALIZE_CHAT_SYSTEM =
  "You are a postal address parser. Reply with ONLY the JSON object the user describes.";

function formalizeChatRequest(text: string) {
  return {
    model: process.env.MODAL_FORMALIZE_MODEL ?? FORMALIZE_CHAT_MODEL_FALLBACK,
    messages: [
      { role: "system", content: FORMALIZE_CHAT_SYSTEM },
      { role: "user", content: formalizePrompt(text) },
    ],
    temperature: 0,
    max_tokens: 224,
    stream: false,
  };
}

function formalizeEndpoint(): { url: string; headers: Record<string, string> } {
  const base = (process.env.MODAL_FORMALIZE_URL ?? "").replace(/\/+$/, "");
  if (!base) {
    throw new Error(
      "MODAL_FORMALIZE_URL is not set (deploy backend/formalize_worker.py; see backend/.env.example)",
    );
  }
  warnIfNotEndpointUrl(base);
  const auth = modalProxyHeaders();
  if (!auth) {
    throw new Error(`Modal proxy auth is not configured — ${MODAL_PROXY_ENV_HINT}`);
  }
  return {
    url: `${base}${FORMALIZE_CHAT_PATH}`,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": userAgentFromEnv("MODAL_USER_AGENT", "WhoFundsIt/0.1"),
      ...auth,
    },
  };
}

function chatContent(data: unknown): unknown {
  const content = (data as { choices?: { message?: { content?: unknown } }[] } | null | undefined)
    ?.choices?.[0]?.message?.content;
  return content ?? data;
}

// Production caller: POST one address as OpenAI chat to the Modal server.
export function modalFormalizeCaller(timeoutMs = 120000): FormalizeCaller {
  const { url, headers } = formalizeEndpoint();
  return async (text: string) => {
    apiLog("POST", url);
    console.log(`[formalize] >> 1 text to ${url}`);
    console.log(`[formalize] >> [0] ${text}`);
    let data: unknown;
    try {
      ({ data } = await axios.post(url, formalizeChatRequest(text), {
        headers,
        timeout: timeoutMs,
      }));
      console.log(`[formalize] << [0] ${JSON.stringify(data)}`);
    } catch (err) {
      if (isModalAuthRejection(err)) {
        // Thrown per-row: formalizeAddresses records it as llm-call-failed,
        // so a bad token fails loud on every row instead of silently.
        throw new Error(`Modal proxy auth rejected — ${MODAL_PROXY_ENV_HINT}`);
      }
      throw err;
    }
    return chatContent(data) as unknown;
  };
}

// Formalize a list, one paced call at a time (Modal webhook etiquette,
// same 250ms spacing as the name normalizer). A failed call becomes a
// per-row failureCause; the batch never dies on one bad address.
export async function formalizeAddresses(
  texts: string[],
  call: FormalizeCaller = modalFormalizeCaller(),
  minIntervalMs = 250,
): Promise<FormalizeResult[]> {
  const out: FormalizeResult[] = [];
  let lastAt = 0;
  for (const text of texts) {
    const wait = Math.max(0, lastAt + minIntervalMs - Date.now());
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
    try {
      out.push(parseFormalizeResponse(await call(text), text));
    } catch (err) {
      const notes = err instanceof Error ? err.message : String(err);
      console.error(`[formalize] call failed for ${text.slice(0, 120)}: ${notes}`);
      out.push({
        original: text,
        address: { ...EMPTY },
        confidence: null,
        notes,
        failureCause: "llm-call-failed",
      });
    } finally {
      lastAt = Date.now();
    }
  }
  return out;
}

// Progress/log chunking: the server takes one address per request, so a
// chunk is N sequential chat calls. 24 keeps logs readable and bounds a
// chunk's runtime; smaller chunks waste cold starts.
export const FORMALIZE_BATCH = 24;

// The .env value must be the server base URL (.modal.direct), not the
// Modal dashboard/deployment link — the dashboard 405s POSTs. Warn, don't
// throw: custom domains exist.
export function warnIfNotEndpointUrl(url: string): void {
  if (!/^https:\/\/[^/]+\.modal\.(run|direct)(\/|$)/.test(url)) {
    console.warn(
      `[formalize] ${url} does not look like a Modal endpoint URL — want the https://....modal.run function URL or https://....modal.direct server URL from \`modal deploy\`, not the dashboard link.`,
    );
  }
}

export type FormalizeBatchCaller = (texts: string[]) => Promise<unknown[]>;

// Sequential singles: the OpenAI server takes one address per request, so
// a chunk fans out into N chat calls (kept sequential: one replica, one
// request at a time). Returns message contents aligned with `texts`.
// 3 min per address: parses take seconds; a slow cold start surfaces as
// llm-call-failed rows, not a hung chunk.
export function modalFormalizeBatchCaller(
  timeoutMs = 180000,
): FormalizeBatchCaller {
  const { url, headers } = formalizeEndpoint();
  return async (texts: string[]) => {
    if (!Array.isArray(texts)) {
      throw new Error(`modal formalize batch malformed: expected array, got ${typeof texts}`);
    }
    apiLog("POST", url);
    console.log(`[formalize] >> ${texts.length} texts to ${url}`);
    const out: unknown[] = [];
    try {
      for (let i = 0; i < texts.length; i += 1) {
        const text = texts[i];
        console.log(`[formalize] >> [${i}] ${text}`);
        const { data } = await axios.post(url, formalizeChatRequest(String(text)), {
          headers,
          timeout: timeoutMs,
        });
        const content = chatContent(data);
        console.log(`[formalize] << [${i}] ${JSON.stringify(content)}`);
        out.push(content);
      }
    } catch (err) {
      if (isModalAuthRejection(err)) {
        throw new Error(`Modal proxy auth rejected — ${MODAL_PROXY_ENV_HINT}`);
      }
      throw err;
    }
    if (out.length !== texts.length) {
      throw new Error(`modal formalize batch short: got ${out.length} for ${texts.length}`);
    }
    return out as unknown[];
  };
}

// True when Modal rejected our proxy headers (wrong token pair — usually CLI
// API tokens pasted where wk-/ws- proxy tokens belong). Pure.
export function isModalAuthRejection(err: unknown): boolean {
  return (
    axios.isAxiosError(err) &&
    (err.response?.status === 401 || err.response?.status === 403)
  );
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

// Formalize in GPU-sized chunks: one call per chunk, a failed chunk marks
// every row llm-call-failed, the run never dies mid-queue.
export async function formalizeAddressesBatched(
  texts: string[],
  call: FormalizeBatchCaller = modalFormalizeBatchCaller(),
  batchSize: number = FORMALIZE_BATCH,
): Promise<FormalizeResult[]> {
  const out: FormalizeResult[] = [];
  const chunks = chunk(texts, batchSize);
  let n = 0;
  for (const part of chunks) {
    n += 1;
    console.log(`[formalize] chunk ${n}/${chunks.length} (${part.length} addresses)`);
    try {
      const replies = await call(part);
      part.forEach((text, i) => {
        const raw = replies[i];
        out.push(
          raw === undefined
            ? {
                original: text,
                address: { ...EMPTY },
                confidence: null,
                notes: "batch reply short: no element for this index",
                failureCause: "llm-call-failed",
              }
            : parseFormalizeResponse(raw, text),
        );
      });
    } catch (err) {
      const notes = err instanceof Error ? err.message : String(err);
      console.error(
        `[formalize] chunk ${n}/${chunks.length} failed: ${notes} (${part.length} rows marked llm-call-failed)`,
      );
      for (const text of part) {
        out.push({
          original: text,
          address: { ...EMPTY },
          confidence: null,
          notes,
          failureCause: "llm-call-failed",
        });
      }
    }
  }
  return out;
}
