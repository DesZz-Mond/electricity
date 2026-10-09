(() => {
  'use strict';

  const STORAGE_KEY = 'svitlo-porych.addresses.v1';
  const ACTIVE_KEY = 'svitlo-porych.active-address.v1';
  const THEME_KEY = 'svitlo-porych.theme.v1';
  const QUEUES = Array.from({ length: 6 }, (_, i) => [1, 2].map((sub) => `${i + 1}.${sub}`)).flat();
  const SOURCE_URL = 'https://svitlo.live/kirovogradska-oblast';
  const state = {
    addresses: [],
    activeId: null,
    selectedDay: 'today',
    schedule: null,
    storageAvailable: true,
    editingId: null,
    toastTimeout: null,
  };

  const $ = (selector) => document.querySelector(selector);
  const dom = {
    addressList: $('#address-list'),
    addressCount: $('#address-count'),
    emptyAddresses: $('#empty-addresses'),
    addressForm: $('#address-form'),
    showAddressForm: $('#show-address-form'),
    emptyAddButton: $('#empty-add-button'),
    cancelAddressForm: $('#cancel-address-form'),
    formError: $('#form-error'),
    scheduleTitle: $('#schedule-title'),
    scheduleAddress: $('#schedule-address'),
    currentStatus: $('#current-status'),
    currentTime: $('#current-time'),
    dateLabel: $('#schedule-date'),
    timeline: $('#timeline'),
    timelineCaption: $('#timeline-caption'),
    dataMessage: $('#data-message'),
    lastUpdated: $('#last-updated'),
    removeAddress: $('#remove-address'),
    editAddress: $('#edit-address'),
    formSubmit: $('#address-form-submit'),
    refreshData: $('#refresh-data'),
    toast: $('#toast'),
    queue: $('#queue'),
    themeToggle: $('#theme-toggle'),
    tabToday: $('#tab-today'),
    tabTomorrow: $('#tab-tomorrow'),
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
  }

  function safeStorageGet(key) {
    try { return window.localStorage.getItem(key); }
    catch (error) { state.storageAvailable = false; return null; }
  }

  function safeStorageSet(key, value) {
    try { window.localStorage.setItem(key, value); return true; }
    catch (error) { state.storageAvailable = false; return false; }
  }

  function safeStorageRemove(key) {
    try { window.localStorage.removeItem(key); }
    catch (error) { state.storageAvailable = false; }
  }

  function dateInKyiv(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(date).reduce((result, part) => {
      if (part.type !== 'literal') result[part.type] = part.value;
      return result;
    }, {});
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function prettyDate(dateString) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateString || ''))) return 'Дата невідома';
    const [year, month, day] = dateString.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day, 12));
    return new Intl.DateTimeFormat('uk-UA', {
      timeZone: 'Europe/Kyiv', weekday: 'short', day: 'numeric', month: 'long',
    }).format(date).replace('.', '');
  }

  function todayAndTomorrow() {
    const today = dateInKyiv();
    const noon = new Date(`${today}T12:00:00+03:00`);
    noon.setUTCDate(noon.getUTCDate() + 1);
    return { today, tomorrow: dateInKyiv(noon) };
  }

  function localTime() {
    return new Intl.DateTimeFormat('uk-UA', {
      timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date());
  }

  function safeQueue(value) {
    return QUEUES.includes(value) ? value : '';
  }

  function loadAddresses() {
    const raw = safeStorageGet(STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      state.addresses = parsed.filter((item) => item && typeof item.id === 'string' && typeof item.settlement === 'string' && typeof item.street === 'string' && typeof item.house === 'string' && safeQueue(item.queue));
    } catch (error) {
      state.addresses = [];
      showToast('Не вдалося прочитати збережені адреси. Додайте їх ще раз.');
    }
    state.activeId = safeStorageGet(ACTIVE_KEY);
    if (!state.addresses.some((item) => item.id === state.activeId)) state.activeId = state.addresses[0]?.id || null;
  }

  function saveAddresses() {
    const ok = safeStorageSet(STORAGE_KEY, JSON.stringify(state.addresses));
    if (state.activeId) safeStorageSet(ACTIVE_KEY, state.activeId);
    else safeStorageRemove(ACTIVE_KEY);
    if (!ok) showToast('Браузер не дозволив зберегти дані. Перевірте налаштування приватності.');
  }

  function activeAddress() {
    return state.addresses.find((address) => address.id === state.activeId) || null;
  }

  function addressTitle(address) {
    return address.label?.trim() || `${address.street}, ${address.house}`;
  }

  function fullAddress(address) {
    return `${address.settlement}, ${address.street}, ${address.house}`;
  }

  function getQueueIcon(label) {
    const lower = String(label || '').toLowerCase();
    if (lower.includes('робот')) return 'work';
    if (lower.includes('дач')) return 'garden';
    return 'home';
  }

  function addressIcon(type) {
    if (type === 'work') return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V4h8v3M3 12h18M10 12v2h4v-2"/></svg>';
    if (type === 'garden') return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21v-9m0 0c-5 0-8-3-8-8 5 0 8 3 8 8Zm0-2c0-5 3-8 8-8 0 5-3 8-8 8Z"/></svg>';
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-7h6v7"/></svg>';
  }

  function renderAddressList() {
    dom.addressCount.textContent = String(state.addresses.length);
    dom.emptyAddresses.hidden = state.addresses.length > 0;
    dom.addressList.innerHTML = state.addresses.map((address) => `
      <button class="address-card${address.id === state.activeId ? ' is-active' : ''}" type="button" data-address-id="${escapeHtml(address.id)}" aria-pressed="${address.id === state.activeId}">
        <span class="address-symbol">${addressIcon(getQueueIcon(address.label))}</span>
        <span class="address-details"><strong>${escapeHtml(addressTitle(address))}</strong><span>${escapeHtml(address.settlement)} · ${escapeHtml(address.street)}, ${escapeHtml(address.house)}</span></span>
        <span class="queue-chip">${escapeHtml(address.queue)}</span>
      </button>
    `).join('');
    dom.removeAddress.hidden = !activeAddress();
    dom.editAddress.hidden = !activeAddress();
    dom.addressList.querySelectorAll('[data-address-id]').forEach((button) => {
      button.addEventListener('click', () => {
        state.activeId = button.dataset.addressId;
        safeStorageSet(ACTIVE_KEY, state.activeId);
        renderAddressList();
        renderSchedule();
      });
    });
  }

  function openAddressForm(address = null) {
    state.editingId = address?.id || null;
    dom.addressForm.hidden = false;
    dom.emptyAddresses.hidden = true;
    dom.formError.hidden = true;
    $('#address-label').value = address?.label || '';
    $('#settlement').value = address?.settlement || '';
    $('#street').value = address?.street || '';
    $('#house').value = address?.house || '';
    dom.queue.value = address?.queue || '';
    dom.addressForm.querySelector('.form-heading h3').textContent = address ? 'Змініть адресу' : 'Збережіть адресу';
    dom.formSubmit.innerHTML = address ? 'Зберегти зміни <span aria-hidden="true">→</span>' : 'Зберегти адресу <span aria-hidden="true">→</span>';
    $('#address-label').focus();
  }

  function closeAddressForm() {
    state.editingId = null;
    dom.addressForm.hidden = true;
    dom.formError.hidden = true;
    dom.addressForm.reset();
    dom.addressForm.querySelector('.form-heading h3').textContent = 'Збережіть адресу';
    dom.formSubmit.innerHTML = 'Зберегти адресу <span aria-hidden="true">→</span>';
    dom.emptyAddresses.hidden = state.addresses.length > 0;
  }

  function showFormError(message) {
    dom.formError.textContent = message;
    dom.formError.hidden = false;
  }

  function showToast(message) {
    if (!dom.toast) return;
    dom.toast.textContent = message;
    dom.toast.classList.add('is-visible');
    window.clearTimeout(state.toastTimeout);
    state.toastTimeout = window.setTimeout(() => dom.toast.classList.remove('is-visible'), 2800);
  }

  function normalizeStatus(value) {
    if (['on', 'off', 'possible', 'unknown'].includes(value)) return value;
    if (value === '●' || value === 'light' || value === 'powered') return 'on';
    if (value === '✕' || value === '×' || value === 'off') return 'off';
    if (value === '±') return 'possible';
    return 'unknown';
  }

  function currentHourIndex() {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
    return Number.isFinite(hour) && hour >= 0 && hour <= 23 ? hour : 0;
  }

  function statusText(status) {
    return ({
      on: ['Світло є', 'За даними джерела електропостачання позначене як наявне.'],
      off: ['Світла немає за графіком', 'За даними джерела цей інтервал позначений як відключення.'],
      possible: ['Можливе відключення', 'Джерело вказує на можливе, а не гарантоване відключення.'],
      unknown: ['Немає підтверджених даних', 'Джерело не вказало стан електропостачання на цю годину.'],
    })[status] || ['Немає підтверджених даних', 'Стан електропостачання не вказано.'];
  }

  function dayData(day) {
    return state.schedule?.days?.[day] || null;
  }

  function hasUsableHours(hours) {
    return Array.isArray(hours) && hours.some((value) => normalizeStatus(value) !== 'unknown');
  }

  function nextKnownChange(hours, index) {
    const current = normalizeStatus(hours[index]);
    if (current === 'unknown') return null;
    for (let offset = 1; offset <= 24; offset += 1) {
      const nextIndex = (index + offset) % 24;
      const next = normalizeStatus(hours[nextIndex]);
      if (next !== 'unknown' && next !== current) {
        const clockHour = nextIndex.toString().padStart(2, '0');
        return `${clockHour}:00`;
      }
    }
    return null;
  }

  function isDayStale(dayRecord, selectedDay) {
    if (!dayRecord?.date) return true;
    const target = todayAndTomorrow()[selectedDay];
    if (!target) return false;
    // A cached/stale source page must not be presented as today's live schedule.
    return dayRecord.date !== target;
  }

  function setCurrentStatus(status, headline, detail) {
    dom.currentStatus.className = `current-status current-status-${status}`;
    const copy = dom.currentStatus.querySelector('.current-status-copy');
    copy.innerHTML = `<strong>${escapeHtml(headline)}</strong><span>${escapeHtml(detail)}</span>`;
  }

  function renderTimeline(hours, stale) {
    const values = Array.isArray(hours) && hours.length === 24 ? hours.map(normalizeStatus) : Array(24).fill('unknown');
    const nowIndex = state.selectedDay === 'today' ? currentHourIndex() : -1;
    dom.timeline.innerHTML = values.map((status, hour) => {
      const names = { on: 'Світло є', off: 'Світла немає', possible: 'Можливе відключення', unknown: 'Немає даних' };
      const isCurrent = hour === nowIndex;
      const title = `${hour.toString().padStart(2, '0')}:00–${(hour + 1).toString().padStart(2, '0')}:00 · ${names[status]}${stale ? ' · дата джерела застаріла' : ''}`;
      const icon = ({ on: '●', off: '×', possible: '±', unknown: '–' })[status];
      return `<div class="hour-cell is-${status}${isCurrent ? ' is-current' : ''}" tabindex="0" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"><b>${hour.toString().padStart(2, '0')}</b><span>${icon}</span></div>`;
    }).join('');
  }

  function setDataMessage(message, warning = false) {
    dom.dataMessage.classList.toggle('is-warning', warning);
    dom.dataMessage.innerHTML = `<span class="data-message-icon">${warning ? '!' : 'i'}</span><p>${escapeHtml(message)}</p>`;
  }

  function renderSchedule() {
    const address = activeAddress();
    const day = dayData(state.selectedDay);
    const { today, tomorrow } = todayAndTomorrow();
    const expectedDate = state.selectedDay === 'today' ? today : tomorrow;
    const queueHours = address && day?.queues ? day.queues[address.queue] : null;
    const isStale = isDayStale(day, state.selectedDay);
    const usable = hasUsableHours(queueHours) && !isStale;

    dom.currentTime.innerHTML = `${localTime()}<small>за Києвом</small>`;
    dom.tabToday.classList.toggle('is-active', state.selectedDay === 'today');
    dom.tabTomorrow.classList.toggle('is-active', state.selectedDay === 'tomorrow');
    dom.tabToday.setAttribute('aria-selected', String(state.selectedDay === 'today'));
    dom.tabTomorrow.setAttribute('aria-selected', String(state.selectedDay === 'tomorrow'));
    dom.dateLabel.textContent = prettyDate(day?.date || expectedDate);

    if (!address) {
      dom.scheduleTitle.textContent = 'Ваш графік';
      dom.scheduleAddress.textContent = 'Оберіть або додайте адресу, щоб побачити графік.';
      setCurrentStatus('neutral', 'Очікуємо адресу', 'Ваш персональний графік з’явиться тут.');
      renderTimeline(null, false);
      setDataMessage('Щоб побачити графік, спершу додайте адресу та вкажіть її підчергу.');
      dom.lastUpdated.textContent = 'Перевірка джерела запускається приблизно кожні 10 хв';
      dom.removeAddress.hidden = true;
      return;
    }

    dom.scheduleTitle.textContent = addressTitle(address);
    dom.scheduleAddress.textContent = `${fullAddress(address)} · підчерга ${address.queue}`;
    dom.removeAddress.hidden = false;
    renderTimeline(queueHours, isStale);

    if (!day || !day.queues || !Array.isArray(queueHours)) {
      setCurrentStatus('neutral', 'Графік недоступний', 'Не вдалося завантажити дані джерела.');
      setDataMessage('Немає даних графіка для цієї підчерги. Перевірте джерело або спробуйте пізніше.', true);
    } else if (isStale) {
      setCurrentStatus('neutral', 'Дані застаріли', `Джерело містить дату ${prettyDate(day.date)} замість очікуваної дати. Не використовуйте цей графік як актуальний.`);
      setDataMessage('Автоматичне оновлення ще не принесло свіжий графік. Поки дата джерела не збігається з поточним днем, години відображаються лише як довідка. Перевірте офіційний сайт.', true);
    } else if (!hasUsableHours(queueHours)) {
      setCurrentStatus('neutral', 'Немає підтверджених даних', 'Для цієї підчерги джерело не опублікувало стан по годинах.');
      setDataMessage('Це не означає, що світло точно буде або зникне. На цей день джерело не містить погодинних даних для вибраної підчерги.', true);
    } else {
      const nowIndex = state.selectedDay === 'today' ? currentHourIndex() : 0;
      const currentStatus = normalizeStatus(queueHours[nowIndex]);
      const [headline, detail] = statusText(currentStatus);
      const nextChange = nextKnownChange(queueHours, nowIndex);
      const extra = nextChange ? ` Наступна зміна за даними графіка — близько ${nextChange}.` : '';
      setCurrentStatus(currentStatus === 'unknown' ? 'neutral' : currentStatus, state.selectedDay === 'today' ? headline : `Початок дня: ${headline.toLowerCase()}`, detail + extra);
      const unavailableCount = queueHours.map(normalizeStatus).filter((item) => item === 'off').length;
      const possibleCount = queueHours.map(normalizeStatus).filter((item) => item === 'possible').length;
      setDataMessage(`На графіку позначено ${unavailableCount} год. без світла та ${possibleCount} год. з можливим відключенням. Це довідкові дані — фактичний стан може відрізнятися.`);
    }
    if (state.schedule?.updatedAt) {
      const updated = new Date(state.schedule.updatedAt);
      if (!Number.isNaN(updated.getTime())) dom.lastUpdated.textContent = `Дані змінювалися: ${new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(updated)}`;
      else dom.lastUpdated.textContent = 'Автоперевірка запускається приблизно кожні 10 хв';
    } else {
      dom.lastUpdated.textContent = 'Автоперевірка запускається приблизно кожні 10 хв';
    }
  }

  async function loadSchedule({ bypassCache = false } = {}) {
    dom.refreshData.disabled = true;
    dom.refreshData.style.opacity = '.6';
    try {
      const url = `data/schedule.json${bypassCache ? `?refresh=${Date.now()}` : ''}`;
      const response = await fetch(url, { cache: bypassCache ? 'no-store' : 'default' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!data || data.schemaVersion !== 1 || !data.days || !data.days.today || !data.days.tomorrow) {
        throw new Error('Unexpected schedule format');
      }
      state.schedule = data;
      renderSchedule();
      if (bypassCache) showToast('Дані на сторінці перечитано. Джерело синхронізується окремо.');
    } catch (error) {
      state.schedule = null;
      renderSchedule();
      setCurrentStatus('neutral', 'Не вдалося завантажити графік', 'Перевірте з’єднання та спробуйте ще раз.');
      setDataMessage('Файл з даними недоступний. Якщо ви щойно опублікували сайт, перевірте, що папка data/schedule.json додана до репозиторію.', true);
      if (bypassCache) showToast('Не вдалося перечитати файл графіка.');
    } finally {
      dom.refreshData.disabled = false;
      dom.refreshData.style.opacity = '';
    }
  }

  function populateQueueOptions() {
    dom.queue.innerHTML = '<option value="">Оберіть</option>' + QUEUES.map((queue) => `<option value="${queue}">${queue}</option>`).join('');
  }

  function addAddress(event) {
    event.preventDefault();
    dom.formError.hidden = true;
    const formData = new FormData(dom.addressForm);
    const settlement = String(formData.get('settlement') || '').trim();
    const street = String(formData.get('street') || '').trim();
    const house = String(formData.get('house') || '').trim();
    const queue = safeQueue(String(formData.get('queue') || ''));
    const label = String(formData.get('label') || '').trim();
    if (!settlement || !street || !house || !queue) {
      showFormError('Заповніть населений пункт, вулицю, будинок і підчергу.');
      return;
    }
    const duplicate = state.addresses.some((item) => item.id !== state.editingId && item.settlement.toLocaleLowerCase('uk-UA') === settlement.toLocaleLowerCase('uk-UA') && item.street.toLocaleLowerCase('uk-UA') === street.toLocaleLowerCase('uk-UA') && item.house.toLocaleLowerCase('uk-UA') === house.toLocaleLowerCase('uk-UA'));
    if (duplicate) {
      showFormError('Ця адреса вже є у вашому списку. Відкрийте наявну картку або змініть адресу.');
      return;
    }
    const updatedFields = {
      label: label.slice(0, 40), settlement: settlement.slice(0, 90), street: street.slice(0, 100), house: house.slice(0, 20), queue,
    };
    if (state.editingId) {
      state.addresses = state.addresses.map((item) => item.id === state.editingId ? { ...item, ...updatedFields } : item);
      state.activeId = state.editingId;
      saveAddresses();
      renderAddressList();
      closeAddressForm();
      renderSchedule();
      showToast('Дані адреси оновлено.');
    } else {
      const newAddress = {
        id: (window.crypto && typeof window.crypto.randomUUID === 'function') ? window.crypto.randomUUID() : `addr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ...updatedFields,
      };
      state.addresses.push(newAddress);
      state.activeId = newAddress.id;
      saveAddresses();
      renderAddressList();
      closeAddressForm();
      renderSchedule();
      showToast('Адресу збережено на цьому пристрої.');
    }
  }

  function removeActiveAddress() {
    const address = activeAddress();
    if (!address) return;
    const confirmed = window.confirm(`Видалити адресу «${addressTitle(address)}» зі збережених?`);
    if (!confirmed) return;
    state.addresses = state.addresses.filter((item) => item.id !== address.id);
    state.activeId = state.addresses[0]?.id || null;
    saveAddresses();
    renderAddressList();
    renderSchedule();
    showToast('Адресу видалено.');
  }

  function applyTheme(theme) {
    document.body.classList.toggle('dark', theme === 'dark');
    dom.themeToggle.setAttribute('aria-label', theme === 'dark' ? 'Увімкнути світлу тему' : 'Увімкнути темну тему');
    dom.themeToggle.title = theme === 'dark' ? 'Увімкнути світлу тему' : 'Увімкнути темну тему';
    const icon = theme === 'dark'
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 15.1A8.5 8.5 0 0 1 8.9 3.5 8.5 8.5 0 1 0 20.5 15.1Z"/></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></svg>';
    dom.themeToggle.innerHTML = icon;
  }

  function setupEvents() {
    dom.showAddressForm.addEventListener('click', () => openAddressForm());
    dom.emptyAddButton.addEventListener('click', () => openAddressForm());
    dom.cancelAddressForm.addEventListener('click', closeAddressForm);
    dom.addressForm.addEventListener('submit', addAddress);
    dom.removeAddress.addEventListener('click', removeActiveAddress);
    dom.editAddress.addEventListener('click', () => {
      const address = activeAddress();
      if (address) openAddressForm(address);
    });
    dom.refreshData.addEventListener('click', () => loadSchedule({ bypassCache: true }));
    dom.tabToday.addEventListener('click', () => { state.selectedDay = 'today'; renderSchedule(); });
    dom.tabTomorrow.addEventListener('click', () => { state.selectedDay = 'tomorrow'; renderSchedule(); });
    dom.themeToggle.addEventListener('click', () => {
      const next = document.body.classList.contains('dark') ? 'light' : 'dark';
      applyTheme(next);
      safeStorageSet(THEME_KEY, next);
    });
  }

  function init() {
    populateQueueOptions();
    const savedTheme = safeStorageGet(THEME_KEY);
    applyTheme(savedTheme === 'dark' ? 'dark' : 'light');
    loadAddresses();
    renderAddressList();
    setupEvents();
    renderSchedule();
    loadSchedule();
    window.setInterval(() => {
      dom.currentTime.innerHTML = `${localTime()}<small>за Києвом</small>`;
      if (state.selectedDay === 'today') renderSchedule();
    }, 60_000);
    if (!state.storageAvailable) showToast('Збереження заблоковане браузером. Адреси можуть не запам’ятатися.');
  }

  document.addEventListener('DOMContentLoaded', init);
})();
