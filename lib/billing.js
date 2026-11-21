/**
 * Shared ARIS Chrome Utility Suite — Stripe Monetization & Pro Entitlement Module.
 * Zero tracking, zero telemetry. Opens live Stripe Payment Links directly and
 * supports online Stripe verification (Cloud Run verifier) or offline signed license keys.
 */
export class BillingManager {
  constructor(config) {
    this.config = config;
    this.storageKey = `aris_pro_${config.productKey}`;
    this.state = {
      tier: "free",
      plan: null,
      email: "",
      licenseKey: "",
      activatedAt: null,
      verifierUrl: config.verifierUrl || ""
    };
  }

  async init() {
    const data = await chrome.storage.local.get(this.storageKey);
    if (data && data[this.storageKey]) {
      this.state = { ...this.state, ...data[this.storageKey] };
    }
    return this.state;
  }

  isPro() {
    return this.state.tier === "pro";
  }

  openCheckout(planKey) {
    const link = this.config.paymentLinks?.[planKey];
    if (!link) throw new Error(`Missing payment link for ${planKey}`);
    const url = this.state.email
      ? `${link}${link.includes("?") ? "&" : "?"}prefilled_email=${encodeURIComponent(this.state.email)}`
      : link;
    chrome.tabs.create({ url });
  }

  /**
   * Validates deterministic offline license format ARIS-<PROD4>-<8HEX>-<4CHK>
   * or verifies live email against the deployed Stripe Cloud Run verifier.
   */
  validateOfflineKey(rawKey) {
    const key = String(rawKey || "").trim().toUpperCase();
    const prefix = this.config.productKey.slice(0, 4).toUpperCase();
    const match = key.match(/^ARIS-([A-Z0-9]{4})-([A-F0-9]{8})-([A-F0-9]{4})$/);
    if (!match || match[1] !== prefix) return false;
    const payload = `ARIS:${match[1]}:${match[2]}:SUITE2026`;
    let hash = 0x811c9dc5;
    for (let i = 0; i < payload.length; i++) {
      hash ^= payload.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    const expected = (hash & 0xffff).toString(16).toUpperCase().padStart(4, "0");
    return match[3] === expected;
  }

  async restoreByEmail(email, verifierUrlOverride) {
    const cleanEmail = String(email || "").trim().toLowerCase();
    if (!cleanEmail || !cleanEmail.includes("@")) {
      return { ok: false, error: "Enter the email address used at Stripe checkout." };
    }
    const endpoint = (verifierUrlOverride || this.state.verifierUrl || this.config.verifierUrl || "").replace(/\/+$/, "");
    if (!endpoint) {
      return {
        ok: false,
        error: "Verifier endpoint not configured yet. Deploy server/verifier.py or enter your ARIS Pro license key."
      };
    }
    try {
      const resp = await fetch(`${endpoint}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: cleanEmail,
          product_id: this.config.stripeProductId,
          product_key: this.config.productKey
        })
      });
      const json = await resp.json();
      if (!resp.ok) {
        return { ok: false, error: json.error || `Verification failed (${resp.status})` };
      }
      if (json.tier === "pro") {
        this.state = {
          ...this.state,
          tier: "pro",
          plan: json.plan || "stripe",
          email: cleanEmail,
          activatedAt: new Date().toISOString()
        };
        await chrome.storage.local.set({ [this.storageKey]: this.state });
        return { ok: true, state: this.state };
      }
      return { ok: false, error: json.reason || "No active Pro subscription or lifetime purchase found for this email." };
    } catch (err) {
      return { ok: false, error: `Could not reach verifier: ${err.message}` };
    }
  }

  async activateLicenseKey(rawKey, email = "") {
    const key = String(rawKey || "").trim().toUpperCase();
    if (!this.validateOfflineKey(key)) {
      return { ok: false, error: "Invalid license key format or checksum." };
    }
    this.state = {
      ...this.state,
      tier: "pro",
      plan: "license",
      email: String(email || this.state.email || "").trim().toLowerCase(),
      licenseKey: key,
      activatedAt: new Date().toISOString()
    };
    await chrome.storage.local.set({ [this.storageKey]: this.state });
    return { ok: true, state: this.state };
  }

  async deactivate() {
    this.state = {
      ...this.state,
      tier: "free",
      plan: null,
      licenseKey: "",
      activatedAt: null
    };
    await chrome.storage.local.set({ [this.storageKey]: this.state });
    return this.state;
  }

  async openPortal() {
    const endpoint = (this.state.verifierUrl || this.config.verifierUrl || "").replace(/\/+$/, "");
    if (!endpoint || !this.state.email) {
      return { ok: false, error: "Configure verifier URL & checkout email to open Stripe Customer Portal." };
    }
    const resp = await fetch(`${endpoint}/portal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: this.state.email, product_key: this.config.productKey })
    });
    const data = await resp.json();
    if (data.url) {
      chrome.tabs.create({ url: data.url });
      return { ok: true };
    }
    return { ok: false, error: data.error || "Unable to open billing portal." };
  }

  mountProPanel(container, { onToast, onTierChange }) {
    const render = () => {
      const isPro = this.isPro();
      container.innerHTML = `
        <div class="card">
          <div class="row">
            <div>
              <div style="font-weight:700;font-size:14px;">${this.config.proName}</div>
              <div class="muted">${isPro ? `Active (${this.state.plan || "pro"})` : "Free Plan · Upgrade anytime via Stripe"}</div>
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
          <div class="muted" style="text-align:center;">Secured by Stripe · ARIS PARTY LLC · Cancel anytime</div>
        </div>
        <div class="card">
          <div class="card-title">Restore Purchase / License Key</div>
          <div style="display:flex;flex-direction:column;gap:7px;">
            <input type="email" id="arisBillingEmail" placeholder="Stripe checkout email (e.g. you@domain.com)" value="${this.state.email || ""}">
            <div class="row">
              <button class="btn btn-sm" id="arisRestoreBtn" style="flex:1;">Restore via Stripe</button>
              ${isPro ? `<button class="btn btn-sm" id="arisPortalBtn">Billing Portal</button>` : ""}
            </div>
            <input type="text" id="arisLicenseInput" placeholder="Or enter license key: ARIS-${this.config.productKey.slice(0,4).toUpperCase()}-XXXXXXXX-XXXX" value="${this.state.licenseKey || ""}">
            <div class="row">
              <button class="btn btn-sm" id="arisActivateKeyBtn" style="flex:1;">Activate Key</button>
              ${isPro ? `<button class="btn btn-danger btn-sm" id="arisResetFreeBtn">Reset to Free</button>` : ""}
            </div>
          </div>
        </div>
      `;

      container.querySelectorAll("[data-checkout]").forEach(btn => {
        btn.addEventListener("click", () => {
          const emailInput = container.querySelector("#arisBillingEmail");
          if (emailInput && emailInput.value.trim()) {
            this.state.email = emailInput.value.trim();
          }
          this.openCheckout(btn.getAttribute("data-checkout"));
          onToast?.("Opening secure Stripe Checkout...");
        });
      });

      container.querySelector("#arisRestoreBtn")?.addEventListener("click", async () => {
        const email = container.querySelector("#arisBillingEmail").value;
        const res = await this.restoreByEmail(email);
        if (res.ok) {
          onToast?.(`${this.config.proName} restored!`);
          onTierChange?.(this.state);
          render();
        } else {
          onToast?.(res.error);
        }
      });

      container.querySelector("#arisActivateKeyBtn")?.addEventListener("click", async () => {
        const key = container.querySelector("#arisLicenseInput").value;
        const email = container.querySelector("#arisBillingEmail").value;
        const res = await this.activateLicenseKey(key, email);
        if (res.ok) {
          onToast?.(`${this.config.proName} unlocked!`);
          onTierChange?.(this.state);
          render();
        } else {
          onToast?.(res.error);
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
