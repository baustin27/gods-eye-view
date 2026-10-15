/**
 * Join NCEI Storm Events onto the SPC report snapshot.
 *
 * The two are the same underlying reports in different shapes, which was
 * verified at ~100% 0.1-degree cell overlap across 270 matched days in 2025.
 * They are not independent observations, so this is a join and not a
 * cross-check — but it is a valuable one, because NCEI carries three things
 * SPC does not:
 *
 *   EPISODE_ID          real storm identity. SPC's segment fields are zero on
 *                       every hail and wind row, so this is the only ground
 *                       truth for "which storm was this".
 *   EPISODE_NARRATIVE   a written description, present on 100% of events.
 *                       SPC's per-day comments reach only about half.
 *   DAMAGE_PROPERTY     actual dollar damage, present on about a third, where
 *                       SPC's crowd-sourced `loss` reaches far fewer.
 *
 * Pure: no I/O. `build-storm-reports.mjs` does the fetching.
 * @module scripts/lib/storm-ncei-join
 */

/**
 * NCEI writes money as an abbreviated string: `1.00K`, `500`, `2.5M`.
 * @param {string} [raw]
 * @returns {number} USD, 0 when absent or unparseable.
 */
export function parseNceiMoney(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/[$,]/g, '');
  if (!text) return 0;
  const scale = { k: 1e3, m: 1e6, b: 1e9 }[
    text[text.length - 1]?.toLowerCase()
  ];
  const digits = scale ? text.slice(0, -1) : text;
  const value = Number(digits);
  return Number.isFinite(value) ? value * (scale || 1) : 0;
}

/**
 * NCEI's `BEGIN_DATE_TIME` is `31-MAR-25 11:04:00`, with a two-digit year.
 * `END_DATE_TIME` may be blank or identical.
 * @param {string} [raw]
 * @returns {{iso: string, minute: number}|null}
 */
export function parseNceiDateTime(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2,4})\s+(\d{1,2}):(\d{2})/.exec(text);
  if (!m) return null;
  const [, day, monthName, rawYear, hour, minute] = m;
  const months = [
    'JAN',
    'FEB',
    'MAR',
    'APR',
    'MAY',
    'JUN',
    'JUL',
    'AUG',
    'SEP',
    'OCT',
    'NOV',
    'DEC',
  ];
  const month = months.indexOf(monthName.toUpperCase());
  if (month < 0) return null;
  // Two-digit years here are always 20xx for this record.
  const year = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
  if (!Number.isFinite(year) || year < 1900 || year > 2100) return null;
  const h = Number(hour);
  const min = Number(minute);
  if (h > 24 || min > 59) return null;
  return {
    iso: `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    minute: h * 60 + min,
  };
}

/**
 * 0.1-degree cell key. Both sources round their coordinates to two decimals,
 * so this lands on the same cell for the same physical report.
 * @param {number} lat
 * @param {number} lon
 * @returns {string}
 */
export function cellKey(lat, lon) {
  return `${Math.round(lat * 10)}:${Math.round(lon * 10)}`;
}

/**
 * Reduce an NCEI file to the fields the join needs.
 *
 * `EVENT_TYPE` is the filter: hail and the two wind types are the hazards this
 * pipeline covers, and letting floods and droughts through would attach
 * narratives to storms that never produced a hail or wind report.
 * @param {Array<Object<string,string>>} rows
 * @returns {{episodes: Map<string, object>, events: object[]}}
 */
export function indexNceiEvents(rows) {
  const WANTED = new Set(['Hail', 'Thunderstorm Wind', 'Strong Wind']);
  const episodes = new Map();
  const events = [];
  for (const row of rows) {
    const type = String(row.EVENT_TYPE ?? '').trim();
    if (!WANTED.has(type)) continue;
    const begin = parseNceiDateTime(row.BEGIN_DATE_TIME);
    if (!begin) continue;
    const lat = Number(row.BEGIN_LAT);
    const lon = Number(row.BEGIN_LON);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const episodeId = String(row.EPISODE_ID ?? '').trim();
    const eventId = String(row.EVENT_ID ?? '').trim();
    const event = {
      episodeId,
      eventId,
      date: begin.iso,
      minute: begin.minute,
      hazard: type === 'Hail' ? 'hail' : 'wind',
      lat,
      lon,
      cell: cellKey(lat, lon),
      damage: parseNceiMoney(row.DAMAGE_PROPERTY),
      narrative: String(row.EPISODE_NARRATIVE ?? '').trim() || null,
    };
    events.push(event);
    if (episodeId && !episodes.has(episodeId)) {
      episodes.set(episodeId, {
        episodeId,
        firstDate: event.date,
        firstMinute: event.minute,
        eventCount: 0,
        maxHailIn: null,
        maxWindKt: null,
        damage: 0,
        narrative: null,
        hazards: new Set(),
      });
    }
    const episode = episodes.get(episodeId);
    if (!episode) continue;
    episode.eventCount += 1;
    episode.hazards.add(event.hazard);
    episode.damage += event.damage;
    if (episode.narrative === null && event.narrative)
      episode.narrative = event.narrative;
  }
  return { episodes, events };
}

/**
 * Attach NCEI identity and narrative to the SPC reports.
 *
 * Matching is two-stage and deliberately tolerant, because the two files
 * disagree on some rows:
 *
 *   1. exact day + 0.1-degree cell — the common case
 *   2. same day + cell, nearest in time within `timeWindowMinutes`
 *
 * A report that matches nothing keeps `episodeId: null` and is reported back
 * as unmatched, so a silent drop is visible rather than assumed to be an
 * absence of storms.
 *
 * Mutates in place.
 * @param {object[]} reports Internal report shape.
 * @param {object[]} nceiEvents From {@link indexNceiEvents}.
 * @param {{timeWindowMinutes?: number}} [options]
 * @returns {{matched: number, unmatched: number, episodesUsed: number}}
 */
export function joinNcei(reports, nceiEvents, options = {}) {
  const timeWindowMinutes = options.timeWindowMinutes ?? 60;
  const byCell = new Map();
  for (const event of nceiEvents) {
    const key = `${event.date}|${event.cell}`;
    if (!byCell.has(key)) byCell.set(key, []);
    byCell.get(key).push(event);
  }
  const episodesUsed = new Set();
  let matched = 0;
  let unmatched = 0;
  for (const report of reports) {
    const candidates = byCell.get(
      `${report.date}|${cellKey(report.lat, report.lon)}`,
    );
    if (!candidates?.length) {
      unmatched += 1;
      continue;
    }
    let best = null;
    let bestGap = Infinity;
    for (const candidate of candidates) {
      if (candidate.hazard !== report.hazard) continue;
      const gap = Math.abs((candidate.minute ?? 0) - (report.minute ?? 0));
      if (gap < bestGap) {
        bestGap = gap;
        best = candidate;
      }
    }
    if (!best || bestGap > timeWindowMinutes) {
      unmatched += 1;
      continue;
    }
    report.episodeId = best.episodeId;
    report.sources = [...new Set([...(report.sources || []), 'ncei'])];
    if (best.narrative && !report.comment) report.comment = best.narrative;
    if (best.damage > 0 && !report.loss) report.loss = best.damage;
    episodesUsed.add(best.episodeId);
    matched += 1;
  }
  return { matched, unmatched, episodesUsed: episodesUsed.size };
}

/**
 * Fold matched reports into storm events, ordered the way a timeline reads.
 *
 * `identitySource` is carried through to the UI so inferred clustering is
 * never presented alongside a real `EPISODE_ID` without saying which it is.
 * @param {object[]} reports
 * @param {Map<string, object>} episodes
 * @returns {object[]}
 */
export function buildStormEvents(reports, episodes) {
  const byEpisode = new Map();
  for (const report of reports) {
    if (!report.episodeId) continue;
    if (!byEpisode.has(report.episodeId)) byEpisode.set(report.episodeId, []);
    byEpisode.get(report.episodeId).push(report);
  }
  const events = [];
  for (const [episodeId, list] of byEpisode) {
    let maxHailIn = null;
    let maxWindKt = null;
    let damage = 0;
    let narrative = null;
    const counties = new Set();
    const states = new Set();
    const hazards = new Set();
    let firstMinute = Infinity;
    let lastMinute = -Infinity;
    for (const report of list) {
      hazards.add(report.hazard);
      if (report.countyFips) counties.add(report.countyFips);
      if (report.state) states.add(report.state);
      damage += report.loss || 0;
      if (report.comment && !narrative) narrative = report.comment;
      const minute = report.minute ?? 0;
      if (minute < firstMinute) firstMinute = minute;
      if (minute > lastMinute) lastMinute = minute;
      if (report.hazard === 'hail') {
        if (
          report.size != null &&
          (maxHailIn === null || report.size > maxHailIn)
        )
          maxHailIn = report.size;
      } else if (
        report.size != null &&
        (maxWindKt === null || report.size > maxWindKt)
      ) {
        maxWindKt = report.size;
      }
    }
    const first = episodes.get(episodeId);
    events.push({
      id: episodeId,
      identitySource: 'ncei',
      date: list[0].date,
      beginMinute: firstMinute,
      endMinute: lastMinute,
      durationMinutes: lastMinute - firstMinute,
      hazards: [...hazards].sort(),
      maxHailIn,
      maxWindKt,
      reportCount: list.length,
      damage,
      counties: [...counties].sort(),
      states: [...states].sort(),
      narrative: narrative || first?.narrative || null,
      eventCount: first?.eventCount ?? list.length,
    });
  }
  events.sort((a, b) =>
    a.date === b.date
      ? a.beginMinute - b.beginMinute
      : a.date < b.date
        ? -1
        : 1,
  );
  return events;
}
