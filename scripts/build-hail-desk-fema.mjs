#!/usr/bin/env node
/**
 * build-hail-desk-fema.mjs — realised homeowner damage, by ZIP.
 *
 * WHY THIS IS HERE. Every other number in the desk is either a measurement
 * of WEATHER (a report, a radar reading) or a MEASUREMENT OF A PLACE (a
 * population, a housing count). None of them says whether damage actually
 * happened. This one does.
 *
 * FEMA's Individual Assistance register is the only free source that pairs
 * real post-disaster homeowner damage with a geography, and it is keyed to a
 * ZIP. A household that applied for help, the damage it reported, and the
 * money it was approved - which is a household that had damage.
 *
 * It is also the only source here that is CURRENT: the SBA disaster-loan
 * series stops in September 2022, and this runs to today.
 *
 * The app already fetches this - `server/providers/storm-recent.js` selects
 * `zipCode` and then aggregates it away to county level, throwing the ZIP
 * away. This keeps it.
 *
 * Output:
 *   <out>/fema_damage.json.gz   per ZIP: households, damage, approved
 *
 * Usage:
 *   node scripts/build-hail-desk-fema.mjs [--out <dir>] [--max-pages 40]
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENDPOINT = 'https://www.fema.gov/api/open/v2/HousingAssistanceOwners';
const PAGE = 50000;

const args = parseArgs(process.argv.slice(2));

function parseArgs(argv) {
  const out = { out: 'apps/hail-desk/public/data', maxPages: 40 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') out.out = String(argv[++i] ?? '').trim();
    else if (arg === '--max-pages') out.maxPages = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: node scripts/build-hail-desk-fema.mjs [--out <dir>] [--max-pages 40]',
      );
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function step(message) {
  console.log(`[fema] ${message}`);
}

/**
 * One page of the register.
 *
 * The API is keyless and public, and it pages by `$skip`, so this is a plain
 * loop rather than something clever. A page that comes back short ends the
 * walk.
 */
async function fetchPage(skip) {
  const url =
    `${ENDPOINT}?$top=${PAGE}&$skip=${skip}` +
    '&$select=disasterNumber,state,county,zipCode,totalDamage,' +
    'repairReplaceAmount,totalApprovedIhpAmount';
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`OpenFEMA ${response.status} at skip ${skip}`);
  }
  const payload = await response.json();
  return payload.HousingAssistanceOwners || [];
}

async function main() {
  const outDir = path.isAbsolute(args.out)
    ? args.out
    : path.join(ROOT, args.out);

  const byZip = new Map();
  const disasters = new Set();
  let rows = 0;
  for (let page = 0; page < args.maxPages; page += 1) {
    const batch = await fetchPage(page * PAGE);
    rows += batch.length;
    for (const row of batch) {
      const zip = String(row.zipCode || '').trim();
      if (!zip) continue;
      if (row.disasterNumber) disasters.add(row.disasterNumber);
      let entry = byZip.get(zip);
      if (!entry) {
        entry = { households: 0, damage: 0, approved: 0, replace: 0, disasters: 0 };
        byZip.set(zip, entry);
      }
      entry.households += 1;
      entry.damage += Number(row.totalDamage) || 0;
      entry.approved += Number(row.totalApprovedIhpAmount) || 0;
      entry.replace += Number(row.repairReplaceAmount) || 0;
      entry.disasters += 1;
    }
    step(`page ${page + 1}: ${rows.toLocaleString()} rows, ${byZip.size} ZIPs`);
    if (batch.length < PAGE) break;
  }

  const zips = [...byZip.entries()]
    .map(([zip, entry]) => ({
      zip,
      households: entry.households,
      damage: Math.round(entry.damage),
      approved: Math.round(entry.approved),
      replace: Math.round(entry.replace),
    }))
    .sort((a, b) => b.damage - a.damage);
  step(`rows: ${rows.toLocaleString()} over ${disasters.size} disasters, ${zips.length} ZIPs`);

  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, 'fema_damage.json.gz');
  fs.writeFileSync(
    target,
    zlib.gzipSync(
      Buffer.from(
        JSON.stringify({
          meta: {
            title: "God's Eye View - Hail Desk realised damage by ZIP",
            source:
              'FEMA OpenFEMA HousingAssistanceOwners, Individual Assistance ' +
              'registrations',
            license: 'US Government public domain',
            builtAt: new Date().toISOString(),
            rows: zips.length,
            disasters: disasters.size,
            note:
              'Households that registered for Individual Assistance, with the ' +
              'damage they reported and the help they were approved. A ZIP ' +
              'with entries here had damage that people asked for help with - ' +
              'which is a smaller set than the damage that happened, because ' +
              'most people do not apply for anything.',
          },
          zips,
        }),
        'utf8',
      ),
      { level: 9 },
    ),
  );
  step(
    `wrote ${path.relative(ROOT, target)} — ` +
      `${(fs.statSync(target).size / 1024).toFixed(0)} KB`,
  );
}

main().catch((error) => {
  console.error(`[fema] failed: ${error.message}`);
  process.exitCode = 1;
});
