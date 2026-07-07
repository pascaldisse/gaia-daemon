import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT_DIR = './out';
const URL = 'http://127.0.0.1:8787/';

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome' });
    console.log('[OK] Launched Chrome (channel)');
  } catch (err) {
    console.warn(`[WARN] Chrome channel not available: ${err.message}`);
    console.log('[INFO] Falling back to Playwright bundled Chromium...');
    browser = await chromium.launch();
    console.log('[OK] Launched bundled Chromium');
  }

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log(`[INFO] Navigating to ${URL}...`);
    await page.goto(URL, { waitUntil: 'domcontentloaded' });

    // Wait for #app to exist and contain text
    await page.waitForSelector('#app', { timeout: 10000 });
    await page.waitForFunction(() => {
      const el = document.querySelector('#app');
      return el !== null && el.textContent.trim().length > 0;
    }, { timeout: 15000 });
    console.log('[OK] #app element is populated');

    // Assert title contains GAIA
    const title = await page.title();
    console.log(`[INFO] Page title: "${title}"`);
    if (!title.includes('GAIA')) {
      throw new Error(`Title assertion FAILED: "${title}" does not contain "GAIA"`);
    }
    console.log('[OK] Title assertion passed');

    // Screenshot
    const screenshotPath = `${OUT_DIR}/gaia.png`;
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log(`[OK] Screenshot saved to ${screenshotPath}`);

    console.log('[DONE] All checks passed.');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`[FATAL] ${err.message}`);
  process.exit(1);
});
