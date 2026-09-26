import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'official.json');
const SOURCE = 'https://kiroe.com.ua/electricity-blackout';

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const normalizeKey = (v) => clean(v).toLowerCase().replaceAll('’', "'");

function looksLikeAddressObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj).map(normalizeKey);
  const hasStreet = keys.some(k => /street|улиц|вулиц|streetname/.test(k));
  const hasHouse = keys.some(k => /house|building|будин|номер/.test(k));
  const hasSettlement = keys.some(k => /settlement|locality|city|населен|міст|селищ|село/.test(k));
  const hasQueue = keys.some(k => /queue|черг|підчерг|subqueue/.test(k));
  return (hasStreet && hasSettlement) || (hasStreet && hasHouse) || (hasSettlement && hasQueue);
}

function flattenObjects(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) flattenObjects(item, out);
  } else if (value && typeof value === 'object') {
    if (looksLikeAddressObject(value)) out.push(value);
    for (const child of Object.values(value)) flattenObjects(child, out);
  }
  return out;
}

function mapAddress(obj) {
  const pick = (...patterns) => {
    const entry = Object.entries(obj).find(([k]) => patterns.some(p => p.test(normalizeKey(k))));
    return entry ? entry[1] : '';
  };
  const subQueue = clean(pick(/subqueue/, /підчерг/ , /queue_number/, /queueid/, /queue/));
  const queueId = Number(clean(pick(/queueid/, /queue/))) || Number(String(subQueue).split('.')[0]) || null;
  return {
    otg: clean(pick(/otgid/, /otg/)),
    otgName: clean(pick(/otgname/, /districtname/, /district/)),
    settlement: clean(pick(/settlement/, /locality/, /city/, /населен/, /міст/, /селищ/, /село/)),
    street: clean(pick(/streetname/, /street/, /вулиц/)),
    house: clean(pick(/house/, /building/, /будин/, /number/)),
    queueId,
    subQueue,
    sourceObject: obj
  };
}

function isUsefulAddress(a) {
  return Boolean(a.settlement || a.street) && Boolean(a.queueId || a.subQueue || a.house);
}

function deepFindSchedule(value, found = []) {
  if (Array.isArray(value)) {
    if (value.length >= 20 && value.length <= 30) {
      const text = JSON.stringify(value);
      if (/00:00|01:00|23:00|hour|час/i.test(text)) found.push(value);
    }
    for (const item of value) deepFindSchedule(item, found);
  } else if (value && typeof value === 'object') {
    const keys = Object.keys(value).map(normalizeKey);
    if (keys.some(k => /schedule|графік|blackout|outage|відключ/.test(k)) && keys.some(k => /hour|time|час/.test(k))) found.push(value);
    for (const child of Object.values(value)) deepFindSchedule(child, found);
  }
  return found;
}

function collectQueueSchedules(value, out = {}) {
  if (Array.isArray(value)) {
    for (const item of value) collectQueueSchedules(item, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;

  const keys = Object.keys(value);
  for (const key of keys) {
    if (/^[1-6]\.[12]$/.test(key)) {
      const candidate = value[key];
      const arr = Array.isArray(candidate) ? candidate : candidate?.hours;
      if (Array.isArray(arr) && arr.length >= 20) out[key] = arr.slice(0, 24);
    }
  }

  const queue = String(value.subQueue ?? value.queueNumber ?? value.queue ?? '').trim();
  if (queue && (/^[1-6]\.[12]$/.test(queue) || /^[1-6]$/.test(queue))) {
    const candidate = value.hours ?? value.schedule ?? value.times ?? value.data;
    const arr = Array.isArray(candidate) ? candidate : candidate?.hours;
    if (Array.isArray(arr) && arr.length >= 20) out[queue] = arr.slice(0, 24);
  }

  for (const child of Object.values(value)) collectQueueSchedules(child, out);
  return out;
}

async function main() {
  const previous = JSON.parse(await fs.readFile(OUT, 'utf8').catch(() => '{"ready":false}'));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: 'uk-UA' });
  const network = [];

  page.on('response', async (response) => {
    try {
      const url = response.url();
      if (!url.includes('kiroe.com.ua')) return;
      const headers = response.headers();
      const contentType = headers['content-type'] || '';
      if (!/json|javascript|html|text\//i.test(contentType)) return;
      const body = await response.text();
      network.push({ url, status: response.status(), contentType, body: body.slice(0, 2_000_000) });
    } catch { /* response may disappear */ }
  });

  await page.goto(SOURCE, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(3000);

  const pageInfo = await page.evaluate(() => ({
    title: document.title,
    forms: [...document.querySelectorAll('form')].map(f => ({ action: f.action, method: f.method })),
    selects: [...document.querySelectorAll('select')].map((s, index) => ({ index, name: s.name, id: s.id, options: [...s.options].slice(0, 500).map(o => ({ value: o.value, text: o.textContent.trim() })) })),
    inputs: [...document.querySelectorAll('input')].map((i, index) => ({ index, name: i.name, id: i.id, type: i.type, placeholder: i.placeholder, list: i.getAttribute('list'), ariaControls: i.getAttribute('aria-controls'), attrs: [...i.attributes].reduce((a,x)=>(a[x.name]=x.value,a),{}) })).filter(x => x.type !== 'hidden'),
    text: document.body?.innerText?.slice(0, 80_000) || ''
  }));

  const addressObjects = [];
  const scheduleObjects = [];
  for (const item of network) {
    if (/json/i.test(item.contentType)) {
      try {
        const json = JSON.parse(item.body);
        addressObjects.push(...flattenObjects(json));
        scheduleObjects.push(...deepFindSchedule(json));
      } catch { /* not JSON */ }
    }
  }

  // Give dependent controls a chance to make their own network requests.
  const selects = page.locator('select');
  const selectCount = await selects.count();
  for (let i = 0; i < Math.min(selectCount, 3); i++) {
    const options = await selects.nth(i).locator('option').evaluateAll(os => os.map(o => ({ value: o.value, text: o.textContent.trim() })).filter(o => o.value));
    for (const opt of options.slice(0, 50)) {
      try {
        await selects.nth(i).selectOption(opt.value);
        await page.waitForTimeout(300);
      } catch { /* continue */ }
    }
  }

  const inputs = page.locator('input[type="text"], input:not([type])');
  const inputCount = await inputs.count();
  for (let i = 0; i < Math.min(inputCount, 4); i++) {
    const input = inputs.nth(i);
    for (const term of ['а', 'о', 'і', 'в']) {
      try {
        await input.fill(term);
        await page.waitForTimeout(350);
      } catch { /* continue */ }
    }
  }

  const allText = await page.locator('body').innerText().catch(() => pageInfo.text);
  const postExploreInfo = await page.evaluate(() => ({
    selects: [...document.querySelectorAll('select')].map((s, index) => ({ index, name: s.name, id: s.id, options: [...s.options].slice(0, 500).map(o => ({ value: o.value, text: o.textContent.trim() })) })),
    datalists: [...document.querySelectorAll('datalist')].map(d => ({ id: d.id, options: [...d.options].map(o => ({ value: o.value, label: o.label })) }))
  }));
  const mapped = addressObjects.map(mapAddress).filter(isUsefulAddress);
  const uniqueMap = new Map();
  for (const item of mapped) {
    const key = [normalizeKey(item.settlement), normalizeKey(item.street), normalizeKey(item.house)].join('|');
    if (!uniqueMap.has(key)) uniqueMap.set(key, item);
  }

  const addresses = [...uniqueMap.values()].map(({ sourceObject, ...a }) => a);
  const queueSchedules = {};
  for (const item of scheduleObjects) collectQueueSchedules(item, queueSchedules);
  for (const item of network) {
    if (!/json/i.test(item.contentType)) continue;
    try { collectQueueSchedules(JSON.parse(item.body), queueSchedules); } catch {}
  }
  const fetchedAt = new Date().toISOString();
  const result = {
    ready: addresses.length > 0,
    source: SOURCE,
    fetchedAt,
    addressCount: addresses.length,
    addresses,
    queueSchedules,
    // Keep lightweight discovery metadata so future parser tweaks can diagnose site changes.
    discovery: {
      pageTitle: pageInfo.title,
      forms: pageInfo.forms,
      selectSummary: postExploreInfo.selects.map(s => ({ index: s.index, name: s.name, id: s.id, optionCount: s.options.length, sample: s.options.slice(0, 20) })),
      datalists: postExploreInfo.datalists,
      inputSummary: pageInfo.inputs,
      capturedSameOriginResponses: network.length,
      scheduleCandidates: scheduleObjects.length,
      textDigest: allText.slice(0, 20000)
    }
  };

  // If the live site changes its internal API, never overwrite a previously valid snapshot with an empty file.
  const final = addresses.length > 0 ? result : {
    ...previous,
    ready: Boolean(previous.ready),
    source: SOURCE,
    fetchedAt: previous.fetchedAt ?? null,
    lastAttemptAt: fetchedAt,
    syncWarning: 'Сайт відповів, але автоматичний екстрактор не знайшов адресних записів. Попередній валідний знімок залишено без змін.',
    discovery: result.discovery
  };

  await fs.writeFile(OUT, JSON.stringify(final, null, 2), 'utf8');
  await browser.close();
  console.log(JSON.stringify({ ready: final.ready, addressCount: final.addressCount ?? 0, captured: network.length, output: OUT }, null, 2));
}

main().catch(async (error) => {
  console.error(error);
  const previous = JSON.parse(await fs.readFile(OUT, 'utf8').catch(() => '{"ready":false}'));
  previous.lastAttemptAt = new Date().toISOString();
  previous.syncWarning = `Помилка синхронізації: ${error.message}`;
  await fs.writeFile(OUT, JSON.stringify(previous, null, 2), 'utf8').catch(() => {});
  process.exitCode = 1;
});
