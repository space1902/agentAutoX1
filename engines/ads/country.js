// Country of a sale or a campaign. Pure.
//  - Sale: the customer's phone prefix first (real column "Teléfono cliente", digits with country code), then the
//    country of the matched ad's campaign, then a country name inside the flow. The method is reported.
//  - Campaign: country tokens inside the campaign name ("Col", "MX", "Ven"...), configurable.
import { normalizeText } from './parse.js';

export const COUNTRY_NAMES = Object.freeze({
  CO: 'Colombia', MX: 'México', VE: 'Venezuela', PE: 'Perú', EC: 'Ecuador', US: 'Estados Unidos', CL: 'Chile', AR: 'Argentina',
  BR: 'Brasil', BO: 'Bolivia', PY: 'Paraguay', UY: 'Uruguay', PA: 'Panamá', CR: 'Costa Rica', GT: 'Guatemala', SV: 'El Salvador',
  HN: 'Honduras', NI: 'Nicaragua', CU: 'Cuba', DO: 'República Dominicana', ES: 'España',
});

// Calling code -> ISO country. "1" covers the US/Canada numbering plan (treated as US).
const PREFIXES = {
  57: 'CO', 52: 'MX', 58: 'VE', 51: 'PE', 593: 'EC', 56: 'CL', 54: 'AR', 55: 'BR', 591: 'BO', 595: 'PY', 598: 'UY', 507: 'PA',
  506: 'CR', 502: 'GT', 503: 'SV', 504: 'HN', 505: 'NI', 53: 'CU', 34: 'ES', 1: 'US',
};

export const DEFAULT_COUNTRY_TOKENS = Object.freeze({
  CO: ['col', 'colombia', 'co'],
  MX: ['mx', 'mex', 'mexico'],
  VE: ['ve', 'ven', 'venezuela'],
  PE: ['pe', 'peru'],
  EC: ['ec', 'ecu', 'ecuador'],
  US: ['us', 'usa', 'eeuu'],
});

export function countryFromPhone(value) {
  let digits = String(value ?? '').replace(/\D/g, '').replace(/^00/, '');
  if (digits.length < 8) return '';
  // A bare Colombian mobile (10 digits, starts with 3).
  if (digits.length === 10 && digits.startsWith('3')) digits = `57${digits}`;
  for (const len of [3, 2, 1]) {
    const country = PREFIXES[digits.slice(0, len)];
    if (country) return digits.length >= 8 && digits.length <= 15 ? country : '';
  }
  return '';
}

export function campaignCountry(name, tokens = DEFAULT_COUNTRY_TOKENS) {
  const words = normalizeText(name).split(/[^a-z0-9]+/).filter(Boolean);
  for (const [country, list] of Object.entries(tokens ?? {})) {
    if (list.some((token) => words.includes(normalizeText(token)))) return country;
  }
  return '';
}

export function flowCountry(flow) {
  const text = normalizeText(flow);
  for (const [country, name] of Object.entries(COUNTRY_NAMES)) if (text.includes(normalizeText(name))) return country;
  return '';
}

export function deriveCountry({ phone, campaignName, flow }, tokens = DEFAULT_COUNTRY_TOKENS) {
  const byPhone = countryFromPhone(phone);
  if (byPhone) return { country: byPhone, source: 'telefono' };
  const byCampaign = campaignCountry(campaignName, tokens);
  if (byCampaign) return { country: byCampaign, source: 'campana' };
  const byFlow = flowCountry(flow);
  if (byFlow) return { country: byFlow, source: 'flujo' };
  return { country: '', source: '' };
}
