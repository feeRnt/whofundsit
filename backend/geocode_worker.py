"""WhoFundsIt batch geocoder — Modal + Nominatim (CPU only, no GPU needed).

TEMPLATE: not deployed from the coding sandbox. Deploy: modal deploy
backend/geocode_worker.py, then set MODAL_GEOCODE_URL=<printed URL> and
GEOCODE_BACKEND=modal in backend/.env.
Contract: POST {"texts": [...], "userAgent": "..."} ->
[{lat, lng} | null, ...] aligned by index (max 200 texts per call).
Caveat: Nominatim may throttle datacenter egress IPs; if batches start
failing, run with GEOCODE_BACKEND unset (local) instead.
"""

import modal
import time

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
MAX_BATCH = 200

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("requests", "fastapi[standard]")
)

app = modal.App("whofundsit-geocoder")


@app.function(image=image, timeout=600)
@modal.fastapi_endpoint(method="POST", label="geocode")
def geocode_endpoint(payload: dict) -> list:
    import requests

    texts = [t for t in payload.get("texts", []) if isinstance(t, str)][:MAX_BATCH]
    ua = payload.get("userAgent") or "WhoFundsIt/0.1 (contact: dev@example.com)"
    out = []
    for i, text in enumerate(texts):
        if i:
            time.sleep(1.1)  # Nominatim usage policy: <= 1 req/s
        try:
            r = requests.get(
                NOMINATIM_URL,
                params={"format": "jsonv2", "limit": 1, "q": text},
                headers={
                    "User-Agent": ua,
                    "Accept": "application/json",
                    "Accept-Encoding": "gzip, deflate",
                },
                timeout=30,
            )
            hits = r.json()
            out.append(
                {"lat": float(hits[0]["lat"]), "lng": float(hits[0]["lon"])}
                if hits
                else None
            )
        except Exception:
            out.append(None)
    return out
