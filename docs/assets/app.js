(() => {
  'use strict';

  const DATA = 'data/';
  const SEAT_DIGITS = 7;
  const MAX_BROAD_RECORDS = 60000; // cap on records fetched for a short/broad name query
  const MAX_MATCHES_SHOWN = 30;
  const MIN_NAME_CHARS = 3;

  let meta = null;
  let trie = null;
  const seatCache = new Map();
  const nameCache = new Map();

  const el = (sel, root = document) => root.querySelector(sel);
  const els = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ---------- normalization (must mirror build_data.py normalize()) ----------
  function normalize(s) {
    s = String(s || '');
    s = s.replace(/[\u064B-\u0652\u0670\u0640]/g, '');
    s = s.replace(/[إأآٱ]/g, 'ا');
    s = s.replace(/ى/g, 'ي');
    s = s.replace(/ة/g, 'ه');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }

  // ---------- meta ----------
  async function loadMeta() {
    const res = await fetch(DATA + 'meta.json');
    meta = await res.json();
    const strip = el('#statStrip');
    if (strip) {
      strip.textContent =
        `${meta.total.toLocaleString('en-US')} نتيجة مسجلة`;
    }
  }

  async function loadTrie() {
    if (trie) return trie;
    const res = await fetch(DATA + 'trie.json');
    trie = await res.json();
    return trie;
  }

  // ---------- tabs ----------
  function setupTabs() {
    const tabSeat = el('#tabSeat');
    const tabName = el('#tabName');
    const formSeat = el('#formSeat');
    const formName = el('#formName');

    function activate(which) {
      const seatOn = which === 'seat';
      tabSeat.classList.toggle('active', seatOn);
      tabName.classList.toggle('active', !seatOn);
      tabSeat.setAttribute('aria-selected', String(seatOn));
      tabName.setAttribute('aria-selected', String(!seatOn));
      formSeat.classList.toggle('hidden', !seatOn);
      formName.classList.toggle('hidden', seatOn);
      el('#resultsArea').innerHTML = '';
    }

    tabSeat.addEventListener('click', () => activate('seat'));
    tabName.addEventListener('click', () => activate('name'));
  }

  // ---------- seat digit boxes ----------
  function setupSeatBoxes() {
    const container = el('#seatBoxes');
    const hidden = el('#seatValue');
    const btn = el('#btnSeatSearch');
    const boxes = [];

    for (let i = 0; i < SEAT_DIGITS; i++) {
      const inp = document.createElement('input');
      inp.type = 'tel';
      inp.inputMode = 'numeric';
      inp.maxLength = 1;
      inp.className = 'seat-box';
      inp.setAttribute('aria-label', `رقم ${i + 1} من رقم الجلوس`);
      container.appendChild(inp);
      boxes.push(inp);
    }

    function syncValue() {
      const val = boxes.map(b => b.value).join('');
      hidden.value = val;
      btn.disabled = val.length !== SEAT_DIGITS || !/^\d+$/.test(val);
    }

    boxes.forEach((box, i) => {
      box.addEventListener('input', () => {
        box.value = box.value.replace(/\D/g, '').slice(0, 1);
        box.classList.toggle('filled', box.value !== '');
        if (box.value && i < SEAT_DIGITS - 1) boxes[i + 1].focus();
        syncValue();
      });
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !box.value && i > 0) {
          boxes[i - 1].focus();
        }
      });
      box.addEventListener('paste', (e) => {
        const text = (e.clipboardData || window.clipboardData).getData('text');
        const digits = text.replace(/\D/g, '').slice(0, SEAT_DIGITS);
        if (!digits) return;
        e.preventDefault();
        digits.split('').forEach((d, idx) => {
          if (boxes[idx]) {
            boxes[idx].value = d;
            boxes[idx].classList.add('filled');
          }
        });
        const next = Math.min(digits.length, SEAT_DIGITS - 1);
        boxes[next].focus();
        syncValue();
      });
    });

    if (boxes[0]) boxes[0].focus();
  }

  // ---------- rendering ----------
  function statusClass(code) { return `s${code}`; }

  function renderMessage(text, isError) {
    const area = el('#resultsArea');
    area.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'status-msg' + (isError ? ' error' : '');
    p.textContent = text;
    area.appendChild(p);
  }

  function renderRecord(container, seatNo, name, degree, statusCode) {
    const tpl = el('#stampTpl');
    const node = tpl.content.cloneNode(true);
    el('.result-name', node).textContent = name;
    el('.result-seat', node).textContent = seatNo;
    const stamp = el('.stamp', node);
    stamp.classList.add(statusClass(statusCode));
    stamp.textContent = (meta.statusLabels && meta.statusLabels[statusCode]) || '—';

    const degNum = el('.degree-num', node);
    const max = meta.maxDegree || 320;
    const pct = Math.max(0, Math.min(100, (degree / max) * 100));
    degNum.textContent = `${formatNum(degree)} / ${formatNum(max)}`;
    el('.degree-fill', node).style.width = pct + '%';

    container.appendChild(node);
  }

  function formatNum(n) {
    return Number.isInteger(n) ? String(n) : String(n);
  }

  // ---------- seat search ----------
  async function fetchSeatShard(bucket) {
    if (seatCache.has(bucket)) return seatCache.get(bucket);
    const res = await fetch(`${DATA}seat/${bucket}.json`);
    if (!res.ok) throw new Error('shard-not-found');
    const json = await res.json();
    seatCache.set(bucket, json);
    return json;
  }

  async function searchBySeat(seatStr) {
    renderMessage('بدور على النتيجة…', false);
    const seatNo = parseInt(seatStr, 10);
    if (!Number.isFinite(seatNo)) {
      renderMessage('رقم الجلوس غير صحيح.', true);
      return;
    }
    const bucket = Math.floor(seatNo / 1000) * 1000;
    try {
      const shard = await fetchSeatShard(bucket);
      const offset = String(seatNo - bucket);
      const rec = shard[offset];
      const area = el('#resultsArea');
      area.innerHTML = '';
      if (!rec) {
        renderMessage('لا توجد نتيجة مسجلة برقم الجلوس ده. تأكد من الرقم وحاول تاني.', true);
        return;
      }
      const [name, degree, statusCode] = rec;
      renderRecord(area, seatNo, name, degree, statusCode);
    } catch (err) {
      renderMessage('لا توجد نتيجة مسجلة برقم الجلوس ده. تأكد من الرقم وحاول تاني.', true);
    }
  }

  // ---------- name search (trie routing) ----------
  function collectLeaves(node, out) {
    if (node.f !== undefined) { out.push({ file: node.f, n: node.n || 0 }); return; }
    if (node.t !== undefined) out.push({ file: node.t, n: node.tn || 0 });
    if (node.k) { for (const ch in node.k) collectLeaves(node.k[ch], out); }
  }

  function routeQuery(root, query) {
    let node = root;
    let depth = 0;
    while (true) {
      if (node.f !== undefined) return [{ file: node.f, n: node.n || 0 }];
      if (depth >= query.length) {
        const out = [];
        collectLeaves(node, out);
        return out;
      }
      const ch = query[depth];
      if (node.k && node.k[ch] !== undefined) {
        node = node.k[ch];
        depth++;
        continue;
      }
      return [];
    }
  }

  async function fetchNameShard(id) {
    if (nameCache.has(id)) return nameCache.get(id);
    const res = await fetch(`${DATA}name/${id}.json`);
    const json = await res.json();
    nameCache.set(id, json);
    return json;
  }

  async function searchByName(rawQuery) {
    const query = normalize(rawQuery);
    if (query.replace(/\s+/g, '').length < MIN_NAME_CHARS) {
      renderMessage('اكتب على الأقل ٣ حروف من الاسم.', true);
      return;
    }
    renderMessage('بدور على النتيجة…', false);

    try {
      const root = await loadTrie();
      const leaves = routeQuery(root, query);

      if (leaves.length === 0) {
        renderMessage('مفيش نتيجة مطابقة للاسم ده. تأكد إنك كاتب الاسم زي ما هو مسجل بالشهادة.', true);
        return;
      }

      const totalRecords = leaves.reduce((s, l) => s + l.n, 0);
      if (totalRecords > MAX_BROAD_RECORDS) {
        renderMessage('اكتب اسم أطول وأكثر تحديدًا (الاسم اللي كتبته شائع جدًا).', true);
        return;
      }

      const shards = await Promise.all(leaves.map(l => fetchNameShard(l.file)));
      const matches = [];
      for (const shard of shards) {
        for (const rec of shard) {
          const [seatNo, name, degree, statusCode] = rec;
          if (normalize(name).includes(query)) {
            matches.push(rec);
          }
        }
      }

      const area = el('#resultsArea');
      area.innerHTML = '';

      if (matches.length === 0) {
        renderMessage('مفيش نتيجة مطابقة للاسم ده. تأكد إنك كاتب الاسم زي ما هو مسجل بالشهادة.', true);
        return;
      }

      // exact normalized match first
      matches.sort((a, b) => {
        const an = normalize(a[1]) === query ? 0 : 1;
        const bn = normalize(b[1]) === query ? 0 : 1;
        return an - bn;
      });

      const shown = matches.slice(0, MAX_MATCHES_SHOWN);
      for (const [seatNo, name, degree, statusCode] of shown) {
        renderRecord(area, seatNo, name, degree, statusCode);
      }
      if (matches.length > MAX_MATCHES_SHOWN) {
        const p = document.createElement('p');
        p.className = 'more-note';
        p.textContent = `فيه ${matches.length - MAX_MATCHES_SHOWN} نتيجة تانية مطابقة — اكتب اسم أكمل عشان تضيّق البحث.`;
        area.appendChild(p);
      }
    } catch (err) {
      renderMessage('حصل خطأ أثناء البحث، حاول تاني.', true);
    }
  }

  // ---------- wiring ----------
  function setupForms() {
    el('#formSeat').addEventListener('submit', (e) => {
      e.preventDefault();
      const val = el('#seatValue').value;
      if (val.length === SEAT_DIGITS) searchBySeat(val);
    });
    el('#formName').addEventListener('submit', (e) => {
      e.preventDefault();
      const val = el('#nameInput').value.trim();
      if (val) searchByName(val);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    setupTabs();
    setupSeatBoxes();
    setupForms();
    loadMeta().catch(() => {});
  });
})();
