/**
 * Leave the app up, on screen, in Colorado isolation mode.
 *
 * Headless capture proves a thing; this leaves it there to be looked at. On its
 * own debug port, because 9222 and 9333 belong to the operator's session and are
 * not ours to touch.
 */
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: false,
  defaultViewport: null,
  userDataDir: '/tmp/gev-colorado-profile',
  args: [
    '--no-sandbox',
    '--remote-debugging-port=9400',
    '--window-size=1600,1000',
    '--window-position=0,0',
  ],
});
const page = (await browser.pages())[0] ?? (await browser.newPage());
await page.setViewport({ width: 1600, height: 1000 });
await page.goto('http://localhost:4173', { waitUntil: 'networkidle2', timeout: 120000 });
await page.waitForFunction(() => window.__godsEyeView?.viewer, { timeout: 90000 });
await page.evaluate(() => {
  try { localStorage.setItem('gev:first-run-mission:v1', 'suppressed'); } catch { /* private mode */ }
});

// Enable through the verb runner, exactly as the QA harness does.
//
// `layer.enable()` on its own does not fetch anything: the manager owns that
// transition, so calling it directly left the layer on with no data and nothing
// drawn. The first version of this script did precisely that and staged an empty
// map.
await page.evaluate(async () => {
  const runner = window.__gevVoiceCommands?.runner;
  await runner?.('set_layer_visibility', { layerId: 'storm-reports', enabled: true });
});

await page.evaluate(async () => {
  const app = window.__godsEyeView;
  const get = (id) => {
    const r = app?.dataManager?.layers?.get(id);
    return r?.module ?? r;
  };
  get('storm-reports')?.setHazard?.('hail');
  get('storm-reports')?.setDate?.('2026-06-01');
  await new Promise((r) => setTimeout(r, 3000));
  await get('isolation')?.setIsolationText?.('Colorado');
  await new Promise((r) => setTimeout(r, 5000));
  get('storm-reports')?.setReportedSwath?.(true);
  get('storm-reports')?.setRadarSwath?.(true);
});

// Wait for the swaths to actually exist before framing, rather than hoping.
await page
  .waitForFunction(
    () => {
      const ds = window.__godsEyeView?.viewer?.dataSources;
      const n = ds?.length ?? 0;
      for (let i = 0; i < n; i += 1) {
        const c = ds.get(i)?.entities;
        const raw = c?.values;
        const ents = typeof raw === 'function' ? raw.call(c) : raw;
        for (const e of ents ?? []) {
          if (String(e.id ?? '').startsWith('storm-swath:radar:')) return true;
        }
      }
      return false;
    },
    { timeout: 60_000, polling: 250 },
  )
  .catch(() => console.log('WARNING: no radar swaths appeared within 60s'));

// Frame with the APP'S OWN verb, not a hand-built Cesium camera call.
//
// The first version reached into the camera and flew it with a borrowed
// `Cartographic.fromDegrees`, which left the viewer in a hard render error -
// "Failed to set the 'length' property on 'Array'", rendering stopped, camera
// coordinates null. The app already has a verb for exactly this and it builds
// its own objects correctly.
const box = await page.evaluate(() => {
  const rec = window.__godsEyeView?.dataManager?.layers?.get('isolation');
  const raw = (rec?.module ?? rec)?.getIsolation?.() ?? null;
  const area = raw?.area?.polygons ? raw.area : raw;
  const b = area?.bbox;
  return Array.isArray(b) ? { lat: (b[1] + b[3]) / 2, lon: (b[0] + b[2]) / 2 } : null;
});
if (box) {
  const flew = await page.evaluate(
    async (t) => {
      const runner = window.__gevVoiceCommands?.runner;
      return runner?.('fly_to_location', {
        latitude: t.lat,
        longitude: t.lon,
        rangeM: 300000,
        waitForArrival: true,
      });
    },
    box,
  );
  console.log('framed:', JSON.stringify(flew));
}
await new Promise((r) => setTimeout(r, 4000));
console.log('Colorado isolation is up on screen; debug port 9400, app on :4173');
console.log('Press Ctrl-C or close the window to stop.');
await new Promise(() => {});
