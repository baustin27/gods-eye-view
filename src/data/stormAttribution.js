/**
 * Attribution and mandatory disclaimers for the storm intelligence layer.
 *
 * Two obligations are hard-coded here rather than left to whoever renders the
 * credits popover, because both are contractual:
 *
 *  - FEMA's National Risk Index terms require the "not endorsed by FEMA"
 *    sentence verbatim whenever National Risk Index data is displayed or
 *    derived from. The National Risk Index Technical Documentation and FEMA's
 *    own terms make this a condition of use, not a courtesy.
 *  - NOAA/NWS and US Census data are public domain; they ask for attribution
 *    but do not require it. Those credits still ship, because a risk map with
 *    no visible source is not usable evidence.
 *
 * The National Risk Index figures shown anywhere in the app are model output
 * built on Hazus 6.0 exposure, not adjudicated losses, and the UI says so.
 *
 * @module data/stormAttribution
 */

/**
 * FEMA's required disclaimer, reproduced verbatim from FEMA's National Risk
 * Index terms of use. Do not paraphrase, shorten, or wrap it into a tooltip
 * that a user might never open.
 * @constant
 */
import { FEMA_NRI_DISCLAIMER } from './femaDisclaimer.js';

/** Re-exported so the storm feature has one obvious place to import it from. */

/**
 * Per-source credits for the bundled storm snapshots.
 * @type {ReadonlyArray<{id:string,label:string,detail:string,url:string,license:string}>}
 */
export const STORM_SOURCE_CREDITS = Object.freeze([
  Object.freeze({
    id: 'spc',
    label: 'NOAA/NWS Storm Prediction Center',
    detail: 'Hail and wind severe-weather reports, 1955–2025',
    url: 'https://www.spc.noaa.gov/wcm/',
    license: 'US Government public domain',
  }),
  Object.freeze({
    id: 'fema-nri',
    label: 'FEMA National Risk Index',
    detail: 'Hail and strong-wind expected annual loss, Hazus 6.0 exposure',
    url: 'https://www.fema.gov/flood-maps/products-tools/national-risk-index',
    license: 'Free to use with FEMA-mandated disclaimer',
  }),
  Object.freeze({
    id: 'census',
    label: 'US Census Bureau',
    detail: 'Cartographic boundary county polygons',
    url: 'https://www.census.gov/geographies/mapping-files.html',
    license: 'US Government public domain',
  }),
]);

/**
 * One-line summary for the layer panel source badge.
 * @constant
 */
export const STORM_SOURCE_BADGE = 'NOAA/NWS SPC · FEMA NRI · Census';

/**
 * Method caveats that must accompany any damage-likelihood score.
 *
 * These are not boilerplate. Each one names a specific way the number can be
 * wrong, and each is worth more to a user than the number itself would be
 * without it.
 * @constant
 */
export const STORM_METHOD_CAVEATS = Object.freeze([
  Object.freeze(
    'Report density is not uniform across decades. The record is much denser after 1995 than before 1980, so raw decade-to-decade comparisons overstate the trend.',
  ),
  Object.freeze(
    'Hail and wind reports are point observations, usually from spotters, public weather stations, and media. A county with good coverage is not a county that was hit harder.',
  ),
  Object.freeze(
    'FEMA expected annual loss is a modelled rate per dollar of building value, not an adjudicated insurance payment. It describes average risk over many years, not one storm.',
  ),
  Object.freeze(
    'A high score means "look here first", not "damage is here". Confirm with radar, warnings, and on-site inspection before committing resources.',
  ),
]);

/**
 * Flat credit rows for the existing Data attribution popover.
 *
 * The popover expects plain display strings, so this is the adapter that keeps
 * the structured credits above from leaking its shape into the UI.
 *
 * @returns {Array<{label:string, text:string}>}
 */
export function stormCreditRows() {
  return [
    ...STORM_SOURCE_CREDITS.map((source) => ({
      label: source.label,
      text: `${source.detail} — ${source.license}. ${source.url}`,
    })),
    { label: 'FEMA disclaimer', text: FEMA_NRI_DISCLAIMER },
  ];
}
