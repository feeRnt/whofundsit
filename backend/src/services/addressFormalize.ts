import axios from "axios";
import { apiLog, userAgentFromEnv } from "./httpCache.js";

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

// Production caller: POST one address to the Modal formalize endpoint.
// MODAL_FORMALIZE_URL wins; MODAL_WEBHOOK_URL is the shared fallback.
export function modalFormalizeCaller(): FormalizeCaller {
  const url = process.env.MODAL_FORMALIZE_URL ?? process.env.MODAL_WEBHOOK_URL;
  if (!url) {
    throw new Error(
      "MODAL_FORMALIZE_URL is not set (deploy backend/formalize_worker.py; see backend/.env.example)",
    );
  }
  return async (text: string) => {
    apiLog("POST", url);
    const { data } = await axios.post(
      url,
      { text },
      {
        headers: {
          "Content-Type": "application/json",
          "User-Agent": userAgentFromEnv("MODAL_USER_AGENT", "WhoFundsIt/0.1"),
        },
        timeout: 120000,
      },
    );
    return data as unknown;
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
      out.push({
        original: text,
        address: { ...EMPTY },
        confidence: null,
        notes: err instanceof Error ? err.message : String(err),
        failureCause: "llm-call-failed",
      });
    } finally {
      lastAt = Date.now();
    }
  }
  return out;
}
