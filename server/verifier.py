"""
ARIS PARTY LLC — Cryptographic Stripe Entitlement Verifier for the 10 Chrome Utility Suite extensions.

Security & Privacy Design (v2 — Zero-Email Enumeration):
- No email-only lookup endpoint exists. No customer email is collected, logged, or returned.
- Buyers unlock Pro either by copying their ECDSA P-256 signed license key (ARIS1.<payload>.<sig>)
  shown immediately on Stripe's /success?session_id={CHECKOUT_SESSION_ID} redirect page, OR by
  pasting their Stripe Checkout Session ID (cs_live_...) into POST /claim.
- Recurring subscriptions and lifetime purchases are re-checked via POST /status using ONLY the
  cryptographically signed license key (verified locally via ECDSA P-256 before querying Stripe).

Environment Secrets (Google Secret Manager):
- STRIPE_SECRET_KEY    : Read-only Stripe restricted key (rk_live_...)
- LICENSE_SIGNING_KEY  : ECDSA P-256 private key PEM (_tools/keys/license-signing-key.pem)
"""
import base64
import html
import json
import os
import re
import secrets
import threading
import time
from collections import defaultdict, deque

import stripe
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import (
    decode_dss_signature,
    encode_dss_signature,
)
from flask import Flask, jsonify, make_response, request
from flask_cors import CORS

app = Flask(__name__)
# Extension popups call /claim and /status; /success is viewed directly in the browser after Stripe checkout.
CORS(
    app,
    resources={
        r"/(claim|status|health)": {
            "origins": [re.compile(r"^chrome-extension://[a-p]{32}$")],
            "methods": ["POST", "GET", "OPTIONS"],
        }
    },
)

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "").strip()
stripe.max_network_retries = 2

PRODUCTS = {
    "eclipsedark": "prod_VfZAcEmjgk8g8I",
    "lexipop": "prod_VfZA0QdeRm3Opf",
    "sweepclean": "prod_VfZAA1Ivm61Ze6",
    "consentzero": "prod_VfZArgHBYmhP1Z",
    "snapforge": "prod_VfZA1TFydJxw96",
    "tabpulse": "prod_VfZAbATt9W00ig",
    "clarityread": "prod_VfZAU36JDMI1BF",
    "ramguard": "prod_VfZAev4Vk6qhtW",
    "vaulttabs": "prod_VfZAoAPsczoCoh",
    "pulsereload": "prod_VfZASkP06Mf3fn",
}
PRODUCT_NAMES = {
    "eclipsedark": "EclipseDark Pro",
    "lexipop": "LexiPop Pro",
    "sweepclean": "SweepClean Pro",
    "consentzero": "ConsentZero Pro",
    "snapforge": "SnapForge Pro",
    "tabpulse": "TabPulse Pro",
    "clarityread": "ClarityRead Pro",
    "ramguard": "RamGuard Pro",
    "vaulttabs": "VaultTabs Pro",
    "pulsereload": "PulseReload Pro",
}
PRODUCT_ID_TO_KEY = {v: k for k, v in PRODUCTS.items()}

LIVE_SUB_STATUSES = {"active", "trialing", "past_due"}
SESSION_ID_RE = re.compile(r"^cs_(?:live|test)_[A-Za-z0-9_]{16,120}$")

# Per-IP rate limiting
_hits = defaultdict(deque)
_hits_lock = threading.Lock()


def rate_limited(bucket: str, ip: str, limit: int, window_sec: int) -> bool:
    now = time.time()
    key = f"{bucket}:{ip}"
    with _hits_lock:
        q = _hits[key]
        while q and now - q[0] > window_sec:
            q.popleft()
        if len(q) >= limit:
            return True
        q.append(now)
        return False


def _client_ip() -> str:
    return (request.headers.get("X-Forwarded-For") or request.remote_addr or "?").split(",")[0].strip()


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(text: str) -> bytes:
    pad = "=" * ((4 - len(text) % 4) % 4)
    return base64.urlsafe_b64decode(text + pad)


def _load_signing_key():
    pem = os.environ.get("LICENSE_SIGNING_KEY", "").strip()
    if not pem:
        return None
    # Handle escaped newlines if injected via single-line env var
    if "\\n" in pem and "\n" not in pem:
        pem = pem.replace("\\n", "\n")
    return serialization.load_pem_private_key(pem.encode("utf-8"), password=None)


_SIGNING_KEY = _load_signing_key()


def get_signing_key():
    global _SIGNING_KEY
    if _SIGNING_KEY is None:
        _SIGNING_KEY = _load_signing_key()
    return _SIGNING_KEY


def mint_license_key(product_key: str, plan: str, session_id: str = "", sub_id: str = "") -> str:
    key = get_signing_key()
    if key is None:
        raise RuntimeError("LICENSE_SIGNING_KEY not configured")
    payload = {
        "p": product_key,
        "pl": plan,
        "iat": int(time.time()),
        "id": secrets.token_hex(6),
    }
    if session_id:
        payload["cs"] = session_id
    if sub_id:
        payload["sub"] = sub_id
    head = "ARIS1." + _b64url_encode(json.dumps(payload, separators=(",", ":")).encode("utf-8"))
    r, s = decode_dss_signature(key.sign(head.encode("ascii"), ec.ECDSA(hashes.SHA256())))
    return head + "." + _b64url_encode(r.to_bytes(32, "big") + s.to_bytes(32, "big"))


def verify_license_key(raw_key: str, expected_product: str = None):
    """Verify ECDSA P-256 signature and return decoded payload dict, or None if invalid."""
    key = get_signing_key()
    if key is None:
        return None
    try:
        parts = str(raw_key or "").strip().split(".")
        if len(parts) != 3 or parts[0] != "ARIS1":
            return None
        payload = json.loads(_b64url_decode(parts[1]).decode("utf-8"))
        if not isinstance(payload, dict) or payload.get("p") not in PRODUCTS:
            return None
        if expected_product and payload.get("p") != expected_product:
            return None
        sig_raw = _b64url_decode(parts[2])
        if len(sig_raw) != 64:
            return None
        r = int.from_bytes(sig_raw[:32], "big")
        s = int.from_bytes(sig_raw[32:], "big")
        der_sig = encode_dss_signature(r, s)
        head = f"{parts[0]}.{parts[1]}".encode("ascii")
        key.public_key().verify(der_sig, head, ec.ECDSA(hashes.SHA256()))
        return payload
    except (InvalidSignature, ValueError, KeyError, TypeError, json.JSONDecodeError):
        return None


def g(obj, key, default=None):
    if obj is None:
        return default
    try:
        val = obj[key]
    except (KeyError, TypeError, IndexError):
        val = getattr(obj, key, default)
    return default if val is None else val


def payment_refunded(session) -> bool:
    pi_id = g(session, "payment_intent")
    if not pi_id:
        return False
    pi = stripe.PaymentIntent.retrieve(
        pi_id if isinstance(pi_id, str) else pi_id.id,
        expand=["latest_charge"],
    )
    charge = g(pi, "latest_charge")
    if not charge or isinstance(charge, str):
        return False
    return bool(g(charge, "refunded")) or bool(g(charge, "disputed"))


def _extract_session_product(session):
    """Return (product_key, plan_hint) from a Stripe Checkout Session's line items or metadata."""
    items = g(session, "line_items")
    if not items:
        items = stripe.checkout.Session.list_line_items(g(session, "id"), limit=10)
    for it in g(items, "data", []) or []:
        price = g(it, "price")
        prod = g(price, "product")
        prod_id = prod if isinstance(prod, str) else g(prod, "id")
        if prod_id in PRODUCT_ID_TO_KEY:
            rec = g(price, "recurring")
            plan_hint = g(rec, "interval") if rec else "lifetime"
            return PRODUCT_ID_TO_KEY[prod_id], plan_hint
    meta = g(session, "metadata") or {}
    pk = (g(meta, "aris_product_key") or "").strip().lower()
    if pk in PRODUCTS:
        return pk, (g(meta, "plan") or "lifetime")
    return None, None


def verify_checkout_session(session_id: str, expected_product_key: str = None):
    """Validate a Stripe Checkout Session and return (ok, result_dict, http_status)."""
    if not SESSION_ID_RE.match(session_id):
        return False, {"error": "Invalid checkout session code format (expected cs_live_...)."}, 400
    if not stripe.api_key:
        return False, {"error": "Stripe API key is not configured."}, 503
    if get_signing_key() is None:
        return False, {"error": "License signing key is not configured."}, 503

    try:
        sess = stripe.checkout.Session.retrieve(session_id, expand=["line_items"])
    except stripe.InvalidRequestError:
        return False, {"error": "Checkout session not found."}, 404
    except stripe.StripeError as exc:
        app.logger.error("Stripe error retrieving session: %s", exc)
        return False, {"error": "Could not reach Stripe. Please try again shortly."}, 502

    if g(sess, "status") != "complete":
        return False, {"error": "Checkout is not complete yet."}, 402

    product_key, plan_hint = _extract_session_product(sess)
    if not product_key:
        return False, {"error": "This checkout session does not match an ARIS Chrome Utility Suite product."}, 400
    if expected_product_key and product_key != expected_product_key:
        return False, {
            "error": f"This checkout belongs to {PRODUCT_NAMES.get(product_key, product_key)}, not {PRODUCT_NAMES.get(expected_product_key, expected_product_key)}."
        }, 400

    mode = g(sess, "mode")
    if mode == "subscription":
        sub_ref = g(sess, "subscription")
        sub_id = sub_ref if isinstance(sub_ref, str) else g(sub_ref, "id")
        if not sub_id:
            return False, {"error": "No subscription attached to this checkout session."}, 402
        try:
            sub = stripe.Subscription.retrieve(sub_id)
        except stripe.StripeError as exc:
            app.logger.error("Stripe error retrieving subscription: %s", exc)
            return False, {"error": "Could not verify subscription status with Stripe."}, 502
        if g(sub, "status") not in LIVE_SUB_STATUSES:
            return False, {"error": f"Subscription is no longer active (status: {g(sub, 'status')})."}, 402
        plan = plan_hint if plan_hint in ("month", "year") else "subscription"
        license_key = mint_license_key(product_key, plan, session_id=session_id, sub_id=sub_id)
        return True, {"tier": "pro", "product_key": product_key, "plan": plan, "license_key": license_key}, 200

    if mode == "payment":
        if g(sess, "payment_status") != "paid":
            return False, {"error": "Payment has not settled yet."}, 402
        if payment_refunded(sess):
            return False, {"error": "This purchase has been refunded or disputed."}, 402
        license_key = mint_license_key(product_key, "lifetime", session_id=session_id)
        return True, {"tier": "pro", "product_key": product_key, "plan": "lifetime", "license_key": license_key}, 200

    return False, {"error": "Unsupported checkout session mode."}, 400


@app.route("/health", methods=["GET"])
def health():
    return jsonify(
        {
            "ok": True,
            "version": "2.0.0",
            "mode": "signed-claim",
            "products": len(PRODUCTS),
            "stripe_key": bool(stripe.api_key),
            "signing_key": get_signing_key() is not None,
        }
    )


@app.route("/claim", methods=["POST"])
def claim():
    if rate_limited("claim", _client_ip(), limit=20, window_sec=600):
        return jsonify({"error": "Too many attempts. Try again in a few minutes."}), 429

    data = request.get_json(silent=True) or {}
    code = (data.get("code") or data.get("session_id") or "").strip()
    product_key = (data.get("product_key") or "").strip().lower()
    if product_key not in PRODUCTS:
        return jsonify({"error": "Unknown product."}), 400

    ok, body, status = verify_checkout_session(code, expected_product_key=product_key)
    return jsonify(body), status


@app.route("/status", methods=["POST"])
def status_check():
    if rate_limited("status", _client_ip(), limit=60, window_sec=600):
        return jsonify({"error": "Too many status checks. Try again shortly."}), 429

    data = request.get_json(silent=True) or {}
    raw_key = (data.get("license_key") or "").strip()
    product_key = (data.get("product_key") or "").strip().lower()
    if product_key not in PRODUCTS:
        return jsonify({"error": "Unknown product."}), 400

    payload = verify_license_key(raw_key, expected_product=product_key)
    if not payload:
        return jsonify({"tier": "free", "error": "Invalid or tampered license key."}), 400

    sub_id = payload.get("sub")
    if sub_id:
        if not stripe.api_key:
            return jsonify({"error": "Stripe API key is not configured."}), 503
        try:
            sub = stripe.Subscription.retrieve(sub_id)
        except stripe.InvalidRequestError:
            return jsonify({"tier": "free", "reason": "Subscription no longer exists."}), 200
        except stripe.StripeError as exc:
            app.logger.error("Stripe status error: %s", exc)
            return jsonify({"error": "Could not reach Stripe. Try again shortly."}), 502
        if g(sub, "status") in LIVE_SUB_STATUSES:
            return jsonify({"tier": "pro", "plan": payload.get("pl") or "subscription"}), 200
        return jsonify({"tier": "free", "reason": f"Subscription ended ({g(sub, 'status')})."}), 200

    cs_id = payload.get("cs")
    if cs_id and payload.get("pl") == "lifetime":
        if not stripe.api_key:
            return jsonify({"error": "Stripe API key is not configured."}), 503
        try:
            sess = stripe.checkout.Session.retrieve(cs_id)
            if payment_refunded(sess):
                return jsonify({"tier": "free", "reason": "Lifetime purchase was refunded or disputed."}), 200
        except stripe.StripeError as exc:
            app.logger.error("Stripe lifetime status error: %s", exc)
            return jsonify({"error": "Could not reach Stripe. Try again shortly."}), 502
        return jsonify({"tier": "pro", "plan": "lifetime"}), 200

    # Support-minted key (no sub/cs bound) — signature already verified above.
    return jsonify({"tier": "pro", "plan": payload.get("pl") or "license"}), 200


@app.route("/success", methods=["GET"])
def success_page():
    if rate_limited("success", _client_ip(), limit=30, window_sec=600):
        return make_response("Too many requests. Please wait a minute and refresh.", 429)

    session_id = (request.args.get("session_id") or "").strip()
    ok, body, status = verify_checkout_session(session_id)

    if not ok:
        err = html.escape(body.get("error", "Unable to verify checkout."))
        page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ARIS Pro Activation</title>
<style>body{{font-family:system-ui,-apple-system,sans-serif;background:#0b1120;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}}
.card{{max-width:480px;width:100%;background:#111827;border:1px solid rgba(248,113,113,.4);border-radius:14px;padding:28px;text-align:center}}
h1{{margin:0 0 10px;font-size:20px;color:#fca5a5}}p{{color:#94a3b8;line-height:1.5}}</style>
</head><body><div class="card"><h1>Activation Incomplete</h1><p>{err}</p>
<p style="font-size:13px">If you just finished paying, refresh this page in a few seconds or contact ARIS PARTY LLC support with your Stripe receipt.</p>
</div></body></html>"""
        resp = make_response(page, status)
        resp.headers["Cache-Control"] = "no-store"
        return resp

    prod_name = html.escape(PRODUCT_NAMES.get(body["product_key"], "ARIS Pro"))
    plan_label = html.escape(body["plan"].capitalize())
    license_key = html.escape(body["license_key"])

    page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{prod_name} — License Key</title>
<style>
  body{{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0b1120;color:#f8fafc;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px}}
  .card{{max-width:540px;width:100%;background:#111827;border:1px solid rgba(56,189,248,.35);border-radius:16px;padding:28px;box-shadow:0 20px 50px rgba(0,0,0,.45)}}
  .pill{{display:inline-block;background:rgba(52,211,153,.15);color:#34d399;border:1px solid rgba(52,211,153,.4);border-radius:999px;padding:3px 10px;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase}}
  h1{{margin:12px 0 6px;font-size:22px}}
  p{{color:#94a3b8;font-size:14px;line-height:1.5;margin:8px 0}}
  textarea{{width:100%;box-sizing:border-box;min-height:92px;background:#0b1120;color:#38bdf8;border:1px solid rgba(148,163,184,.25);border-radius:10px;padding:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;resize:none;word-break:break-all;margin:12px 0}}
  button{{width:100%;background:linear-gradient(135deg,#38bdf8,#0284c7);color:#fff;border:none;border-radius:10px;padding:12px;font-size:14px;font-weight:700;cursor:pointer}}
  button:hover{{filter:brightness(1.08)}}
  ol{{color:#cbd5e1;font-size:13.5px;line-height:1.6;padding-left:20px;margin:16px 0 0}}
</style>
</head><body>
  <div class="card">
    <span class="pill">Payment Verified · {plan_label}</span>
    <h1>{prod_name} Unlocked</h1>
    <p>Copy your signed license key below. Keep it safe — you can use it to activate Pro on your Chrome profiles without sharing your email with the extension.</p>
    <textarea id="keyBox" readonly>{license_key}</textarea>
    <button id="copyBtn" onclick="navigator.clipboard.writeText(document.getElementById('keyBox').value).then(()=>{{document.getElementById('copyBtn').textContent='Copied to Clipboard!';}})">Copy License Key</button>
    <ol>
      <li>Click the <strong>{prod_name.replace(' Pro','')}</strong> icon in your Chrome toolbar.</li>
      <li>Open the <strong>Pro</strong> tab.</li>
      <li>Paste your key into <strong>Activate License Key</strong> and click <strong>Activate</strong>.</li>
    </ol>
  </div>
</body></html>"""
    resp = make_response(page, 200)
    resp.headers["Cache-Control"] = "no-store"
    return resp


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
