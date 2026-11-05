import axios from "axios";
import {
  apiLog,
  modalProxyHeaders,
  MODAL_PROXY_ENV_HINT,
  userAgentFromEnv,
} from "./httpCache.js";

// Shared OpenAI-chat client for the Modal Glimmer-30B servers
// (formalize_worker.py + inference_worker.py are the same @app.server
// architecture; both speak /v1/chat/completions). Callers differ only in
// system prompt, user text, model default, and timeouts — the endpoint
// resolve, proxy auth, logging, and reply extraction are identical.
export interface ChatMessage {
  role: string;
  content: string;
}

export const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

export function chatBody(
  model: string,
  messages: ChatMessage[],
  temperature: number,
  maxTokens: number,
): Record<string, unknown> {
  return {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
}

// The .env value must be the server base URL (https://....modal.direct),
// not the Modal dashboard/deployment link — the dashboard 405s POSTs.
// Warn, don't throw: custom domains exist.
export function warnIfNotEndpointUrl(url: string): void {
  if (!/^https:\/\/[^/]+\.modal\.(run|direct)(\/|$)/.test(url)) {
    console.warn(
      `[modal] ${url} does not look like a Modal endpoint URL — want the https://....modal.run function URL or https://....modal.direct server URL from \`modal deploy\`, not the dashboard link.`,
    );
  }
}

// True when Modal rejected our proxy headers (wrong token pair — usually
// CLI API tokens pasted where wk-/ws- proxy tokens belong). Pure.
export function isModalAuthRejection(err: unknown): boolean {
  return (
    axios.isAxiosError(err) &&
    (err.response?.status === 401 || err.response?.status === 403)
  );
}

export interface ChatEndpoint {
  url: string;
  headers: Record<string, string>;
  model: string;
}

// Resolve a Modal OpenAI server from its env var. Throws when unset or
// when proxy auth is missing (both are deploy-time config, never per-row).
// The model stays caller-owned (each worker keeps its own MODEL_* env).
export function resolveChatEndpoint(
  envVar: string,
  model: string,
): ChatEndpoint {
  const base = (process.env[envVar] ?? "").replace(/\/+$/, "");
  if (!base) {
    throw new Error(
      `${envVar} is not set (deploy the Modal worker; see backend/.env.example)`,
    );
  }
  warnIfNotEndpointUrl(base);
  const auth = modalProxyHeaders();
  if (!auth) {
    throw new Error(`Modal proxy auth is not configured — ${MODAL_PROXY_ENV_HINT}`);
  }
  return {
    url: `${base}${CHAT_COMPLETIONS_PATH}`,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": userAgentFromEnv("MODAL_USER_AGENT", "WhoFundsIt/0.1"),
      ...auth,
    },
    model,
  };
}

// One OpenAI chat call: log the label going out, log the full reply,
// turn proxy-auth rejections into the actionable hint error. Returns the
// assistant message content (or the raw body when the shape surprises).
export async function postChatCompletion(
  endpoint: ChatEndpoint,
  body: Record<string, unknown>,
  timeoutMs: number,
  tag: string,
  label: string,
): Promise<unknown> {
  apiLog("POST", endpoint.url);
  console.log(`[${tag}] >> ${label}`);
  let data: unknown;
  try {
    ({ data } = await axios.post(endpoint.url, body, {
      headers: endpoint.headers,
      timeout: timeoutMs,
    }));
    console.log(`[${tag}] << ${JSON.stringify(data)}`);
  } catch (err) {
    if (isModalAuthRejection(err)) {
      throw new Error(`Modal proxy auth rejected — ${MODAL_PROXY_ENV_HINT}`);
    }
    throw err;
  }
  const content = (
    data as { choices?: { message?: { content?: unknown } }[] } | null | undefined
  )?.choices?.[0]?.message?.content;
  return content ?? data;
}
