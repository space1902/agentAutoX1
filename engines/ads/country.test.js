import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COUNTRY_NAMES, DEFAULT_COUNTRY_TOKENS, campaignCountry, countryFromPhone, deriveCountry, flowCountry } from './country.js';

test('countryFromPhone uses the longest calling-code prefix', () => {
  assert.equal(countryFromPhone('573001234567'), 'CO');
  assert.equal(countryFromPhone('+57 300 123 4567'), 'CO');
  assert.equal(countryFromPhone('525512345678'), 'MX');
  assert.equal(countryFromPhone('584141234567'), 'VE');
  assert.equal(countryFromPhone('51987654321'), 'PE');
  assert.equal(countryFromPhone('593987654321'), 'EC');
  assert.equal(countryFromPhone('56912345678'), 'CL');
  assert.equal(countryFromPhone('17865551234'), 'US');
  assert.equal(countryFromPhone('0057 300 1234567'), 'CO');
});

test('countryFromPhone treats a bare Colombian mobile as CO and rejects junk', () => {
  assert.equal(countryFromPhone('3001234567'), 'CO');
  for (const v of ['', null, undefined, 'abc', '12', '999999999999']) assert.equal(countryFromPhone(v), '');
});

test('campaignCountry reads country tokens as whole words, case-insensitively', () => {
  assert.equal(campaignCountry('CT 01 Col 2 - ventas'), 'CO');
  assert.equal(campaignCountry('CT 03 COL'), 'CO');
  assert.equal(campaignCountry('CT 04 MX test'), 'MX');
  assert.equal(campaignCountry('CT 02 Ven'), 'VE');
  assert.equal(campaignCountry('CT 05 VE - ventas'), 'VE');
  assert.equal(campaignCountry('CT 06 Colchones'), '', 'a longer word is not a token');
  assert.equal(campaignCountry('CT 07'), '');
  assert.equal(campaignCountry(''), '');
});

test('campaignCountry honours a custom token map', () => {
  assert.equal(campaignCountry('CT 08 Peru', { PE: ['peru', 'pe'] }), 'PE');
  assert.equal(campaignCountry('CT 08 Col', { PE: ['peru'] }), '');
  assert.ok(DEFAULT_COUNTRY_TOKENS.CO.includes('col'));
});

test('flowCountry finds the country name in the flow', () => {
  assert.equal(flowCountry('Bebidas México - aporte'), 'MX');
  assert.equal(flowCountry('Bebidas - Venezuela'), 'VE');
  assert.equal(flowCountry('Bebidas - aporte'), '');
});

test('deriveCountry: phone first, then the ad campaign, then the flow; reports how', () => {
  assert.deepEqual(deriveCountry({ phone: '525512345678', campaignName: 'CT 01 Col', flow: 'Bebidas' }), { country: 'MX', source: 'telefono' });
  assert.deepEqual(deriveCountry({ phone: '', campaignName: 'CT 01 Col', flow: 'Bebidas' }), { country: 'CO', source: 'campana' });
  assert.deepEqual(deriveCountry({ phone: '', campaignName: '', flow: 'Bebidas México' }), { country: 'MX', source: 'flujo' });
  assert.deepEqual(deriveCountry({ phone: '', campaignName: '', flow: 'Bebidas' }), { country: '', source: '' });
});

test('country names are available for the UI', () => {
  assert.equal(COUNTRY_NAMES.CO, 'Colombia');
  assert.equal(COUNTRY_NAMES.MX, 'México');
});
