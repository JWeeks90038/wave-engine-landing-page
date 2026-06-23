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