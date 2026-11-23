# VaultTabs

> **Crash-Proof Tab & Tab Group Session Manager with Zero Duplication**

A fast, privacy-first Chrome Manifest V3 extension built by **ARIS PARTY LLC** to outperform **Tab Session Manager** (`iaiomicjabeggjcfkbimgmglanimpnae`, 100K+ users, 3.5★).

- **Product Page:** https://arisparty.org/extensions/vaulttabs
- **Privacy Policy:** https://arisparty.org/extensions/vaulttabs/privacy
- **Support & Setup:** https://arisparty.org/extensions/vaulttabs/support (`support@arisparty.org`)

## Competitive Advantages
- Replaces Tab Session Manager (100K users, 3.5★, notorious session wipes & Tab Group duplication bugs)
- Atomic write-verified storage prevents update/crash data wipes
- Smart Tab Group matching restores groups cleanly without duplicating them on relaunch
- Zero invasive Google identity/OAuth bloat (~55KB vs 2.79MB)

## Free vs VaultTabs Pro
### Free
- Crash-proof versioned session snapshots stored safely in chrome.storage.local
- Preserves Chrome Tab Groups (titles, colors, collapsed state) WITHOUT duplicating groups on restore
- Up to 10 named saved sessions with instant Open in New Window or Merge into Current Window
- 1-click JSON export and import backup

### Pro (Monetized via Stripe)
- Unlimited named sessions with custom tags & search
- Rolling automatic scheduled backup snapshots (never lose tabs after a crash)
- Edit, reorder, and delete individual tabs inside saved sessions
- Session Buddy & Tab Session Manager JSON importer

| Plan | Price | Stripe Product / Price ID | Live Checkout Link |
|---|---|---|---|
| Monthly | $2.99/mo | `price_1UeE3UFtqvN4GZH3is80rHW0` | [Checkout](https://buy.stripe.com/9B65kDgrZe0hamj6eCg3609) |
| Yearly | $19.99/yr | `price_1UeE4bFtqvN4GZH3M6mBCxld` | [Checkout](https://buy.stripe.com/9B67sL2B95tL51Z1Ymg360j) |
| Lifetime | $29.99 one-time | `price_1UeE5lFtqvN4GZH3L11s3nmX` | [Checkout](https://buy.stripe.com/eVq4gz8Zx6xPdyv1Ymg360t) |

- **Stripe Product ID:** `prod_VfZAoAPsczoCoh`

## Local Installation (Chrome)
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** and select this repository root

## Verification & Chrome Web Store Packaging
```bash
node tests/verify.mjs .
```
Outputs a store-ready archive with 56 `_locales` at `dist/vaulttabs-extension-v1.0.1.zip`.
