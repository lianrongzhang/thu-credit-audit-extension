// @ts-nocheck
import { test, expect } from './fixtures';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();
// This test performs the end-to-end flow described by the user:
// 1) Login to fsis site
// 2) Navigate to transcript page
// 3) Open extension popup
// 4) Select filters and run query/compare
// 5) Export CSV and verify download

// Credentials come from environment variables to avoid hardcoding secrets.
const USERNAME = process.env.THU_USERNAME || '';
const PASSWORD = process.env.THU_PASSWORD || '';

// Safeguard: skip the test if no credentials are provided
const maybe = USERNAME && PASSWORD ? test : test.skip;

maybe('full login → transcript → popup → compare → export CSV', async ({ context, extensionId, downloadsDir }) => {
  const page = await context.newPage();

  // 1. Visit login page
  await page.goto('https://fsis.thu.edu.tw/mosi/ccsd3/index.php?job=stud&loginn=&r=https://fsis.thu.edu.tw/');

  // 2. Enter username
  await page.getByPlaceholder('THU-NID 帳號').fill(USERNAME);

  // 3. Enter password
  await page.getByPlaceholder('THU-NID 密碼').fill(PASSWORD);

  // 4. Click login button (text: 登入)
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'load' }),
    page.getByRole('button', { name: '登入' }).click(),
  ]);

  // 5. Wait for 10 seconds (allow SSO/redirects)
  await page.waitForTimeout(10_000);

  // 6. Go to transcript page
  await page.goto('https://fsiso.thu.edu.tw/wwwstud/STUD_V6/COURSE/rcrd_all_gpa.php');
  await page.waitForLoadState('domcontentloaded');

  // 7. Open extension popup window
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);

  // Wait for initial dynamic loads
  await popup.waitForSelector('#setyear');

  // 8. Select 113 at #setyear
  await popup.selectOption('#setyear', '113');

  // 9. Wait 2s
  await popup.waitForTimeout(2_000);

  // 10. Select 碩士班 at #stype (value G)
  await popup.selectOption('#stype', 'G');

  // 11. Wait 2s and allow dependent list to load
  await popup.waitForTimeout(2_000);

  // 12. Select 資工系 at #majr (try several common values for robustness)
  // The value depends on remote HTML; try to pick by text first, fallback to a likely code.
  const majr = popup.locator('#majr');
  await majr.waitFor({ state: 'visible' });
  const optionByText = majr.locator('option', { hasText: '資工' });
  if (await optionByText.count()) {
    const val = await optionByText.first().getAttribute('value');
    if (val) await popup.selectOption('#majr', val);
  } else {
    // Fallback: pick first non-empty option
    const first = majr.locator('option[value]:not([value=""])').first();
    const val = await first.getAttribute('value');
    if (val) await popup.selectOption('#majr', val);
  }

  // Ensure subMajr loads
  await popup.waitForTimeout(1_000);

  // If subMajr has options, select the first
  const subMajr = popup.locator('#subMajr');
  if (await subMajr.count()) {
    const hasOptions = await subMajr.locator('option').count();
    if (hasOptions) {
      const val = await subMajr.locator('option').first().getAttribute('value');
      if (val) await popup.selectOption('#subMajr', val);
    }
  }

  // 13. Click 查詢
  await popup.getByRole('button', { name: '查詢' }).click();

  // 14. Wait 2 seconds (for iframe content)
  await popup.waitForTimeout(2_000);

  // 15. Click 學分比對
  await popup.getByRole('button', { name: '學分比對' }).click();

  // 16. Wait 2 seconds
  await popup.waitForTimeout(2_000);

  // 17. Click 匯出 CSV (wait for download)
  const [ download ] = await Promise.all([
    popup.waitForEvent('download', { timeout: 30_000 }),
    popup.getByRole('button', { name: '匯出 CSV' }).click(),
  ]);

  // 18. Verify the CSV was downloaded by saving it with the intended file name
  // For blob:// downloads via chrome.downloads, Chromium reports a GUID suggested filename.
  // We build the intended name from the popup selections and save explicitly.
  const intended = await popup.evaluate(() => {
    const y = document.querySelector('#setyear')?.value || 'UNKNOWN';
    const st = document.querySelector('#stype')?.value || 'UNKNOWN';
    const mj = document.querySelector('#majr')?.value || 'UNKNOWN';
    return `THU_compare_report_${y}_${st}_${mj}.csv`;
  });

  if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });
  const finalPath = path.join(downloadsDir, intended);
  await download.saveAs(finalPath);
  expect(fs.existsSync(finalPath)).toBeTruthy();
});
