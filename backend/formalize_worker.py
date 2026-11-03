"""WhoFundsIt address formalizer — Modal + vLLM, Llama-3.3-70B on 2xL40S.

The 70B does the addressing (the hardest parse job). fp8 quantization is
load-bearing: bf16 weights (~140 GB) don't fit 2x48 GB, fp8 (~70 GB) does,
with room left for batched KV cache. The GPU shuts down seconds after
every run, so the client sends everything in a few big chunks (24 texts
per call, one generate() each). Weights live on a persistent hf-hub-cache
volume: the first deploy downloads (~140 GB, slow), later cold starts
reuse the cache and only pay model load.

TEMPLATE: not deployed from the coding sandbox. Deployment (Modal account):
  1. Accept the Llama 3.3 license on Hugging Face for
     meta-llama/Llama-3.3-70B-Instruct (the weights are gated).
  2. modal secret create <name> HF_TOKEN=<your HF token>
     (default name huggingface-secret; or --from-dotenv <file holding just
     HF_TOKEN>. If yours differs, export MODAL_HF_SECRET_NAME=<name> before
     deploying; the worker reads Modal's env, never your local .env)
  3. modal deploy backend/formalize_worker.py
  4. Put the printed endpoint URL in backend/.env as MODAL_FORMALIZE_URL.
  5. Create a Proxy Auth Token (modal.com/settings/proxy-auth-tokens)
     and store it as MODAL_TOKEN_ID/MODAL_TOKEN_SECRET in backend/.env —
     the endpoint enforces them natively (requires_proxy_auth).
Contract: POST {"text": "..."} (+ Modal-Key / Modal-Secret headers) ->
one JSON object (see SYSTEM_PROMPT); POST {"texts": [...]} -> a list
aligned by index. The model only parses: it never returns coordinates.
Every failure carries notes + failureCause so the verification/geocode
step can explain why a row failed.
Never hardcode tokens in this file (ground rules).
"""

import json
import os

import modal

MODEL_ID = "meta-llama/Llama-3.3-70B-Instruct"

# Modal secret holding HF_TOKEN. Deploy-time only: `modal deploy` reads your
# local shell env, not backend/.env — export MODAL_HF_SECRET_NAME=<name>
# in the deploying shell when yours isn't the default.
HF_SECRET_NAME = os.environ.get("MODAL_HF_SECRET_NAME", "huggingface-secret")

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("vllm==0.6.3", "fastapi[standard]")
)

app = modal.App("whofundsit-formalize")

# Persistent HF cache: weights download once (~140 GB), later cold starts
# reuse it instead of re-downloading. Free: Modal includes 1 TB of volume
# storage monthly. Auto-created on first deploy.
hf_cache = modal.Volume.from_name("hf-hub-cache", create_if_missing=True)

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

def _prompt(system: str, text: str) -> str:
    return (
        "<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n"
        f"{system}<|eot_id|>"
        "<|start_header_id|>user<|end_header_id|>\n\n"
        f"{text}<|eot_id|>"
        "<|start_header_id|>assistant<|end_header_id|>\n\n"
    )


@app.cls(
    image=image,
    gpu="L40S:2",
    secrets=[modal.Secret.from_name(HF_SECRET_NAME)],
    volumes={"/root/.cache/huggingface": hf_cache},
    timeout=60 * 15,
    # 5s idle shutoff: gaps between chunks are milliseconds, but a >2s
    # hiccup would cold-start the 70B mid-run (minutes lost for ~3s saved).
    scaledown_window=5,
)
class FormalizeWorker:
    @modal.enter()
    def load(self) -> None:
        from vllm import LLM, SamplingParams

        os.environ.setdefault("HF_HOME", "/root/.cache/huggingface")
        self.llm = LLM(
            model=MODEL_ID,
            tensor_parallel_size=2,
            quantization="fp8",
            max_model_len=4096,
            gpu_memory_utilization=0.90,
        )
        # Persist freshly downloaded weights so the next cold start skips the
        # download (cheap no-op when the cache is already full).
        hf_cache.commit()
        # Addresses are tiny: cap output so runaway JSON can't burn KV.
        self.sampling = SamplingParams(temperature=0.0, max_tokens=224)

    @modal.method()
    def formalize(self, text: str) -> str:
        outputs = self.llm.generate([_prompt(SYSTEM_PROMPT, text)], self.sampling)
        return outputs[0].outputs[0].text.strip()

    @modal.method()
    def formalize_batch(self, texts: list) -> list:
        """One generate() call for the whole chunk: true batching, one GPU
        spin-up serves dozens of addresses instead of one."""
        prompts = [_prompt(SYSTEM_PROMPT, t) for t in texts]
        outputs = self.llm.generate(prompts, self.sampling)
        return [o.outputs[0].text.strip() for o in outputs]


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


@app.function(image=image, timeout=60 * 10)
@modal.fastapi_endpoint(method="POST", label="formalize", requires_proxy_auth=True)
def formalize_endpoint(payload: dict):
    """HTTP webhook: {"text": ...} -> object; {"texts": [...]} -> list."""
    worker = FormalizeWorker()
    if isinstance(payload.get("texts"), list):
        texts = [str(t) for t in payload["texts"] if str(t).strip()]
        if not texts:
            return []
        outs = worker.formalize_batch.remote(texts)
        return [_parse(o, t) for o, t in zip(outs, texts)]
    text = str(payload.get("text", "")).strip()
    if not text:
        return {"error": "missing 'text'"}
    return _parse(worker.formalize.remote(text), text)
