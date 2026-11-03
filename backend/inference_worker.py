"""WhoFundsIt small-tasks worker — Modal + vLLM, Llama-3.1-8B on 1xT4.

The 8B handles the basic jobs: company-name cleanup and 3-4 line
verify-flag commentary. Addressing (the hard parse) lives on the 70B
worker (formalize_worker.py). One deploy prints both endpoint URLs.

TEMPLATE: not deployed from the coding sandbox. Deployment (Modal account):
  1. Accept the Llama 3.1 license on Hugging Face for
     meta-llama/Llama-3.1-8B-Instruct (the weights are gated).
  2. modal secret create huggingface-secret HF_TOKEN=<your HF token>
     (or --from-dotenv <file holding just HF_TOKEN>; the worker reads
     Modal's env, never your local .env)
  3. modal deploy backend/inference_worker.py
  4. Put the printed endpoint URLs in backend/.env as MODAL_WEBHOOK_URL
     (normalize) and MODAL_DIAGNOSE_URL (diagnose).
  5. Create a Proxy Auth Token (modal.com/settings/proxy-auth-tokens)
     and store it as MODAL_TOKEN_ID/MODAL_TOKEN_SECRET in backend/.env —
     both endpoints enforce them natively (requires_proxy_auth).
Contract: POST {"text": "..."} (+ Modal-Key / Modal-Secret headers) ->
normalized object (normalize) or {"diagnosis": "..."} (diagnose).
Never hardcode tokens in this file (ground rules).
"""

import json

import modal

MODEL_ID = "meta-llama/Llama-3.1-8B-Instruct"

# T4 is a 16 GB card and 8B bf16 weights are ~16 GB: tight, may OOM on
# deploy. If it does, flip to "L4" (24 GB, still cheap) and redeploy.
GPU = "T4:1"

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("vllm==0.6.3", "fastapi[standard]")
)

app = modal.App("whofundsit-inference")

NAME_SYSTEM_PROMPT = (
    "You clean SEC filing data. Given one raw filing line, reply with ONLY a "
    'JSON object: {"canonicalName": string, "aliases": string[], '
    '"entityType": string|null, "locationText": string|null} — canonicalName '
    "is the clean, deduplicated company name (not ALL-CAPS unless it is an "
    "acronym), aliases lists other name variants of the same company, "
    "entityType is the business kind if inferable, locationText is any state "
    "or address text found in the input. No prose, no code fences."
)

DIAGNOSE_SYSTEM_PROMPT = (
    "You explain data-audit flags. Given one flag plus its known facts, "
    'reply with ONLY a JSON object: {"diagnosis": string} — 2-3 sentences '
    "on why the flag likely fired and how to confirm or fix it. Use ONLY "
    "the facts given plus general methodology knowledge. Never invent "
    "live values; never assume an outside lookup was made. No prose, "
    "no code fences."
)


@app.cls(
    image=image,
    gpu=GPU,
    secrets=[modal.Secret.from_name("huggingface-secret")],
    timeout=60 * 15,
    # Close the GPU after every run: these calls are rare, idling burns budget.
    scaledown_window=0,
)
class InferenceWorker:
    @modal.enter()
    def load(self) -> None:
        from vllm import LLM, SamplingParams

        self.llm = LLM(
            model=MODEL_ID,
            tensor_parallel_size=1,
            max_model_len=4096,
            gpu_memory_utilization=0.90,
        )
        self.name_sampling = SamplingParams(temperature=0.0, max_tokens=192)
        self.diag_sampling = SamplingParams(temperature=0.2, max_tokens=320)

    def _ask(self, system: str, text: str, sampling) -> str:
        prompt = (
            "<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n"
            f"{system}<|eot_id|>"
            "<|start_header_id|>user<|end_header_id|>\n\n"
            f"{text}<|eot_id|>"
            "<|start_header_id|>assistant<|end_header_id|>\n\n"
        )
        outputs = self.llm.generate([prompt], sampling)
        return outputs[0].outputs[0].text.strip()

    @modal.method()
    def normalize(self, text: str) -> str:
        """Normalize one unstructured filing line into a clean JSON string."""
        return self._ask(NAME_SYSTEM_PROMPT, text, self.name_sampling)

    @modal.method()
    def diagnose(self, text: str) -> str:
        """Explain one verify-audit flag in 2-3 sentences (JSON string)."""
        return self._ask(DIAGNOSE_SYSTEM_PROMPT, text, self.diag_sampling)


def _clean_json(raw: str) -> str:
    return raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()


@app.function(image=image, timeout=60 * 10)
@modal.fastapi_endpoint(method="POST", label="normalize", requires_proxy_auth=True)
def normalize_endpoint(payload: dict) -> dict:
    """Name cleanup: the pipeline POSTs {"text": ...} (MODAL_WEBHOOK_URL)."""
    text = str(payload.get("text", "")).strip()
    if not text:
        return {"error": "missing 'text'"}
    raw = InferenceWorker().normalize.remote(text)
    raw = _clean_json(raw)
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {"raw": raw}
    except json.JSONDecodeError:
        return {"canonicalName": text, "raw": raw}


@app.function(image=image, timeout=60 * 10)
@modal.fastapi_endpoint(method="POST", label="diagnose", requires_proxy_auth=True)
def diagnose_endpoint(payload: dict) -> dict:
    """Second webhook: verify:claims POSTs {"text": flag} for a why/how."""
    text = str(payload.get("text", "")).strip()
    if not text:
        return {"error": "missing 'text'"}
    raw = InferenceWorker().diagnose.remote(text)
    raw = _clean_json(raw)
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict) and isinstance(parsed.get("diagnosis"), str):
            return {"diagnosis": parsed["diagnosis"]}
        return {"diagnosis": raw}
    except json.JSONDecodeError:
        return {"diagnosis": raw}
