/**
 * Tests for overvaagning.mjs: beslutningen (hvornår der sendes SMS) og én hel kørsel med falsk net.
 * Kør: node --test scripts/overvaagning.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { beslut, siden, tilHistorik, kl, smsTekst, msisdn, koer, TJEK_TRIN } from './overvaagning.mjs';

const oppe = { nede: false, start: new Date('2026-11-02T09:00:00Z') };
const nede = { nede: true, start: new Date('2026-11-02T09:05:00Z') };

test('1 fejl giver ingen SMS', () => {
  assert.equal(beslut(true, [oppe, oppe]), null);
});

test('2 i træk nede giver én SMS', () => {
  assert.equal(beslut(true, [nede, oppe]), 'nede');
});

test('fortsat nede giver ingen nye SMS', () => {
  assert.equal(beslut(true, [nede, nede]), null);
  assert.equal(beslut(true, [nede, nede, nede, oppe]), null);
});

test('oppe igen efter 2+ nede giver én SMS, og kun én', () => {
  assert.equal(beslut(false, [nede, nede]), 'oppe');
  assert.equal(beslut(false, [oppe, nede, nede]), null);
});

test('oppe efter én enkelt fejl giver ingen SMS (der blev aldrig sendt "nede")', () => {
  assert.equal(beslut(false, [nede, oppe]), null);
});

test('manglende historik: ingen SMS, men 2 nede uden ældre kørsler alarmerer', () => {
  assert.equal(beslut(true, []), null);
  assert.equal(beslut(false, []), null);
  assert.equal(beslut(true, [nede]), 'nede');
  assert.equal(beslut(false, [nede]), null);
});

test('stadig nede: én SMS mere, når 12 kørsler i træk er nede (ca. en time), og kun én gang', () => {
  const tolv = Array(12).fill(nede);
  assert.equal(beslut(true, [...tolv, oppe]), 'stadig');
  assert.equal(beslut(true, [...tolv.slice(1), oppe]), null);
  assert.equal(beslut(true, [...tolv, nede, oppe]), null);
  // starten af nedbruddet kan ikke ses (aflyste kørsler fylder listen): hellere ingen end en hver 5. minut
  assert.equal(beslut(true, tolv), null);
  assert.equal(beslut(false, [...tolv, oppe]), 'oppe');
});

test('siden: starten af nedbruddet er den ældste kørsel nede i træk', () => {
  const tidlig = { nede: true, start: new Date('2026-11-02T08:00:00Z') };
  assert.equal(siden([nede, tidlig, oppe]), tidlig.start);
  assert.equal(siden([nede]), nede.start);
  assert.equal(siden([]), undefined);
});

test('tilHistorik: kun lykkedes/fejlede tæller, denne kørsel springes over', () => {
  const runs = [
    { id: 9, conclusion: null, run_started_at: '2026-11-02T09:15:00Z' },
    { id: 8, conclusion: 'cancelled', run_started_at: '2026-11-02T09:10:00Z' },
    { id: 7, conclusion: 'failure', run_started_at: '2026-11-02T09:05:00Z' },
    { id: 6, conclusion: 'success', created_at: '2026-11-02T09:00:00Z' },
  ];
  assert.deepEqual(tilHistorik(runs, 9), [
    { nede: true, start: new Date('2026-11-02T09:05:00Z') },
    { nede: false, start: new Date('2026-11-02T09:00:00Z') },
  ]);
  assert.deepEqual(tilHistorik(undefined, 1), []);
});

test('tilHistorik: en fejlet kørsel, hvor tjekket ikke fejlede (fejl hos GitHub), springes over', () => {
  const runs = [
    { id: 7, conclusion: 'failure', tjekFejlede: false, run_started_at: '2026-11-02T09:05:00Z' },
    { id: 6, conclusion: 'failure', tjekFejlede: true, run_started_at: '2026-11-02T09:00:00Z' },
  ];
  assert.deepEqual(tilHistorik(runs, 9), [{ nede: true, start: new Date('2026-11-02T09:00:00Z') }]);
});

test('klokkeslæt i dansk tid, sommer- og vintertid', () => {
  assert.equal(kl(new Date('2026-10-15T12:05:00Z')), '14.05');
  assert.equal(kl(new Date('2026-11-02T07:03:00Z')), '08.03');
  assert.equal(kl(new Date('2026-11-01T23:30:00Z')), '00.30');
});

test('SMS-teksterne er korte, uden tankestreg og kun GSM-7-tegn', () => {
  const t = new Date('2026-11-02T13:07:00Z');
  assert.equal(smsTekst('nede', t), 'et kreativt bureau: portal.etkreativt.dk svarer ikke (siden kl. 14.07). Tjek Railway.');
  assert.equal(smsTekst('oppe', t), 'et kreativt bureau: portal.etkreativt.dk svarer igen (kl. 14.07).');
  assert.equal(smsTekst('stadig', t), 'et kreativt bureau: portal.etkreativt.dk svarer stadig ikke (siden kl. 14.07). Tjek Railway.');
  for (const s of [smsTekst('nede', t), smsTekst('stadig', t), smsTekst('oppe', t)]) {
    assert.ok(s.length <= 160);
    assert.match(s, /^[A-Za-z0-9 .,:()]+$/);
  }
});

test('msisdn: +45, 00 og 8 cifre bliver til cifre med landekode', () => {
  assert.equal(msisdn('+45 12 34 56 78'), '4512345678');
  assert.equal(msisdn('004512345678'), '4512345678');
  assert.equal(msisdn('12345678'), '4512345678');
  assert.equal(msisdn(''), null);
  assert.equal(msisdn(undefined), null);
});

/**
 * Falsk net: health svarer med status (eller kaster), GitHub giver runs og jobs, GatewayAPI optages.
 * githubSvar/smsSvar: statuskoder for de første kald (derefter githubStatus/200). githubFejl: { runId: 'checkout' | 'budget' }
 * er kørsler, der fejlede hos GitHub; alle andre fejlede kørsler fejlede i tjek-trinnet.
 */
function net({ health, runs = [], githubStatus = 200, githubSvar = [], smsSvar = [], githubFejl = {} }) {
  const sms = [];
  const kald = { github: 0, sms: 0 };
  const steps = (id) => ({
    checkout: [{ name: 'Run actions/checkout@v7', conclusion: 'failure' }, { name: TJEK_TRIN, conclusion: 'skipped' }],
    budget: [],
  }[githubFejl[id]] || [{ name: 'Run actions/checkout@v7', conclusion: 'success' }, { name: TJEK_TRIN, conclusion: 'failure' }]);
  const hent = async (url, opts = {}) => {
    if (url.includes('/health')) {
      const s = health.shift();
      if (s === 'timeout') throw new Error('The operation was aborted due to timeout');
      return { ok: s >= 200 && s < 300, status: s };
    }
    if (url.includes('api.github.com')) {
      kald.github++;
      const s = githubSvar.shift() ?? githubStatus;
      const jobs = url.match(/\/runs\/(\d+)\/jobs$/);
      return { ok: s === 200, status: s, json: async () => (jobs ? { jobs: [{ steps: steps(jobs[1]) }] } : { workflow_runs: runs }) };
    }
    if (url.includes('gatewayapi')) {
      kald.sms++;
      const s = smsSvar.shift() ?? 200;
      if (s !== 200) return { ok: false, status: s, text: async () => 'midlertidig fejl' };
      sms.push({ headers: opts.headers, body: JSON.parse(opts.body) });
      return { ok: true, status: 200 };
    }
    throw new Error(`uventet url ${url}`);
  };
  return { hent, sms, kald };
}
const env = { GITHUB_TOKEN: 'gh', GITHUB_REPOSITORY: 'etkreativt/etkreativt-portal', GITHUB_RUN_ID: '100', GATEWAYAPI_TOKEN: 'tok', ALERT_PHONE: '+45 12 34 56 78' };
const vent = async () => {};

test('kørsel: oppe giver exit 0 og ingen SMS', async () => {
  const { hent, sms } = net({ health: [200], runs: [{ id: 99, conclusion: 'success' }] });
  assert.equal(await koer({ env, hent, vent, log: () => {} }), 0);
  assert.equal(sms.length, 0);
});

test('kørsel: genstart (fejl, så oppe 30 sek. efter) tæller som oppe', async () => {
  const { hent, sms } = net({ health: [502, 200], runs: [{ id: 99, conclusion: 'failure' }, { id: 98, conclusion: 'success' }] });
  assert.equal(await koer({ env, hent, vent, log: () => {} }), 0);
  assert.equal(sms.length, 0);
});

test('kørsel: 2. kørsel nede sender én SMS med tid fra forrige kørsel og fejler', async () => {
  const runs = [{ id: 99, conclusion: 'failure', run_started_at: '2026-11-02T13:02:00Z' }, { id: 98, conclusion: 'success' }];
  const { hent, sms } = net({ health: ['timeout', 503], runs });
  assert.equal(await koer({ env, hent, vent, log: () => {} }), 1);
  assert.equal(sms.length, 1);
  assert.deepEqual(sms[0].body, { sender: 'ETKREATIVT', message: 'et kreativt bureau: portal.etkreativt.dk svarer ikke (siden kl. 14.02). Tjek Railway.', recipient: 4512345678 });
  assert.equal(sms[0].headers.Authorization, 'Token tok');
});

test('kørsel: manglende secrets giver tydelig advarsel, ingen crash, og kørslen fejler stadig når portalen er nede', async () => {
  const runs = [{ id: 99, conclusion: 'failure' }, { id: 98, conclusion: 'success' }];
  const { hent, sms } = net({ health: [503, 503], runs });
  const linjer = [];
  const kode = await koer({ env: { ...env, GATEWAYAPI_TOKEN: '', ALERT_PHONE: '' }, hent, vent, log: (l) => linjer.push(l) });
  assert.equal(kode, 1);
  assert.equal(sms.length, 0);
  assert.ok(linjer.some((l) => l.startsWith('::warning') && l.includes('GATEWAYAPI_TOKEN')));
  assert.ok(linjer.some((l) => l.startsWith('::warning') && l.includes('ALERT_PHONE')));
  assert.ok(linjer.some((l) => l.startsWith('::error') && l.includes('SMS kunne ikke sendes')));
});

test('kørsel: GitHub-opslag fejler giver advarsel og ingen SMS', async () => {
  const { hent, sms } = net({ health: [503, 503], githubStatus: 500 });
  const linjer = [];
  assert.equal(await koer({ env, hent, vent, log: (l) => linjer.push(l) }), 1);
  assert.equal(sms.length, 0);
  assert.ok(linjer.some((l) => l.startsWith('::warning') && l.includes('forrige kørsler')));
});

test('kørsel: simuler_nede rører ikke portalen og tæller som nede', async () => {
  const { hent, sms } = net({ health: [], runs: [{ id: 99, conclusion: 'failure' }, { id: 98, conclusion: 'success' }] });
  assert.equal(await koer({ env: { ...env, SIMULER_NEDE: 'true' }, hent, vent, log: () => {} }), 1);
  assert.equal(sms.length, 1);
});

test('kørsel: nummeret maskeres i loggen', async () => {
  const { hent } = net({ health: [200] });
  const linjer = [];
  await koer({ env, hent, vent, log: (l) => linjer.push(l) });
  assert.equal(linjer[0], '::add-mask::4512345678');
});

test('kørsel: GitHub-opslaget fejler første gang; 2. forsøg virker, og alarmen kommer stadig', async () => {
  const runs = [{ id: 99, conclusion: 'failure' }, { id: 98, conclusion: 'success' }];
  const { hent, sms } = net({ health: [503, 503], runs, githubSvar: [502] });
  const pauser = [];
  assert.equal(await koer({ env, hent, vent: async (ms) => { pauser.push(ms); }, log: () => {} }), 1);
  assert.equal(sms.length, 1);
  assert.deepEqual(pauser, [30_000, 5_000]);
});

test('kørsel: GitHub-opslaget prøves 3 gange, før kørslen giver op', async () => {
  const { hent, kald } = net({ health: [503, 503], githubStatus: 500 });
  await koer({ env, hent, vent, log: () => {} });
  assert.equal(kald.github, 3);
});

test('kørsel: SMS fejler første gang og sendes i 2. forsøg', async () => {
  const runs = [{ id: 99, conclusion: 'failure' }, { id: 98, conclusion: 'success' }];
  const { hent, sms, kald } = net({ health: [503, 503], runs, smsSvar: [503] });
  const linjer = [];
  assert.equal(await koer({ env, hent, vent, log: (l) => linjer.push(l) }), 1);
  assert.equal(kald.sms, 2);
  assert.equal(sms.length, 1);
  assert.ok(linjer.includes('SMS sendt (nede).'));
});

test('kørsel: fejl hos GitHub (checkout, budget) tæller ikke som nede', async () => {
  // to GitHub-fejl og så grøn: ingen falsk "svarer igen"
  let n = net({ health: [200], runs: [{ id: 99, conclusion: 'failure' }, { id: 98, conclusion: 'failure' }, { id: 97, conclusion: 'success' }], githubFejl: { 99: 'checkout', 98: 'budget' } });
  assert.equal(await koer({ env, hent: n.hent, vent, log: () => {} }), 0);
  assert.equal(n.sms.length, 0);
  // GitHub-fejl lige før et rigtigt nedbrud sluger ikke alarmen
  n = net({ health: [503, 503], runs: [{ id: 99, conclusion: 'failure' }, { id: 98, conclusion: 'failure' }, { id: 97, conclusion: 'failure' }, { id: 96, conclusion: 'success' }], githubFejl: { 98: 'budget', 97: 'checkout' } });
  assert.equal(await koer({ env, hent: n.hent, vent, log: () => {} }), 1);
  assert.equal(n.sms.length, 1);
  assert.match(n.sms[0].body.message, /svarer ikke/);
});

test('kørsel: efter 12 kørsler nede kommer "stadig nede" med tid fra nedbruddets start', async () => {
  const runs = Array.from({ length: 12 }, (_, i) => ({ id: 99 - i, conclusion: 'failure', run_started_at: new Date(Date.UTC(2026, 10, 2, 13, 57 - 5 * i)).toISOString() }));
  runs.push({ id: 87, conclusion: 'success', run_started_at: '2026-11-02T12:57:00Z' });
  const { hent, sms } = net({ health: [503, 503], runs });
  assert.equal(await koer({ env, hent, vent, log: () => {} }), 1);
  assert.equal(sms.length, 1);
  assert.equal(sms[0].body.message, 'et kreativt bureau: portal.etkreativt.dk svarer stadig ikke (siden kl. 14.02). Tjek Railway.');
});

test('workflowet: tjek-trinnet hedder det, scriptet slår op, og der er tid til 3 forsøg', () => {
  const yml = fs.readFileSync(new URL('../.github/workflows/overvaagning.yml', import.meta.url), 'utf8');
  assert.match(yml, new RegExp(`- name: ${TJEK_TRIN}\\n\\s+run: node scripts/overvaagning\\.mjs`));
  assert.match(yml, /timeout-minutes: 5\b/);
});
