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

## Sitemap maintenance

List public, indexable static canonical pages in `sitemap.xml`. Add new pages
when they are published, and omit administrative, checkout, and `noindex`
pages. Use `lastmod` only when the date of the page's last significant change
is known; otherwise omit it. The public policies page is indexable, including
the operator identification in its Terms. `robots.txt` advertises the static
sitemap and the dynamic sitemap index at `/sitemap-artists.xml`. The index includes
`sitemap.xml` and paginated sitemaps for approved artist profiles whose slugs
are also approved. It uses the same `MUSIC_SITE_URL` origin as artist profile
canonical URLs, and removes profiles from the sitemap when approval is revoked.
Search and AI search crawlers remain permitted by the wildcard robots rule;
robots.txt is not an access-control mechanism. Submit the sitemap in search
engine webmaster tools and monitor indexing; inclusion is not guaranteed.

On small screens, primary navigation opens as an overlay. It can be dismissed
with the menu button, the backdrop, or Escape; without JavaScript, the links
remain available.

## Digital music library setup

`music.html` displays published tracks from Firestore. `music-admin.html` uses the
same Firebase administrator account and `admin: true` claim as apparel inventory.
Administrators can upload MP3 (up to 100 MiB), WAV (up to 100 MiB), and PNG,
JPEG, or WebP artwork (up to 10 MiB). Uploads go directly from the browser to
Firebase Storage; the API serves published files with byte-range support, so
playback and downloads do not expose permanent Firebase Storage download URLs.
The API rechecks publication on every public streaming request. An in-progress
response or a file already downloaded cannot be recalled after unpublishing.
After a song finishes, playback advances to the next playable song in library
order and stops after the last song. It uses MP3 when available unless the
listener has already selected another format for that song.
The player provides play and pause, seeking, volume, mute, and playback-speed
controls.

Song counters start at zero when this feature is deployed; earlier plays are
not included. A play is counted after 30 seconds of listening, or after a
shorter song finishes. Album tracks have separate counters. The browser sends
the song ID to the API without a listener identifier, and the server stores
aggregate counts in the private `songStreamCounts` Firestore collection.
Counts are approximate: interruptions or failed requests may be missed, and
anonymous requests can be manipulated. The endpoint is not fraud-resistant.
Each count incurs Firestore reads and a write, and public listings read count
documents for published releases. Monitor Firebase costs and traffic; heavy
traffic or abuse can increase costs, and popular releases can experience
write contention. The existing Firestore catch-all rule denies direct client
access to this collection; no new client access rule is needed.

Page and product previews use smaller images from `Images/optimized`; the
product image dialog still loads the original full-size image. Artist-uploaded
artwork and audio are served from Storage in their uploaded formats, so their
size, network conditions, and function latency still affect load times. MP3
uploads generally stream faster than larger WAV files.

### Paid music downloads

Listening is free. A $1.49 USD Stripe Checkout purchase covers one track in
its currently available MP3 and WAV formats. Streaming serves the audio to
the listener and is not DRM-protected, so a technical user can save the
stream without purchasing it.

1. In Stripe, create one active one-time $1.49 USD Price for a generic music
   download. A separate Price is needed for test mode and live mode.
2. Set `MUSIC_STRIPE_MODE` to `test` or `live`, `MUSIC_STRIPE_PRICE_ID` to the
   matching Price ID, `MUSIC_SITE_URL` to the website's HTTPS root (or a
   localhost URL for testing), and `STRIPE_SECRET_KEY` to a matching Stripe
   secret or restricted key. The key must be able to retrieve Prices,
   Checkout Sessions and PaymentIntents and create Checkout Sessions.
   The same secret key is used by apparel checkout; test mode must use a
   separate local or preview environment so live apparel payments are unaffected.
3. Keep `MUSIC_LIVE_CHECKOUT_ENABLED` unset until test-mode checkout,
   payment verification, both available file downloads, declined payments,
   refunds and support recovery have been tested. Set it to `true` only when
   ready to accept live payments. Without a configured Price, checkout reports
   that it is unavailable; the paid download action fails closed.
4. In Stripe Dashboard, enable **Customer emails > Successful payments** to
   send receipts. Stripe receipts do not deliver files. After successful card
   payment the customer is returned to a download page, which verifies the
   payment with Stripe before offering available formats.

The download-page URL is a bearer link: anyone holding it can access the
purchase until it expires, so buyers must keep it private. The purchase page
and file requests expire 10 minutes after Stripe creates the successful charge.
This applies to existing purchases too. Downloads started before expiry can
finish, but new or resumed requests after expiry are denied. There is no
account or automated email delivery or link recovery; help customers manually
with alternate delivery if necessary. Buyers should save their files
immediately. Downloaded files do not expire. Review the digital music license
and refund policy with counsel before enabling sales.

### Artist foundation (development)

The initial artist workflow adds email-verified account registration, one artist
profile per Firebase user, unique artist slugs, private profile/release uploads,
single and album drafts, and an administrator approval screen. Approved profiles are
available at `/artist/{slug}` and appear on the music page. Artists with approved
profiles can open their storefront from Artist Studio, confirm their rights and
submit a saved track for review. A storefront remains unavailable while its
profile awaits review. Only
tracks approved by an administrator can be streamed publicly; draft and
submitted tracks remain private. Artist sales are disabled until configured. Existing
`musicTracks` records and Stripe checkout are unchanged.
While waiting for email verification, Artist Studio checks periodically while
visible and when the tab becomes visible. Once verification is confirmed, it
refreshes the sign-in token and opens the artist workflow automatically; the
manual check remains available in the meantime.
On the music page, selecting or hovering over an artist's circle displays their
approved tracks and a profile link; selecting another artist stops the previous
artist's playback. Close the preview with its button or Escape; closing it also
stops playback. On artist profiles, a supplied website appears as a "Visit Artist
Website" button. Song prices appear in Stripe Checkout; album prices appear beside
the album download button.
On an artist storefront, the Artist Studio navigation link appears only when
the signed-in, email-verified owner is viewing their own profile.
Artist Studio also previews custom accent and background colors, a featured
message, up to five background images, and up to six gallery photos. Images
must be PNG, JPEG, or WebP and at most 10 MiB each. Selecting new files replaces
the entire set; each set can also be removed. Approved profiles publish changes
immediately, while pending profiles and their images remain private. Background
slideshows can be paused and do not start automatically with reduced motion.
Administrators can preview pending profile images and featured messages during
the initial profile review.
Before enabling these uploads, merge and deploy the updated artist image rules
in `music-storage.rules`; existing deployed Storage rules must be preserved.
Artists can search and select one optional genre for each draft; existing custom
genre and mood data is retained when an older draft is edited.
An album contains 1–20 MP3 or WAV songs (up to 100 MiB each) and one shared
cover, which is required before submission. Add songs in the desired order and
edit their titles in Artist Studio. Albums are reviewed, published and withdrawn
as one release; reviewers can listen to each song separately. Artists can see
the selected and saved cover in Artist Studio, and administrators can see it
while reviewing submitted releases. Unpublished artwork remains private.

#### Artist downloads and Stripe Connect

Artists may set an optional USD download price from $0.50 to $100.00 on a
single. An album can be streaming-only, sold for one album price, sold as
individually priced songs, or offered both ways; each listed price must be $0.50–$100.00. Artists
confirm the rights to sell downloads when submitting a priced release for review.
The artist must complete Stripe Standard account onboarding; checkout verifies
that charges and payouts are enabled and Stripe's fee payer is the connected
account. Stripe processes direct card charges on that account. The application
fee is 10% of the listed price, rounded to the nearest cent; Stripe deducts
processing fees from the artist. Payout timing and requirements are managed by
Stripe. An album purchase provides a separate download link for every song;
individual purchases provide only the purchased song. Downloads use the uploaded
MP3 or WAV files. Price changes require withdrawing the release and submitting
it for review again.

Artist checkout uses `MUSIC_STRIPE_MODE`, `ARTIST_STRIPE_SECRET_KEY`, and
`MUSIC_SITE_URL` described above. Register and configure Connect with Stripe,
ensure the key can create and retrieve connected accounts, account links,
Checkout Sessions and PaymentIntents on connected accounts, and enable the
requested mode in a separate environment. `ARTIST_SALES_ENABLED=true` enables
download checkout; onboarding is available when either artist sales or
contributions are enabled. Leave these flags unset until the relevant flows have
been tested and reviewed. Production requires `MUSIC_STRIPE_MODE=live` and the matching live
artist key. Store the artist key only as a server-side secret, never in the
repository or browser. The existing `STRIPE_SECRET_KEY` for apparel and Wave
Engine downloads is unchanged. Never use live credentials in a staging
environment.

Before enabling live sales, use a separate Stripe test-mode and Firebase staging
environment to test onboarding, incomplete verification, successful and declined
payments, actual fees and payouts, downloads, expiration, refunds, disputes,
unpublishing and support recovery. Confirm Stripe account eligibility, sales
tax, seller terms, licensing, refund responsibilities and dispute procedures
with appropriate advisers. Stripe Standard's account settings must charge
processing fees to the connected artist; checkout fails closed otherwise.
Support must handle refunds in the artist's connected Stripe account and
application-fee refunds separately where appropriate. There is no automated
receipt-based file delivery or refund workflow.

Purchases use a private, server-side Firestore record and a bearer return link;
payment is verified with the artist's connected Stripe account. Links expire
10 minutes after the charge. If the release is unpublished or its approved audio
is removed or replaced, downloads stop and support must resolve the purchase.
An already-open checkout can still complete after a track is withdrawn, so
support may need to refund or manually resolve it. The audio stream is not DRM.
Anonymous checkout creates Stripe sessions and Firestore records; implement
appropriate abuse monitoring and retention policies before launch.

#### Artist contributions

The artist storefront offers a one-time contribution in USD. Supporters choose
any amount from $0.50 to $999,999.99 (Stripe's USD limits) on the artist page
and pay by card through Stripe Checkout. The artist must have an approved
profile and a ready connected Stripe account. The direct charge uses the artist's
account: Wave Engine receives a 5% application fee, rounded to the nearest cent,
and Stripe deducts processing fees from the artist. For small contributions,
processing fees can leave the artist with little or no net proceeds.

Set `ARTIST_CONTRIBUTIONS_ENABLED=true` to enable new contribution checkouts
and artist Stripe onboarding independently of download sales. It is disabled
by default. The return page verifies payment with Stripe; it can still verify
an existing checkout after the flag is turned off. Stripe keeps the payment
records; no separate contribution record is created in Firestore. Test in
separate Stripe test-mode and Firebase staging environments before enabling
live contributions, including onboarding, payment, cancellation, fees, payout,
refunds and disputes. Confirm Stripe account eligibility, applicable terms and
refund responsibilities with appropriate advisers. Support must handle
refunds and disputes in the artist's connected account and application-fee
refunds separately where appropriate. An already-open checkout can still complete
after a profile is deactivated or contributions are disabled; resolve any
resulting issues through support. Monitor anonymous checkout creation for abuse.

The artist APIs use the existing Firebase Admin credentials and Firestore
project. The browser uploads directly to Firebase Storage; the
`artistUploads/{uid}/...` rule restricts verified users with a pending or
approved artist profile to new, size-limited files under their own UID using a
server-assigned `artistUpload` custom claim. This avoids granting the Storage
service agent broad read access to Firestore. Removing a claim does not revoke
already-issued ID tokens immediately; they can remain valid for up to about an
hour, but files remain private and confined to the former artist's UID.
Public profile images are streamed by `/api/artist-media` only after profile approval. Merge the additional
`artistUploads` match block in `music-storage.rules` into your currently
deployed Storage rules; do not replace the deployed rules wholesale. Test the
merged rules against a separate Firebase staging project before deployment.

Administrators can listen to submitted audio on `/artist-admin`, approve it for
streaming, or return it to draft. Both the artist and an administrator can
remove a published track from streaming. A submitted track is locked against
editing until it is withdrawn or returned to draft. Review and streaming use
the exact Storage object generation captured on submission, so replacing an
object does not silently substitute different audio. Deleting that generation
will make the track unavailable. Unpublishing blocks new requests, but cannot
recall an in-progress stream or audio already saved by a listener.

Streaming serves the audio to listeners and does not provide DRM. A rights
confirmation is not legal review or proof of ownership. Establish a takedown
process, review the applicable licenses and policies with counsel, and test
Firebase/Vercel costs and large-file delivery before promoting public uploads.

The artist dashboard requires Firebase email/password authentication and a
verified email. Enable the email/password provider and add the staging host to
Firebase Authentication's authorized domains. The existing administrator
account and `admin: true` custom claim can review applications at
`/artist-admin`. Configure the staging deployment with the Firebase Admin
credentials and `FIREBASE_STORAGE_BUCKET` used by the music API. The Vercel
rewrite serves `/artist/{slug}` through the profile API, which adds approved
profile metadata and the artist's public avatar to the initial HTML for social
sharing. Profiles without an avatar use the Wave Engine social image. Set
`MUSIC_SITE_URL` to the staging site's HTTPS origin when testing; otherwise
share metadata defaults to `https://waveenginemusic.com`. Share the clean
`/artist/{slug}` URL on a host using this Vercel configuration. Social
platforms control the preview shape and may cache previews after an image change.

No new package dependencies were added. Costs are limited to existing Vercel
function usage, Firebase Auth, Firestore, and Storage upload/egress usage; no
provider billing settings were inspected, so estimate costs from actual staging
traffic before enabling public uploads at scale.

### Firebase music setup

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