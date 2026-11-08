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

## Apparel Checkout and manual fulfillment

The Original Edition costs $24.99 and the Freedom Edition $29.99. The server verifies each
configured Stripe Price is active, one-time, USD, not tax-inclusive, in the selected mode and
exactly the expected amount. A mismatch disables checkout for that product. For an unavailable
price, the storefront shows an unverified preview and disables checkout. Checkout calculates
shipping from the combined pre-tax merchandise subtotal: $5.99 below $75.00, otherwise free.
The U.S. shipping address and phone number are collected by Stripe; Checkout collects the email.
Stripe stores variant IDs, sizes, colors and quantities in session metadata, not customer data.

**Sales tax is not currently calculated or collected by this integration.** Determine your tax
obligations and configure and test a suitable tax solution before live sales; Stripe Tax is not
enabled by this code and may involve additional costs. Inventory, label printing, shipping,
refunds and customer support remain manual. The cart stays saved after payment.

### Test locally before launch

Node.js 18 or newer and `npm install` are required. In Stripe's **test mode**, create separate
one-time USD Prices for $24.99 and $29.99. The live Price IDs in the catalog cannot be used with
test keys. In a private PowerShell terminal set the following values (replace placeholders; do
not commit or share keys):

```powershell
$env:APPAREL_STRIPE_MODE="test"
$env:STRIPE_SECRET_KEY="sk_test_replace_me"
$env:APPAREL_TEST_PRICE_ORIGINAL="price_replace_original"
$env:APPAREL_TEST_PRICE_FREEDOM="price_replace_freedom"
$env:APPAREL_SITE_URL="http://127.0.0.1:5500/"
$env:STRIPE_WEBHOOK_SECRET="whsec_replace_me"
node .\server\album-generator-server.js
```

Serve the site with Live Server on port 5500 and open `http://127.0.0.1:5500/apparel.html`.
Match `APPAREL_SITE_URL` to your actual Live Server origin. The local API is at port 8787.
For webhook testing, run the Stripe CLI in a separate terminal:

```powershell
stripe listen --forward-to http://127.0.0.1:8787/api/apparel-webhook
```

Set `STRIPE_WEBHOOK_SECRET` to the signing secret printed by that CLI, restart the API, and keep
the CLI listening. Use Stripe's documented test card `4242 4242 4242 4242`, a future expiry and
any valid test CVC, with test customer information. Verify the test-mode banner, address requirement,
both prices, variant labels, and totals: three Original shirts are $74.97 plus $5.99 shipping;
two Original plus one Freedom are $79.97 with free shipping. Verify the success page and CLI
webhook delivery, then inspect the paid order as described below. An uncompleted or failed payment
must not appear as paid. Test async payment methods only if enabled in your Stripe account.
No live keys, IDs, sessions, events or signing secrets should be used in a test deployment.

### Reviewing and fulfilling paid orders

Stripe is the source of order data; the webhook verifies signatures and retrieves sessions but
does not create records, ship orders or prevent manual duplicate shipments. Duplicate webhook
deliveries are harmless because the handler performs no fulfillment. Failed/unpaid sessions are
not treated as paid. Missing required shipping data or a Stripe retrieval failure returns an
error for Stripe to retry. Monitor failed webhook deliveries and reconcile in the Dashboard.

With the same mode and secret key set in a **private** terminal, run:

```powershell
node .\server\apparel-orders.js
```

The JSON report lists paid, complete apparel sessions, customer/contact and shipping details,
variants, Stripe line items, payment reference, date and amounts in cents. It paginates sessions
and line items. The `review` list identifies paid sessions that could not be decoded (including
older orders without shipping details); the command exits nonzero when review is needed. Inspect
those sessions manually in Stripe and never overlook them. The output contains personal data:
do not post it, commit it, or store it in a publicly served directory.

Keep a private, access-restricted spreadsheet outside the website with one row per **mode and
Checkout Session ID**. Record payment status, fulfillment status, shipment date and tracking
number; never mark an order shipped before confirming the carrier label. Reconcile all paid Stripe
sessions against the sheet regularly, check the session ID before printing a label, and investigate
failed webhook deliveries and `review` entries. Use a single person or coordinated process to
avoid two people shipping the same order. Check refunds and disputes directly in Stripe before
shipping; the report's paid status alone does not reflect subsequent refunds. Do not mix test and
live sheets. Stripe events and logs are not a fulfillment checklist.

### Deploying live

Live mode is the default, but **live checkout is disabled** until
`APPAREL_LIVE_CHECKOUT_ENABLED=true` is explicitly set on the server. First verify the existing
live Stripe Price IDs in `server/apparel-catalog.js` match the required prices and complete the
test and fulfillment checks above. Set `APPAREL_STRIPE_MODE=live`, a live `STRIPE_SECRET_KEY`,
`APPAREL_SITE_URL` (the exact public site base URL with trailing slash), and a live
`STRIPE_WEBHOOK_SECRET` privately in Vercel. Register the live `/api/apparel-webhook` endpoint for
`checkout.session.completed`, `checkout.session.async_payment_succeeded`, and
`checkout.session.async_payment_failed`. Check its deliveries. Only then enable live checkout.
Live charges are real. Never expose secret keys in browser code.

When the static site is hosted separately, configure the `apparel-api-base` meta tag in both
`apparel.html` and `apparel-success.html` to the API origin. A static-only deployment cannot
load the catalog or take payments. Run automated checks with `npm test`.

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