/**
 * Shared ARIS Chrome Utility Suite — Zero-PII Stripe Monetization & Pro Entitlement Module (v2).
 *
 * Privacy & Security:
 * - Zero tracking, zero telemetry, zero email-only lookups.
 * - Checkout opens live Stripe Payment Links directly on buy.stripe.com.
 * - After checkout, Stripe redirects to the ARIS verifier /success page, which mints an
 *   ECDSA P-256 signed license key (ARIS1.<payload>.<sig>) containing NO personal data.
 * - Users can paste either their signed ARIS1. license key or a Stripe Checkout Session
 *   claim code (cs_live_...) into the Pro tab to unlock Pro.
 */
const LICENSE_PUBLIC_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "rBofjg_N6NbDO33ff9QBbz63irMOxYld1TkfdWdx0pY",
  y: "MefMsiP3aW68E75BktND5D-wLbZI_BzG528wwdoio08"
};

// Re-check subscription/refund status this often using only the signed license key.
const RECHECK_MS = 3 * 24 * 60 * 60 * 1000;
// Keep Pro unlocked during offline periods up to 21 days if the server cannot be reached.
const OFFLINE_GRACE_MS = 21 * 24 * 60 * 60 * 1000;

const esc = v =>
  String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function b64urlToBytes(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(str.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

export class BillingManager {
  constructor(config) {
    this.config = config;
    this.storageKey = `aris_pro_${config.productKey}`;
    this.state = {
      tier: "free",
      plan: null,
      licenseKey: "",
      activatedAt: null,
      verifiedAt: null,
      verifierUrl: config.verifierUrl || ""
    };
  }

  async init() {
    const data = await chrome.storage.local.get(this.storageKey);
    if (data && data[this.storageKey]) {
      // Strip any legacy email field from v1 storage so no personal data lingers locally.
      const { email: _drop, ...clean } = data[this.storageKey];
      this.state = { ...this.state, ...clean };
    }
    if (this.config.verifierUrl) this.state.verifierUrl = this.config.verifierUrl;
    await this._migrateLegacyState();
    this._recheckEntitlement(); // fire-and-forget; never blocks popup rendering
    return this.state;
  }

  // Drop legacy email-only or non-P256 states that lack a cryptographically valid ARIS1 key.
  async _migrateLegacyState() {
    if (this.state.tier === "pro") {
      const payload = await this.parseAndVerifyKey(this.state.licenseKey);
      if (!payload) {
        await this.deactivate();
      }
    }
  }

  async _recheckEntitlement() {
    if (this.state.tier !== "pro" || !this.state.licenseKey) return;
    const payload = await this.parseAndVerifyKey(this.state.licenseKey);
    if (!payload) {
      await this.deactivate();
      return;
    }
    // Only subscription or session-bound lifetime keys need periodic server status checks.
    if (!payload.sub && !payload.cs) return;
    const last = Date.parse(this.state.verifiedAt || this.state.activatedAt || 0) || 0;
    if (Date.now() - last < RECHECK_MS) return;

    const res = await this._callStatus(this.state.licenseKey);
    if (res.status === "pro") {
      this.state = { ...this.state, plan: res.plan || this.state.plan, verifiedAt: new Date().toISOString() };
      await this._save();
    } else if (res.status === "free" || (payload.sub && Date.now() - last > OFFLINE_GRACE_MS)) {
      await this.deactivate();
    }
  }

  async _save() {
    await chrome.storage.local.set({ [this.storageKey]: this.state });
  }

  _endpoint() {
    return (this.config.verifierUrl || this.state.verifierUrl || "").replace(/\/+$/, "");
  }

  async _callClaim(code) {
    const endpoint = this._endpoint();
    if (!endpoint) return { ok: false, error: "License server URL is not configured." };
    try {
      const resp = await fetch(`${endpoint}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, product_key: this.config.productKey })
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) return { ok: false, error: json.error || `Claim failed (${resp.status}).` };
      if (json.tier === "pro" && json.license_key) {
        return { ok: true, plan: json.plan || "pro", licenseKey: json.license_key };
      }
      return { ok: false, error: json.error || "Checkout code could not be verified." };
    } catch (err) {
      return { ok: false, error: `Could not reach the license server: ${err.message}` };
    }
  }

  async _callStatus(licenseKey) {
    const endpoint = this._endpoint();
    if (!endpoint) return { status: "error", error: "License server URL is not configured." };
    try {
      const resp = await fetch(`${endpoint}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ license_key: licenseKey, product_key: this.config.productKey })
      });
      const json = await resp.json().catch(() => ({}));
      if (!resp.ok) return { status: resp.status === 400 ? "free" : "error", error: json.error || `Status check failed (${resp.status})` };
      if (json.tier === "pro") return { status: "pro", plan: json.plan };
      return { status: "free", error: json.reason };
    } catch (err) {
      return { status: "error", error: `Could not reach the license server: ${err.message}` };
    }
  }

  isPro() {
    return this.state.tier === "pro";
  }

  openCheckout(planKey) {
    const link = this.config.paymentLinks?.[planKey];
    if (!link) throw new Error(`Missing payment link for ${planKey}`);
    chrome.tabs.create({ url: link });
  }

  /**
   * Verifies an ECDSA P-256 signed license key (ARIS1.<base64url JSON>.<base64url 64-byte sig>)
   * and returns its decoded payload object if valid for this product, or null otherwise.
   */
  async parseAndVerifyKey(rawKey) {
    try {
      const parts = String(rawKey || "").trim().split(".");
      if (parts.length !== 3 || parts[0] !== "ARIS1") return null;
      const payloadBytes = b64urlToBytes(parts[1]);
      const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
      if (!payload || payload.p !== this.config.productKey) return null;
      const key = await crypto.subtle.importKey(
        "jwk",
        LICENSE_PUBLIC_JWK,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"]
      );
      const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
      const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64urlToBytes(parts[2]), signed);
      return ok ? payload : null;
    } catch {
      return null;
    }
  }

  async validateOfflineKey(rawKey) {
    return (await this.parseAndVerifyKey(rawKey)) !== null;
  }

  /**
   * Unified activation accepting either:
   *  - A signed ARIS1.<payload>.<sig> license key (from the /success page or support keygen), OR
   *  - A Stripe Checkout Session ID (cs_live_... / cs_test_...) exchanged via POST /claim.
   */
  async activate(rawInput) {
    const token = String(rawInput || "").trim();
    if (!token) {
      return { ok: false, error: "Paste your ARIS1. license key or Stripe checkout code (cs_...)." };
    }

    if (/^cs_(?:live|test)_/.test(token)) {
      const claimed = await this._callClaim(token);
      if (!claimed.ok) return claimed;
      const payload = await this.parseAndVerifyKey(claimed.licenseKey);
      if (!payload) return { ok: false, error: "Server returned an invalid license signature." };
      const now = new Date().toISOString();
      this.state = {
        ...this.state,
        tier: "pro",
        plan: claimed.plan || payload.pl || "pro",
        licenseKey: claimed.licenseKey,
        activatedAt: now,
        verifiedAt: now
      };
      await this._save();
      return { ok: true, state: this.state };
    }

    const payload = await this.parseAndVerifyKey(token);
    if (!payload) {
      return { ok: false, error: "That license key or checkout code isn't valid for this extension." };
    }

    // If bound to a Stripe subscription or session, verify it hasn't been canceled/refunded.
    let plan = payload.pl || "license";
    let verifiedAt = null;
    if ((payload.sub || payload.cs) && this._endpoint()) {
      const st = await this._callStatus(token);
      if (st.status === "free") {
        return { ok: false, error: st.error || "This subscription or purchase is no longer active." };
      }
      if (st.status === "pro") {
        plan = st.plan || plan;
        verifiedAt = new Date().toISOString();
      }
    }

    const now = new Date().toISOString();
    this.state = {
      ...this.state,
      tier: "pro",
      plan,
      licenseKey: token,
      activatedAt: now,
      verifiedAt: verifiedAt || now
    };
    await this._save();
    return { ok: true, state: this.state };
  }

  async activateLicenseKey(rawKey) {
    return this.activate(rawKey);
  }

  async deactivate() {
    this.state = {
      ...this.state,
      tier: "free",
      plan: null,
      licenseKey: "",
      activatedAt: null,
      verifiedAt: null
    };
    await this._save();
    return this.state;
  }

  async openPortal() {
    const url = this.config.portalLoginUrl || "";
    if (!url) return { ok: false, error: "Use your Stripe receipt link or contact support to manage billing." };
    chrome.tabs.create({ url });
    return { ok: true };
  }

  mountProPanel(container, { onToast, onTierChange }) {
    const render = () => {
      const isPro = this.isPro();
      container.innerHTML = `
        <div class="card">
          <div class="row">
            <div>
              <div style="font-weight:700;font-size:14px;">${this.config.proName}</div>
              <div class="muted">${isPro ? `Active (${esc(this.state.plan || "pro")})` : "Free Plan · Upgrade anytime via Stripe"}</div>
            </div>
            <span class="tier-pill ${isPro ? "pro" : ""}">${isPro ? "PRO ACTIVE" : "FREE"}</span>
          </div>
          <ul class="feature-list">
            ${this.config.proFeatures.map(f => `<li>${f}</li>`).join("")}
          </ul>
          <div class="plan-grid">
            <div class="plan-card">
              <div>
                <div class="plan-badge">Flexible</div>
                <div class="plan-name">Monthly</div>
                <div class="plan-price">$2.99</div>
                <div class="plan-note">per month</div>
              </div>
              <button class="btn btn-sm btn-block" data-checkout="monthly">Choose</button>
            </div>
            <div class="plan-card featured">
              <div>
                <div class="plan-badge">Save 44%</div>
                <div class="plan-name">Yearly</div>
                <div class="plan-price">$19.99</div>
                <div class="plan-note">$1.67/mo billed yearly</div>
              </div>
              <button class="btn btn-primary btn-sm btn-block" data-checkout="yearly">Upgrade</button>
            </div>
            <div class="plan-card">
              <div>
                <div class="plan-badge">One-Time</div>
                <div class="plan-name">Lifetime</div>
                <div class="plan-price">$29.99</div>
                <div class="plan-note">pay once, keep forever</div>
              </div>
              <button class="btn btn-sm btn-block" data-checkout="lifetime">Unlock</button>
            </div>
          </div>
          <div class="muted" style="text-align:center;">Secured by Stripe · ARIS PARTY LLC · Instant license key after checkout</div>
        </div>
        <div class="card">
          <div class="card-title">Activate License Key or Checkout Code</div>
          <div style="display:flex;flex-direction:column;gap:7px;">
            <input type="text" id="arisLicenseInput" placeholder="Paste ARIS1. license key or cs_... checkout code" value="${esc(this.state.licenseKey)}">
            <div class="row">
              <button class="btn btn-primary btn-sm" id="arisActivateBtn" style="flex:1;">Activate Pro</button>
              ${isPro && this.state.licenseKey ? `<button class="btn btn-sm" id="arisCopyKeyBtn">Copy Key</button>` : ""}
            </div>
            ${isPro ? `
              <div class="row">
                ${this.config.portalLoginUrl ? `<button class="btn btn-sm" id="arisPortalBtn" style="flex:1;">Manage Billing</button>` : ""}
                <button class="btn btn-danger btn-sm" id="arisResetFreeBtn" style="flex:1;">Reset to Free</button>
              </div>
            ` : `<div class="muted">Zero personal data collected: checkout gives you a signed key right on the confirmation page.</div>`}
          </div>
        </div>
      `;

      container.querySelectorAll("[data-checkout]").forEach(btn => {
        btn.addEventListener("click", () => {
          this.openCheckout(btn.getAttribute("data-checkout"));
          onToast?.("Opening secure Stripe Checkout...");
        });
      });

      container.querySelector("#arisActivateBtn")?.addEventListener("click", async () => {
        const btn = container.querySelector("#arisActivateBtn");
        const val = container.querySelector("#arisLicenseInput").value;
        btn.disabled = true;
        btn.textContent = "Verifying...";
        const res = await this.activate(val);
        btn.disabled = false;
        btn.textContent = "Activate Pro";
        if (res.ok) {
          onToast?.(`${this.config.proName} unlocked!`);
          onTierChange?.(this.state);
          render();
        } else {
          onToast?.(res.error);
        }
      });

      container.querySelector("#arisCopyKeyBtn")?.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(this.state.licenseKey);
          onToast?.("License key copied!");
        } catch {
          onToast?.("Select and copy the key from the box above.");
        }
      });

      container.querySelector("#arisPortalBtn")?.addEventListener("click", async () => {
        const res = await this.openPortal();
        if (!res.ok) onToast?.(res.error);
      });

      container.querySelector("#arisResetFreeBtn")?.addEventListener("click", async () => {
        await this.deactivate();
        onToast?.("Switched back to Free tier.");
        onTierChange?.(this.state);
        render();
      });
    };

    render();
    return { rerender: render };
  }
}
