const { chromium } = require('playwright');

(async () => {
  const portsToTry = [3000, 5173, 8080, 3001];
  let url = null;

  // Try to find a responsive local server URL
  for (const port of portsToTry) {
    try {
      const resp = await fetch(`http://localhost:${port}/`);
      if (resp && resp.status < 500) { url = `http://localhost:${port}`; break; }
    } catch (e) {}
  }

  if (!url) {
    // fallback to 3000
    url = 'http://localhost:3000';
  }

  console.log('Using URL:', url);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', msg => {
    try { console.log('[PAGE LOG]', msg.type(), msg.text()); } catch (e) { console.log('[PAGE LOG] (failed to print)'); }
  });

  page.on('pageerror', err => {
    console.error('[PAGE ERROR]', err);
  });

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  } catch (e) {
    console.error('Navigation failed:', e.message || e);
  }

  // Try clicking the share screen button by its label text
  try {
    const btn = page.getByRole('button', { name: /share screen|sharing/i });
    await btn.click({ timeout: 5000 });
    console.log('Clicked SHARE SCREEN button');
  } catch (e) {
    console.error('Could not click share button:', e.message || e);
  }

  // Wait a bit to capture console logs and any errors from getDisplayMedia
  await page.waitForTimeout(8000);

  // Try to read the UI error banner (errorText) if present
  try {
    const errText = await page.locator('text=Core Error Protocol').first().innerText().catch(() => null);
    if (errText) console.log('Found error banner text snippet:', errText.substring(0, 200));
  } catch (e) {}

  await context.close();
  await browser.close();
  process.exit(0);
})();
