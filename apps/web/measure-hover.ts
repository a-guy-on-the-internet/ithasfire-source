import { chromium } from 'playwright';

const scratchpad = '/private/tmp/claude-501/-Users-somehuman-Projects-TicketHunter/cfcdac2d-e2be-4a8b-b05c-aee4bac7fc9b/scratchpad';

(async () => {
  // Try to use persistent user data dir to preserve session
  const browser = await chromium.launch({
    headless: false,
    // Launch with user data dir to keep cookies/session
  });

  // Create context without clearing storage to preserve session cookies if they exist
  const context = await browser.newContext({
    // Don't clear storage so any existing session persists
  });

  const page = await context.newPage();

  console.log('=== Starting hover measurement ===\n');

  // Step 1: Navigate with cache-bust
  const cacheParam = Math.random().toString(36).substring(7);
  const url = `http://localhost:3000/admin/demo/payments?cb=${cacheParam}`;
  console.log(`[1] Navigating to ${url}`);
  await page.goto(url);

  // Wait for Next dev server to recompile (~10s)
  console.log('[1] Waiting 10s for Next dev server to recompile...');
  await page.waitForTimeout(10000);

  // Check current page state
  const pageUrl = page.url();
  console.log(`    Current URL: ${pageUrl}`);
  const pageTitle = await page.title();
  console.log(`    Page title: ${pageTitle}`);

  // Check if we're on the sign-in page
  if (pageUrl.includes('/sign-in')) {
    console.log('[2] On sign-in page, attempting sign-in...');
    try {
      // Wait for the form to be visible
      await page.waitForSelector('[data-testid="auth-sign-in-form"]', { timeout: 5000 }).catch(() => {});

      // Click "Use password instead" button using JavaScript to bypass pointer event interception
      await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="auth-sign-in-password-toggle"]') as HTMLElement;
        if (btn) btn.click();
      }).catch(() => {
        console.log('    Note: Could not click password toggle via JavaScript');
      });

      await page.waitForTimeout(500);

      // Fill email input
      const emailInput = page.locator('input[data-testid="auth-sign-in-email"]');
      const emailVisible = await emailInput.isVisible().catch(() => false);
      if (emailVisible) {
        await emailInput.fill('admin@ithasfire.com');
      } else {
        console.log('    Note: Email input not visible');
      }

      await page.waitForTimeout(200);

      // Fill password input
      const passwordInput = page.locator('input[data-testid="auth-sign-in-password"]');
      const pwdVisible = await passwordInput.isVisible().catch(() => false);
      if (pwdVisible) {
        await passwordInput.fill('Dev-Login-2026!');
      } else {
        console.log('    Note: Password input not visible');
      }

      await page.waitForTimeout(200);

      // Submit form using JavaScript
      await page.evaluate(() => {
        const btn = document.querySelector('button[data-testid="auth-sign-in-submit"]') as HTMLElement;
        if (btn) btn.click();
      }).catch(() => {
        console.log('    Note: Could not click submit button via JavaScript');
      });

      // Wait for redirect to payments page or other navigation
      console.log('[2] Waiting for sign-in to complete...');
      await page.waitForNavigation({ timeout: 15000 }).catch(() => {
        console.log('    Note: Navigation did not occur after sign-in');
      });

      await page.waitForTimeout(3000);
    } catch (e) {
      console.log(`    Warning: Sign-in attempt had issues: ${e}`);
    }
  }

  await page.waitForTimeout(2000);

  // Step 2: Check if inert state is active
  console.log('[2] Checking inert state...');
  const inertCheckResult = await page.evaluate(() => {
    const elem = document.querySelector('[data-testid="payout-schedule-setup-required"]');
    return elem !== null;
  });

  const pageContent = await page.evaluate(() => {
    // Check what elements are actually on the page
    const bodyText = document.body.textContent?.substring(0, 200) || '';
    const dataTestIds = Array.from(document.querySelectorAll('[data-testid]')).map(el => el.getAttribute('data-testid')).slice(0, 15);
    const errorMsgs = Array.from(document.querySelectorAll('[role="alert"], [data-testid*="error"]')).map(el => el.textContent?.trim()).filter(t => t && t.length > 0);
    return { bodyText, dataTestIds, errorMsgs };
  });

  console.log(`    Inert state active (setup-required element found): ${inertCheckResult}`);
  console.log(`    Page data-testids found: ${pageContent.dataTestIds.join(', ')}`);
  if (pageContent.errorMsgs.length > 0) {
    console.log(`    Error messages on page: ${pageContent.errorMsgs.join(' | ')}`);
  }

  if (!inertCheckResult) {
    console.log('    ❌ STOP: DB state is wrong - inert element not found');
    console.log(`    Page content (first 200 chars): ${pageContent.bodyText}`);
    console.log('    Skipping sign-in flow and continuing anyway to try the measurement...');
  }

  // Step 3: Measure RESTING background (mouse parked far away)
  console.log('[3] Measuring RESTING background (mouse parked far away)...');

  // First check if the schedule option element exists
  const asapElementExists = await page.evaluate(() => {
    return document.querySelector('[data-testid="schedule-option-ASAP"]') !== null;
  });

  if (!asapElementExists) {
    console.log('    ⚠️  schedule-option-ASAP element not found on page');
    console.log('    This may indicate the page failed to load or user is not authenticated');
  }

  // Hover over page heading to move mouse away from the row
  const headings = await page.locator('h1, h2, h3').all();
  if (headings.length > 0) {
    await headings[0].hover().catch(() => {
      console.log('    Note: Could not hover over heading');
    });
  }

  await page.waitForTimeout(500);

  const restingBg = await page.evaluate(() => {
    const elem = document.querySelector('[data-testid="schedule-option-ASAP"]');
    if (!elem) return null;
    return getComputedStyle(elem).backgroundColor;
  });
  console.log(`    RESTING backgroundColor: ${restingBg}`);

  // Step 4: Hover over ASAP row and measure HOVERED background
  console.log('[4] Hovering over ASAP row and measuring HOVERED background...');
  const asapRow = page.locator('[data-testid="schedule-option-ASAP"]');
  await asapRow.hover();
  await page.waitForTimeout(500);

  const hoveredBg = await page.evaluate(() => {
    const elem = document.querySelector('[data-testid="schedule-option-ASAP"]');
    if (!elem) return null;
    return getComputedStyle(elem).backgroundColor;
  });
  console.log(`    HOVERED backgroundColor: ${hoveredBg}`);

  // Step 5: Compare RESTING and HOVERED
  console.log('[5] Comparing RESTING and HOVERED...');
  const isIdentical = restingBg === hoveredBg;
  console.log(`    RESTING === HOVERED: ${isIdentical}`);
  if (!isIdentical) {
    console.log(`    ⚠️  They differ - EXPECTED identical but got:`);
    console.log(`        RESTING: ${restingBg}`);
    console.log(`        HOVERED: ${hoveredBg}`);
  }

  // Step 6: Check cursor style while hovered
  console.log('[6] Checking cursor style while hovered...');
  const cursor = await page.evaluate(() => {
    const elem = document.querySelector('[data-testid="schedule-option-ASAP"]');
    if (!elem) return null;
    return getComputedStyle(elem).cursor;
  });
  console.log(`    Cursor while hovered: ${cursor}`);

  // Step 7: Take screenshot while hovering
  console.log('[7] Taking screenshot of hovered state...');
  const screenshotPath = `${scratchpad}/hover-inert.png`;
  await page.screenshot({ path: screenshotPath });
  console.log(`    Screenshot saved to: ${screenshotPath}`);

  // Step 8: Report console messages
  console.log('[8] Console messages:');
  const consoleMessages: any[] = [];
  page.on('console', (msg) => {
    consoleMessages.push({
      type: msg.type(),
      text: msg.text(),
      location: msg.location(),
    });
  });

  // Give console messages a moment to accumulate
  await page.waitForTimeout(1000);

  if (consoleMessages.length === 0) {
    console.log('    (No console messages)');
  } else {
    consoleMessages.forEach((msg, i) => {
      console.log(`    [${i + 1}] ${msg.type.toUpperCase()}: ${msg.text}`);
      if (msg.location) {
        console.log(`         at ${msg.location.url}:${msg.location.lineNumber}`);
      }
    });
  }

  console.log('\n=== Summary ===');
  console.log(`Inert state active: ${inertCheckResult}`);
  console.log(`RESTING backgroundColor: ${restingBg}`);
  console.log(`HOVERED backgroundColor: ${hoveredBg}`);
  console.log(`RESTING === HOVERED: ${isIdentical}`);
  console.log(`Cursor style (hovered): ${cursor}`);
  console.log(`Screenshot: ${screenshotPath}`);

  await browser.close();
})();
