const CONFIG = Object.freeze({
  officialSource: 'https://kiroe.com.ua/electricity-blackout',
  syncFile: 'data/official.json',
  fallbackFile: 'data/fallback.json',
  refreshEveryMs: 60_000,
  savedKey: 'svitlo-kiroe-addresses-v3',
  activeKey: 'svitlo-kiroe-active-address-v3'
});

const state = {
  official: null,
  fallback: null,
  addresses: [],
  selected: null,
  day: 'today',
  timer: null,
  syncing: false
};

const el = (id) => document.getElementById(id);

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replaceAll('’', "'")
    .replaceAll('`', "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'uk'));
}

async function getJson(url) {
  const response = await fetch(`${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function mergeOfficialWithFallback(official, fallback) {
  const result = {
    settlements: [],
    addresses: [],
    queueSchedules: {},
    notices: [],
    updatedAt: official?.fetchedAt ?? null,
    source: official?.source ?? CONFIG.officialSource,
    ready: Boolean(official?.ready)
  };

  if (Array.isArray(fallback?.streets)) {
    for (const item of fallback.streets) {
      result.addresses.push({
        otg: item.districtId,
        otgName: fallback.districts?.find(d => d.id === item.districtId)?.name ?? '',
        settlement: item.settlement,
        street: item.street,
        house: '',
        queueId: null,
        subQueue: '',
        buildingNote: item.buildingNote ?? '',
        isFallback: true
      });
    }
  }

  if (Array.isArray(official?.addresses)) {
    result.addresses = official.addresses.map(a => ({
      otg: a.otg ?? a.otgId ?? a.districtId ?? '',
      otgName: a.otgName ?? a.districtName ?? a.otg ?? '',
      settlement: a.settlement ?? a.city ?? a.locality ?? '',
      street: a.street ?? a.streetName ?? '',
      house: a.house ?? a.building ?? a.number ?? '',
      queueId: Number(a.queueId ?? a.queue ?? String(a.subQueue ?? '').split('.')[0]) || null,
      subQueue: a.subQueue ?? a.queueNumber ?? a.queue ?? '',
      buildingNote: a.buildingNote ?? '',
      isFallback: false
    })).filter(a => a.settlement || a.street);
  }

  const explicitSettlements = official?.settlements ?? official?.locations ?? [];
  if (Array.isArray(explicitSettlements)) {
    for (const s of explicitSettlements) {
      result.addresses.push({ settlement: s.name ?? s.settlement ?? s.label ?? '', street: '', house: '', queueId: null, subQueue: '' });
    }
  }

  result.addresses = dedupeAddresses(result.addresses);
  result.settlements = uniqueSorted(result.addresses.map(a => a.settlement));
  result.queueSchedules = official?.queueSchedules ?? official?.schedules ?? {};
  result.notices = Array.isArray(official?.notices) ? official.notices : [];
  return result;
}

function dedupeAddresses(list) {
  const seen = new Set();
  const out = [];
  for (const a of list) {
    const key = [normalizeText(a.settlement), normalizeText(a.street), normalizeText(a.house)].join('|');
    if (!key.replaceAll('|', '')) continue;
    if (!seen.has(key)) { seen.add(key); out.push(a); }
  }
  return out;
}

function currentDateKey(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function officialScheduleFor(subQueue, offset) {
  const schedules = state.merged?.queueSchedules ?? {};
  const queueId = state.selected?.queueId ? String(state.selected.queueId) : String(subQueue || '').split('.')[0];
  const item = schedules[subQueue] ?? schedules[String(subQueue)] ?? schedules[queueId] ?? null;
  if (!item) return null;
  if (Array.isArray(item)) return item;
  const dateKey = currentDateKey(offset);
  return item[dateKey] ?? item[offset === 1 ? 'tomorrow' : 'today'] ?? item.hours ?? item;
}

function unknownSchedule() {
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    status: 'unknown',
    label: `${String(hour).padStart(2,'0')}:00 – ${String((hour + 1) % 24).padStart(2,'0')}:00`
  }));
}

function normalizeHours(raw) {
  if (!raw) return null;
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw.hours) ? raw.hours : null;
  if (!arr) return null;
  const hours = arr.map((x, i) => {
    if (typeof x === 'string') {
      const status = /off|no|вимк|відсут/i.test(x) ? 'no' : /unknown|none|інф/i.test(x) ? 'unknown' : 'yes';
      return { hour: i, status, label: `${String(i).padStart(2,'0')}:00 – ${String((i+1)%24).padStart(2,'0')}:00` };
    }
    const hour = Number(x.hour ?? x.h ?? i);
    let status = String(x.status ?? x.state ?? '').toLowerCase();
    if (!['yes', 'no', 'unknown', 'maybe'].includes(status)) {
      if (/off|no|вимк|відсут/i.test(String(x.status ?? x.state ?? x.label ?? x.text ?? ''))) status = 'no';
      else if (/unknown|none|інф/i.test(String(x.status ?? x.state ?? x.label ?? x.text ?? ''))) status = 'unknown';
      else status = 'yes';
    }
    return { hour, status: status === 'maybe' ? 'unknown' : status, label: x.label ?? `${String(hour).padStart(2,'0')}:00 – ${String((hour+1)%24).padStart(2,'0')}:00` };
  }).filter(x => Number.isInteger(x.hour));
  return hours.length === 24 ? hours.sort((a,b) => a.hour-b.hour) : null;
}

function fillSettlementOptions() {
  const input = el('settlementInput');
  const list = el('settlementOptions');
  const needle = normalizeText(input.value);
  list.replaceChildren();
  for (const value of state.merged.settlements.filter(s => !needle || normalizeText(s).includes(needle)).slice(0, 80)) {
    const o = document.createElement('option'); o.value = value; list.appendChild(o);
  }
  el('addressCount').textContent = `${state.merged.settlements.length.toLocaleString('uk-UA')} населених пунктів`;
}

function fillStreetOptions() {
  const settlement = normalizeText(el('settlementInput').value);
  const streets = uniqueSorted(state.merged.addresses.filter(a => normalizeText(a.settlement) === settlement).map(a => a.street));
  const input = el('streetInput');
  const list = el('streetOptions');
  const needle = normalizeText(input.value);
  list.replaceChildren();
  for (const value of streets.filter(s => !needle || normalizeText(s).includes(needle)).slice(0, 100)) {
    const o = document.createElement('option'); o.value = value; list.appendChild(o);
  }
}

function fillHouseOptions() {
  const settlement = normalizeText(el('settlementInput').value);
  const street = normalizeText(el('streetInput').value);
  const houses = uniqueSorted(state.merged.addresses.filter(a => normalizeText(a.settlement) === settlement && normalizeText(a.street) === street).map(a => a.house));
  const input = el('houseInput');
  const list = el('houseOptions');
  const needle = normalizeText(input.value);
  list.replaceChildren();
  for (const value of houses.filter(Boolean).filter(h => !needle || normalizeText(h).includes(needle)).slice(0, 120)) {
    const o = document.createElement('option'); o.value = value; list.appendChild(o);
  }
}

function resetDependent(level) {
  if (level <= 1) { el('streetInput').value = ''; el('houseInput').value = ''; }
  if (level <= 2) { el('houseInput').value = ''; }
  const hasSettlement = Boolean(el('settlementInput').value.trim());
  const hasStreet = Boolean(el('streetInput').value.trim());
  el('streetInput').disabled = !hasSettlement;
  el('streetInput').placeholder = hasSettlement ? 'Введіть або оберіть вулицю…' : 'Спочатку оберіть населений пункт…';
  el('houseInput').disabled = !hasStreet;
}

function findAddressMatch() {
  const settlement = normalizeText(el('settlementInput').value);
  const street = normalizeText(el('streetInput').value);
  const house = normalizeText(el('houseInput').value);
  const exact = state.merged.addresses.find(a => normalizeText(a.settlement) === settlement && normalizeText(a.street) === street && (!house || normalizeText(a.house) === house));
  if (exact) return exact;
  const streetMatch = state.merged.addresses.find(a => normalizeText(a.settlement) === settlement && normalizeText(a.street) === street);
  return streetMatch ?? null;
}

function saveCurrentAddress() {
  if (!state.selected) return;
  const item = {
    settlement: el('settlementInput').value.trim(),
    street: el('streetInput').value.trim(),
    house: el('houseInput').value.trim(),
    subQueue: state.selected.subQueue ?? '',
    queueId: state.selected.queueId ?? null
  };
  const saved = loadSaved().filter(x => JSON.stringify(x) !== JSON.stringify(item));
  saved.unshift(item);
  localStorage.setItem(CONFIG.savedKey, JSON.stringify(saved.slice(0, 8)));
  renderSaved();
}

function loadSaved() {
  try { return JSON.parse(localStorage.getItem(CONFIG.savedKey) || '[]'); } catch { return []; }
}

function renderSaved() {
  const wrap = el('savedWrap');
  const list = el('savedList');
  const saved = loadSaved();
  wrap.hidden = saved.length === 0;
  list.replaceChildren();
  saved.forEach((item, index) => {
    const node = document.createElement('div');
    node.className = 'saved-item';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `${item.settlement}, ${item.street}${item.house ? `, ${item.house}` : ''}${item.subQueue ? ` · ${item.subQueue}` : ''}`;
    button.addEventListener('click', () => applySaved(item));
    const del = document.createElement('button'); del.type='button'; del.textContent='×'; del.title='Видалити'; del.addEventListener('click', e => { e.stopPropagation(); const next = loadSaved(); next.splice(index,1); localStorage.setItem(CONFIG.savedKey, JSON.stringify(next)); renderSaved(); });
    node.append(button, del); list.append(node);
  });
}

function applySaved(item) {
  el('settlementInput').value = item.settlement || '';
  resetDependent(1); fillStreetOptions();
  el('streetInput').value = item.street || '';
  resetDependent(2); fillHouseOptions();
  el('houseInput').value = item.house || '';
  checkAddress();
}

function setFormMessage(message, error = false) { el('formMessage').textContent = message; el('formMessage').classList.toggle('error', error); }

function stateForHour(hours) {
  const now = new Date();
  const h = now.getHours();
  return hours.find(x => x.hour === h)?.status ?? 'unknown';
}

function renderStatus(hours) {
  const hero = el('statusHero');
  hero.classList.remove('is-on','is-off','is-unknown');
  const status = stateForHour(hours);
  const subQueue = state.selected?.subQueue || '—';
  if (status === 'yes') { hero.classList.add('is-on'); el('statusIcon').textContent='⚡'; el('statusLabel').textContent='Світло є'; el('statusSub').textContent='За синхронізованим графіком для цієї адреси електроенергія має подаватися.'; }
  else if (status === 'no') { hero.classList.add('is-off'); el('statusIcon').textContent='⏻'; el('statusLabel').textContent='Відключення за графіком'; el('statusSub').textContent='Поточна година позначена як період відключення.'; }
  else { hero.classList.add('is-unknown'); el('statusIcon').textContent='?'; el('statusLabel').textContent='Немає підтвердженої інформації'; el('statusSub').textContent='Перевірте офіційний сайт: аварійні ситуації можуть з’являтися окремо від ГПВ.'; }
  el('queueChip').textContent = subQueue ? `Черга ${subQueue}` : 'Черга —';
}

function renderSchedule() {
  const offset = state.day === 'tomorrow' ? 1 : 0;
  const subQueue = state.selected?.subQueue;
  el('todayBtn').classList.toggle('is-active', state.day === 'today');
  el('tomorrowBtn').classList.toggle('is-active', state.day === 'tomorrow');

  if (!state.selected || !subQueue) {
    el('scheduleGrid').replaceChildren();
    el('scheduleGrid').hidden = true;
    el('scheduleEmpty').hidden = false;
    el('scheduleTitle').textContent = 'Графік';
    return;
  }

  const sourceHours = normalizeHours(officialScheduleFor(subQueue, offset));
  const hours = sourceHours ?? unknownSchedule();
  const usingFallbackSchedule = !sourceHours;
  el('scheduleGrid').hidden = false;
  el('scheduleEmpty').hidden = true;
  el('scheduleTitle').textContent = state.day === 'tomorrow' ? `Завтра · черга ${subQueue}` : `Сьогодні · черга ${subQueue}`;
  const currentHour = new Date().getHours();
  const grid = el('scheduleGrid'); grid.replaceChildren();
  hours.forEach(item => {
    const card = document.createElement('article');
    card.className = `hour-card ${item.status === 'yes' ? 'on' : item.status === 'no' ? 'off' : 'unknown'}`;
    if (state.day === 'today' && item.hour === currentHour) card.classList.add('current');
    const time = document.createElement('div'); time.className = 'hour-card__time'; time.innerHTML = `<span>${item.label}</span><span>${item.status === 'yes' ? '●' : item.status === 'no' ? '■' : '•'}</span>`;
    const label = document.createElement('div'); label.className='hour-card__state'; label.textContent = item.status === 'yes' ? 'Світло є' : item.status === 'no' ? 'Відключення' : 'Немає інформації';
    card.append(time, label); grid.append(card);
  });
  if (usingFallbackSchedule) {
    setFormMessage('Для цієї черги ще немає підтвердженого погодинного графіка у синхронізованому знімку. Усі години позначені як «немає інформації».', true);
  }
  if (state.day === 'today') renderStatus(hours);
}

function renderSourceMeta() {
  const official = state.official;
  const ready = Boolean(official?.ready && Array.isArray(official?.addresses));
  el('sourceStatus').textContent = ready ? 'Синхронізовано' : 'Очікує першої синхронізації';
  el('sourceStatus').style.color = ready ? '#8be4b7' : '#ddca6f';
  const stamp = official?.fetchedAt ? new Date(official.fetchedAt).toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'medium' }) : '—';
  el('lastSync').textContent = stamp;
  el('syncNote').textContent = ready ? `У пам’яті сайту використовуються ${official.addresses.length.toLocaleString('uk-UA')} адресних записів з останньої синхронізації.` : 'До першої успішної синхронізації сайт використовує вбудований резервний набір адрес із попередньої версії проєкту.';
  el('freshnessText').textContent = ready ? `Знімок офіційного джерела: ${stamp}. Сторінка перевіряє нову версію щохвилини.` : 'Показано резервний набір до першого успішного оновлення офіційного знімка.';
}

async function syncData(showToast = false) {
  if (state.syncing) return;
  state.syncing = true;
  try {
    const [official, fallback] = await Promise.all([getJson(CONFIG.syncFile), getJson(CONFIG.fallbackFile)]);
    state.official = official;
    state.fallback = fallback;
    state.merged = mergeOfficialWithFallback(official, fallback);
    fillSettlementOptions();
    renderSourceMeta();
    if (showToast) showToastMessage(state.merged.ready ? 'Дані оновлено.' : 'Сайт перевірив доступний знімок.');
    if (state.selected) renderSchedule();
  } catch (error) {
    console.error(error);
    if (showToast) showToastMessage('Не вдалося оновити знімок. Залишаємо поточні дані.');
    if (!state.merged && state.fallback) state.merged = mergeOfficialWithFallback(null, state.fallback);
  } finally { state.syncing = false; }
}

function checkAddress() {
  setFormMessage('');
  const match = findAddressMatch();
  const settlement = el('settlementInput').value.trim();
  const street = el('streetInput').value.trim();
  const house = el('houseInput').value.trim();
  if (!settlement || !street) { setFormMessage('Заповніть населений пункт і вулицю.', true); return; }
  if (!match) { setFormMessage('Адресу не знайдено у синхронізованому наборі. Звірте написання на офіційному сайті.', true); return; }
  state.selected = match;
  if (match.isFallback) {
    setFormMessage('Адресу знайдено лише у резервному наборі попередньої версії. Офіційна черга буде показана після успішної синхронізації.', true);
  }
  localStorage.setItem(CONFIG.activeKey, JSON.stringify({ settlement, street, house, subQueue: match.subQueue ?? '', queueId: match.queueId ?? null }));
  const label = [settlement, street, house].filter(Boolean).join(', ');
  setFormMessage(`${label} · ${match.subQueue ? `черга ${match.subQueue}` : 'чергу не визначено'}`);
  renderSchedule();
  saveCurrentAddress();
  document.querySelector('.schedule-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function loadLastAddress() {
  let item = null;
  try { item = JSON.parse(localStorage.getItem(CONFIG.activeKey) || 'null'); } catch {}
  if (!item) return;
  applySaved(item);
}

function showToastMessage(message) { const node = el('toast'); node.textContent = message; node.classList.add('show'); clearTimeout(state.timer); state.timer = setTimeout(() => node.classList.remove('show'), 2200); }

function updateClock() {
  el('clock').textContent = new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date());
}

function bindEvents() {
  el('settlementInput').addEventListener('input', () => { resetDependent(1); fillSettlementOptions(); fillStreetOptions(); });
  el('streetInput').addEventListener('input', () => { resetDependent(2); fillHouseOptions(); });
  el('houseInput').addEventListener('input', fillHouseOptions);
  el('checkBtn').addEventListener('click', checkAddress);
  [el('settlementInput'), el('streetInput'), el('houseInput')].forEach(node => node.addEventListener('keydown', e => { if (e.key === 'Enter') checkAddress(); }));
  el('todayBtn').addEventListener('click', () => { state.day = 'today'; renderSchedule(); });
  el('tomorrowBtn').addEventListener('click', () => { state.day = 'tomorrow'; renderSchedule(); });
  el('refreshBtn').addEventListener('click', () => syncData(true));
  el('clearSavedBtn').addEventListener('click', () => { localStorage.removeItem(CONFIG.savedKey); renderSaved(); showToastMessage('Збережені адреси очищено.'); });
}

(async function init() {
  bindEvents();
  renderSaved();
  updateClock();
  setInterval(updateClock, 1000);
  await syncData(false);
  fillSettlementOptions();
  loadLastAddress();
  setInterval(() => syncData(false), CONFIG.refreshEveryMs);
  renderSchedule();
})();
