# Handoff: the two Modal workers (for Wonder)

Two files, two apps, three endpoints total. (`geocode_worker.py` exists but is untouched and out of scope.)

## backend/formalize_worker.py → app `whofundsit-formalize`
- 70B (Llama-3.3-70B-Instruct, fp8) on L40S:2. One endpoint: `formalize` (`{"text"}` or batched `{"texts"}` → parsed address JSON).
- Timeouts: class `startup_timeout` 1hr (covers the ~140 GB weight download) + exec 15min; CPU endpoint wrapper 22min; client waits 25min. Scaledown 5s idle.
- Weights cached on `hf-hub-cache` Modal Volume (free tier), committed after load.
- `.env` key: `MODAL_FORMALIZE_URL`. Secret name via deploy-time `MODAL_HF_SECRET_NAME` (default `huggingface-secret`).

## backend/inference_worker.py → app `whofundsit-inference`
- 8B (Llama-3.1-8B-Instruct) on T4:1. One endpoint: `diagnose` (`{"text": flag}` → `{"diagnosis"}`).
- Timeouts: still 10min endpoint / 15min class (8B loads fast; bump if it ever matters). Scaledown 2s.
- Weights cached on `hf-hub-cache-8b` volume (~16 GB).
- `.env` key: `MODAL_INFERENCE_URL` (named after the live app URL, not the endpoint). Same secret scheme as above.

## Live state + the open doubt
- Formalize is crash-looping on cold start: endpoint timed out at 10min while the GPU class was still downloading, container idled out, download lost, repeat (crash-loop email received). Nothing above is deployed yet for formalize — the volume + timeout fixes are committed, awaiting a redeploy AFTER the live client run ends (redeploying mid-run kills it; the pass file writes once at the end).
- Inference worker is idle: safe to deploy anytime.
- Both workers compile; client suites green (tsc + 10/10 formalize, 17/17 verify). No deploys run from here.
- Question for you: sanity-check the timeout chain (client 25 ≥ endpoint 22; class startup 1hr/exec 15min) and the volume-cache wiring against current Modal behavior. Owner doubts it'll work; a second pair of eyes wanted.
