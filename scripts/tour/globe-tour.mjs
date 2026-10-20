/**
 * Drives the product and captures the screens.
 *
 *   node scripts/tour/desk-tour.mjs      # the desk, on :5234
 *   node scripts/tour/globe-tour.mjs     # the globe, on :4173
 *
 * Both need their server already up, and a Chrome at
 * /usr/bin/google-chrome. The globe one is FLKY IN HEADLESS - the renderer
 * runs out of memory under software WebGL once the storm layers load - so run
 * it in a real browser, or accept that it may die half way.
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const OUT = process.env.GEV_TOUR_OUT || '/tmp/hail-tour';
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-gl=swiftshader'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1050 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function ev(fn, tries = 12) {
  for (let i = 0; i < tries; i += 1) {
    try { return await page.evaluate(fn); } catch (e) {
      if (!/detached|Execution context|Session closed/i.test(e.message)) throw e;
      await wait(3000);
    }
  }
  return null;
}
const shot = async (n) => {
  try { await page.screenshot({ path: `${OUT}/${n}.png` }); console.log('  shot:', n); }
  catch (e) { console.log('  shot failed:', n); }
};

await page.goto('http://127.0.0.1:4173/', { waitUntil: 'domcontentloaded', timeout: 180000 });

// The modal takes its time. Wait for it, then kill it.
for (let i = 0; i < 20; i += 1) {
  const gone = await ev(() => {
    const btn = [...document.querySelectorAll('button')].find((x) =>
      /don't show this again/i.test(x.textContent),
    );
    if (!btn) return 'not yet';
    const box = [...document.querySelectorAll('input[type=checkbox]')].find((b) => {
      const p = b.closest('label') || b.parentElement;
      return p && /don't show/i.test(p.textContent);
    });
    if (box && !box.checked) box.click();
    btn.click();
    return 'dismissed';
  });
  if (gone === 'dismissed') { console.log('  modal dismissed'); break; }
  await wait(3000);
}
await wait(8000);

// The location search: type a place and the camera flies there.
const searched = await ev(() => {
  const input = [...document.querySelectorAll('input')].find((i) =>
    /search any location/i.test(i.placeholder || ''),
  );
  if (!input) return 'no search input';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'Colorado Springs');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  input.form?.requestSubmit?.();
  return 'typed';
});
console.log('  search:', searched);
await wait(14000);
await shot('30-globe-search');

// The suggestion that comes back.
const suggestion = await ev(() => {
  const els = [...document.querySelectorAll('*')].filter((e) =>
    e.children.length === 0 && /Colorado Springs/i.test(e.textContent),
  );
  if (!els.length) return null;
  els[0].click();
  return els[0].textContent.trim();
});
console.log('  suggestion:', JSON.stringify(suggestion));
await wait(22000);
await shot('31-globe-over-cos');

// Open the layer panel and turn the observed layer on.
await ev(() => {
  const plus = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '+');
  if (plus) plus.click();
  return true;
});
await wait(5000);
await ev(() => {
  const row = [...document.querySelectorAll('.data-toggle-row')].find((r) =>
    r.textContent.includes('Hail & Wind — Observed'),
  );
  if (!row) return false;
  const b = row.querySelector('.data-toggle-btn');
  if (!b.className.includes('active')) b.click();
  return true;
});
await wait(30000);
await shot('32-globe-swath-cos');

// The reports layer + RADAR chip, for the contoured swath.
await ev(() => {
  const row = [...document.querySelectorAll('.data-toggle-row')].find((r) =>
    r.textContent.includes('Hail & Wind — Individual Reports'),
  );
  if (!row) return false;
  const b = row.querySelector('.data-toggle-btn');
  if (!b.className.includes('active')) b.click();
  return true;
});
await wait(26000);
await ev(() => {
  const row = [...document.querySelectorAll('.data-toggle-row')].find((r) =>
    r.textContent.includes('Hail & Wind — Individual Reports'),
  );
  const chip = [...(row?.querySelectorAll('.data-toggle-chip') || [])].find((c) =>
    c.textContent.trim() === '2026-10-15',
  );
  if (chip) chip.click();
  return !!chip;
});
await wait(18000);
await ev(() => {
  const row = [...document.querySelectorAll('.data-toggle-row')].find((r) =>
    r.textContent.includes('Hail & Wind — Individual Reports'),
  );
  const chip = [...(row?.querySelectorAll('.data-toggle-chip') || [])].find((c) =>
    c.textContent.trim() === 'RADAR',
  );
  if (chip) chip.click();
  return !!chip;
});
await wait(26000);
await shot('33-globe-contoured-swath');

await browser.close();
