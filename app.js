// Lugn — minimal schedule + medication app
// Data persists in localStorage. No backend.

(function () {
  'use strict';

  // ---------- State ----------
  const STORAGE_KEY = 'lugn.v1';

  const defaultState = {
    activities: [], // { id, title, date (YYYY-MM-DD), time (HH:MM | null), notes, notify, done, subtasks:[{id,title,done}] }
    medications: [], // { id, name, dosage, days [0..6], times [HH:MM], notes, notify }
    medLog: {}, // { medId: { 'YYYY-MM-DD::HH:MM': takenAtISO } }
    settings: {
      notificationsEnabled: false,
      pushEnabled: false,        // background notifications via Web Push
      pushBackend: '',           // URL of the Lugn push server (e.g. https://lugn-push.onrender.com)
      pushSubscriptionId: ''     // returned by backend after /subscribe
    }
  };

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return structuredClone(defaultState);
      const parsed = JSON.parse(raw);
      return Object.assign(structuredClone(defaultState), parsed);
    } catch {
      return structuredClone(defaultState);
    }
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    debouncedSyncPushSchedule();
  }
  let _syncTimer = null;
  function debouncedSyncPushSchedule() {
    if (!state.settings.pushEnabled || !state.settings.pushBackend || !state.settings.pushSubscriptionId) return;
    clearTimeout(_syncTimer);
    _syncTimer = setTimeout(() => { syncPushSchedule().catch(() => {}); }, 1500);
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // ---------- Date helpers ----------
  const DAY_NAMES_LONG = ['Söndag', 'Måndag', 'Tisdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lördag'];
  const DAY_NAMES_SHORT = ['Sön', 'Mån', 'Tis', 'Ons', 'Tor', 'Fre', 'Lör'];
  const MONTH_NAMES = ['januari', 'februari', 'mars', 'april', 'maj', 'juni', 'juli', 'augusti', 'september', 'oktober', 'november', 'december'];

  function todayStr() {
    return toDateStr(new Date());
  }

  function toDateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function fromDateStr(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function dayOfWeekISO(d) {
    // Monday-first index 0..6
    const js = d.getDay(); // 0=Sun..6=Sat
    return (js + 6) % 7;
  }

  function startOfWeek(d) {
    const x = new Date(d);
    const dow = dayOfWeekISO(x);
    x.setDate(x.getDate() - dow);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  function addDays(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  }

  function greeting() {
    const h = new Date().getHours();
    if (h < 5) return 'God natt';
    if (h < 10) return 'God morgon';
    if (h < 13) return 'God förmiddag';
    if (h < 17) return 'God eftermiddag';
    if (h < 22) return 'God kväll';
    return 'God natt';
  }

  function prettyDate(d) {
    return `${d.getDate()} ${MONTH_NAMES[d.getMonth()]}`;
  }

  // ---------- Routing / view state ----------
  let currentView = 'today';
  let currentWeekDate = todayStr(); // selected date in week view detail
  let weekOffset = 0; // 0 = this week

  function setView(v) {
    currentView = v;
    render();
  }

  // ---------- Helpers for activities ----------
  function isRecurring(a) {
    return a.repeat && a.repeat !== 'none' && a.seriesId;
  }
  function addDaysStr(dateStr, n) {
    const d = fromDateStr(dateStr);
    d.setDate(d.getDate() + n);
    return toDateStr(d);
  }
  function getActivityDone(a, dateStr) {
    if (!isRecurring(a)) return !!a.done;
    const inst = a.instanceData && a.instanceData[dateStr];
    return !!(inst && inst.done);
  }
  function setActivityDone(a, dateStr, done) {
    if (!isRecurring(a)) {
      a.done = done;
    } else {
      a.instanceData = a.instanceData || {};
      a.instanceData[dateStr] = a.instanceData[dateStr] || {};
      a.instanceData[dateStr].done = done;
    }
  }
  function getSubtaskDone(a, dateStr, subId) {
    if (!isRecurring(a)) {
      const sub = (a.subtasks || []).find(s => s.id === subId);
      return !!(sub && sub.done);
    }
    const inst = a.instanceData && a.instanceData[dateStr];
    return !!(inst && inst.subtaskDone && inst.subtaskDone[subId]);
  }
  function setSubtaskDone(a, dateStr, subId, done) {
    if (!isRecurring(a)) {
      const sub = (a.subtasks || []).find(s => s.id === subId);
      if (sub) sub.done = done;
    } else {
      a.instanceData = a.instanceData || {};
      a.instanceData[dateStr] = a.instanceData[dateStr] || {};
      a.instanceData[dateStr].subtaskDone = a.instanceData[dateStr].subtaskDone || {};
      a.instanceData[dateStr].subtaskDone[subId] = done;
    }
  }
  function occursOn(a, dateStr) {
    if (!isRecurring(a)) return a.date === dateStr;
    if (dateStr < a.date) return false;
    if (a.seriesEnd && dateStr > a.seriesEnd) return false;
    if (a.exceptions && a.exceptions.includes(dateStr)) return false;
    // 'daily' for now
    return true;
  }

  function activitiesFor(dateStr) {
    return state.activities
      .filter(a => occursOn(a, dateStr))
      .sort((a, b) => {
        if (!a.time && !b.time) return 0;
        if (!a.time) return 1;
        if (!b.time) return -1;
        return a.time.localeCompare(b.time);
      });
  }

  function medsForDate(dateStr) {
    const d = fromDateStr(dateStr);
    const dow = dayOfWeekISO(d);
    const out = [];
    for (const m of state.medications) {
      if (m.exceptions && m.exceptions.includes(dateStr)) continue;
      if (!m.days || m.days.length === 0 || m.days.includes(dow)) {
        for (const t of (m.times || [])) {
          out.push({ med: m, time: t });
        }
      }
    }
    out.sort((a, b) => a.time.localeCompare(b.time));
    return out;
  }
  function medOccursOn(med, dateStr) {
    if (!med) return false;
    if (med.exceptions && med.exceptions.includes(dateStr)) return false;
    const dow = dayOfWeekISO(fromDateStr(dateStr));
    if (med.days && med.days.length > 0 && !med.days.includes(dow)) return false;
    return (med.times || []).length > 0;
  }

  function medTakenKey(medId, date, time) {
    return `${date}::${time}`;
  }
  function isMedTaken(medId, date, time) {
    const log = state.medLog[medId] || {};
    return Boolean(log[medTakenKey(medId, date, time)]);
  }
  function toggleMedTaken(medId, date, time) {
    const log = state.medLog[medId] || (state.medLog[medId] = {});
    const k = medTakenKey(medId, date, time);
    if (log[k]) delete log[k];
    else log[k] = new Date().toISOString();
    save();
  }

  // ---------- Combined day list (activities + meds) ----------
  // Sort domain:
  //   untimed activities (no time, no order): -10000  -> top
  //   manually ordered activities: a.order (any number)
  //   timed activities and meds: timeInMinutes (0..1440)
  function timeToMinutes(t) {
    if (!t) return -10000;
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  }
  function activitySortKey(a) {
    if (a.order != null) return a.order;
    return timeToMinutes(a.time);
  }
  function itemSortKey(item) {
    if (item.kind === 'activity') return activitySortKey(item.data);
    return timeToMinutes(item.data.time);
  }
  function dayItems(dateStr) {
    const items = [];
    for (const a of activitiesFor(dateStr)) {
      items.push({ kind: 'activity', data: a });
    }
    for (const m of medsForDate(dateStr)) {
      items.push({ kind: 'med', data: m });
    }
    // Stable numeric sort by sort key
    items.forEach((it, i) => { it._idx = i; });
    items.sort((x, y) => {
      const dk = itemSortKey(x) - itemSortKey(y);
      return dk !== 0 ? dk : x._idx - y._idx;
    });
    return items;
  }

  // ---------- DOM render ----------
  const app = document.getElementById('app');
  const tabbar = document.getElementById('tabbar');
  const modalRoot = document.getElementById('modal-root');

  function render() {
    // Tab active state
    for (const btn of tabbar.querySelectorAll('.tab')) {
      btn.classList.toggle('active', btn.dataset.view === currentView);
    }

    // Render view
    app.innerHTML = '';
    const fab = document.querySelector('.fab');
    if (fab) fab.remove();

    if (currentView === 'today') renderToday();
    else if (currentView === 'week') renderWeek();
    else if (currentView === 'meds') renderMeds();
    else if (currentView === 'settings') renderSettings();
  }

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ---------- TODAY view ----------
  function renderToday() {
    const today = todayStr();
    const date = new Date();

    const header = el(`
      <header class="view-header">
        <div class="greeting">${escapeHtml(greeting())}</div>
        <h1>Idag</h1>
        <div class="subtitle">${escapeHtml(DAY_NAMES_LONG[date.getDay()] + ', ' + prettyDate(date))}</div>
      </header>
    `);
    app.appendChild(header);

    const items = dayItems(today);

    if (items.length === 0) {
      app.appendChild(el(`
        <div class="empty">
          <div class="icon">·</div>
          <div class="text">Inga planer än idag.<br>Lägg till något med +</div>
        </div>
      `));
    } else {
      const list = el(`<div class="list"></div>`);
      for (const it of items) {
        list.appendChild(renderItem(it, today));
      }
      app.appendChild(list);
      attachActivityReorder(list, today);
    }

    app.appendChild(el(`<div class="tiny-tip">En sak i taget. Det räcker.</div>`));

    addFab(() => openActivityModal({ date: today }));
  }

  function attachActivityReorder(listEl, dateStr) {
    setupReorder(listEl, '.act-drag-handle', (from, to) => {
      const items = dayItems(dateStr);
      if (from < 0 || from >= items.length) return;
      const dragged = items[from];
      if (dragged.kind !== 'activity') return;
      // Compute new order based on neighbors in the destination position (in the array sans dragged)
      const filtered = items.filter((_, i) => i !== from);
      const above = to > 0 ? filtered[to - 1] : null;
      const below = to < filtered.length ? filtered[to] : null;
      let newOrder;
      const aboveKey = above ? itemSortKey(above) : null;
      const belowKey = below ? itemSortKey(below) : null;
      if (above && below) {
        if (aboveKey < belowKey) newOrder = (aboveKey + belowKey) / 2;
        else newOrder = aboveKey + 0.001;
      } else if (above) {
        newOrder = aboveKey + 100;
      } else if (below) {
        newOrder = belowKey - 100;
      } else {
        newOrder = 0;
      }
      dragged.data.order = newOrder;
      save();
      render();
    });
  }

  // ---------- Render single item card (activity or med) ----------
  function renderItem(item, dateStr) {
    if (item.kind === 'activity') {
      const a = item.data;
      const subs = a.subtasks || [];
      const aDone = getActivityDone(a, dateStr);
      const recurring = isRecurring(a);
      const wrapper = el(`<div class="activity-wrap"></div>`);
      const node = el(`
        <div class="item ${aDone ? 'done' : ''}">
          <button class="check" aria-label="Markera som klar">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12l5 5L20 7"/></svg>
          </button>
          <div class="body"></div>
          <button class="act-drag-handle" aria-label="Flytta" title="Dra för att ändra ordning">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/></svg>
          </button>
          <button class="menu-btn" aria-label="Meny">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>
          </button>
        </div>
      `);
      const body = node.querySelector('.body');
      const titleLine = el(`<div class="item-title">${escapeHtml(a.title)}</div>`);
      if (subs.length > 0) {
        const doneCount = subs.filter(s => getSubtaskDone(a, dateStr, s.id)).length;
        titleLine.appendChild(el(`<span class="sub-count"> ${doneCount}/${subs.length}</span>`));
      }
      body.appendChild(titleLine);
      const meta = el(`<div class="item-meta"></div>`);
      if (a.time) meta.appendChild(el(`<span class="time-pill">${escapeHtml(a.time)}</span>`));
      if (recurring) meta.appendChild(el(`<span class="badge">↻ varje dag</span>`));
      if (a.notify) meta.appendChild(el(`<span class="badge">· påminnelse</span>`));
      body.appendChild(meta);
      if (a.notes) body.appendChild(el(`<div class="item-note">${escapeHtml(a.notes)}</div>`));

      node.querySelector('.check').addEventListener('click', (e) => {
        e.stopPropagation();
        setActivityDone(a, dateStr, !aDone);
        save();
        render();
      });
      node.querySelector('.menu-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openActivityActions(a, dateStr);
      });
      body.addEventListener('click', () => openActivityModal({ activity: a, contextDate: dateStr }));
      wrapper.appendChild(node);

      if (subs.length > 0) {
        const subList = el(`<div class="subtasks ${aDone ? 'parent-done' : ''}"></div>`);
        for (const s of subs) {
          const sDone = getSubtaskDone(a, dateStr, s.id);
          const isMed = !!s.medId;
          const med = isMed ? state.medications.find(m => m.id === s.medId) : null;
          const label = isMed
            ? (med ? (med.dosage ? `${med.name} · ${med.dosage}` : med.name) : '(borttagen medicin)')
            : (s.title || '');
          const subRow = el(`
            <div class="subtask ${sDone ? 'done' : ''} ${isMed ? 'is-med' : ''}">
              <button class="sub-check" aria-label="Markera delsteg">
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3.5"><path d="M5 12l5 5L20 7"/></svg>
              </button>
              ${isMed ? '<span class="sub-pill">💊</span>' : ''}
              <span class="sub-title"></span>
              ${s.notifyAt ? `<span class="sub-notify-pill">🔔 ${escapeHtml(s.notifyAt)}</span>` : ''}
            </div>
          `);
          subRow.querySelector('.sub-title').textContent = label;
          subRow.querySelector('.sub-check').addEventListener('click', (e) => {
            e.stopPropagation();
            setSubtaskDone(a, dateStr, s.id, !sDone);
            save();
            render();
          });
          subList.appendChild(subRow);
        }
        wrapper.appendChild(subList);
      }
      return wrapper;
    } else {
      // med
      const m = item.data.med;
      const time = item.data.time;
      const taken = isMedTaken(m.id, dateStr, time);
      const node = el(`
        <div class="item ${taken ? 'done' : ''}">
          <button class="check" aria-label="Markera som tagen">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12l5 5L20 7"/></svg>
          </button>
          <div class="body"></div>
          <button class="menu-btn" aria-label="Meny">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>
          </button>
        </div>
      `);
      const body = node.querySelector('.body');
      const titleLine = m.dosage ? `${m.name} · ${m.dosage}` : m.name;
      body.appendChild(el(`<div class="item-title">💊 ${escapeHtml(titleLine)}</div>`));
      const meta = el(`<div class="item-meta"></div>`);
      meta.appendChild(el(`<span class="time-pill">${escapeHtml(time)}</span>`));
      if (m.notify) meta.appendChild(el(`<span class="badge">· påminnelse</span>`));
      body.appendChild(meta);
      if (taken) {
        const log = state.medLog[m.id] || {};
        const at = log[medTakenKey(m.id, dateStr, time)];
        if (at) {
          const t = new Date(at);
          const hh = String(t.getHours()).padStart(2, '0');
          const mm = String(t.getMinutes()).padStart(2, '0');
          body.appendChild(el(`<div class="taken-log">tagen ${hh}:${mm}</div>`));
        }
      }
      node.querySelector('.check').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMedTaken(m.id, dateStr, time);
        render();
      });
      node.querySelector('.menu-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        openMedActions(m);
      });
      body.addEventListener('click', () => openMedModal({ medication: m }));
      return node;
    }
  }

  // ---------- WEEK view ----------
  function renderWeek() {
    const today = new Date();
    const wkStart = addDays(startOfWeek(today), weekOffset * 7);

    const weekLabel = weekOffset === 0 ? 'Denna vecka' : (weekOffset === 1 ? 'Nästa vecka' : (weekOffset === -1 ? 'Förra veckan' : `Vecka ${weekOffset > 0 ? '+' : ''}${weekOffset}`));

    const header = el(`
      <header class="view-header">
        <div class="greeting">Översikt</div>
        <h1>${escapeHtml(weekLabel)}</h1>
      </header>
    `);
    app.appendChild(header);

    const nav = el(`
      <div class="btn-row" style="margin-bottom:16px;">
        <button class="btn ghost" id="prev-week">← Förra</button>
        <button class="btn ghost" id="this-week">Idag</button>
        <button class="btn ghost" id="next-week">Nästa →</button>
      </div>
    `);
    nav.querySelector('#prev-week').addEventListener('click', () => { weekOffset--; render(); });
    nav.querySelector('#next-week').addEventListener('click', () => { weekOffset++; render(); });
    nav.querySelector('#this-week').addEventListener('click', () => { weekOffset = 0; render(); });
    app.appendChild(nav);

    const todayDS = todayStr();

    for (let i = 0; i < 7; i++) {
      const d = addDays(wkStart, i);
      const ds = toDateStr(d);
      const items = dayItems(ds);
      const isToday = ds === todayDS;
      const card = el(`
        <button class="daycard ${isToday ? 'today' : ''}">
          <div class="top">
            <span class="day-name">${escapeHtml(DAY_NAMES_LONG[d.getDay()])}</span>
            <span class="day-date">${escapeHtml(prettyDate(d))}</span>
          </div>
          <div class="preview"></div>
        </button>
      `);
      const prev = card.querySelector('.preview');
      if (items.length === 0) {
        prev.textContent = 'Inget planerat';
      } else {
        const summary = items.slice(0, 3).map(it => {
          if (it.kind === 'activity') return (it.data.time ? it.data.time + ' ' : '') + it.data.title;
          return it.data.time + ' ' + it.data.med.name;
        }).join(' · ');
        prev.textContent = items.length > 3 ? summary + ` · +${items.length - 3} till` : summary;
      }
      card.addEventListener('click', () => openDayModal(ds));
      app.appendChild(card);
    }

    addFab(() => openActivityModal({ date: todayDS }));
  }

  // ---------- DAY detail (modal) ----------
  function openDayModal(dateStr) {
    const d = fromDateStr(dateStr);
    const items = dayItems(dateStr);
    const isToday = dateStr === todayStr();

    const modal = el(`
      <div class="modal" role="dialog" aria-label="${escapeHtml(DAY_NAMES_LONG[d.getDay()])}">
        <div class="modal-handle"></div>
        <h2>${escapeHtml(DAY_NAMES_LONG[d.getDay()])} <span style="font-weight:400;color:var(--text-soft);font-size:16px;">${escapeHtml(prettyDate(d))}${isToday ? ' · idag' : ''}</span></h2>
        <div class="day-items"></div>
        <div class="btn-row" style="margin-top:20px;">
          <button class="btn primary block" id="add-day-act">+ Lägg till aktivitet</button>
        </div>
      </div>
    `);
    const list = modal.querySelector('.day-items');
    if (items.length === 0) {
      list.appendChild(el(`<div class="empty"><div class="text">Inget planerat den här dagen.</div></div>`));
    } else {
      const ll = el(`<div class="list"></div>`);
      for (const it of items) ll.appendChild(renderItem(it, dateStr));
      list.appendChild(ll);
      attachActivityReorder(ll, dateStr);
    }
    modal.querySelector('#add-day-act').addEventListener('click', () => {
      closeModal();
      openActivityModal({ date: dateStr });
    });
    showModal(modal);
  }

  // ---------- Activity edit modal ----------
  function openActivityModal({ activity = null, date = null, contextDate = null } = {}) {
    const isEdit = !!activity;
    const a = activity || { id: uid(), title: '', date: date || todayStr(), time: '', notes: '', notify: false, done: false, subtasks: [], repeat: 'none' };
    const draftSubs = (a.subtasks || []).map(s => ({ ...s }));
    const ctxDate = contextDate || a.date;
    const wasRecurring = isRecurring(a);

    const modal = el(`
      <div class="modal" role="dialog" aria-label="Aktivitet">
        <div class="modal-handle"></div>
        <h2>${isEdit ? 'Redigera aktivitet' : 'Ny aktivitet'}</h2>

        <div class="field">
          <label for="act-title">Vad</label>
          <input class="input" id="act-title" placeholder="Dusch, äta, ärende…" value="${escapeHtml(a.title)}" />
        </div>

        <div class="row">
          <div class="field" style="flex:1.2;">
            <label for="act-date">${wasRecurring && ctxDate !== a.date ? 'Den här dagen' : 'Dag'}</label>
            <input class="input" type="date" id="act-date" value="${escapeHtml(wasRecurring ? ctxDate : a.date)}" ${wasRecurring && ctxDate !== a.date ? 'readonly' : ''} />
          </div>
          <div class="field" style="flex:1;">
            <label for="act-time">Tid (valfritt)</label>
            <input class="input" type="time" id="act-time" value="${escapeHtml(a.time || '')}" />
          </div>
        </div>

        <div class="field">
          <label for="act-repeat">Upprepning</label>
          <select class="input" id="act-repeat">
            <option value="none" ${(a.repeat || 'none') === 'none' ? 'selected' : ''}>Engångs</option>
            <option value="daily" ${a.repeat === 'daily' ? 'selected' : ''}>Varje dag</option>
          </select>
        </div>

        <div class="field">
          <label>Delsteg (valfritt)</label>
          <div class="subtask-edit-list" id="sub-list"></div>
          <div class="row" style="margin-top:8px;gap:8px;">
            <button type="button" class="add-time" id="add-sub">+ Delsteg</button>
            <button type="button" class="add-time" id="add-sub-med">+ Medicin</button>
          </div>
        </div>

        <div class="field">
          <label for="act-notes">Anteckning för dagen (valfritt)</label>
          <textarea class="textarea" id="act-notes" placeholder="T.ex. tag det lugnt, byt handduk…">${escapeHtml(a.notes || '')}</textarea>
        </div>

        <div class="settings-group" style="margin-top:8px;">
          <div class="toggle-row">
            <div class="label-block">
              <div class="l">Påminn mig</div>
              <div class="h">Notis när det är dags</div>
            </div>
            <button class="toggle ${a.notify ? 'on' : ''}" id="act-notify" aria-label="Påminnelse"></button>
          </div>
        </div>

        <div class="btn-row" style="margin-top:20px;">
          <button class="btn ghost" id="act-cancel">Avbryt</button>
          <button class="btn primary" id="act-save">${isEdit ? 'Spara' : 'Lägg till'}</button>
        </div>
        ${isEdit ? `<div style="margin-top:6px;"><button class="btn danger block" id="act-delete">Ta bort</button></div>` : ''}
      </div>
    `);

    const subListEl = modal.querySelector('#sub-list');
    const HANDLE_SVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" stroke-width="2.4" stroke-linecap="round"/></svg>`;
    const BELL_SVG = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9z"/><path d="M10.3 21a2 2 0 0 0 3.4 0"/></svg>`;
    function attachNotifyControls(row, s) {
      const btn = row.querySelector('.sub-notify-btn');
      function refresh() {
        btn.classList.toggle('set', !!s.notifyAt);
        btn.querySelector('.t').textContent = s.notifyAt || '';
      }
      refresh();
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();
        const result = await openNotifyTimeModal(s.notifyAt, s);
        if (result === undefined) return; // cancelled
        s.notifyAt = result || undefined;
        refresh();
        // Ask for permission lazily — non-blocking, fine if denied
        if (s.notifyAt) ensureNotificationPermission().catch(() => {});
      });
    }
    function renderSubs() {
      subListEl.innerHTML = '';
      draftSubs.forEach((s, idx) => {
        if (s.medId) {
          const med = state.medications.find(m => m.id === s.medId);
          const label = med ? (med.dosage ? `${med.name} · ${med.dosage}` : med.name) : '(borttagen)';
          const row = el(`
            <div class="time-row med-row sub-edit-row">
              <button type="button" class="drag-handle" aria-label="Flytta">${HANDLE_SVG}</button>
              <div class="sub-input-wrap med-chip">
                <span class="med-chip-label"><span>💊</span> <span class="ml"></span></span>
                <button type="button" class="sub-notify-btn" aria-label="Notis-tid">${BELL_SVG}<span class="t"></span></button>
              </div>
              <button type="button" class="remove" aria-label="Ta bort delsteg">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 6l12 12M6 18L18 6"/></svg>
              </button>
            </div>
          `);
          row.querySelector('.ml').textContent = label;
          row.querySelector('.remove').addEventListener('click', () => {
            draftSubs.splice(idx, 1);
            renderSubs();
          });
          attachNotifyControls(row, s);
          subListEl.appendChild(row);
        } else {
          const row = el(`
            <div class="time-row sub-edit-row">
              <button type="button" class="drag-handle" aria-label="Flytta">${HANDLE_SVG}</button>
              <div class="sub-input-wrap">
                <input class="input sub-input" type="text" placeholder="T.ex. plocka fram handduk" />
                <button type="button" class="sub-notify-btn" aria-label="Notis-tid">${BELL_SVG}<span class="t"></span></button>
              </div>
              <button type="button" class="remove" aria-label="Ta bort delsteg">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 6l12 12M6 18L18 6"/></svg>
              </button>
            </div>
          `);
          const input = row.querySelector('.sub-input');
          input.value = s.title || '';
          input.addEventListener('input', (e) => { s.title = e.target.value; });
          input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              draftSubs.push({ id: uid(), title: '', done: false });
              renderSubs();
              setTimeout(() => {
                const inputs = subListEl.querySelectorAll('input.sub-input');
                inputs[inputs.length - 1]?.focus();
              }, 0);
            }
          });
          row.querySelector('.remove').addEventListener('click', () => {
            draftSubs.splice(idx, 1);
            renderSubs();
          });
          attachNotifyControls(row, s);
          subListEl.appendChild(row);
        }
      });
      setupReorder(subListEl, '.drag-handle', (from, to) => {
        const [item] = draftSubs.splice(from, 1);
        draftSubs.splice(to, 0, item);
        renderSubs();
      });
    }
    renderSubs();
    modal.querySelector('#add-sub').addEventListener('click', () => {
      draftSubs.push({ id: uid(), title: '', done: false });
      renderSubs();
      setTimeout(() => {
        const inputs = subListEl.querySelectorAll('input[type="text"]');
        inputs[inputs.length - 1]?.focus();
      }, 0);
    });
    modal.querySelector('#add-sub-med').addEventListener('click', () => {
      openMedPicker(async (medId) => {
        const med = state.medications.find(m => m.id === medId);
        if (!med) return;
        if (medOccursOn(med, ctxDate)) {
          const choice = await askScope({
            title: 'Medicinen är redan schemalagd',
            message: `${med.name} finns redan som huvudpost ${ctxDate === todayStr() ? 'idag' : 'den här dagen'}. Var vill du att den ska finnas?`,
            thisLabel: 'Som delsteg (ta bort huvudposten den här dagen)',
            futureLabel: 'Behåll som huvudpost (avbryt)'
          });
          if (choice === null || choice === 'future') return;
          // 'this' = som delsteg
          med.exceptions = med.exceptions || [];
          if (!med.exceptions.includes(ctxDate)) med.exceptions.push(ctxDate);
          save();
        }
        draftSubs.push({ id: uid(), medId, done: false });
        renderSubs();
      });
    });

    const notifyToggle = modal.querySelector('#act-notify');
    notifyToggle.addEventListener('click', async () => {
      const willOn = !notifyToggle.classList.contains('on');
      if (willOn) {
        const ok = await ensureNotificationPermission();
        if (!ok) return;
      }
      notifyToggle.classList.toggle('on');
    });

    modal.querySelector('#act-cancel').addEventListener('click', closeModal);
    modal.querySelector('#act-save').addEventListener('click', async () => {
      const title = modal.querySelector('#act-title').value.trim();
      if (!title) { modal.querySelector('#act-title').focus(); return; }
      const newRepeat = modal.querySelector('#act-repeat').value || 'none';
      const dateField = modal.querySelector('#act-date').value || todayStr();
      const cleanSubs = draftSubs
        .map(s => {
          const base = s.medId
            ? { id: s.id, medId: s.medId }
            : { id: s.id, title: (s.title || '').trim() };
          if (s.notifyAt) base.notifyAt = s.notifyAt;
          return base;
        })
        .filter(s => s.medId || (s.title && s.title.length > 0));

      const newProps = {
        title,
        time: modal.querySelector('#act-time').value || '',
        notes: modal.querySelector('#act-notes').value.trim(),
        notify: notifyToggle.classList.contains('on'),
        subtasks: cleanSubs,
        repeat: newRepeat
      };

      if (!isEdit) {
        // Create new
        Object.assign(a, newProps);
        a.date = dateField;
        if (newRepeat !== 'none') {
          a.seriesId = uid();
          a.exceptions = [];
          a.instanceData = {};
          a.seriesEnd = null;
          a.done = false;
        }
        // Preserve done flags from cleanSubs (always false for new)
        a.subtasks = cleanSubs.map(s => ({ ...s, done: false }));
        state.activities.push(a);
      } else {
        // Editing existing
        if (wasRecurring) {
          // Recurring: ask scope
          const choice = await askScope({
            title: 'Ändra upprepad aktivitet',
            message: 'Ska ändringen gälla bara den här dagen, eller alla kommande dagar?',
            thisLabel: 'Bara den här dagen',
            futureLabel: 'Alla kommande från denna'
          });
          if (choice === null) return;

          if (choice === 'this') {
            // Add exception, create one-off for ctxDate
            a.exceptions = a.exceptions || [];
            if (!a.exceptions.includes(ctxDate)) a.exceptions.push(ctxDate);
            const single = {
              id: uid(),
              date: ctxDate,
              done: false,
              repeat: 'none',
              ...newProps,
              subtasks: cleanSubs.map(s => ({ ...s, done: false }))
            };
            state.activities.push(single);
          } else {
            // 'future'
            if (ctxDate === a.date) {
              // Editing first day — update template in place
              Object.assign(a, newProps);
              if (newRepeat === 'none') {
                // No longer recurring — clear series fields
                delete a.seriesId; delete a.exceptions; delete a.instanceData; delete a.seriesEnd;
              }
              a.subtasks = cleanSubs.map(s => {
                const old = (a.subtasks || []).find(x => x.id === s.id);
                return { ...s, done: old ? !!old.done : false };
              });
            } else {
              // Split: end old at ctxDate-1, create new template from ctxDate
              a.seriesEnd = addDaysStr(ctxDate, -1);
              const newTemplate = {
                id: uid(),
                date: ctxDate,
                done: false,
                ...newProps,
                subtasks: cleanSubs.map(s => ({ ...s, done: false }))
              };
              if (newRepeat !== 'none') {
                newTemplate.seriesId = uid();
                newTemplate.exceptions = [];
                newTemplate.instanceData = {};
                newTemplate.seriesEnd = null;
              }
              state.activities.push(newTemplate);
            }
          }
        } else {
          // Non-recurring: simple update + maybe convert to recurring
          Object.assign(a, newProps);
          a.date = dateField;
          a.subtasks = cleanSubs.map(s => {
            const old = (a.subtasks || []).find(x => x.id === s.id);
            return { ...s, done: old ? !!old.done : false };
          });
          if (newRepeat !== 'none') {
            a.seriesId = uid();
            a.exceptions = [];
            a.instanceData = {};
            a.seriesEnd = null;
            a.done = false;
          }
        }
      }

      save();
      scheduleAllNotifications();
      closeModal();
      render();
    });
    if (isEdit) {
      modal.querySelector('#act-delete').addEventListener('click', async () => {
        if (wasRecurring) {
          const choice = await askScope({
            title: 'Ta bort upprepad aktivitet',
            message: 'Ska aktiviteten tas bort bara den här dagen, eller alla kommande dagar?',
            thisLabel: 'Bara den här dagen',
            futureLabel: 'Alla kommande från denna',
            danger: true
          });
          if (choice === null) return;
          if (choice === 'this') {
            a.exceptions = a.exceptions || [];
            if (!a.exceptions.includes(ctxDate)) a.exceptions.push(ctxDate);
          } else {
            if (ctxDate === a.date) {
              state.activities = state.activities.filter(x => x.id !== a.id);
            } else {
              a.seriesEnd = addDaysStr(ctxDate, -1);
            }
          }
        } else {
          if (!confirm('Ta bort den här aktiviteten?')) return;
          state.activities = state.activities.filter(x => x.id !== a.id);
        }
        save();
        closeModal();
        render();
      });
    }

    showModal(modal);
    setTimeout(() => modal.querySelector('#act-title').focus(), 80);
  }

  function openNotifyTimeModal(currentValue, subtaskRef) {
    return new Promise((resolve) => {
      // Suggest a sensible default: parent activity time or 09:00
      const fallbackParent = (() => {
        // Try to find current draft activity time from open modal
        const t = document.querySelector('#act-time')?.value;
        return t || '09:00';
      })();
      const initial = currentValue || fallbackParent;
      let label = subtaskRef ? (subtaskRef.medId
          ? (state.medications.find(m => m.id === subtaskRef.medId)?.name || 'medicinen')
          : (subtaskRef.title || 'delsteget'))
        : 'delsteget';
      const modal = el(`
        <div class="modal" role="dialog" aria-label="Notis-tid">
          <div class="modal-handle"></div>
          <h2>Notis-tid</h2>
          <p style="color:var(--text-soft);margin:0 0 18px;">När ska notisen om <strong></strong> gå av?</p>
          <div class="field">
            <input class="input notify-time-input" type="time" value="${escapeHtml(initial)}" />
          </div>
          <div class="btn-row" style="margin-top:8px;">
            <button class="btn ghost" id="notify-cancel">Avbryt</button>
            <button class="btn primary" id="notify-save">Spara</button>
          </div>
          ${currentValue ? '<div style="margin-top:6px;"><button class="btn danger block" id="notify-clear">Ta bort notisen</button></div>' : ''}
        </div>
      `);
      modal.querySelector('strong').textContent = label;
      const inputEl = modal.querySelector('.notify-time-input');
      modal.querySelector('#notify-cancel').addEventListener('click', () => { closeModal(); resolve(undefined); });
      modal.querySelector('#notify-save').addEventListener('click', () => {
        const t = inputEl.value || '';
        if (!t) { inputEl.focus(); return; }
        closeModal();
        resolve(t);
      });
      const clearBtn = modal.querySelector('#notify-clear');
      if (clearBtn) clearBtn.addEventListener('click', () => { closeModal(); resolve(''); });
      showModal(modal, { stack: true });
      setTimeout(() => {
        try {
          inputEl.focus();
          if (typeof inputEl.showPicker === 'function') inputEl.showPicker();
        } catch {}
      }, 60);
    });
  }

  function setupReorder(container, handleSelector, onDrop) {
    const handles = container.querySelectorAll(handleSelector);
    handles.forEach((handle) => {
      handle.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        // Walk up to find the direct child of container = the row
        let row = handle;
        while (row && row.parentElement !== container) row = row.parentElement;
        if (!row || row === container) return;
        const rows = Array.from(container.children);
        const startIdx = rows.indexOf(row);
        if (startIdx < 0 || rows.length < 2) return;

        const centers = rows.map(r => {
          const rect = r.getBoundingClientRect();
          return rect.top + rect.height / 2;
        });
        const rowH = rows.length > 1 ? Math.abs(centers[1] - centers[0]) : (row.offsetHeight + 8);

        let targetIdx = startIdx;
        const startY = ev.clientY;

        row.classList.add('dragging');
        try { handle.setPointerCapture(ev.pointerId); } catch {}

        const onMove = (e) => {
          const dy = e.clientY - startY;
          row.style.transform = `translateY(${dy}px)`;
          const draggedCenter = centers[startIdx] + dy;
          let aboveCount = 0;
          for (let i = 0; i < centers.length; i++) {
            if (i === startIdx) continue;
            if (centers[i] < draggedCenter) aboveCount++;
          }
          targetIdx = aboveCount;

          // Visually shift other rows
          rows.forEach((r, i) => {
            if (i === startIdx) return;
            const k = i < startIdx ? i : i - 1; // index in filtered array
            const finalPos = k < targetIdx ? k : k + 1;
            const delta = (finalPos - i) * rowH;
            r.style.transform = `translateY(${delta}px)`;
            r.style.transition = 'transform 0.14s ease';
          });
        };
        const onUp = () => {
          handle.removeEventListener('pointermove', onMove);
          handle.removeEventListener('pointerup', onUp);
          handle.removeEventListener('pointercancel', onUp);
          row.classList.remove('dragging');
          // Reset transforms before re-render
          rows.forEach(r => { r.style.transform = ''; r.style.transition = ''; });
          if (targetIdx !== startIdx) {
            onDrop(startIdx, targetIdx);
          }
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
      });
    });
  }

  function openMedPicker(onPick) {
    const meds = state.medications;
    const modal = el(`
      <div class="modal" role="dialog" aria-label="Välj medicin">
        <div class="modal-handle"></div>
        <h2>Välj medicin</h2>
        <div class="picker-list"></div>
        <div class="btn-row" style="margin-top:16px;">
          <button class="btn ghost block" id="pick-cancel">Avbryt</button>
        </div>
      </div>
    `);
    const list = modal.querySelector('.picker-list');
    if (meds.length === 0) {
      list.appendChild(el(`
        <div class="empty" style="padding:24px 0;">
          <div class="text">Inga mediciner ännu.<br>Lägg till från fliken Mediciner.</div>
        </div>
      `));
    } else {
      for (const m of meds) {
        const label = m.dosage ? `${m.name} · ${m.dosage}` : m.name;
        const btn = el(`
          <button class="picker-row" type="button">
            <span class="pill-icon">💊</span>
            <span class="picker-label"></span>
          </button>
        `);
        btn.querySelector('.picker-label').textContent = label;
        btn.addEventListener('click', () => {
          closeModal();
          onPick(m.id);
        });
        list.appendChild(btn);
      }
    }
    modal.querySelector('#pick-cancel').addEventListener('click', closeModal);
    showModal(modal, { stack: true });
  }

  function openActivityActions(a, dateStr) {
    const aDone = getActivityDone(a, dateStr);
    const sheet = el(`
      <div class="actionsheet" role="dialog" aria-label="Aktivitetsåtgärder">
        <button class="action-btn" id="a-edit">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 17.5V21h3.5L17 10.5 13.5 7 3 17.5z"/><path d="M14.5 6L18 9.5"/></svg>
          Redigera
        </button>
        <button class="action-btn" id="a-toggle">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 12l5 5L20 7"/></svg>
          ${aDone ? 'Markera som ej klar' : 'Markera som klar'}
        </button>
        <button class="action-btn danger" id="a-del">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>
          Ta bort
        </button>
      </div>
    `);
    sheet.querySelector('#a-edit').addEventListener('click', () => {
      closeModal();
      openActivityModal({ activity: a, contextDate: dateStr });
    });
    sheet.querySelector('#a-toggle').addEventListener('click', () => {
      setActivityDone(a, dateStr, !aDone);
      save(); closeModal(); render();
    });
    sheet.querySelector('#a-del').addEventListener('click', async () => {
      if (isRecurring(a)) {
        closeModal();
        const choice = await askScope({
          title: 'Ta bort upprepad aktivitet',
          message: 'Ska aktiviteten tas bort bara den här dagen, eller alla kommande dagar?',
          thisLabel: 'Bara den här dagen',
          futureLabel: 'Alla kommande från denna',
          danger: true
        });
        if (choice === null) return;
        if (choice === 'this') {
          a.exceptions = a.exceptions || [];
          if (!a.exceptions.includes(dateStr)) a.exceptions.push(dateStr);
        } else {
          if (dateStr === a.date) {
            state.activities = state.activities.filter(x => x.id !== a.id);
          } else {
            a.seriesEnd = addDaysStr(dateStr, -1);
          }
        }
        save(); render();
      } else {
        if (!confirm('Ta bort den här aktiviteten?')) return;
        state.activities = state.activities.filter(x => x.id !== a.id);
        save(); closeModal(); render();
      }
    });
    showModal(sheet);
  }

  function askScope({ title, message, thisLabel = 'Bara denna', futureLabel = 'Alla kommande', danger = false } = {}) {
    return new Promise((resolve) => {
      const modal = el(`
        <div class="modal" role="dialog" aria-label="${escapeHtml(title)}">
          <div class="modal-handle"></div>
          <h2>${escapeHtml(title)}</h2>
          <p style="color:var(--text-soft);margin:0 0 18px;">${escapeHtml(message)}</p>
          <div style="display:flex;flex-direction:column;gap:8px;">
            <button class="btn ${danger ? 'danger' : 'primary'} block" id="ask-this">${escapeHtml(thisLabel)}</button>
            <button class="btn ${danger ? 'danger' : 'primary'} block" id="ask-future">${escapeHtml(futureLabel)}</button>
            <button class="btn ghost block" id="ask-cancel">Avbryt</button>
          </div>
        </div>
      `);
      modal.querySelector('#ask-this').addEventListener('click', () => { closeModal(); resolve('this'); });
      modal.querySelector('#ask-future').addEventListener('click', () => { closeModal(); resolve('future'); });
      modal.querySelector('#ask-cancel').addEventListener('click', () => { closeModal(); resolve(null); });
      showModal(modal, { stack: true });
    });
  }

  // ---------- MEDS view ----------
  function renderMeds() {
    const header = el(`
      <header class="view-header">
        <div class="greeting">Översikt</div>
        <h1>Mediciner</h1>
        <div class="subtitle">Allt du tar och när</div>
      </header>
    `);
    app.appendChild(header);

    if (state.medications.length === 0) {
      app.appendChild(el(`
        <div class="empty">
          <div class="icon">·</div>
          <div class="text">Inga mediciner ännu.<br>Lägg till med +</div>
        </div>
      `));
    } else {
      const list = el(`<div class="list"></div>`);
      for (const m of state.medications) {
        const days = (m.days && m.days.length > 0)
          ? m.days.slice().sort().map(i => DAY_NAMES_SHORT[(i + 1) % 7]).join(' · ')
          : 'Varje dag';
        const times = (m.times || []).join('  ·  ') || '—';
        const node = el(`
          <button class="item" style="text-align:left;">
            <div class="check" style="background:var(--accent-soft);border-color:var(--accent-soft);">
              <span style="font-size:14px;">💊</span>
            </div>
            <div class="body">
              <div class="item-title">${escapeHtml(m.name)}${m.dosage ? ' · ' + escapeHtml(m.dosage) : ''}</div>
              <div class="item-meta"><span>${escapeHtml(days)}</span></div>
              <div class="item-meta"><span class="time-pill" style="font-weight:400;color:var(--text-soft);">${escapeHtml(times)}</span></div>
              ${m.notify ? '<div class="item-meta"><span class="badge">· påminnelse</span></div>' : ''}
            </div>
            <div class="menu-btn">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 6l6 6-6 6"/></svg>
            </div>
          </button>
        `);
        node.addEventListener('click', () => openMedModal({ medication: m }));
        list.appendChild(node);
      }
      app.appendChild(list);
    }

    addFab(() => openMedModal({}));
  }

  function openMedModal({ medication = null } = {}) {
    const isEdit = !!medication;
    const m = medication || { id: uid(), name: '', dosage: '', days: [], times: ['08:00'], notes: '', notify: false };
    // Clone arrays so we can edit before committing
    const draft = {
      ...m,
      days: [...(m.days || [])],
      times: [...(m.times && m.times.length ? m.times : ['08:00'])]
    };

    const modal = el(`
      <div class="modal" role="dialog" aria-label="Medicin">
        <div class="modal-handle"></div>
        <h2>${isEdit ? 'Redigera medicin' : 'Ny medicin'}</h2>

        <div class="field">
          <label for="med-name">Namn</label>
          <input class="input" id="med-name" placeholder="T.ex. Sertralin" value="${escapeHtml(draft.name)}" />
        </div>

        <div class="field">
          <label for="med-dose">Dosering (valfritt)</label>
          <input class="input" id="med-dose" placeholder="50 mg" value="${escapeHtml(draft.dosage || '')}" />
        </div>

        <div class="field">
          <label>Dagar</label>
          <div class="daychips" id="med-days"></div>
          <div style="font-size:12px;color:var(--text-faint);margin-top:6px;">Lämna alla av för "varje dag".</div>
        </div>

        <div class="field">
          <label>Tider</label>
          <div class="times-list" id="med-times"></div>
          <button class="add-time" id="add-time">+ Lägg till tid</button>
        </div>

        <div class="settings-group" style="margin-top:8px;">
          <div class="toggle-row">
            <div class="label-block">
              <div class="l">Påminn mig</div>
              <div class="h">Notis vid varje dos</div>
            </div>
            <button class="toggle ${draft.notify ? 'on' : ''}" id="med-notify"></button>
          </div>
        </div>

        <div class="btn-row" style="margin-top:20px;">
          <button class="btn ghost" id="med-cancel">Avbryt</button>
          <button class="btn primary" id="med-save">${isEdit ? 'Spara' : 'Lägg till'}</button>
        </div>
        ${isEdit ? `<div style="margin-top:6px;"><button class="btn danger block" id="med-delete">Ta bort medicin</button></div>` : ''}
      </div>
    `);

    // Day chips (Mon-first)
    const daysEl = modal.querySelector('#med-days');
    for (let i = 0; i < 7; i++) {
      const chip = el(`<button class="daychip ${draft.days.includes(i) ? 'on' : ''}" data-d="${i}">${DAY_NAMES_SHORT[(i + 1) % 7]}</button>`);
      chip.addEventListener('click', () => {
        const idx = draft.days.indexOf(i);
        if (idx >= 0) draft.days.splice(idx, 1); else draft.days.push(i);
        chip.classList.toggle('on');
      });
      daysEl.appendChild(chip);
    }

    // Times
    const timesEl = modal.querySelector('#med-times');
    function renderTimes() {
      timesEl.innerHTML = '';
      draft.times.forEach((t, idx) => {
        const row = el(`
          <div class="time-row">
            <input class="input" type="time" value="${escapeHtml(t)}" />
            <button class="remove" aria-label="Ta bort tid">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 6l12 12M6 18L18 6"/></svg>
            </button>
          </div>
        `);
        row.querySelector('input').addEventListener('change', (e) => {
          draft.times[idx] = e.target.value;
        });
        row.querySelector('.remove').addEventListener('click', () => {
          if (draft.times.length === 1) return;
          draft.times.splice(idx, 1);
          renderTimes();
        });
        timesEl.appendChild(row);
      });
    }
    renderTimes();

    modal.querySelector('#add-time').addEventListener('click', () => {
      draft.times.push('20:00');
      renderTimes();
    });

    const notifyToggle = modal.querySelector('#med-notify');
    notifyToggle.addEventListener('click', async () => {
      const willOn = !notifyToggle.classList.contains('on');
      if (willOn) {
        const ok = await ensureNotificationPermission();
        if (!ok) return;
      }
      notifyToggle.classList.toggle('on');
    });

    modal.querySelector('#med-cancel').addEventListener('click', closeModal);
    modal.querySelector('#med-save').addEventListener('click', () => {
      const name = modal.querySelector('#med-name').value.trim();
      if (!name) { modal.querySelector('#med-name').focus(); return; }
      draft.name = name;
      draft.dosage = modal.querySelector('#med-dose').value.trim();
      draft.notify = notifyToggle.classList.contains('on');
      // Filter empty times and dedupe
      draft.times = [...new Set(draft.times.filter(Boolean))].sort();
      if (draft.times.length === 0) draft.times = ['08:00'];

      if (isEdit) {
        Object.assign(medication, draft);
      } else {
        state.medications.push(draft);
      }
      save();
      scheduleAllNotifications();
      closeModal();
      render();
    });
    if (isEdit) {
      modal.querySelector('#med-delete').addEventListener('click', () => {
        if (!confirm('Ta bort den här medicinen?')) return;
        state.medications = state.medications.filter(x => x.id !== medication.id);
        delete state.medLog[medication.id];
        save();
        closeModal();
        render();
      });
    }

    showModal(modal);
    setTimeout(() => modal.querySelector('#med-name').focus(), 80);
  }

  function openMedActions(m) {
    const sheet = el(`
      <div class="actionsheet">
        <button class="action-btn" id="m-edit">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 17.5V21h3.5L17 10.5 13.5 7 3 17.5z"/><path d="M14.5 6L18 9.5"/></svg>
          Redigera
        </button>
        <button class="action-btn danger" id="m-del">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>
          Ta bort
        </button>
      </div>
    `);
    sheet.querySelector('#m-edit').addEventListener('click', () => { closeModal(); openMedModal({ medication: m }); });
    sheet.querySelector('#m-del').addEventListener('click', () => {
      if (!confirm('Ta bort den här medicinen?')) return;
      state.medications = state.medications.filter(x => x.id !== m.id);
      delete state.medLog[m.id];
      save(); closeModal(); render();
    });
    showModal(sheet);
  }

  // ---------- SETTINGS ----------
  function renderSettings() {
    const header = el(`
      <header class="view-header">
        <div class="greeting">Mig själv</div>
        <h1>Inställningar</h1>
      </header>
    `);
    app.appendChild(header);

    const group = el(`<div class="settings-group"></div>`);

    const notifPerm = (typeof Notification !== 'undefined') ? Notification.permission : 'unsupported';
    const notifLabel = notifPerm === 'granted' ? 'På' : (notifPerm === 'denied' ? 'Avstängd i webbläsaren' : 'Be om tillstånd');

    const row1 = el(`
      <div class="toggle-row">
        <div class="label-block">
          <div class="l">Notiser</div>
          <div class="h">${escapeHtml(notifLabel)}</div>
        </div>
        <button class="toggle ${notifPerm === 'granted' && state.settings.notificationsEnabled ? 'on' : ''}" id="notif-toggle"></button>
      </div>
    `);
    row1.querySelector('#notif-toggle').addEventListener('click', async () => {
      if (state.settings.notificationsEnabled) {
        state.settings.notificationsEnabled = false;
        save();
        render();
        return;
      }
      const ok = await ensureNotificationPermission();
      state.settings.notificationsEnabled = ok;
      save();
      if (ok) scheduleAllNotifications();
      render();
    });
    group.appendChild(row1);

    app.appendChild(group);

    // Background notifications via push server
    const pushGroup = el(`<div class="settings-group"></div>`);
    const pushRow = el(`
      <div class="toggle-row">
        <div class="label-block">
          <div class="l">Bakgrundsnotiser</div>
          <div class="h">${state.settings.pushEnabled ? 'På · skickas via din push-server' : 'Av · notiser endast när appen är öppen'}</div>
        </div>
        <button class="toggle ${state.settings.pushEnabled ? 'on' : ''}" id="push-toggle"></button>
      </div>
    `);
    pushRow.querySelector('#push-toggle').addEventListener('click', async () => {
      if (state.settings.pushEnabled) {
        await disablePush();
        render();
      } else {
        const ok = await enablePush();
        if (ok) render();
      }
    });
    pushGroup.appendChild(pushRow);

    const backendField = el(`
      <div class="toggle-row" style="display:block;">
        <div class="label-block" style="margin-bottom:8px;">
          <div class="l">Push-server URL</div>
          <div class="h">T.ex. https://din-server.onrender.com</div>
        </div>
        <input class="input" id="push-backend" type="url" placeholder="https://..." value="${escapeHtml(state.settings.pushBackend || '')}" style="width:100%;" />
      </div>
    `);
    const backendInput = backendField.querySelector('#push-backend');
    backendInput.addEventListener('change', () => {
      state.settings.pushBackend = backendInput.value.trim();
      save();
    });
    pushGroup.appendChild(backendField);

    app.appendChild(pushGroup);
    app.appendChild(el(`<div class="tiny-tip" style="margin-top:6px;margin-bottom:18px;text-align:left;">Bakgrundsnotiser kräver att du driftsätter den lilla push-servern (se README) och anger dess URL ovan.</div>`));

    const danger = el(`
      <div class="settings-group">
        <button class="action-btn" id="export">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/></svg>
          Exportera data (JSON)
        </button>
        <button class="action-btn danger" id="reset">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>
          Återställ all data
        </button>
      </div>
    `);
    danger.querySelector('#export').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `lugn-${todayStr()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });
    danger.querySelector('#reset').addEventListener('click', () => {
      if (!confirm('Återställ all data? Detta kan inte ångras.')) return;
      state = structuredClone(defaultState);
      save();
      render();
    });
    app.appendChild(danger);

    app.appendChild(el(`<div class="tiny-tip">Lugn sparar allt lokalt på din telefon. Inget skickas någonstans.</div>`));
  }

  // ---------- FAB ----------
  function addFab(onClick) {
    const fab = el(`
      <button class="fab" aria-label="Lägg till">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    `);
    fab.addEventListener('click', onClick);
    document.body.appendChild(fab);
  }

  // ---------- Modal plumbing (stackable) ----------
  function showModal(node, { stack = false } = {}) {
    if (!stack) closeAllModals();
    const backdrop = el(`<div class="modal-backdrop"></div>`);
    backdrop.appendChild(node);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeModal();
    });
    modalRoot.appendChild(backdrop);
    document.body.style.overflow = 'hidden';
  }
  function closeModal() {
    const backdrops = modalRoot.querySelectorAll('.modal-backdrop');
    if (backdrops.length === 0) return;
    backdrops[backdrops.length - 1].remove();
    if (modalRoot.querySelectorAll('.modal-backdrop').length === 0) {
      document.body.style.overflow = '';
    }
  }
  function closeAllModals() {
    modalRoot.innerHTML = '';
    document.body.style.overflow = '';
  }

  // ---------- Notifications ----------
  async function ensureNotificationPermission() {
    if (typeof Notification === 'undefined') {
      alert('Den här webbläsaren stöder inte notiser.');
      return false;
    }
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') {
      alert('Notiser är avstängda. Slå på dem i webbläsarens inställningar.');
      return false;
    }
    const r = await Notification.requestPermission();
    return r === 'granted';
  }

  // ---------- Web Push (background notifications) ----------
  function urlBase64ToUint8Array(base64) {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(b64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }
  function backendUrl(path) {
    const base = (state.settings.pushBackend || '').replace(/\/$/, '');
    return base + path;
  }
  async function enablePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      alert('Den här webbläsaren stöder inte bakgrundsnotiser.');
      return false;
    }
    const backend = (state.settings.pushBackend || '').trim();
    if (!backend) {
      alert('Ange URL till push-servern först.');
      return false;
    }
    const okPerm = await ensureNotificationPermission();
    if (!okPerm) return false;
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const keyResp = await fetch(backendUrl('/vapid-public-key'));
        if (!keyResp.ok) throw new Error('Kunde inte hämta VAPID-nyckel');
        const { key } = await keyResp.json();
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(key)
        });
      }
      const subResp = await fetch(backendUrl('/subscribe'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), userAgent: navigator.userAgent })
      });
      if (!subResp.ok) throw new Error('Kunde inte registrera prenumeration');
      const { subscriptionId } = await subResp.json();
      state.settings.pushEnabled = true;
      state.settings.pushSubscriptionId = subscriptionId;
      save();
      await syncPushSchedule();
      return true;
    } catch (err) {
      console.error('enablePush', err);
      alert('Kunde inte aktivera bakgrundsnotiser: ' + (err.message || err));
      return false;
    }
  }
  async function disablePush() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
      if (state.settings.pushSubscriptionId && state.settings.pushBackend) {
        try {
          await fetch(backendUrl('/subscribe/' + encodeURIComponent(state.settings.pushSubscriptionId)), { method: 'DELETE' });
        } catch {}
      }
    } catch {}
    state.settings.pushEnabled = false;
    state.settings.pushSubscriptionId = '';
    save();
  }
  function buildScheduleItems() {
    const items = [];
    const now = Date.now();
    const horizon = now + 7 * 24 * 60 * 60 * 1000; // 7 days
    for (let d = 0; d < 7; d++) {
      const date = addDays(new Date(), d);
      const ds = toDateStr(date);
      for (const a of state.activities) {
        if (!occursOn(a, ds)) continue;
        // Activity-level notification
        if (a.notify && a.time && !getActivityDone(a, ds)) {
          const ts = parseDateTime(ds, a.time);
          if (ts && ts > now && ts < horizon) {
            items.push({
              tag: `lugn-act-${a.id}-${ds}`,
              title: a.title,
              body: a.notes || 'Påminnelse',
              sendAt: ts
            });
          }
        }
        // Subtask notifications
        for (const s of (a.subtasks || [])) {
          if (!s.notifyAt) continue;
          if (getSubtaskDone(a, ds, s.id)) continue;
          const ts = parseDateTime(ds, s.notifyAt);
          if (!ts || ts <= now || ts >= horizon) continue;
          let label;
          if (s.medId) {
            const med = state.medications.find(m => m.id === s.medId);
            label = med ? (med.dosage ? `💊 ${med.name} · ${med.dosage}` : `💊 ${med.name}`) : '💊 Medicin';
          } else {
            label = s.title || 'Delsteg';
          }
          items.push({
            tag: `lugn-sub-${a.id}-${s.id}-${ds}`,
            title: label,
            body: `i ${a.title}`,
            sendAt: ts
          });
        }
      }
      // Med-level notifications
      const dow = dayOfWeekISO(date);
      for (const m of state.medications) {
        if (!m.notify) continue;
        if (m.exceptions && m.exceptions.includes(ds)) continue;
        if (m.days && m.days.length > 0 && !m.days.includes(dow)) continue;
        for (const t of (m.times || [])) {
          if (isMedTaken(m.id, ds, t)) continue;
          const ts = parseDateTime(ds, t);
          if (!ts || ts <= now || ts >= horizon) continue;
          items.push({
            tag: `lugn-med-${m.id}-${ds}-${t}`,
            title: '💊 ' + m.name,
            body: m.dosage ? `Dags att ta ${m.dosage}` : 'Dags att ta din medicin',
            sendAt: ts
          });
        }
      }
    }
    return items;
  }
  async function syncPushSchedule() {
    if (!state.settings.pushEnabled || !state.settings.pushBackend || !state.settings.pushSubscriptionId) return;
    const items = buildScheduleItems();
    const r = await fetch(backendUrl('/schedule'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriptionId: state.settings.pushSubscriptionId, items })
    });
    if (!r.ok) {
      // If subscription is unknown (server lost it), force re-enable
      if (r.status === 404) {
        state.settings.pushSubscriptionId = '';
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      }
    }
  }

  // Best-effort in-page notification scheduler.
  // Runs while the tab is open; phone OS-level scheduled notifications
  // would require a service worker — kept simple for v1.
  let scheduledTimers = [];
  function clearScheduled() {
    for (const id of scheduledTimers) clearTimeout(id);
    scheduledTimers = [];
  }
  function scheduleAllNotifications() {
    clearScheduled();
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;

    const now = Date.now();
    const horizon = now + 24 * 60 * 60 * 1000; // schedule next 24h

    // Activities (incl. recurring expansions) + subtask notifications
    for (let dayAhead = 0; dayAhead < 2; dayAhead++) {
      const dCheck = addDays(new Date(), dayAhead);
      const ds = toDateStr(dCheck);
      for (const a of state.activities) {
        if (!occursOn(a, ds)) continue;

        // Activity-level notification
        if (a.notify && a.time && !getActivityDone(a, ds)) {
          const ts = parseDateTime(ds, a.time);
          if (ts && ts > now && ts < horizon) {
            scheduledTimers.push(setTimeout(() => {
              new Notification(a.title, { body: a.notes || 'Påminnelse', tag: `lugn-act-${a.id}-${ds}` });
            }, ts - now));
          }
        }

        // Subtask-level notifications
        for (const s of (a.subtasks || [])) {
          if (!s.notifyAt) continue;
          if (getSubtaskDone(a, ds, s.id)) continue;
          const ts = parseDateTime(ds, s.notifyAt);
          if (!ts || ts <= now || ts >= horizon) continue;
          let label;
          if (s.medId) {
            const med = state.medications.find(m => m.id === s.medId);
            label = med ? (med.dosage ? `💊 ${med.name} · ${med.dosage}` : `💊 ${med.name}`) : '💊 Medicin';
          } else {
            label = s.title || 'Delsteg';
          }
          scheduledTimers.push(setTimeout(() => {
            new Notification(label, { body: `i ${a.title}`, tag: `lugn-sub-${a.id}-${s.id}-${ds}` });
          }, ts - now));
        }
      }
    }

    // Meds for next 24h on relevant days
    for (let dayAhead = 0; dayAhead < 2; dayAhead++) {
      const d = addDays(new Date(), dayAhead);
      const ds = toDateStr(d);
      const dow = dayOfWeekISO(d);
      for (const m of state.medications) {
        if (!m.notify) continue;
        if (m.days && m.days.length > 0 && !m.days.includes(dow)) continue;
        for (const t of (m.times || [])) {
          const ts = parseDateTime(ds, t);
          if (!ts) continue;
          if (isMedTaken(m.id, ds, t)) continue;
          if (ts > now && ts < horizon) {
            scheduledTimers.push(setTimeout(() => {
              new Notification('💊 ' + m.name, { body: m.dosage ? `Dags att ta ${m.dosage}` : 'Dags att ta din medicin', tag: `lugn-med-${m.id}-${ds}-${t}` });
            }, ts - now));
          }
        }
      }
    }
  }

  function parseDateTime(dateStr, timeStr) {
    if (!dateStr || !timeStr) return null;
    const [y, mo, d] = dateStr.split('-').map(Number);
    const [h, mi] = timeStr.split(':').map(Number);
    return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
  }

  // ---------- Init ----------
  for (const btn of tabbar.querySelectorAll('.tab')) {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  }

  // Esc closes modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  render();
  scheduleAllNotifications();
  // Re-schedule every hour (rolling 24h horizon)
  setInterval(scheduleAllNotifications, 60 * 60 * 1000);

})();
