import puppeteer from 'puppeteer-core';

/**
 * Drives the globe in the USER'S OWN BROWSER WINDOW, isolated to Colorado.
 *
 * The browser is the Pinokio desktop app's Electron/Antigravity Chrome, which
 * publishes a DevTools endpoint. `Target.createTarget` is not supported by it,
 * so the tab is the one that was already there.
 *
 *   node scripts/tour/drive-my-browser.mjs
 */

const url = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://127.0.0.1:4173/';
const OUT = process.env.GEV_TOUR_OUT || '/tmp/hail-tour';

const browser = await puppeteer.connect({
  browserURL: 'http://127.0.0.1:47343',
  defaultViewport: null,
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function ev(page, fn, tries = 12) {
  for (let i = 0; i < tries; i += 1) {
    try { return await page.evaluate(fn); } catch (e) {
      if (!/detached|Execution context|Session closed/i.test(e.message)) throw e;
      await wait(2500);
    }
  }
  return null;
}

const pages = await browser.pages();
const page = pages[pages.length - 1];
const restore = page.url();
console.log('driving tab; it was at:', restore.slice(0, 70));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
await wait(15000);

// What IS the modal's dismiss button called? Dump it rather than guess.
const modal = await ev(page, () => {
  const dialogs = [...document.querySelectorAll('div,section,aside')].filter((d) =>
    /first launch/i.test(d.textContent || ''),
  );
  const box = dialogs[dialogs.length - 1];
  if (!box) return null;
  return {
    buttons: [...box.querySelectorAll('button')].map((b) => ({
      text: b.textContent.trim().slice(0, 40),
      cls: b.className,
    })),
    checkboxes: [...box.querySelectorAll('input')].map((b) => b.type),
  };
});
console.log('modal buttons:', JSON.stringify(modal, null, 1));

// The modal has NO dismiss button - "Don't show this again" is a LABEL next
// to a checkbox, and the modal says "ESC TO DISMISS". So: tick the box and
// press ESC.
await ev(page, () => {
  const dialogs = [...document.querySelectorAll('div,section,aside')].filter((d) =>
    /first launch/i.test(d.textContent || ''),
  );
  const box = dialogs[dialogs.length - 1];
  const cb = [...(box?.querySelectorAll('input[type=checkbox]') || [])][0];
  if (cb && !cb.checked) cb.click();
  return true;
});
await page.keyboard.press('Escape');
await wait(1500);
await page.keyboard.press('Escape');
await wait(6000);
const stillThere = await ev(page, () =>
  /first launch/i.test(document.body.innerText),
);
console.log('modal still up:', stillThere);

// The panel, the isolation, and Colorado.
await ev(page, () => {
  const plus = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '+');
  if (plus) plus.click();
  return true;
});
await wait(5000);
await ev(page, () => {
  const row = [...document.querySelectorAll('.data-toggle-row')].find((r) =>
    r.textContent.includes('Isolation Mode'),
  );
  if (!row) return false;
  const b = row.querySelector('.data-toggle-btn');
  if (!b.className.includes('active')) b.click();
  return true;
});
await wait(12000);
await ev(page, () => {
  const row = [...document.querySelectorAll('.data-toggle-row')].find((r) =>
    r.textContent.includes('Isolation Mode'),
  );
  const input = row?.querySelector('.data-toggle-field-input');
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'Colorado');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  input.blur();
  return true;
});
await wait(20000);
await ev(page, () => {
  const row = [...document.querySelectorAll('.data-toggle-row')].find((r) =>
    r.textContent.includes('Isolation Mode'),
  );
  const chip = [...(row?.querySelectorAll('.data-toggle-chip') || [])].find((c) =>
    c.textContent.trim() === 'FRAME',
  );
  if (chip) chip.click();
  return true;
});
await wait(28000);

// The storm layer inside the isolation.
await ev(page, () => {
  const row = [...document.querySelectorAll('.data-toggle-row')].find((r) =>
    r.textContent.includes('Hail & Wind — Observed'),
  );
  if (!row) return false;
  const b = row.querySelector('.data-toggle-btn');
  if (!b.className.includes('active')) b.click();
  return true;
});
await wait(26000);

// Fly to Colorado Springs with the app's own location search, which is what
// a person uses. FRAME framed the whole state at 639 km, where the swath is
// coarse blocks; the 1 km field only draws under 12 km.
const typed = await ev(page, () => {
  const input = [...document.querySelectorAll('input')].find((i) =>
    /search any location/i.test(i.placeholder || ''),
  );
  if (!input) return 'no input';
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'Colorado Springs');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return 'typed';
});
console.log('search:', typed);
await wait(7000);
const suggestion = await ev(page, () => {
  const el = [...document.querySelectorAll('*')].find(
    (e) => e.children.length === 0 && /Colorado Springs/i.test(e.textContent || ''),
  );
  if (!el) return null;
  el.click();
  return el.textContent.trim().slice(0, 40);
});
console.log('suggestion:', suggestion);
await wait(26000);
await page.screenshot({ path: `${OUT}/61-colorado-springs.png` });
console.log('shot: 61-colorado-springs.png');

// And zoom in on the globe canvas - the biggest one on the page.
const box = await ev(page, () => {
  let best = null;
  for (const c of document.querySelectorAll('canvas')) {
    const r = c.getBoundingClientRect();
    const area = r.width * r.height;
    if (!best || area > best.area) best = { area, x: r.x, y: r.y, w: r.width, h: r.height };
  }
  return best;
});
console.log('globe canvas:', JSON.stringify(box));
if (box) {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  for (let i = 0; i < 10; i += 1) {
    await page.mouse.move(cx, cy);
    await page.mouse.wheel({ deltaY: -400 });
    await wait(1500);
  }
}
await wait(16000);
await page.screenshot({ path: `${OUT}/60-colorado-isolated-zoomed.png` });
console.log('shot: 60-colorado-isolated-zoomed.png');

const where = await ev(page, () => {
  const text = document.body.innerText;
  const summary = text.match(/SUMMARY[^\n]{0,120}/)?.[0];
  const gsd = text.match(/GSD:[^\n]{0,60}/)?.[0];
  return { summary, gsd };
});
console.log('camera:', JSON.stringify(where));

await browser.disconnect();
