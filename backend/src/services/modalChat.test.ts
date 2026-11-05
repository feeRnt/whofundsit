import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_COMPLETIONS_PATH,
  chatBody,
  resolveChatEndpoint,
} from "./modalChat.js";

describe("modalChat", () => {
  it("builds a non-streaming OpenAI chat body", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    assert.deepEqual(chatBody("m", messages, 0.2, 320), {
      model: "m",
      messages,
      temperature: 0.2,
      max_tokens: 320,
      stream: false,
    });
  });

  it("resolves the endpoint from env, stripping trailing slashes", () => {
    const oldUrl = process.env.MODAL_INFERENCE_URL;
    const oldId = process.env.MODAL_TOKEN_ID;
    const oldSecret = process.env.MODAL_TOKEN_SECRET;
    process.env.MODAL_INFERENCE_URL = "https://example.modal.direct/";
    process.env.MODAL_TOKEN_ID = "wk-id";
    process.env.MODAL_TOKEN_SECRET = "ws-secret";
    try {
      const ep = resolveChatEndpoint("MODAL_INFERENCE_URL", "model-x");
      assert.equal(ep.url, `https://example.modal.direct${CHAT_COMPLETIONS_PATH}`);
      assert.equal(ep.model, "model-x");
      assert.equal(ep.headers["Modal-Key"], "wk-id");
    } finally {
      if (oldUrl === undefined) {
        delete process.env.MODAL_INFERENCE_URL;
      } else {
        process.env.MODAL_INFERENCE_URL = oldUrl;
      }
      if (oldId === undefined) {
        delete process.env.MODAL_TOKEN_ID;
      } else {
        process.env.MODAL_TOKEN_ID = oldId;
      }
      if (oldSecret === undefined) {
        delete process.env.MODAL_TOKEN_SECRET;
      } else {
        process.env.MODAL_TOKEN_SECRET = oldSecret;
      }
    }
  });

  it("throws when the endpoint env is unset", () => {
    const old = process.env.MODAL_INFERENCE_URL;
    delete process.env.MODAL_INFERENCE_URL;
    try {
      assert.throws(
        () => resolveChatEndpoint("MODAL_INFERENCE_URL", "m"),
        /MODAL_INFERENCE_URL is not set/,
      );
    } finally {
      if (old !== undefined) {
        process.env.MODAL_INFERENCE_URL = old;
      }
    }
  });
});
