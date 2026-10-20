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

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));

async function ev(fn, tries = 8) {
  for (let i = 0; i < tries; i += 1) {
    try { return await page.evaluate(fn); } catch (e) {
      if (!/detached|Execution context/i.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  throw new Error('the page kept navigating away');
}
const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log('  shot:', name);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// =====================================================================
// THE DESK
// =====================================================================
console.log('DESK');
await page.goto('http://127.0.0.1:5234/', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.waitForSelector('#tableWrap table', { timeout: 120000 });
await wait(2500);
await shot('01-desk-city-table');

// Colorado Springs -> its storm days.
const opened = await ev(() => {
  const row = [...document.querySelectorAll('#tableWrap tbody tr')].find((r) =>
    r.textContent.includes('Colorado Springs'),
  );
  if (!row) return false;
  row.querySelector('td').click();
  return true;
});
console.log('  opened Colorado Springs:', opened);
await wait(3500);
await shot('02-desk-storm-days');

// The storm table's summary line - the thesis, in one paragraph.
const summary = await ev(() => {
  const panel = document.getElementById('detail');
  return [...(panel?.querySelectorAll('.detail-summary') || [])].map((p) =>
    p.textContent.replace(/\s+/g, ' ').trim(),
  );
});
console.log('  storm summary:', JSON.stringify(summary, null, 1));

// The tracts, then the knock list for the biggest storm.
const whichDay = await ev(() => {
  const rows = [...document.querySelectorAll('#detail tbody tr')];
  // The biggest day: most houses under the hail.
  let best = null;
  let bestHouses = -1;
  for (const row of rows) {
    const cells = [...row.children].map((c) => c.textContent.trim());
    const houses = Number(cells[6]?.replace(/,/g, '')) || 0;
    if (houses > bestHouses) { bestHouses = houses; best = row; }
  }
  if (!best) return null;
  const b = [...best.querySelectorAll('button')].find((x) => x.textContent === 'tracts');
  if (!b) return null;
  b.click();
  return best.children[0].textContent.trim();
});
console.log('  biggest storm day:', whichDay);
await wait(2500);
await shot('03-desk-tracts');

// The knock list for the SAME day.
await ev(() => {
  const rows = [...document.querySelectorAll('#detail tbody tr')];
  let best = null; let bestHouses = -1;
  for (const row of rows) {
    const cells = [...row.children].map((c) => c.textContent.trim());
    const houses = Number(cells[6]?.replace(/,/g, '')) || 0;
    if (houses > bestHouses) { bestHouses = houses; best = row; }
  }
  const b = [...best.querySelectorAll('button')].find((x) => x.textContent === 'streets');
  b.click();
  return true;
});
await wait(11000);
await shot('04-desk-knock-list');

// Scroll to the knock list and capture it properly.
await ev(() => {
  const p = document.getElementById('streets');
  p.scrollIntoView({ block: 'start' });
  return true;
});
await wait(900);
await shot('05-desk-knock-list-scrolled');

const knock = await ev(() => {
  const p = document.getElementById('streets');
  const notes = [...p.querySelectorAll('.detail-summary')].map((n) => n.textContent.replace(/\s+/g, ' ').trim());
  const heads = [...(p.querySelectorAll('thead tr')[1]?.children || [])].map((c) => c.textContent);
  const rows = [...p.querySelectorAll('tbody tr')].slice(0, 6)
    .map((r) => [...r.children].map((c) => c.textContent.trim()).join(' | '));
  return { notes, heads, rows };
});
console.log('  knock list notes:', JSON.stringify(knock.notes, null, 1));
console.log('  knock list heads:', JSON.stringify(knock.heads));
console.log('  knock list rows:');
for (const r of knock.rows) console.log('   ', r);

// The tract drill-down: streets inside one tract.
await ev(() => {
  const rows = [...document.querySelectorAll('#tracts tbody tr')];
  const b = [...rows[0].querySelectorAll('button')].find((x) => x.textContent === 'streets');
  b.click();
  return true;
});
await wait(11000);
await ev(() => {
  document.getElementById('streets').scrollIntoView({ block: 'start' });
  return true;
});
await wait(800);
await shot('06-desk-tract-streets');

const tractStreets = await ev(() => {
  const p = document.getElementById('streets');
  return {
    heading: p.querySelector('h2')?.textContent,
    notes: [...p.querySelectorAll('.detail-summary')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()),
    rows: [...p.querySelectorAll('tbody tr')].slice(0, 6)
      .map((r) => [...r.children].map((c) => c.textContent.trim()).join(' | ')),
  };
});
console.log('  tract streets:', JSON.stringify(tractStreets, null, 1));

// =====================================================================
// THE GLOBE
// =====================================================================
console.log('GLOBE');
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'domcontentloaded', timeout: 180000 });
await wait(15000);
await ev(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /don't show this again/i.test(x.textContent));
  if (b) b.click();
  return !!b;
});
await wait(9000);
await shot('07-globe-clean');

// The observed layer: the swath and the county list.
await ev(() => {
  const row = [...document.querySelectorAll('.data-toggle-row')].find((r) =>
    r.textContent.includes('Hail & Wind — Observed'),
  );
  row.querySelector('.data-toggle-btn').click();
  return true;
});
await wait(25000);
await shot('08-globe-observed-layer');

// The reports layer: the timeline.
await ev(() => {
  const row = [...document.querySelectorAll('.data-toggle-row')].find((r) =>
    r.textContent.includes('Hail & Wind — Individual Reports'),
  );
  row.querySelector('.data-toggle-btn').click();
  return true;
});
await wait(22000);
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
await wait(20000);
const chips = await ev(() => {
  const row = [...document.querySelectorAll('.data-toggle-row')].find((r) =>
    r.textContent.includes('Hail & Wind — Individual Reports'),
  );
  return [...(row?.querySelectorAll('.data-toggle-chip') || [])].map((c) => c.textContent.trim());
});
console.log('  globe chips:', JSON.stringify(chips));
await shot('09-globe-timeline');

console.log('\nconsole errors:', errors.length ? errors.slice(0, 5) : 'none');
console.log('screenshots in', OUT);
await browser.close();
