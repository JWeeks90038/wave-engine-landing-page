# Wave Engine Landing Page

High-conversion, mobile-first landing page for Wave Engine built with plain HTML, CSS, and vanilla JavaScript.

## Stack

- HTML
- CSS
- Vanilla JavaScript

## Project Structure

- `index.html` - page structure and embeds
- `style.css` - layout, visual design, and responsive behavior
- `script.js` - lightweight CTA tracking hooks and embed fallbacks
- `album-generator.html` - AI album cover generator page
- `album-generator.css` - dedicated styling for the generator page
- `album-generator.js` - client-side generator workflow and download handling
- `api/album-cover.js` - Vercel serverless endpoint for production image generation
- `api/credits.js` - returns the current credit balance and payment configuration
- `api/deduct-credits.js` - server-side credit deduction endpoint for future flows
- `api/use-credit.js` - reserved endpoint for server-side credit consumption flows
- `api/verify-solana-payment.js` - verifies a SOL transaction on-chain and grants credits
- `server/album-generator-service.js` - shared OpenAI image generation logic
- `server/app-config.js` - single configuration source for credit pack pricing, image costs, RPC settings, and receiver wallet
- `server/api-utils.js` - shared request helpers for API routes
- `server/payment-service.js` - Solana transaction verification logic and public payment config
- `server/session-service.js` - anonymous signed user session helper for future auth upgrades
- `server/storage/database.js` - pluggable storage layer with local JSON persistence
- `server/album-generator-server.js` - secure local/backend proxy for OpenAI image generation
- `apparel.html`, `apparel.css`, `apparel.js` - LISTEN UP AMERICA! storefront and browser cart
- `apparel-success.html`, `apparel-cancel.html`, `apparel-status.js` - Stripe return pages and payment-status verification
- `server/apparel-catalog.js` - trusted apparel catalog, variants, Stripe Price IDs, and preview prices
- `api/apparel-*.js` - apparel catalog, checkout, payment-status, and webhook endpoints
- `Images/apparel/` - replaceable product image placeholders
- `Images/` - local artwork used by the page

## Local Preview

Open `index.html` directly in a browser, or run a local server.

Example with Python:

```bash
python -m http.server 4173
```

Then visit:

```text
http://127.0.0.1:4173/index.html
```

## AI Album Cover Generator Setup

The album cover generator page uses a separate backend endpoint so the OpenAI API key never appears in the browser.

The generator now includes a credit system with direct SOL wallet payments. Credits are enforced on the server before any OpenAI image generation call is made.

Run `npm install` once before starting the Node backend to install its dependencies.

1. Set the `OPENAI_API_KEY` environment variable.
2. Set the Solana environment variables.
2. Start the backend server.
3. Serve the static site.
4. Open `album-generator.html` in the browser.

PowerShell example:

```powershell
$env:OPENAI_API_KEY="your_openai_api_key"
$env:SOLANA_RPC_ENDPOINT="https://api.mainnet-beta.solana.com"
$env:SOLANA_RECEIVER_WALLET="your_solana_receiver_wallet"
$env:SOLANA_COMMITMENT="confirmed"
node .\server\album-generator-server.js
```

The backend listens on:

```text
http://127.0.0.1:8787/api/album-cover
```

For local development, the page automatically uses that local endpoint when opened from `file:`, `localhost`, or `127.0.0.1`.

In production, the `album-generator-api` meta tag in `album-generator.html` should be updated only if your static site is hosted separately from the backend.

### Credit Packs

- Starter: 0.05 SOL for 50 credits
- Professional: 0.10 SOL for 120 credits
- Studio: 0.25 SOL for 350 credits

These values live in `server/app-config.js`.

### Image Costs

- Standard image: 1 credit
- Future high-resolution image: 2 credits

These values also live in `server/app-config.js`.

Notes:

- The backend uses `gpt-image-2` with a square `2880x2880` output and returns PNG data for download.
- The backend requires Node.js 18 or newer because it uses the built-in `fetch` API.
- GitHub Pages is static-only, so the backend must run separately or be deployed to a separate server/serverless environment and the public endpoint URL must be updated in `album-generator.html`.
- The default storage adapter writes a JSON file locally. On Vercel, writes fall back to the instance temp directory, so you should replace `server/storage/database.js` with a persistent adapter for production durability.
- Install a Solana wallet such as Phantom, Solflare, or Backpack in the browser to buy credits locally.

## Vercel Deployment

This repository now includes a Vercel serverless function at `api/album-cover.js`.

### Option 1: Deploy the full site to Vercel

If you connect this GitHub repository directly to Vercel, Vercel will serve both the static files and the `/api/album-cover` function from the same deployment.

Setup:

1. Import the GitHub repository into Vercel.
2. Add the `OPENAI_API_KEY` environment variable in the Vercel project settings.
3. Add `SOLANA_RPC_ENDPOINT`, `SOLANA_RECEIVER_WALLET`, and optionally `SOLANA_COMMITMENT` in the Vercel project settings.
3. Deploy.

In this setup, no frontend endpoint change is needed because `album-generator.html` already defaults to `/api/album-cover`.

## Apparel marketplace and Stripe live mode

**Checkout charges real money, but no apparel will be shipped or fulfilled.** Product descriptions
are placeholders. There is no shipping address collection, shipping/tax
calculation, durable order database, inventory management, or fulfillment integration. The
storefront and Stripe Checkout disclose this before payment. A verified webhook logs the event
and session IDs; it does not create or fulfill an order. The cart stays in browser storage after
checkout, including after a successful payment. Monitor Stripe directly and handle any customer
inquiries and refunds manually.

### Local setup

Node.js 18 or newer is required. Install dependencies with `npm install`. Configure a Stripe
**live** secret or restricted key privately in your environment, then start the existing API server.
The example below uses placeholders; do not put real keys in the repository or share them in chat:

```powershell
$env:STRIPE_SECRET_KEY="sk_live_replace_me"
$env:APPAREL_SITE_URL="http://127.0.0.1:4173/"
$env:STRIPE_WEBHOOK_SECRET="whsec_replace_me"
node .\server\album-generator-server.js
```

Serve the repository as a static site on port 4173 (for example, `python -m http.server 4173`)
and visit `http://127.0.0.1:4173/apparel.html`. The browser uses the local API at port 8787.
Any completed checkout with a live key is a real charge, even locally. The publishable key is
not needed for this server-created Stripe Checkout flow.

### Deployment and live-readiness

Deploy the same repository to Vercel for the Node API and set `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, and `APPAREL_SITE_URL` in the Vercel environment. Use the exact
public site base URL, including any GitHub Pages path and a trailing slash, for
`APPAREL_SITE_URL`; the server never derives return URLs from a request header. Register
`https://your-vercel-project.vercel.app/api/apparel-webhook` as a Stripe **live-mode** webhook
endpoint for `checkout.session.completed` and `checkout.session.async_payment_succeeded`, and
use that endpoint's signing secret. Deploy after setting the variables.

When the static site is hosted on GitHub Pages separately from Vercel, set the
`apparel-api-base` meta tag in **both** `apparel.html` and `apparel-success.html` to the API
origin, for example `https://your-vercel-project.vercel.app` (without `/api`). When the
site and API share an origin, leave both values empty. A static-only deployment without the
API cannot load the catalog or take checkout payments.

Edit `server/apparel-catalog.js` to add products or update trusted price IDs, colors, sizes, and the
front/back/model image paths. Both editions use their configured live Stripe Price IDs. The
catalog endpoint retrieves their current amounts from Stripe; checkout uses the same Stripe Price
IDs and stores selected sizes and colors in Checkout Session metadata (`variants_1`, etc.).
The Stripe product name is displayed at checkout; size and color selections are recorded in
session metadata rather than shown as separate Stripe line-item descriptions. The price must be
active, live, one-time, fixed per-unit, in USD, and not tax-inclusive. If Stripe is unavailable
or the price is unsupported, the collection shows the catalog's unverified `previewPrice` if
available. Items can be added to the cart, but checkout is disabled until every cart price is
verified. Update this amount when the expected price changes;
Stripe's verified price always takes precedence. Loading the verified prices locally needs the live key or a
configured remote API. The catalog endpoint supplies the same trusted data to the
storefront; checkout independently validates IDs, selections, and quantities and ignores any
browser-submitted price.

The navigation and collection background uses `Images/apparel/apparel-background.jpg.png`.
Replace that file with your own artwork, or update the image URL in
the `.apparel-stage` rule in `apparel.css`. The dark overlay keeps the navigation and heading
legible; the cart keeps its separate dark background.

Before offering actual apparel for sale, replace placeholder content and pricing, implement durable
and idempotent order recording keyed by Stripe event/session ID, reliable fulfillment and webhook
retry handling, shipping/tax and customer support policies, and thoroughly verify the entire flow.
The code rejects test keys, test sessions, and test webhook events. A separate live webhook
signing secret is required; the API secret key and publishable key are not webhook secrets.

Run the focused automated checks with `npm test`.

## Album generator: GitHub Pages and Railway

### Option 2: Keep GitHub Pages for the site and use Vercel only for the API

If the website stays on GitHub Pages, deploy this same repository to Vercel for the API and then update the `album-generator-api` meta tag in `album-generator.html` to:

```text
https://your-vercel-project.vercel.app/api/album-cover
```

Setup:

1. Import the GitHub repository into Vercel.
2. Add the `OPENAI_API_KEY` environment variable in the Vercel project settings.
3. Add `SOLANA_RPC_ENDPOINT`, `SOLANA_RECEIVER_WALLET`, and optionally `SOLANA_COMMITMENT` in the Vercel project settings.
4. Deploy and copy the production Vercel URL.
5. Update the `album-generator-api` meta tag in `album-generator.html` to the Vercel URL above.
6. Push that change so GitHub Pages uses the Vercel backend.

### Railway

Railway is optional. It is still a valid place to run `server/album-generator-server.js`, but it is not required if you deploy the API through Vercel.

## Deploying

This repository includes a GitHub Actions workflow that deploys the site to GitHub Pages.

After pushing to `main`:

1. Open the repository on GitHub.
2. Go to `Settings > Pages`.
3. Confirm the source is `GitHub Actions`.
4. Wait for the `Deploy static site to Pages` workflow to complete.

## Notes

- Spotify and YouTube embeds are wired into the featured section.
- CTA buttons link to the live artist/platform destinations.
- The hero image is loaded from `Images/Beast Mode 2 Thumbnail.png`.