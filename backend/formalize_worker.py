"""WhoFundsIt address formalizer — Modal + vLLM, Muse-Glimmer-30B on 2xA100.

Glimmer (Apache 2.0, ungated — no license acceptance needed) does the
addressing. bf16 weights (~60 GB) split over 2x80 GB with room for
batched KV cache. max_model_len=4096 is load-bearing: the 131k native
context would size the KV cache into an OOM. The GPU shuts down seconds
after every run, so the client sends everything in a few big chunks (24
texts per call, one generate() each). Weights live on a persistent
hf-hub-cache volume: the first deploy downloads (~60 GB, slow), later
cold starts reuse the cache and only pay model load.

TEMPLATE: not deployed from the coding sandbox. Deployment (Modal account):
  1. No license step (Apache 2.0, public repo). HF_TOKEN only helps with
     rate limits; set it via step 2 anyway.
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
MODEL_ID = "meta-models/Muse-Glimmer-30B"

# Unpinned: vLLM pulls the torch/transformers it was built against.
# (No extra index: everything here is on plain PyPI; the pytorch.org
# homepage is not a PEP 503 index and breaks the image build.)
image = modal.Image.debian_slim().pip_install(
    "vllm", "transformers", "fastapi[standard]", "torch",
)

# Deploy-time only: `modal deploy` reads your local shell env, not
# backend/.env — export MODAL_HF_SECRET_NAME=<name> when yours differs.
HF_SECRET_NAME = os.environ.get("MODAL_HF_SECRET_NAME", "huggingface-secret")

app = modal.App("whofundsit-formalize")
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

def _prompt(text: str) -> str:
    return (
    f"<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n{SYSTEM_PROMPT}<|eot_id|>"
    f"<|start_header_id|>user<|end_header_id|>\n\n{text}<|eot_id|>"
    "<|start_header_id|>assistant<|end_header_id|>\n\n"
    )
@app.cls(
    image=image,
    gpu="A100-80GB:2",
    secrets=[modal.Secret.from_name(HF_SECRET_NAME)],
    volumes={"/root/.cache/huggingface": hf_cache},
    startup_timeout=3600,
    timeout=900,
    scaledown_window=45,
)
class FormalizeWorker:
    @modal.enter()
    def load(self):
        from vllm import LLM, SamplingParams
        self.llm = LLM(
            model=MODEL_ID,
            tensor_parallel_size=2,
            # Load-bearing: Glimmer's 131k native context would size the
            # KV cache into an OOM; addresses need a fraction of this.
            max_model_len=4096,
            gpu_memory_utilization=0.90,
        )
        hf_cache.commit()
        self.sampling = SamplingParams(temperature=0.0, max_tokens=224)
    @modal.method()
    def formalize(self, text: str) -> str:
        return self.llm.generate([_prompt(text)], self.sampling)[0].outputs[0].text.strip()
    @modal.method()
    def formalize_batch(self, texts: list) -> list:
        outputs = self.llm.generate([_prompt(t) for t in texts], self.sampling)
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

@app.function(image=image, timeout=1320)
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

#import json
#import os
#
#import modal
#
##MODEL_ID = "meta-llama/Llama-3.3-70B-Instruct"
#MODEL_ID = "meta-models/Muse-Glimmer-30B" # Glimmer is lighter and more updated than
## llama for our tasks tbh. Seems to be better in results too
#
## Modal secret holding HF_TOKEN. Deploy-time only: `modal deploy` reads your
## local shell env, not backend/.env — export MODAL_HF_SECRET_NAME=<name>
## in the deploying shell when yours isn't the default.
#HF_SECRET_NAME = os.environ.get("MODAL_HF_SECRET_NAME", "huggingface-secret")
#
## Pin the HF cache onto the volume mount BEFORE vllm is imported (hf_hub
## freezes HF_HOME at import; the default already matches, this just locks it).
#os.environ.setdefault("HF_HOME", "/root/.cache/huggingface")
#
#image = (
#    # Either use debian and play with fire , or ------
#    #modal.Image.debian_slim(python_version="3.12")
#    modal.Image.debian_slim()
#    # transformers pinned: unpinned, pip now resolves a release that
#    # removed TokenizerBackend.all_special_tokens_extended, and vllm
#    # 0.6.3 crashes in tokenizer init (~9s, before any weight download).
#    # transformers 
#    # The conflict is caused by:
#    # The user requested torch==2.6.0
#    # vllm 0.6.3 depends on torch==2.4.0
#
#    #To fix this you could try to:
#    # 1. loosen the range of package versions you've specified
#    # 2. remove package versions to allow pip to attempt to solve the dependency conflict
#
#    # [transformers] Disabling PyTorch because PyTorch >= 2.6 is required but found 2.4.0
#    # The user requested transformers==4.44.2
#    # vllm 0.6.3 depends on transformers>=4.45.0
#    #.pip_install("vllm==0.6.3", "transformers==4.45.0", "fastapi[standard]",
#    #   "torch==2.4.0", extra_index_url="https://pytorch.org")
#    #.pip_install("vllm==0.6.3", "transformers==4.45.0", "fastapi[standard]",
#    #   "torch==2.4.0", extra_index_url="https://pytorch.org")
#    .pip_install("vllm", "transformers", "fastapi[standard]",
#       "torch", extra_index_url="https://pytorch.org")
#
#    # ----- get the vllm-nvidia-cuda image, and play with the jungle
#    # modal.Image.from_registry("vllm/vllm-openai:v0.6.3")
#    #.pip_install("fastapi[standard]") it's python3 on this image, direct call:
#    # .run_commands("python3 -m pip install 'fastapi[standard]'")
#    # │ We were unable to determine the version of Python installed in  │
#    # │ the Image provided for the `formalize_endpoint`  ~ Please contact modal
#    # support.
#
#    # NVM man, life is like a sand dune with Dune playing in the background
#    # always
#)
#
#app = modal.App("whofundsit-formalize")
#
## Persistent HF cache: weights download once (~140 GB), later cold starts
## reuse it instead of re-downloading. Free: Modal includes 1 TB of volume
## storage monthly. Auto-created on first deploy.
#hf_cache = modal.Volume.from_name("hf-hub-cache", create_if_missing=True)
#
#SYSTEM_PROMPT = (
#    "You parse postal addresses. Given one raw address, reply with ONLY a "
#    'JSON object: {"houseNumber": string|null, "street": string|null, '
#    '"city": string|null, "stateOrRegion": string|null, '
#    '"postalCode": string|null, "country": string|null, '
#    '"countryCode": string|null, "confidence": number, "notes": string, '
#    '"failureCause": string|null} — never invent a house number, postal '
#    "code, or coordinates; drop suite/floor/unit designators into notes. "
#    "When the text cannot be formalized, set unsupported fields to null, "
#    "confidence low, failureCause to one of po-box, "
#    "missing-house-number, missing-postal-code, ambiguous-country, "
#    "registrant-name-not-address, multi-address, other, and explain the "
#    "cause in notes. No prose, no code fences."
#)
#
#def _prompt(system: str, text: str) -> str:
#    return (
#        "<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n"
#        f"{system}<|eot_id|>"
#        "<|start_header_id|>user<|end_header_id|>\n\n"
#        f"{text}<|eot_id|>"
#        "<|start_header_id|>assistant<|end_header_id|>\n\n"
#    )
#
#
#@app.cls(
#    image=image,
#    #gpu="L40S:2", #44 GB OOM's:
#    # Runner failed with exception: OutOfMemoryError('CUDA out of memory. Tried
#    # to allocate 448.00 MiB. GPU 0 has a total capacity of 44.42 GiB of which
#    # 410.94 MiB is free.
#    gpu="A100-80GB:2",
#    secrets=[modal.Secret.from_name(HF_SECRET_NAME)],
#    volumes={"/root/.cache/huggingface": hf_cache},
#    # Startup (download + fp8 load) gets its own hour: without startup_timeout
#    # the 15-min execution timeout would kill the 140 GB download mid-load.
#    startup_timeout=60 * 60,
#    timeout=60 * 15,
#    # 5s idle shutoff: gaps between chunks are milliseconds, but a >2s
#    # hiccup would cold-start the 70B mid-run (minutes lost for ~3s saved).
#    # upped to 45 secs
#    scaledown_window=45,
#    #container_idle_timeout=80, # ends if no req for 5 mins. -- this flag is
#    # deprecated. wow AI hallucination fest here
#)
#class FormalizeWorker:
#    @modal.enter()
#    def load(self) -> None:
#        from vllm import LLM, SamplingParams
#
#        self.llm = LLM(
#            model=MODEL_ID,
#            tensor_parallel_size=2,
#            #tensor_parallel_size=1, # 1 GPU
#            #quantization="fp8",
#            #max_model_len=4096, prevent OOM from CUDA
#            #max_model_len=4096,
#            #gpu_memory_utilization=0.90,
#            #gpu_memory_utilization=0.90,
#            #apparently this vvv is needed for L40S p2p CUDA
#            #disable_custom_all_reduce=True,
#        )
#        # Persist freshly downloaded weights so the next cold start skips the
#        # download (cheap no-op when the cache is already full).
#        hf_cache.commit()
#        # Addresses are tiny: cap output so runaway JSON can't burn KV.
#        self.sampling = SamplingParams(temperature=0.0, max_tokens=224)
#
#    @modal.method()
#    def formalize(self, text: str) -> str:
#        outputs = self.llm.generate([_prompt(SYSTEM_PROMPT, text)], self.sampling)
#        return outputs[0].outputs[0].text.strip()
#
#    @modal.method()
#    def formalize_batch(self, texts: list) -> list:
#        """One generate() call for the whole chunk: true batching, one GPU
#        spin-up serves dozens of addresses instead of one."""
#        prompts = [_prompt(SYSTEM_PROMPT, t) for t in texts]
#        outputs = self.llm.generate(prompts, self.sampling)
#        return [o.outputs[0].text.strip() for o in outputs]
#
#
#def _parse(raw: str, original: str) -> dict:
#    cleaned = raw.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
#    try:
#        parsed = json.loads(cleaned)
#        if isinstance(parsed, dict):
#            return parsed
#    except json.JSONDecodeError:
#        pass
#    return {
#        "houseNumber": None,
#        "street": None,
#        "city": None,
#        "stateOrRegion": None,
#        "postalCode": None,
#        "country": None,
#        "countryCode": None,
#        "confidence": None,
#        "notes": f"unparsable model output for {original!r}: {raw[:200]}",
#        "failureCause": "llm-unparsable-output",
#    }
#
#
## 22 min: the CPU endpoint just waits on the GPU class, so its budget must
## cover a slow cold start, not just the generate call.
#@app.function(image=image, timeout=60 * 22)
#@modal.fastapi_endpoint(method="POST", label="formalize", requires_proxy_auth=True)
#def formalize_endpoint(payload: dict):
#    """HTTP webhook: {"text": ...} -> object; {"texts": [...]} -> list."""
#    worker = FormalizeWorker()
#    if isinstance(payload.get("texts"), list):
#        texts = [str(t) for t in payload["texts"] if str(t).strip()]
#        if not texts:
#            return []
#        outs = worker.formalize_batch.remote(texts)
#        return [_parse(o, t) for o, t in zip(outs, texts)]
#    text = str(payload.get("text", "")).strip()
#    if not text:
#        return {"error": "missing 'text'"}
#    return _parse(worker.formalize.remote(text), text)
