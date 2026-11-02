"""WhoFundsIt inference worker — Modal + vLLM running Llama-3.1-70B-Instruct.

TEMPLATE: not deployed from the coding sandbox. Deployment (hackathon credits):
  1. Accept the Llama 3.1 license on Hugging Face for
     meta-llama/Llama-3.1-70B-Instruct (the weights are gated).
  2. modal secret create huggingface-secret HF_TOKEN=<your HF token>
  3. modal secret create whofundsit MODAL_API_KEY=$(openssl rand -hex 32)
  4. modal deploy backend/inference_worker.py
  5. Put the printed endpoint URL in backend/.env as MODAL_WEBHOOK_URL
     and the same key as MODAL_API_KEY.
Contract: POST {"text": "...", "key": "..."} -> normalized object.
A wrong/missing key, or an unset secret, answers {"error": "unauthorized"}.
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

app = modal.App("whofundsit-inference")

SYSTEM_PROMPT = (
    "You clean SEC filing data. Given one raw filing line, reply with ONLY a "
    'JSON object: {"canonicalName": string, "aliases": string[], '
    '"entityType": string|null, "locationText": string|null} — canonicalName '
    "is the clean, deduplicated company name (not ALL-CAPS unless it is an "
    "acronym), aliases lists other name variants of the same company, "
    "entityType is the business kind if inferable, locationText is any state "
    "or address text found in the input. No prose, no code fences."
)


@app.cls(
    image=image,
    # 70B in bf16 needs >80 GB of VRAM: two H100s via tensor parallelism.
    gpu="H100:2",
    secrets=[modal.Secret.from_name("huggingface-secret")],
    timeout=60 * 15,
    # Keep the model warm briefly between hackathon bursts; cold-starting a
    # 70B takes minutes, idling H100s burns budget. Tune to taste.
    scaledown_window=120,
)
class InferenceWorker:
    @modal.enter()
    def load(self) -> None:
        from vllm import LLM, SamplingParams

        self.llm = LLM(
            model=MODEL_ID,
            tensor_parallel_size=2,
            max_model_len=4096,
            gpu_memory_utilization=0.90,
        )
        self.sampling = SamplingParams(temperature=0.0, max_tokens=256)

    @modal.method()
    def normalize(self, text: str) -> str:
        """Normalize one unstructured filing line into a clean JSON string."""
        prompt = (
            "<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n"
            f"{SYSTEM_PROMPT}<|eot_id|>"
            "<|start_header_id|>user<|end_header_id|>\n\n"
            f"{text}<|eot_id|>"
            "<|start_header_id|>assistant<|end_header_id|>\n\n"
        )
        outputs = self.llm.generate([prompt], self.sampling)
        return outputs[0].outputs[0].text.strip()


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
@modal.fastapi_endpoint(method="POST", label="normalize")
def normalize_endpoint(payload: dict) -> dict:
    """HTTP webhook the Express backend POSTs {"text": "..."} to."""
    if not _authorized(payload):
        return {"error": "unauthorized"}
    text = str(payload.get("text", "")).strip()
    if not text:
        return {"error": "missing 'text'"}
    raw = InferenceWorker().normalize.remote(text)
    raw = raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {"raw": raw}
    except json.JSONDecodeError:
        return {"canonicalName": text, "raw": raw}
