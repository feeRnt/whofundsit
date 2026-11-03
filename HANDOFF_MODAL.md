# Handoff: the two Modal workers (for Wonder)

Two files, two apps, three endpoints total. (`geocode_worker.py` exists but is untouched and out of scope.)

## backend/formalize_worker.py → app `whofundsit-formalize`
- 70B (Llama-3.3-70B-Instruct, fp8) on L40S:2. One endpoint: `formalize` (`{"text"}` or batched `{"texts"}` → parsed address JSON).
- Timeouts: class `startup_timeout` 1hr (covers the ~140 GB weight download) + exec 15min; CPU endpoint wrapper 22min; client waits 25min. Scaledown 5s idle.
- Weights cached on `hf-hub-cache` Modal Volume (free tier), committed after load.
- `.env` key: `MODAL_FORMALIZE_URL`. Secret name via deploy-time `MODAL_HF_SECRET_NAME` (default `huggingface-secret`).

## backend/inference_worker.py → app `whofundsit-inference`
- 8B (Llama-3.1-8B-Instruct) on T4:1. One endpoint: `diagnose` (`{"text": flag}` → `{"diagnosis"}`).
- Timeouts: startup 30min + exec 15min class; endpoint 22min (aligned with formalize 2026-11-03). Scaledown 2s.
- Weights cached on `hf-hub-cache-8b` volume (~16 GB).
- `.env` key: `MODAL_INFERENCE_URL` (named after the live app URL, not the endpoint). Same secret scheme as above.

## Live state + the open doubt — RESOLVED 2026-11-03 (Wonder)
- Root cause was NOT the download. GPU log (`backend/modal`, container ta-01M6G7DP6GJJAA01NAZEBJ18DR, Nov 03 08:11 UTC): vllm 0.6.3 engine init crashes in ~9s with `AttributeError: TokenizersBackend has no attribute all_special_tokens_extended` — unpinned `transformers` now resolves to a release that removed that API (log also shows transformers disabling PyTorch vs torch 2.4). Crash happens in tokenizer init, BEFORE weight download: `hf_cache.commit()` never runs, so the volume holds at most tokenizer/config files — the ~140 GB weights have (almost certainly) never finished downloading. Endpoint then hits its 10min timeout per attempt and the class crash-loops.
- Fix (both workers, committed, NOT deployed): pin `transformers==4.45.2` beside `vllm==0.6.3`; inference also gained `startup_timeout` 30min + endpoint 22min. Timeout chains are now consistent for cold start once the crash is gone: formalize client 25min ≥ endpoint 22min, class startup 1hr covers the 140 GB pull; first successful deploy will be slow (full download), later cold starts hit the volume.
- Inference worker is idle: safe to deploy anytime. Formalize: still redeploy only AFTER the live client run ends.
- Note: diagnose client (`claimsVerify.ts`) waits 300s — fine warm, short for a cold 8B start; bump only if a cold diagnose actually times out.
