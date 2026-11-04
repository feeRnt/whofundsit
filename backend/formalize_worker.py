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

# Reading the docs because AI builds are not working
import json
import os
import aiohttp
import modal

from typing import Any

MODEL_NAME = "meta-models/Muse-Glimmer-30B"
MODEL_REVISION = "cec94fcfd6512f2cfe708138c32533b346ea4f69"
HF_SECRET_NAME = os.environ.get("MODAL_HF_SECRET_NAME", "huggingface-secret")

vllm_image = (
        modal.Image.from_registry("nvidia/cuda:12.9.0-devel-ubuntu22.04", add_python="3.12")
        .entrypoint([])
        .uv_pip_install("vllm==0.21.0")
        .env(
            {
                "HF_XET_HIGH_PERFORMANCE": "1",
            }
                #"VLLM_LOG_STATS_INTERVAL": "1",
        )
)
#image = modal.Image.debian_slim().pip_install(
#    "vllm", "transformers", "fastapi[standard]", "torch",
#)

# Deploy-time only: `modal deploy` reads your local shell env, not
# backend/.env — export MODAL_HF_SECRET_NAME=<name> when yours differs.

hf_cache_vol = modal.Volume.from_name("huggingface-cache", create_if_missing=True)
vllm_cache_vol = modal.Volume.from_name("vllm-cache", create_if_missing=True)
FAST_BOOT = False # Since we cache.

#SPECULATIVE_MODEL_NAME = ""
#SPECULATIVE_MODEL_REVISION = ""
# do this later, no time now.

app = modal.App("whofundsit-formalize")

N_GPU = 1
MINUTES = 60
VLLM_PORT = 8000
ROUTING_REGION = "us_east"

# the vllm server which takes a model, tmieouts, and port (vllm servers gpu 
# thru a network port on the local machine)
@app.server(
    image=vllm_image,
    gpu=f"A100-80GB:{N_GPU}",
    scaledown_window=2 * MINUTES, # die after 1 min of no reqs.
    startup_timeout=20 * MINUTES, # doc gives 10 mins.
    volumes={"/root/.cache/huggingface": hf_cache_vol,
             "/root/.cache/vllm": vllm_cache_vol,
    },
    port=VLLM_PORT,
    routing_region=ROUTING_REGION,
    target_concurrency=2, # how many can one replica handle? NO idea tbh; 100->80
    secrets=[modal.Secret.from_name(HF_SECRET_NAME)],
    #timeout=900,
)
class Server:
    @modal.enter()
    def start(self):
        import subprocess
        #from vllm import LLM, SamplingParams

        cmd = [
            "vllm",
            "serve",
            MODEL_NAME,
            "--revision",
            MODEL_REVISION,
            "--served-model-name",
            MODEL_NAME,
            "llm",
            "--host",
            "0.0.0.0",
            "--port",
            str(VLLM_PORT),
            "--uvicorn-log-level=info",
            "--async-scheduling",

        # enforce-eager disables both Torch compilation and CUDA graph capture
        # default is no-enforce-eager. see the --compilation-config flag for tighter control
        cmd += ["--enforce-eager" if FAST_BOOT else "--no-enforce-eager"]

        # assume multiple GPUs are for splitting up large matrix multiplications
        cmd += ["--tensor-parallel-size", str(N_GPU)]

        cmd += ["--max-model-len", "4096"]

        # add model-specific configuration
        # apparentlyu it works on glimmer too
        cmd += [
            # skip multimedia support, just language
            "--limit-mm-per-prompt",
            json.dumps({"image": 0, "video": 0, "audio": 0}),
            # enable reasoning and tool use
            #"--enable-auto-tool-choice",
            #"--reasoning-parser",
            #"muse_glimmer",
            #"gemma4",
            #"--tool-call-parser",
            #"muse_glimmer",
            #"gemma4",
        ]

        # add speculative decoding
        #cmd += [
        #    "--speculative-config",
        #    json.dumps(
        #        {
        #            "model": SPECULATIVE_MODEL_NAME,
        #            "revision": SPECULATIVE_MODEL_REVISION,
        #            "num_speculative_tokens": 4,
        #        }
        #    ),
        #]

        print(*cmd)

        self.process = subprocess.Popen(cmd)

@app.local_entrypoint()
async def test(test_timeout=15 * MINUTES, content=None, twice=True):
    import asyncio
    import time

    url = await Server.get_url.aio()

   # system_prompt = {
   #     "role": "system",
   #     "content": "You are a pirate who can't help but drop sly reminders that he went to Harvard.",
    system_prompt = {
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
    }
#
    }
    if content is None:
        content = "Tell me that I was fed nothig, so there is nothing for me to parse."

    messages = [  # OpenAI chat format
        system_prompt,
        {"role": "user", "content": content},
    ]

    async with aiohttp.ClientSession(base_url=url) as session:
        print(f"Running health check for server at {url}")
        deadline = time.time() + test_timeout - 1 * MINUTES
        while time.time() < deadline:
            async with session.get(
                "/health", timeout=aiohttp.ClientTimeout(total=60)
            ) as resp:
                if resp.status == 200:
                    break
                if resp.status == 503:
                    await asyncio.sleep(1)
                    continue
                assert False, (
                    f"Failed health check for server at {url}: HTTP {resp.status}"
                )
        else:
            assert False, f"Failed health check for server at {url}"
        print(f"Successful health check for server at {url}")

        print(f"Sending messages to {url}:", *messages, sep="\n\t")
        await _send_request(session, "llm", messages)
        if twice:
            messages[0]["content"] = "You are Jar Jar Binks."
            print(f"Sending messages to {url}:", *messages, sep="\n\t")
            await _send_request(session, "llm", messages)


async def _send_request(
    session: aiohttp.ClientSession, model: str, messages: list
) -> None:
    # `stream=True` tells an OpenAI-compatible backend to stream chunks
    payload: dict[str, Any] = {"messages": messages, "model": model, "stream": True}
    # explicitly enable thinking for this model
    payload["chat_template_kwargs"] = {"enable_thinking": True}

    headers = {"Content-Type": "application/json", "Accept": "text/event-stream"}

    async with session.post(
        "/v1/chat/completions", json=payload, headers=headers
    ) as resp:
        async for raw in resp.content:
            resp.raise_for_status()
            # extract new content and stream it
            line = raw.decode().strip()
            if not line or line == "data: [DONE]":
                continue
            if line.startswith("data: "):  # SSE prefix
                line = line[len("data: ") :]

            chunk = json.loads(line)
            assert (
                chunk["object"] == "chat.completion.chunk"
            )  # or something went horribly wrong
            delta = chunk["choices"][0]["delta"]
            content = (
                delta.get("content")
                or delta.get("reasoning")
                or delta.get("reasoning_content")
            )
            if content:
                print(content, end="")
            else:
                print("\n", chunk)
    print()

       

    @modal.exit()
    def stop(self):
        self.process.terminate()

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
def _prompt(text: str) -> str:
    return (
    f"<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n{SYSTEM_PROMPT}<|eot_id|>"
    f"<|start_header_id|>user<|end_header_id|>\n\n{text}<|eot_id|>"
    "<|start_header_id|>assistant<|end_header_id|>\n\n"
    )


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
