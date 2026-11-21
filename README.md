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
- `apparel.html`, `apparel.css`, `apparel.js` - FREEDOM UNFILTERED storefront and browser cart
- `apparel-success.html`, `apparel-cancel.html`, `apparel-status.js` - Stripe return pages and payment-status verification
- `server/apparel-catalog.js` - trusted apparel catalog, variants, Stripe Price IDs, and preview prices
- `api/apparel-*.js` - apparel catalog, checkout, payment-status, and webhook endpoints
- `Images/apparel/` - replaceable product image placeholders
- `Images/` - local artwork used by the page

## Digital music library setup

`music.html` displays published tracks from Firestore. `music-admin.html` uses the
same Firebase administrator account and `admin: true` claim as apparel inventory.
Administrators can upload MP3 (up to 100 MiB), WAV (up to 100 MiB), and PNG,
JPEG, or WebP artwork (up to 10 MiB). Uploads go directly from the browser to
Firebase Storage; the API serves published files with byte-range support, so
playback and downloads do not expose permanent Firebase Storage download URLs.
The API rechecks publication on every new request. An in-progress response or
a file already downloaded cannot be recalled after unpublishing.

1. Complete the Firebase inventory setup below using the existing project and
   administrator claim. Enable Cloud Storage for Firebase and set the
   **server-side** `FIREBASE_STORAGE_BUCKET` environment variable in Vercel
   and the local API to the exact bucket name shown in Firebase (without
   `gs://`). Give the existing service account permission to read that bucket.
   The Firebase web configuration and bucket name are public identifiers, not
   service-account credentials. Do not make the bucket or its objects public.
2. Deploy `firestore.rules` using the command in the inventory setup. The new
   `musicTracks` rules allow visitors to read only published metadata and allow
   only users with the administrator claim to modify it. Apparel inventory and
   all other documents remain denied to direct clients.
3. **Before deploying Storage rules**, inspect your currently deployed Storage
   rules and merge the match block in `music-storage.rules` into the existing
   `match /b/{bucket}/o` block. This repository does not contain the deployed
   Storage rules, so replacing them wholesale could break unrelated features.
   Ensure no overlapping rule grants public access to `musicTracks/**`; Storage
   rules are additive. Deploy the merged rules through Firebase Console or
   your normal Firebase CLI configuration.
4. Configure the bucket's CORS policy to allow the administrator page's HTTPS
   origin and the local development origin for `GET`, `POST`, `PUT`, and
   `DELETE`. For example, save the following as a private local JSON file,
   replace the origins as needed, and run
   `gcloud storage buckets update gs://YOUR_BUCKET --cors-file=YOUR_CORS_FILE`.
   Review and preserve any existing bucket CORS policy before replacing it.

   ```json
   [{
     "origin": ["https://waveenginemusic.com", "http://127.0.0.1:4173"],
     "method": ["GET", "POST", "PUT", "DELETE"],
     "responseHeader": ["Content-Type", "Authorization", "X-Goog-Resumable",
       "X-Goog-Upload-Protocol", "X-Goog-Upload-Command", "X-Goog-Upload-Offset",
       "X-Goog-Upload-Header-Content-Type", "X-Goog-Upload-Header-Content-Length"],
     "maxAgeSeconds": 3600
   }]
   ```

   Browser-side draft preview uses authenticated Storage downloads. Add the
   relevant hostnames to Firebase Authentication's authorized domains. Serve the
   admin page over HTTPS (or localhost), and sign in at `/music-admin`.
5. Upload files and save a draft first; preview it from the track list, then
   edit it and select Published. Do not publish until you have tested upload,
   preview, playback, download, unpublish and unauthorized access with a
   separate test project. Deleting a track removes its metadata first and then
   its files. Any failed file cleanup is reported with the affected paths.

The public library and admin page use the existing Vercel API origin; localhost
uses the Node API on port 8787. Firebase Storage download tokens must not be
shared: anyone holding a tokenized URL can bypass Storage rules. Public clients
receive only API links, not Storage paths or tokens. Restrict Firebase Console,
service-account IAM, and administrator accounts accordingly. Music delivery
uses Vercel function execution time and Storage bandwidth; verify capacity,
large-file playback and download behavior on the deployed plan before launch.

## Local Preview

Vercel serves pages without the `.html` extension and redirects old `.html`
URLs to their clean equivalents. To preview the same routing locally, use the
Vercel CLI in a linked project:

```bash
vercel dev --listen 127.0.0.1:4173
```

Then visit `http://127.0.0.1:4173/`. A basic static server or opening files
directly does not provide these clean URL routes.

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

Both current editions have a $29.99 configured price. The server verifies each
configured Stripe Price is active, one-time, USD, not tax-inclusive, in the selected mode and
exactly the expected amount. A mismatch disables checkout for that product. For an unavailable
price, the storefront shows an unverified preview and disables checkout. Checkout calculates
shipping from the combined pre-tax merchandise subtotal: $5.99 below $75.00, otherwise free.
The U.S. shipping address and phone number are collected by Stripe; Checkout collects the email.
Stripe stores variant IDs, sizes, colors and quantities in session metadata, not customer data.

**Sales tax is not currently calculated or collected by this integration.** Determine your tax
obligations and configure and test a suitable tax solution before live sales; Stripe Tax is not
enabled by this code and may involve additional costs. Label printing, shipping, ordinary
returns and customer support remain manual. The cart stays saved after payment.

### Firebase inventory setup

Inventory is required for apparel checkout. The existing Vercel/Node API uses the Firebase
Admin SDK and a Firestore transaction; no Firebase Cloud Function is required. Do not enable
live checkout until this configuration, the webhook, refund permissions and reconciliation
have been tested end to end. Deploy the API with your existing Vercel Git integration or
`vercel --prod` from the project directory; there is no Cloud Function deployment command.

1. Create a Firebase project, enable Firestore and Firebase Authentication with email/password,
   and register a web app. Use a separate Firebase project for test and live deployments.
2. Set these **server-side** environment variables in Vercel and the local API:
   - `FIREBASE_PROJECT_ID`: Firebase project ID.
   - `FIREBASE_WEB_API_KEY` and `FIREBASE_AUTH_DOMAIN`: the web app's public Firebase config;
     these are exposed by the API to initialize Firebase Auth, not Admin credentials.
   - `FIREBASE_SERVICE_ACCOUNT_JSON`: the complete service-account JSON as a single secret
     environment variable. Alternatively, omit it when Application Default Credentials are
     available (for local development, set `GOOGLE_APPLICATION_CREDENTIALS` to the private
     service-account file). The service account needs Firestore access and Firebase Auth
     permissions. Never commit the file or place it in the public site directory.
3. Install dependencies with `npm install`. Deploy the rules from a trusted terminal after
   authenticating the Firebase CLI:

   ```powershell
   firebase deploy --only firestore:rules --project YOUR_FIREBASE_PROJECT_ID
   ```

   [firestore.rules](firestore.rules) denies direct client access to apparel data; the music
   collection has its own published-read and administrator-write rules described above. The public
   apparel catalog API returns only availability; the admin API verifies Firebase ID tokens and the
   `admin: true` custom claim before any inventory access. Restrict service-account IAM and
   access to the project and secrets; Admin SDK access bypasses Firestore rules.
4. Create an email/password user in Firebase Authentication. In a private terminal with the
   same project ID and credentials, grant the claim using the user's Firebase UID:

   ```powershell
   $env:FIREBASE_PROJECT_ID="YOUR_FIREBASE_PROJECT_ID"
   $env:GOOGLE_APPLICATION_CREDENTIALS="C:\private\firebase-service-account.json"
   node .\server\apparel-grant-admin.js YOUR_USER_UID
   ```

   The user must sign out and back in to receive the new claim. To revoke access, remove
   the claim and revoke the user's refresh tokens using Firebase Admin; disabling a user
   also blocks revoked-token verification.
5. Open `/apparel-admin`, sign in, and enter non-negative quantities for all five sizes
   of each product. Save each row. A missing product or size is unavailable until initialized;
   inactive products are also unavailable. Use Refresh after a conflicting update and re-enter
   your changes. Restock returns or cancellations manually only after physical inspection.
   The storefront, success, and admin pages use the configured Vercel API origin; their
   `data-local-api-base` attributes keep local previews pointed at the local API. Update these
   values if the API moves. Add the admin page's domain to Firebase Authentication authorized
   domains and serve it over HTTPS.

Firestore documents are `products/{mode}_{productId}` with `name`, `price` (cents), `image`
and `active`; `products/{mode}_{productId}/inventory/{size}` with `size`, `quantity`,
`updatedAt` and `updatedBy`; and `orders/{stripeSessionId}` with customer/shipping details,
items (product ID/name, size, quantity, unit price in cents), payment and fulfillment status,
creation time, and inventory deductions including before/after counts. Mode prefixes prevent
test stock from affecting live stock even if the same project is accidentally configured.
Product identifiers and Stripe prices remain server-controlled in the apparel catalog.
Firestore orders contain personal data and require restricted IAM and appropriate retention.

Stock is checked before redirecting to Stripe, but that check does not reserve stock. After a
verified successful Stripe payment, the webhook atomically creates the order and deducts stock.
If another paid order has already taken the last item, the order is marked unfulfillable and
the webhook initiates a full Stripe refund with a stable idempotency key. A customer may
therefore briefly be charged before the refund. Failed payments and abandoned carts do not
deduct inventory. Refunds, cancellations and returns do not automatically restock.
Monitor failed webhook deliveries and `refund_pending` orders, including pending/failed Stripe
refunds; retry failed webhook deliveries and reconcile them with Stripe before fulfillment.
The Stripe key must have permission to create refunds. A delayed or failed webhook leaves the
success page in a processing state. Existing sessions created before inventory integration
retain their previous manual fulfillment flow and are not deducted retroactively.
If inventory cannot be loaded, the catalog still displays its real product images and an
availability warning, but all purchasing controls remain disabled until inventory returns.

### Test locally before launch

Node.js 18 or newer and `npm install` are required. In Stripe's **test mode**, create separate
one-time USD Prices for $29.99. The live Price IDs in the catalog cannot be used with
test keys. In a private PowerShell terminal set the following values (replace placeholders; do
not commit or share keys):

```powershell
$env:APPAREL_STRIPE_MODE="test"
$env:STRIPE_SECRET_KEY="sk_test_replace_me"
$env:APPAREL_TEST_PRICE_FREEDOM_1="price_replace_jones"
$env:APPAREL_TEST_PRICE_FREEDOM_2="price_replace_henry"
$env:APPAREL_SITE_URL="http://127.0.0.1:5500/"
$env:STRIPE_WEBHOOK_SECRET="whsec_replace_me"
node .\server\album-generator-server.js
```

Serve the site with `vercel dev --listen 127.0.0.1:5500` and open
`http://127.0.0.1:5500/apparel`. Match `APPAREL_SITE_URL` to your actual preview
origin. The local API is at port 8787.
For webhook testing, run the Stripe CLI in a separate terminal:

```powershell
stripe listen --forward-to http://127.0.0.1:8787/api/apparel-webhook
```

Set `STRIPE_WEBHOOK_SECRET` to the signing secret printed by that CLI, restart the API, and keep
the CLI listening. Use Stripe's documented test card `4242 4242 4242 4242`, a future expiry and
any valid test CVC, with test customer information. Verify the test-mode banner, address requirement,
both prices, variant labels, and totals: two shirts are $59.98 plus $5.99 shipping;
three shirts are $89.97 with free shipping. Verify the success page and CLI
webhook delivery, then inspect the paid order as described below. An uncompleted or failed payment
must not appear as paid. Test async payment methods only if enabled in your Stripe account.
No live keys, IDs, sessions, events or signing secrets should be used in a test deployment.

### Reviewing and fulfilling paid orders

Stripe is the source of payment data. The webhook verifies signatures and retrieves sessions,
then records new inventory-enabled orders and deductions transactionally. It does not ship
orders or prevent manual duplicate shipments. Failed/unpaid sessions are not treated as paid.
Missing required shipping data, refund problems or a Stripe/Firestore failure returns an error
for Stripe to retry. Monitor failed webhook deliveries and reconcile in the Dashboard.

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
live sheets. Inventory-enabled orders with a refunded charge are placed in `review`, not the
fulfillment list; check Stripe again immediately before shipping. Stripe events and logs are not
a fulfillment checklist.

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

When the static site is hosted separately, the `apparel-api-base` meta tags in `apparel.html`,
`apparel-success.html`, and `apparel-admin.html` must point to the deployed API origin.
A static-only deployment cannot load the catalog or take payments. Run automated checks with
`npm test`.

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