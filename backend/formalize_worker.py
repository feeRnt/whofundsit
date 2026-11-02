"""WhoFundsIt address formalizer — Modal + vLLM running Llama-3.1-70B-Instruct.

TEMPLATE: not deployed from the coding sandbox. Deployment (Modal account):
  1. Accept the Llama 3.1 license on Hugging Face for
     meta-llama/Llama-3.1-70B-Instruct (the weights are gated).
  2. modal secret create huggingface-secret HF_TOKEN=<your HF token>
  3. modal secret create whofundsit MODAL_API_KEY=$(openssl rand -hex 32)
  4. modal deploy backend/formalize_worker.py
  5. Put the printed endpoint URL in backend/.env as MODAL_FORMALIZE_URL
     and the same key as MODAL_API_KEY.
Contract: POST {"text": "...", "key": "..."} -> one JSON object (see
SYSTEM_PROMPT); POST {"texts": [...], "key": "..."} -> a list aligned by
index. A wrong/missing key, or an unset secret, answers
{"error": "unauthorized"}. The model only parses: it never returns
coordinates. Every failure carries notes + failureCause so the
verification/geocode step can explain why a row failed.
Never hardcode tokens in this file (ground rules).
"""

import hmac
import json
import os

import modal

MODEL_ID = "meta-llama/Llama-3.1-70B-Instruct"

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("vllm==0.6.3", "fastapi[standard]")
)

app = modal.App("whofundsit-formalize")

SYSTEM_PROMPT = (
    "You parse postal addresses. Given one raw address, reply with ONLY a "
    'JSON object: {"houseNumber": string|null, "street": string|null, '
    '"city": string|null, "stateOrRegion": string|null, '
    '"postalCode": string|null, "country": string|null, '
    '"countryCode": string|null, "confidence": number, "notes": string, '
    '"failureCause": string|null} — never invent a house number, postal '
    "code, or coordinates; drop suite/floor/unit designators into notes. "
    "When the text cannot be formalized, set unsupported fields to null, "
    "confidence low, failureCause to one of po-box, "
    "missing-house-number, missing-postal-code, ambiguous-country, "
    "registrant-name-not-address, multi-address, other, and explain the "
    "cause in notes. No prose, no code fences."
)


@app.cls(
    image=image,
    gpu="H100:2",
    secrets=[modal.Secret.from_name("huggingface-secret")],
    timeout=60 * 15,
    scaledown_window=120,
)
class FormalizeWorker:
    @modal.enter()
    def load(self) -> None:
        from vllm import LLM, SamplingParams

        self.llm = LLM(
            model=MODEL_ID,
            tensor_parallel_size=2,
            max_model_len=4096,
            gpu_memory_utilization=0.90,
        )
        self.sampling = SamplingParams(temperature=0.0, max_tokens=320)

    @modal.method()
    def formalize(self, text: str) -> str:
        prompt = (
            "<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n"
            f"{SYSTEM_PROMPT}<|eot_id|>"
            "<|start_header_id|>user<|end_header_id|>\n\n"
            f"{text}<|eot_id|>"
            "<|start_header_id|>assistant<|end_header_id|>\n\n"
        )
        outputs = self.llm.generate([prompt], self.sampling)
        return outputs[0].outputs[0].text.strip()


def _parse(raw: str, original: str) -> dict:
    cleaned = raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass
    return {
        "houseNumber": None,
        "street": None,
        "city": None,
        "stateOrRegion": None,
        "postalCode": None,
        "country": None,
        "countryCode": None,
        "confidence": None,
        "notes": f"unparsable model output for {original!r}: {raw[:200]}",
        "failureCause": "llm-unparsable-output",
    }


def _authorized(payload: dict) -> bool:
    """Shared-secret gate: MODAL_API_KEY comes from the `whofundsit`
    Modal secret (container env), matched against payload["key"].
    Fail-closed — an unset secret denies everything."""
    expected = os.environ.get("MODAL_API_KEY", "")
    return bool(expected) and hmac.compare_digest(
        str(payload.get("key", "")), expected
    )


@app.function(
    image=image,
    timeout=60 * 10,
    secrets=[modal.Secret.from_name("whofundsit")],
)
@modal.fastapi_endpoint(method="POST", label="formalize")
def formalize_endpoint(payload: dict):
    """HTTP webhook: {"text": ...} -> object; {"texts": [...]} -> list."""
    if not _authorized(payload):
        return {"error": "unauthorized"}
    worker = FormalizeWorker()
    if isinstance(payload.get("texts"), list):
        texts = [str(t) for t in payload["texts"]]
        return [_parse(worker.formalize.remote(t), t) for t in texts]
    text = str(payload.get("text", "")).strip()
    if not text:
        return {"error": "missing 'text'"}
    return _parse(worker.formalize.remote(text), text)
