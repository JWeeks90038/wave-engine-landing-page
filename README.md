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