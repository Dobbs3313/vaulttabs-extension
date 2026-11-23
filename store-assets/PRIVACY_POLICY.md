# Privacy Policy — VaultTabs

**Effective Date:** November 23, 2026  
**Publisher:** ARIS PARTY LLC  
**Hosted HTML Policy:** https://arisparty.org/extensions/vaulttabs/privacy

## Zero Telemetry & Local-First Design
VaultTabs runs locally inside your Chrome browser. We do **not** collect, sell, rent, or transmit your browsing history, page contents, keystrokes, email address, or personal analytics to any server or third-party tracking service.

## Data Stored Locally
All extension preferences, rules, and user-created items are stored exclusively in Chrome's local/sync extension storage (`chrome.storage`) on your device.

## Optional Pro Upgrades (Stripe & Signed License Keys)
If you choose to upgrade to **VaultTabs Pro**, checkout is processed securely by **Stripe** (`buy.stripe.com`). We never see or store your payment card details. Upon completing checkout, our Cloud Run license verifier (`aris-verifier`) validates your Stripe Checkout Session ID and issues an ECDSA P-256 signed license key (`ARIS1.…`) containing only the product identifier, plan type, and Stripe subscription/session reference — **no personal user data or email address is collected, stored, or transmitted by the extension**.

Periodic subscription status checks send only your signed license key and product identifier to verify that a recurring subscription remains active (or that a lifetime purchase has not been refunded).

## Contact
For privacy or billing support, email [support@arisparty.org](mailto:support@arisparty.org) or visit https://arisparty.org/extensions/vaulttabs/support.
