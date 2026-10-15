/**
 * Overvågning af portal.etkreativt.dk. Køres af .github/workflows/overvaagning.yml hvert 5. minut.
 * Hukommelsen er GitHub selv: de forrige kørslers udfald (lykkedes = oppe, fejlede = nede) hentes via API'et,
 * så der skal hverken fil, database eller ekstra tjeneste til. Derfor fejler en kørsel KUN, når portalen er nede, og en
 * fejlet kørsel tæller kun, hvis trinnet TJEK_TRIN fejlede (fejl hos GitHub, fx checkout eller budget, springes over).
 * SMS ved 2. kørsel i træk nede, én gang "stadig nede" efter en time (fanger også en tabt alarm), og ved første kørsel
 * oppe efter 2+ nede. GitHub-opslag og SMS prøves 3 gange. Tests: scripts/overvaagning.test.mjs
 */
import { pathToFileURL } from 'node:url';

const HEALTH_URL = 'https://portal.etkreativt.dk/health';
const SMS_URL = 'https://messaging.gatewayapi.com/mobile/single';
const WORKFLOW = 'overvaagning.yml';
export const TJEK_TRIN = 'Tjek portalen'; // trinnets navn i workflowet
const STADIG_EFTER = 12; // kørsler i træk nede før "stadig nede" (ca. en time)

/** Antal kørsler i træk nede lige før denne (historik nyeste først). */
function nedeITraek(historik) {
  const i = historik.findIndex((h) => !h.nede);
  return i === -1 ? historik.length : i;
}

/**
 * Ren beslutning. nede: denne kørsel; historik: tidligere kørsler, nyeste først. Giver 'nede', 'stadig', 'oppe' eller null.
 * 'stadig' kun når kørslen før de 12 nede kan ses og var oppe, så den kommer præcis én gang pr. nedbrud.
 */
export function beslut(nede, historik) {
  const n = nedeITraek(historik);
  if (nede) return n === 1 ? 'nede' : n === STADIG_EFTER && historik[n] ? 'stadig' : null;
  return n >= 2 ? 'oppe' : null;
}

/** Hvornår nedbruddet startede: den ældste af de kørsler i træk nede, der kan ses. */
export function siden(historik) {
  return historik[nedeITraek(historik) - 1]?.start;
}

/**
 * GitHubs kørsler (nyeste først) til historik. Kun lykkedes/fejlede tæller; aflyste og denne kørsel springes over, og
 * en fejlet kørsel, hvor tjekket ikke fejlede (r.tjekFejlede === false, sat af hentHistorik), var en fejl hos GitHub.
 */
export function tilHistorik(runs = [], egenId) {
  return runs
    .filter((r) => String(r.id) !== String(egenId) && (r.conclusion === 'success' || (r.conclusion === 'failure' && r.tjekFejlede !== false)))
    .map((r) => ({ nede: r.conclusion === 'failure', start: new Date(r.run_started_at || r.created_at || Date.now()) }));
}

/** Klokkeslæt i dansk tid som HH.MM. */
export function kl(d) {
  const fmt = new Intl.DateTimeFormat('da-DK', { timeZone: 'Europe/Copenhagen', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.hour}.${p.minute}`;
}

export function smsTekst(skift, tid) {
  if (skift === 'oppe') return `et kreativt bureau: portal.etkreativt.dk svarer igen (kl. ${kl(tid)}).`;
  return `et kreativt bureau: portal.etkreativt.dk svarer ${skift === 'stadig' ? 'stadig ' : ''}ikke (siden kl. ${kl(tid)}). Tjek Railway.`;
}

/** Nummeret som GatewayAPI vil have det: kun cifre, uden + og 00, dansk landekode hvis den mangler. */
export function msisdn(raw) {
  let d = String(raw || '').replace(/\D/g, '').replace(/^00/, '');
  if (d.length === 8) d = '45' + d;
  return /^\d{10,15}$/.test(d) ? d : null;
}

/** Op til 3 forsøg med 5 sek. pause, hvert med 10 sek. i alt, så et enkelt hik hos GitHub eller GatewayAPI ikke sluger alarmen. */
async function medForsoeg(fn, vent) {
  for (let forsoeg = 1; ; forsoeg++) {
    try { return await fn(AbortSignal.timeout(10_000)); }
    catch (e) { if (forsoeg >= 3) throw e; await vent(5_000); }
  }
}

async function hentHistorik(env, hent, vent) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) throw new Error('GITHUB_TOKEN eller GITHUB_REPOSITORY mangler');
  const api = `${env.GITHUB_API_URL || 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}/actions`;
  const headers = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  return medForsoeg(async (signal) => {
    const json = async (url) => {
      const res = await hent(url, { headers, signal });
      if (!res.ok) throw new Error(`GitHub svarede ${res.status}`);
      return res.json();
    };
    // 15 kørsler: nok til "stadig nede" (12 nede + kørslen før) med plads til et par aflyste
    const runs = (await json(`${api}/workflows/${WORKFLOW}/runs?status=completed&per_page=15&exclude_pull_requests=true`)).workflow_runs || [];
    // En fejlet kørsel er kun nede, hvis tjekket selv fejlede; startede jobbet aldrig, er trinnet ikke kørt
    await Promise.all(runs.filter((r) => r.conclusion === 'failure').map(async (r) => {
      const { jobs = [] } = await json(`${api}/runs/${r.id}/jobs`);
      r.tjekFejlede = jobs.some((j) => (j.steps || []).some((s) => s.name === TJEK_TRIN && s.conclusion === 'failure'));
    }));
    return tilHistorik(runs, env.GITHUB_RUN_ID);
  }, vent);
}

async function sendSms(env, nummer, tekst, hent, vent) {
  if (!env.GATEWAYAPI_TOKEN || !nummer) throw new Error('GATEWAYAPI_TOKEN eller ALERT_PHONE mangler');
  await medForsoeg(async (signal) => {
    const res = await hent(SMS_URL, {
      method: 'POST',
      headers: { Authorization: `Token ${env.GATEWAYAPI_TOKEN}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ sender: 'ETKREATIVT', message: tekst, recipient: Number(nummer) }),
      signal,
    });
    if (!res.ok) throw new Error(`GatewayAPI svarede ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }, vent);
}

/** Én kørsel. Giver exit-koden: 1 når portalen er nede (så GitHub også sender mail), ellers 0. */
export async function koer({ env = process.env, hent = fetch, vent = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log } = {}) {
  const nummer = msisdn(env.ALERT_PHONE);
  if (nummer) log(`::add-mask::${nummer}`); // nummeret i GatewayAPI-format skjules også i loggen
  if (!env.GATEWAYAPI_TOKEN) log('::warning title=Overvågning::Secret GATEWAYAPI_TOKEN mangler (Settings > Secrets and variables > Actions). Der kan ikke sendes SMS.');
  if (!nummer) log('::warning title=Overvågning::Secret ALERT_PHONE mangler eller er ugyldig (Settings > Secrets and variables > Actions). Der kan ikke sendes SMS.');

  const svarer = async () => {
    try {
      const res = await hent(HEALTH_URL, { signal: AbortSignal.timeout(10_000) });
      res.body?.cancel?.().catch(() => {}); // svaret skal ikke læses, kun status
      return res.ok;
    } catch { return false; }
  };

  let nede;
  if (env.SIMULER_NEDE === 'true') {
    log('::notice title=Overvågning::Test: portalen behandles som nede (simuler_nede).');
    nede = true;
  } else {
    nede = !(await svarer());
    if (nede) { // genstart eller deploy: vent og prøv én gang til før kørslen tæller som nede
      log('Portalen svarede ikke. Prøver igen om 30 sek.');
      await vent(30_000);
      nede = !(await svarer());
    }
  }

  let historik = [];
  try { historik = await hentHistorik(env, hent, vent); }
  catch (e) { log(`::warning title=Overvågning::Kunne ikke hente de forrige kørsler efter 3 forsøg (${e.message}). Ingen SMS i denne kørsel.`); }

  const skift = beslut(nede, historik);
  const forrige = historik.slice(0, 3).map((h) => (h.nede ? 'nede' : 'oppe')).join(', ') || 'ingen';
  log(`Portalen er ${nede ? 'NEDE' : 'oppe'}. Forrige kørsler: ${forrige}. SMS: ${skift || 'nej'}.`);
  if (skift) {
    try {
      await sendSms(env, nummer, smsTekst(skift, skift === 'oppe' ? new Date() : siden(historik)), hent, vent);
      log(`SMS sendt (${skift}).`);
    } catch (e) { log(`::error title=Overvågning::SMS kunne ikke sendes: ${e.message}`); } // "stadig nede" efter en time er næste chance
  }
  if (nede) log('::error title=Overvågning::portal.etkreativt.dk svarer ikke. Kørslen markeres som fejlet.');
  return nede ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await koer();
