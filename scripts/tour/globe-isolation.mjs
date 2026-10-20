import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const OUT = process.env.GEV_TOUR_OUT || '/tmp/hail-tour';
const PROFILE = '/tmp/hail-tour-profile';
fs.mkdirSync(OUT, { recursive: true });

// A PERSISTENT profile, so the first-launch modal does not come back on the
// next run and the drive is not fighting it every time.
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  userDataDir: PROFILE,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',
    '--use-gl=swiftshader',
    '--js-flags=--max-old-space-size=4096',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1050 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));

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
  catch (e) { console.log('  shot FAILED:', n, e.message.slice(0, 50)); }
};

await page.goto('http://127.0.0.1:4173/', { waitUntil: 'domcontentloaded', timeout: 180000 });

// 1. Kill the first-launch modal, for good.
for (let i = 0; i < 24; i += 1) {
  const r = await ev(() => {
    const btn = [...document.querySelectorAll('button')].find((x) =>
      /don't show this again/i.test(x.textContent),
    );
    if (!btn) return 'absent';
    const box = [...document.querySelectorAll('input[type=checkbox]')].find((b) => {
      const p = b.closest('label') || b.parentElement;
      return p && /don't show/i.test(p.textContent);
    });
    if (box && !box.checked) box.click();
    btn.click();
    return 'dismissed';
  });
  if (r === 'dismissed') { console.log('  modal: dismissed'); break; }
  if (r === 'absent') { console.log('  modal: absent'); break; }
  await wait(2500);
}
await wait(9000);
await shot('40-modal-cleared');

// 2. Open the layer panel.
const opened = await ev(() => {
  const plus = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '+');
  if (plus) { plus.click(); return 'clicked +'; }
  return 'no +';
});
console.log('  panel:', opened);
await wait(5000);

// 3. Turn ISOLATION MODE on.
const iso = await ev(() => {
  const row = [...document.querySelectorAll('.data-toggle-row')].find((r) =>
    r.textContent.includes('Isolation Mode'),
  );
  if (!row) return 'no row';
  const b = row.querySelector('.data-toggle-btn');
  b.click();
  return 'clicked';
});
console.log('  isolation layer:', iso);
await wait(14000);
await shot('41-isolation-on');

// 4. Type Colorado into the isolation field and commit it.
const typed = await ev(() => {
  const row = [...document.querySelectorAll('.data-toggle-row')].find((r) =>
    r.textContent.includes('Isolation Mode'),
  );
  const input = row?.querySelector('.data-toggle-field-input');
  if (!input) return 'no field';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'Colorado');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  input.blur();
  return 'typed Colorado';
});
console.log('  field:', typed);
await wait(30000);
await shot('42-colorado-isolated');

// 5. What did it say?
const said = await ev(() => {
  const row = [...document.querySelectorAll('.data-toggle-row')].find((r) =>
    r.textContent.includes('Isolation Mode'),
  );
  const input = row?.querySelector('.data-toggle-field-input');
  const msg = row?.querySelector('.data-toggle-field-message')?.textContent
    || row?.querySelector('.field-message')?.textContent;
  return {
    value: input?.value,
    message: msg?.replace(/\s+/g, ' ').trim(),
    row: row?.textContent.replace(/\s+/g, ' ').trim().slice(0, 260),
  };
});
console.log('  isolation says:', JSON.stringify(said, null, 1));

// 6. Now put the storm data inside it.
await ev(() => {
  const row = [...document.querySelectorAll('.data-toggle-row')].find((r) =>
    r.textContent.includes('Hail & Wind — Observed'),
  );
  if (!row) return false;
  const b = row.querySelector('.data-toggle-btn');
  if (!b.className.includes('active')) b.click();
  return true;
});
await wait(34000);
await shot('43-colorado-isolated-storms');

const after = await ev(() => {
  const rows = [...document.querySelectorAll('.data-toggle-row')];
  const obs = rows.find((r) => r.textContent.includes('Hail & Wind — Observed'));
  const isoRow = rows.find((r) => r.textContent.includes('Isolation Mode'));
  return {
    observed: obs?.textContent.replace(/\s+/g, ' ').trim().slice(0, 320),
    isolation: isoRow?.textContent.replace(/\s+/g, ' ').trim().slice(0, 200),
  };
});
console.log('  after:', JSON.stringify(after, null, 1));

console.log('\nconsole errors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
