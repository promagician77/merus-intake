import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as N from '../src/normalize.js';
import { toLead, flatten } from '../src/mapping.js';
import { validate } from '../src/validate.js';
import { injuryFields, contactFields } from '../src/plan.js';
import { formEncode } from '../src/merus/client.js';
import { mapping, bodyDict, firm } from './helpers/env.js';

const F = firm();
const base = () => JSON.parse(readFileSync(new URL('../ghl/custom-webhook-body.json', import.meta.url), 'utf8'));
const lead = (over = {}) => toLead({ contact_id: 'c1', pipeline_stage: 'Signed', first_name: 'Rosa', last_name: 'Peña', date_of_birth: '1980-02-29', phone: '(415) 555-0101', email: 'Rosa@Example.com',
  assigned_attorney: 'Dan Hegwer', signed_date: '2026-10-20', injury_1_type: 'Specific', injury_1_date: '03/04/2025', injury_1_body_parts: 'L knee, right shoulder', ...over }, mapping, { bodyDict, maxInjuries: 3 });

test('the field map has 29 fields: 13 contact, 11 injury, 2 case, 3 without an API field', () => {
  assert.equal(mapping.length, 29);
  const by = (s) => mapping.filter((m) => m.scope === s).length;
  assert.deepEqual([by('contact'), by('injury'), by('case'), by('gap')], [13, 11, 2, 3]);
});

test('the GoHighLevel body template carries every mapped field, three injury slots each', () => {
  const t = base();
  for (const m of mapping) for (const k of m.perInjury ? [1, 2, 3].map((n) => m.ghl_key.replace('{n}', n)) : [m.ghl_key]) assert.ok(k in t, k);
});

test('dates: ISO, US, two-digit years and "Mar 4th 2026"; impossible dates rejected', () => {
  assert.deepEqual(['2026-03-04', '03/04/2026', '3/4/26', 'Mar 4th 2026', 'March 4, 2026'].map(N.isoDate), Array(5).fill('2026-03-04'));
  assert.equal(N.isoDate('02/30/2026'), null);
  assert.equal(N.isoDate('1980-02-29'), '1980-02-29');
  assert.equal(N.mdy('2026-03-04'), '03/04/2026');
});

test('phones: any US format becomes 10 digits', () => {
  assert.deepEqual(['(415) 555-0101', '415-555-0101', '+1 415 555 0101', '14155550101'].map(N.phone10), Array(4).fill('4155550101'));
  assert.equal(N.phone10('555-0101'), null);
});

test('injury type: CT and Specific in the ways intake staff write them', () => {
  assert.deepEqual(['CT', 'cumulative trauma', 'Cumulative', 'repetitive', 'Specific', 'specific injury', 'accident', '??'].map(N.injuryType), ['CT', 'CT', 'CT', 'CT', 'SPECIFIC', 'SPECIFIC', 'SPECIFIC', null]);
});

test('body parts: IDs plus laterality; left + right of one part becomes bilateral; unknown words are reported', () => {
  const r = N.bodyParts('L knee, right knee, low back, bilateral wrists, psyche, elbow-ish thing', bodyDict);
  assert.deepEqual(r.parts.map((p) => [p.part, p.lr]), [['knee', 3], ['low back', 0], ['wrist', 3], ['psyche', 0]]);
  assert.deepEqual(r.unknown, ['elbow-ish thing']);
});

test('EAMS case numbers: ADJ plus 7 or 8 digits', () => {
  assert.equal(N.adj('adj 10387327'), 'ADJ10387327'); assert.equal(N.adj('ADJ6818414'), 'ADJ6818414'); assert.equal(N.adj('10387327'), null);
});

test('names: accents, hyphens, Jr./Sr. and nicknames (English and Spanish) normalise for matching', () => {
  assert.deepEqual(N.nameTokens('Peña-Muñoz Jr.'), ['pena', 'munoz']);
  assert.deepEqual(['Bob', 'Pepe', 'Lupe', 'Chuy'].map(N.canonFirst), ['robert', 'jose', 'guadalupe', 'jesus']);
});

test('webhook bodies: keys match regardless of case and spacing, nested custom data is found', () => {
  const f = flatten({ 'Injury 1 Date': '2025-01-02', customData: { referral_source: 'Union' }, contact: { first_name: 'X' } });
  assert.equal(f.get('injury1date'), '2025-01-02'); assert.equal(f.get('referralsource'), 'Union'); assert.equal(f.get('firstname'), 'X');
});

test('unrendered merge tags count as blank, not as data', () => {
  const l = lead({ injury_2_date: '{{contact.injury_2_date}}', injury_2_type: '{{contact.injury_2_type}}' });
  assert.equal(l.injuries.length, 1);
});

test('lead: three injuries read from numbered fields; occupation copied into each', () => {
  const l = lead({ occupation: 'Carpenter', injury_2_type: 'CT', injury_2_date: '2023-01-01', injury_2_end_date: '2025-06-30', injury_3_type: 'Specific', injury_3_date: '2024-07-04' });
  assert.equal(l.injuries.length, 3);
  assert.deepEqual(l.injuries.map((i) => i.occupation), ['Carpenter', 'Carpenter', 'Carpenter']);
});

test('validation: a CT injury needs an end date after its start', () => {
  assert.match(validate(lead({ injury_1_type: 'CT' }), F, { today: '2026-11-05' }).join('|'), /CT injury needs an end date/);
  assert.match(validate(lead({ injury_1_type: 'CT', injury_1_date: '2025-01-01', injury_1_end_date: '2024-01-01' }), F, { today: '2026-11-05' }).join('|'), /end date is before/);
});

test('validation: future dates, unmapped attorney, unknown body part, repeated injury, too many injuries', () => {
  const e = validate(lead({ injury_1_date: '2027-01-01', assigned_attorney: 'Nobody', injury_1_body_parts: 'spleen', injury_2_type: 'Specific', injury_2_date: '2027-01-01', injury_4_date: '2025-01-01' }), F, { today: '2026-11-05' }).join('|');
  for (const re of [/in the future/, /no MerusCase user ID/, /unknown body part: spleen/, /repeats an earlier injury/, /more than 3 injuries/]) assert.match(e, re);
});

test('validation: a clean lead passes', () => {
  assert.deepEqual(validate(lead(), F, { today: '2026-11-05' }), []);
});

test('injury fields use the published injuries/edit names and formats', () => {
  const l = lead({ injury_1_type: 'CT', injury_1_date: '2023-01-01', injury_1_end_date: '2025-06-30', injury_1_adj_number: 'adj10387327', injury_1_claim_number: 'abc-1' });
  const f = injuryFields(l.injuries[0], F);
  assert.equal(f.injury_type_id, 1); assert.equal(f.date_of_injury, '01/01/2023'); assert.equal(f.date_of_injury_end, '06/30/2025');
  assert.equal(f.eams_case_number, 'ADJ10387327'); assert.equal(f.carrier_claim_number, 'ABC-1');
  assert.deepEqual([f.q1_injury_description_1_id, f.q1_injury_description_1_lr, f.q1_injury_description_2_id, f.q1_injury_description_2_lr], [14, 1, 5, 2]);
});

test('a specific injury sends no end date; contact dates go out as MM/DD/YYYY', () => {
  const l = lead();
  assert.equal(injuryFields(l.injuries[0], F).date_of_injury_end, undefined);
  assert.equal(contactFields(l, mapping).birth_date, '02/29/1980');
  assert.equal(contactFields(l, mapping).email, 'rosa@example.com');
});

test('POST bodies are data[Model][field], arrays as field[]', () => {
  assert.equal(formEncode({ Activity: { case_file_id: 5, activity_type_id: [9001], activity: 'a b' } }).toString(), 'data%5BActivity%5D%5Bcase_file_id%5D=5&data%5BActivity%5D%5Bactivity_type_id%5D%5B%5D=9001&data%5BActivity%5D%5Bactivity%5D=a+b');
});
