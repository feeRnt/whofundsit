"""WhoFundsIt diagnosis worker — Modal + vLLM, Muse-Glimmer-30B on 1xA100-80GB.

Same @app.server OpenAI architecture as formalize_worker.py (stock `vllm
serve`, /v1/chat/completions): the two pipelines are 1:1 on purpose — one
client pattern, one deploy pattern, one smoke test. The diagnose prompt
lives client-side (DIAGNOSE_SYSTEM + diagnosisPrompt in
backend/src/services/claimsVerify.ts); this server only serves the model.
Replaces the old custom {"text"} -> {"diagnosis"} endpoint (removed;
the model only ever reasons over facts the audit already fetched).

TEMPLATE: not deployed from the coding sandbox. Deployment (Modal account):
  1. No license step (Apache 2.0, public repo). HF_TOKEN only helps with
     rate limits; set it via step 2 anyway.
  2. modal secret create <name> HF_TOKEN=<your HF token>
     (default name huggingface-secret; or --from-dotenv <file holding just
     HF_TOKEN>. If yours differs, export MODAL_HF_SECRET_NAME=<name> before
     deploying; the worker reads Modal's env, never your local .env)
  3. modal deploy backend/inference_worker.py
  4. Put the printed server URL in backend/.env as MODAL_INFERENCE_URL.
  5. Create a Proxy Auth Token (modal.com/settings/proxy-auth-tokens)
     and store it as MODAL_TOKEN_ID/MODAL_TOKEN_SECRET in backend/.env —
     the endpoint enforces them natively (requires_proxy_auth).
Contract: OpenAI POST /v1/chat/completions {model, messages, temperature,
max_tokens, stream:false} -> choices[0].message.content, parsed client-side
as {"diagnosis": string}. The model only explains: it never fetches data.
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
        )
)

# Deploy-time only: `modal deploy` reads your local shell env, not
# backend/.env — export MODAL_HF_SECRET_NAME=<name> when yours differs.

# Existing cache volume (already holds Glimmer weights from the custom
# endpoint era): keep the name so redeploys skip the ~60 GB download.
hf_cache_vol = modal.Volume.from_name("hf-hub-cache", create_if_missing=True)
vllm_cache_vol = modal.Volume.from_name("vllm-cache", create_if_missing=True)
FAST_BOOT = False # Since we cache.

app = modal.App("whofundsit-inference")

N_GPU = 1
MINUTES = 60
VLLM_PORT = 8000
ROUTING_REGION = "us-east"

# the vllm server which takes a model, timeouts, and port (vllm servers gpu
# thru a network port on the local machine)
@app.server(
    image=vllm_image,
    gpu=f"A100-80GB:{N_GPU}",
    scaledown_window=2 * MINUTES, # die after 2 min of no reqs.
    startup_timeout=20 * MINUTES, # doc gives 10 mins.
    volumes={"/root/.cache/huggingface": hf_cache_vol,
             "/root/.cache/vllm": vllm_cache_vol,
    },
    port=VLLM_PORT,
    routing_region=ROUTING_REGION,
    target_concurrency=2, # how many can one replica handle?
    secrets=[modal.Secret.from_name(HF_SECRET_NAME)],
)
class Server:
    @modal.enter()
    def start(self):
        import subprocess

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
        ]

        # enforce-eager disables both Torch compilation and CUDA graph capture
        # default is no-enforce-eager. see the --compilation-config flag for tighter control
        cmd += ["--enforce-eager" if FAST_BOOT else "--no-enforce-eager"]

        # assume multiple GPUs are for splitting up large matrix multiplications
        cmd += ["--tensor-parallel-size", str(N_GPU)]

        cmd += ["--max-model-len", "4096"]

        # add model-specific configuration
        cmd += [
            # skip multimedia support, just language
            "--limit-mm-per-prompt",
            json.dumps({"image": 0, "video": 0, "audio": 0}),
        ]

        print(*cmd)

        self.process = subprocess.Popen(cmd)

    @modal.exit()
    def stop(self):
        self.process.terminate()

DIAGNOSE_SYSTEM = (
"You explain data-audit flags. Reply with ONLY a JSON object: "
'{"diagnosis": string} — 2-3 sentences on why the flag likely fired and '
"how to confirm or fix it. Use ONLY the facts given plus general "
"methodology knowledge. Never invent live values; never assume an "
"outside lookup was made. No prose, no code fences."
)

@app.local_entrypoint()
async def test(test_timeout=15 * MINUTES):
    import asyncio
    import time

    url = await Server.get_url.aio()

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

        # The actual job: two real flags must come back as parseable
        # {"diagnosis"} JSON. Non-streaming, like the client reads it.
        for flag in [
            "1653606:Assets: reverse country ca vs bucket us",
            "lei:549300ITODCIPOGBMF68: reverse country us vs bucket non-us",
        ]:
            await _send_diagnose_check(session, flag)


async def _send_diagnose_check(
    session: aiohttp.ClientSession, flag: str
) -> None:
    """Non-streaming diagnose probe using the same contract the TS client
    sends: rules as system, flag as user. The reply must parse as
    {"diagnosis": <non-empty string>}."""
    payload: dict[str, Any] = {
        "messages": [
            {"role": "system", "content": DIAGNOSE_SYSTEM},
            {"role": "user", "content": flag},
        ],
        "model": MODEL_NAME,
        "temperature": 0.2,
        "max_tokens": 320,
        "stream": False,
    }
    async with session.post("/v1/chat/completions", json=payload) as resp:
        resp.raise_for_status()
        body = await resp.json()
    try:
        content = body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise AssertionError(f"unexpected chat shape: {body!r}") from e
    print(f"[diagnose-check] {flag[:60]!r} -> {str(content)[:200]}")
    cleaned = (
        str(content)
        .removeprefix("```json")
        .removeprefix("```")
        .removesuffix("```")
        .strip()
    )
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError as e:
        raise AssertionError(f"reply is not JSON: {content!r}") from e
    assert isinstance(parsed, dict), f"reply is not an object: {parsed!r}"
    diagnosis = parsed.get("diagnosis")
    assert isinstance(diagnosis, str) and diagnosis, (
        f"missing/empty diagnosis in {parsed!r}"
    )
    print(f"[diagnose-check] PASS ({len(diagnosis)} chars)")
