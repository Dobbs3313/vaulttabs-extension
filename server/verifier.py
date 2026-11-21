"""
ARIS PARTY LLC — Multi-Product Stripe Entitlement Verifier & Billing Portal
Supports both recurring Pro subscriptions (monthly/yearly) and one-time Lifetime purchases
for all 10 Chrome Utility Suite extensions. Deploy directly to Google Cloud Run.
"""
import os
import stripe
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

stripe.api_key = os.environ.get("STRIPE_SECRET_KEY", "")

ALLOWED_PRODUCTS = {
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


def find_customers_by_email(email: str):
    return stripe.Customer.list(email=email, limit=5).data


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True, "products": len(ALLOWED_PRODUCTS)})


@app.route("/verify", methods=["POST"])
def verify():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    product_key = (data.get("product_key") or "").strip().lower()
    product_id = ALLOWED_PRODUCTS.get(product_key) or data.get("product_id")

    if not email or not product_id:
        return jsonify({"error": "Missing email or valid product_key"}), 400
    if not stripe.api_key:
        return jsonify({"error": "STRIPE_SECRET_KEY not configured"}), 500

    try:
        customers = find_customers_by_email(email)
        for cust in customers:
            # 1. Check active/trialing subscriptions containing target product
            subs = stripe.Subscription.list(customer=cust.id, status="active", limit=20)
            for sub in subs.data:
                for item in sub.get("items", {}).get("data", []):
                    price = item.get("price") or {}
                    if price.get("product") == product_id:
                        interval = (price.get("recurring") or {}).get("interval", "subscription")
                        return jsonify({"tier": "pro", "plan": interval, "email": email, "product_id": product_id})

            # 2. Check completed one-time Checkout Sessions (Lifetime)
            sessions = stripe.checkout.Session.list(customer=cust.id, limit=25)
            for sess in sessions.data:
                if sess.get("payment_status") == "paid" and sess.get("mode") == "payment":
                    meta = sess.get("metadata") or {}
                    if meta.get("aris_product_key") == product_key:
                        return jsonify({"tier": "pro", "plan": "lifetime", "email": email, "product_id": product_id})
                    line_items = stripe.checkout.Session.list_line_items(sess.id, limit=10)
                    for li in line_items.data:
                        if (li.get("price") or {}).get("product") == product_id:
                            return jsonify({"tier": "pro", "plan": "lifetime", "email": email, "product_id": product_id})

        return jsonify({"tier": "free", "reason": "No active subscription or lifetime purchase found for this product."})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.route("/portal", methods=["POST"])
def portal():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()
    return_url = data.get("return_url") or "https://chromewebstore.google.com/"
    if not email:
        return jsonify({"error": "Missing email"}), 400
    try:
        customers = find_customers_by_email(email)
        if not customers:
            return jsonify({"error": "No Stripe customer found for that email."}), 404
        session = stripe.billing_portal.Session.create(customer=customers[0].id, return_url=return_url)
        return jsonify({"url": session.url})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
