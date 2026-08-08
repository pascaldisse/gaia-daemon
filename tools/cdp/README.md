# GAIA CDP Harness

Playwright-based CDP harness that validates the GAIA UI is running and responsive.

## Prerequisites

- Node.js ≥ 18
- The GAIA UI daemon must be running on `http://127.0.0.1:8787/`

## Install

```bash
cd /Users/pascaldisse/projects/gaia-cdp
npm install
```

This installs Playwright (including a bundled Chromium) and the `playwright` npm package.

If you want to use your system Chrome instead, install it with Playwright's system dependencies:

```bash
npx playwright install-deps chrome
```

## Run

```bash
npm start
```

Or directly:

```bash
node index.mjs
```

## What it does

1. Launches Chromium — tries the `chrome` channel first (your installed Chrome),
   falls back to Playwright's bundled Chromium.
2. Navigates to `http://127.0.0.1:8787/`.
3. Waits for the `#app` element to be populated with text.
4. Asserts that `document.title` contains the string `GAIA`.
5. Saves a viewport screenshot to `./out/gaia.png`.
6. Closes the browser.

## Exit codes

- `0` — all checks passed.
- `1` — an assertion failed or a fatal error occurred (e.g., Chrome unavailable, page
  didn't load, title mismatch).
