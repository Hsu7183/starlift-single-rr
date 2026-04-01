(function () {
  'use strict';

  const SUPABASE_URL = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ5aGJtbW5hY2V6emdrd2Zrb3pzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1OTE0NzksImV4cCI6MjA3NDE2NzQ3OX0.VCSye3-fKrQphejdJSWAM6iRzv_7gkl8MLe7NeVszR0";
  const BUCKET = "reports";

  const PASS_HASH = "0f2b9305e317408510dc9878381e953630ed9fa3d2aadf95f1b8eb47941b18b9";
  const KEY_OK = '__auth_ok__';
  const FAIL_KEY = '__auth_fail__';
  const LOCK_UNTIL_KEY = '__auth_lock_until__';
  const HOME_SLIP_KEY = '__home_slip__';
  const IDLE_MS = 30 * 60 * 1000;

  const DEFAULT_SLIP_PER_SIDE = 2;
  const DEFAULT_POINT_VALUE = 200;
  const DEFAULT_FEE_PER_SIDE = 45;
  const DEFAULT_TAX_RATE = 0.00002;

  const $ = s => document.querySelector(s);

  const shield = $('#shield');
  const gate = $('#gate');
  const slipGate = $('#slipGate');
  const app = $('#app');

  const pwd = $('#pwd');
  const btnLogin = $('#btnLogin');
  const btnClear = $('#btnClear');
  const err = $('#err');

  const slipInput = $('#slipInput');
  const btnSlipConfirm = $('#btnSlipConfirm');
  const btnSlipDefault = $('#btnSlipDefault');
  const slipErr = $('#slipErr');

  if (window.top !== window.self) {
    try { window.top.location = window.self.location.href; } catch (_) {}
  }

  window.addEventListener('contextmenu', e => { e.preventDefault(); }, { capture: true });
  window.addEventListener('copy', e => e.preventDefault(), { capture: true });
  window.addEventListener('cut', e => e.preventDefault(), { capture: true });
  window.addEventListener('selectstart', e => e.preventDefault(), { capture: true });

  window.addEventListener('keydown', (e) => {
    const K = (e.key || '').toUpperCase();
    if (e.key === 'F12') { e.preventDefault(); shield.style.display = 'flex'; }
    if (e.ctrlKey && ['U', 'S', 'P'].includes(K)) { e.preventDefault(); shield.style.display = 'flex'; }
    if (e.ctrlKey && e.shiftKey && ['I', 'J', 'C', 'K'].includes(K)) { e.preventDefault(); shield.style.display = 'flex'; }
  }, { capture: true });

  function isLocked() {
    const until = +(sessionStorage.getItem(LOCK_UNTIL_KEY) || 0);
    return Date.now() < until;
  }

  function remainingLockSec() {
    const until = +(sessionStorage.getItem(LOCK_UNTIL_KEY) || 0);
    return Math.max(0, Math.ceil((until - Date.now()) / 1000));
  }

  function setLock(seconds) {
    sessionStorage.setItem(LOCK_UNTIL_KEY, String(Date.now() + seconds * 1000));
  }

  function addFailAndMaybeLock() {
    const n = (+(sessionStorage.getItem(FAIL_KEY) || 0)) + 1;
    sessionStorage.setItem(FAIL_KEY, String(n));
    if (n >= 5) {
      const m = Math.min(60, Math.pow(2, n - 5));
      setLock(m * 60);
    }
  }

  function resetFails() {
    sessionStorage.removeItem(FAIL_KEY);
    sessionStorage.removeItem(LOCK_UNTIL_KEY);
  }

  let idleTimer = null;
  function startIdleLogout() {
    const kick = () => {
      sessionStorage.removeItem(KEY_OK);
      sessionStorage.removeItem(HOME_SLIP_KEY);
      location.reload();
    };
    const bump = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(kick, IDLE_MS);
    };
    ['click', 'keydown', 'mousemove', 'touchstart', 'scroll'].forEach(ev => {
      document.addEventListener(ev, bump, { passive: true });
    });
    bump();
  }

  function enableDevtoolsWatchAfterLogin() {
    let suspect = 0;

    function trig() {
      if (++suspect >= 3) shield.style.display = 'flex';
    }

    setInterval(() => {
      if (
        Math.abs(window.outerWidth - window.innerWidth) > 250 ||
        Math.abs(window.outerHeight - window.innerHeight) > 250
      ) {
        trig();
      } else {
        suspect = 0;
      }
    }, 1000);

    (function loop(p) {
      const n = performance.now();
      if (n - p > 1200) trig();
      else suspect = 0;
      requestAnimationFrame(() => loop(performance.now()));
    })(performance.now());
  }

  async function sha256Hex(t) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function showSlipGate() {
    gate.classList.add('hidden');
    app.classList.add('hidden');
    slipGate.classList.remove('hidden');
    slipErr.style.display = 'none';
    slipInput.value = sessionStorage.getItem(HOME_SLIP_KEY) || String(DEFAULT_SLIP_PER_SIDE);
    slipInput.focus();
  }

  async function enter() {
    err.style.display = 'none';

    if (isLocked()) {
      err.textContent = `嘗試次數過多，請 ${remainingLockSec()} 秒後再試。`;
      err.style.display = '';
      return;
    }

    const v = (pwd.value || '').trim();
    if (!v) {
      err.textContent = '請輸入密碼 / Please enter password.';
      err.style.display = '';
      return;
    }

    const t0 = Date.now();

    if (await sha256Hex(v) === PASS_HASH) {
      sessionStorage.setItem(KEY_OK, '1');
      resetFails();
      showSlipGate();
    } else {
      const delay = 1000 + Math.random() * 600 - (Date.now() - t0);
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
      addFailAndMaybeLock();
      err.textContent = '密碼錯誤，請再試一次。/ Incorrect password.';
      err.style.display = '';
    }
  }

  function startAppWithSlip(slipPerSide) {
    sessionStorage.setItem(HOME_SLIP_KEY, String(slipPerSide));
    slipGate.classList.add('hidden');
    gate.classList.add('hidden');
    app.classList.remove('hidden');
    startIdleLogout();
    enableDevtoolsWatchAfterLogin();
    loadDepsAndRun(slipPerSide);
  }

  function confirmSlip(customValue) {
    slipErr.style.display = 'none';
    const n = Number(customValue);
    if (!Number.isFinite(n) || n < 0) {
      slipErr.textContent = '請輸入有效滑點。';
      slipErr.style.display = '';
      return;
    }
    startAppWithSlip(n);
  }

  btnLogin.addEventListener('click', enter);
  btnClear.addEventListener('click', () => {
    pwd.value = '';
    err.style.display = 'none';
    resetFails();
    sessionStorage.removeItem(KEY_OK);
    sessionStorage.removeItem(HOME_SLIP_KEY);
    pwd.focus();
  });
  pwd.addEventListener('keydown', e => {
    if (e.key === 'Enter') enter();
  });

  btnSlipConfirm.addEventListener('click', () => confirmSlip(slipInput.value));
  btnSlipDefault.addEventListener('click', () => confirmSlip(DEFAULT_SLIP_PER_SIDE));
  slipInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') confirmSlip(slipInput.value);
  });

  (function boot() {
    if (sessionStorage.getItem(KEY_OK) === '1') {
      const slip = sessionStorage.getItem(HOME_SLIP_KEY);
      if (slip == null) {
        showSlipGate();
      } else {
        startAppWithSlip(Number(slip));
      }
    }
  })();

  function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = () => rej(new Error('load fail: ' + src));
      document.body.appendChild(s);
    });
  }

  const CANON_RE = /^(\d{14})\.0{6}\s+(\d+\.\d{6})\s+(新買|平賣|新賣|平買|強制平倉)\s*$/;
  const EXTRACT_RE = /.*?(\d{14})(?:\.0{1,6})?\s+(\d+(?:\.\d{1,6})?)\s*(新買|平賣|新賣|平買|強制平倉)\s*$/;
  const CSV_LINE_RE = /^(\d{8}),(\d{5,6}),(\d+(?:\.\d+)?),([^,]+?),/;

  function mapAction(act) {
    if (act === '強平') return '強制平倉';
    if (/^(買進|加碼|再加碼|加碼攤平)$/i.test(act)) return '新買';
    if (/^賣出$/i.test(act)) return '平賣';
    return act;
  }

  function normalizeText(raw) {
    let s = raw.replace(/\ufeff/gi, '').replace(/\u200b|\u200c|\u200d/gi, '');
    s = s
      .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/\u3000/g, ' ');
    return s
      .split('\n')
      .map(l => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  }

  function padTime6(t) {
    t = String(t || '').trim();
    return t.padStart(6, '0').slice(0, 6);
  }

  function canonicalize(txt) {
    const out = [];
    let ok = 0;
    const lines = txt.split('\n');

    for (const l of lines) {
      let m = l.match(EXTRACT_RE);
      if (m) {
        const ts = m[1];
        const px = Number(m[2]);
        out.push(`${ts}.000000 ${px.toFixed(6)} ${m[3]}`);
        ok++;
        continue;
      }

      m = l.match(CSV_LINE_RE);
      if (m) {
        const d8 = m[1];
        const t6 = padTime6(m[2]);
        const px = Number(m[3]);
        const act0 = m[4].trim();
        if (Number.isFinite(px)) {
          out.push(`${d8}${t6}.000000 ${px.toFixed(6)} ${mapAction(act0)}`);
          ok++;
          continue;
        }
      }
    }

    return { canon: out.join('\n'), ok };
  }

  async function blobToCanon(blob) {
    const buf = await blob.arrayBuffer();

    for (const enc of ['utf-8', 'big5', 'utf-16le', 'utf-16be']) {
      try {
        const td = new TextDecoder(enc);
        const norm = normalizeText(td.decode(buf));
        const { canon, ok } = canonicalize(norm);
        if (ok > 0) return { canon, ok };
      } catch (_) {}
    }

    const td = new TextDecoder('utf-8');
    const norm = normalizeText(td.decode(buf));
    const { canon, ok } = canonicalize(norm);
    return { canon, ok };
  }

  function parseCanon(text) {
    const rows = [];
    if (!text) return rows;

    for (const line of text.split('\n')) {
      const m = line.match(CANON_RE);
      if (m) rows.push({ ts: m[1], line });
    }

    rows.sort((a, b) => a.ts.localeCompare(b.ts));
    return rows;
  }

  function configureSharedForSlip(slipPerSide) {
    window.SLIP_PER_SIDE = slipPerSide;
    window.SHARED_CFG = {
      slipPerSide,
      pointValue: DEFAULT_POINT_VALUE,
      feePerSide: DEFAULT_FEE_PER_SIDE,
      taxRate: DEFAULT_TAX_RATE
    };
    window.HOMEPAGE_CFG = {
      slipPerSide,
      pointValue: DEFAULT_POINT_VALUE,
      feePerSide: DEFAULT_FEE_PER_SIDE,
      taxRate: DEFAULT_TAX_RATE
    };
  }

  function getTradeGainValue(t) {
    const candidates = [
      t?.gainSlip,
      t?.gain_slip,
      t?.pnlSlip,
      t?.pnl_slip,
      t?.netSlip,
      t?.net_slip,
      t?.gain
    ];

    for (const v of candidates) {
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return null;
  }

  function dailySeriesFromMerged(mergedTxt, slipPerSide) {
    if (!window.SHARED) throw new Error('window.SHARED 未載入');
    if (typeof window.SHARED.parseTXT !== 'function') throw new Error('SHARED.parseTXT 不存在');
    if (typeof window.SHARED.buildReport !== 'function') throw new Error('SHARED.buildReport 不存在');

    configureSharedForSlip(slipPerSide);

    const parsed = window.SHARED.parseTXT(mergedTxt);
    if (!parsed || !Array.isArray(parsed.rows)) throw new Error('parseTXT 結果異常');

    let report = null;
    try {
      report = window.SHARED.buildReport(parsed.rows, {
        slipPerSide,
        pointValue: DEFAULT_POINT_VALUE,
        feePerSide: DEFAULT_FEE_PER_SIDE,
        taxRate: DEFAULT_TAX_RATE
      });
    } catch (_) {
      report = window.SHARED.buildReport(parsed.rows);
    }

    if (!report || !Array.isArray(report.trades)) throw new Error('buildReport 結果異常');

    const m = new Map();
    for (const t of report.trades) {
      if (!t || t.tsOut == null) continue;
      const gain = getTradeGainValue(t);
      if (gain == null) continue;
      const d = String(t.tsOut).slice(0, 8);
      m.set(d, (m.get(d) || 0) + gain);
    }

    return m;
  }

  function atMidnight(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  function mondayOf(d) {
    const x = atMidnight(d);
    const dow = x.getDay();
    const offsetToMonday = (dow + 6) % 7;
    x.setDate(x.getDate() - offsetToMonday);
    return x;
  }

  function sundayOfWeek(d) {
    const m = mondayOf(d);
    const s = new Date(m.getTime());
    s.setDate(s.getDate() + 6);
    return s;
  }

  function addMonthsSameDay(d, n) {
    const x = atMidnight(d);
    const day = x.getDate();
    x.setMonth(x.getMonth() + n);
    x.setDate(day);
    return atMidnight(x);
  }

  function addYearsSameDay(d, n) {
    const x = atMidnight(d);
    const day = x.getDate();
    x.setFullYear(x.getFullYear() + n);
    x.setDate(day);
    return atMidnight(x);
  }

  function fmtDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}/${m}/${dd}`;
  }

  function fmtYmd8(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${dd}`;
  }

  function d8ToDate(s8) {
    return new Date(+s8.slice(0, 4), +s8.slice(4, 6) - 1, +s8.slice(6, 8));
  }

  function getAnchorWeekEnd() {
    const today = new Date();
    return sundayOfWeek(today);
  }

  function makeCoveredSeries(dayMap, coverageStartDate, coverageEndDate) {
    const days = [];
    const vals = [];
    let cur = new Date(coverageStartDate.getTime());
    while (cur <= coverageEndDate) {
      const d8 = fmtYmd8(cur);
      days.push(d8);
      vals.push(dayMap.get(d8) || 0);
      cur.setDate(cur.getDate() + 1);
    }
    return { days, vals };
  }

  function buildPrefix(vals) {
    const p = [0];
    for (const v of vals) p.push(p[p.length - 1] + v);
    return p;
  }

  function sumBetweenCovered(days, vals, pref, startDate, endDate, coverageStartDate, coverageEndDate) {
    if (startDate < coverageStartDate) return null;
    if (endDate > coverageEndDate) return null;
    if (!days.length) return 0;

    const start8 = fmtYmd8(startDate);
    const end8 = fmtYmd8(endDate);

    let i = days.findIndex(d => d >= start8);
    if (i < 0) return null;

    let j = -1;
    for (let idx = days.length - 1; idx >= 0; idx--) {
      if (days[idx] <= end8) {
        j = idx;
        break;
      }
    }
    if (j < i) return 0;

    return pref[j + 1] - pref[i];
  }

  function weekReturnUser(days, vals, pref, coverageStartDate, coverageEndDate, nWeeks) {
    const end = getAnchorWeekEnd();
    const start = new Date(mondayOf(end).getTime());
    start.setDate(start.getDate() - (nWeeks - 1) * 7);

    const sum = sumBetweenCovered(days, vals, pref, start, end, coverageStartDate, coverageEndDate);
    return {
      ret: (sum == null ? null : sum / 1_000_000),
      range: `${fmtDate(start)}~${fmtDate(end)}`
    };
  }

  function monthReturnUser(days, vals, pref, coverageStartDate, coverageEndDate, nMonths) {
    const end = getAnchorWeekEnd();
    const base = addMonthsSameDay(end, -nMonths);
    const start = mondayOf(base);

    const sum = sumBetweenCovered(days, vals, pref, start, end, coverageStartDate, coverageEndDate);
    return {
      ret: (sum == null ? null : sum / 1_000_000),
      range: `${fmtDate(start)}~${fmtDate(end)}`
    };
  }

  function yearReturnUser(days, vals, pref, coverageStartDate, coverageEndDate, nYears) {
    const end = getAnchorWeekEnd();
    const base = addYearsSameDay(end, -nYears);
    const start = mondayOf(base);

    const sum = sumBetweenCovered(days, vals, pref, start, end, coverageStartDate, coverageEndDate);
    return {
      ret: (sum == null ? null : sum / 1_000_000),
      range: `${fmtDate(start)}~${fmtDate(end)}`
    };
  }

  function setVal(id, v) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('pos', 'neg', 'neu');

    if (v == null) {
      el.textContent = '—';
      el.classList.add('neu');
      return;
    }

    el.textContent = (v * 100).toFixed(2) + '%';
    el.classList.add(v > 0 ? 'pos' : (v < 0 ? 'neg' : 'neu'));
  }

  function setAvg(id, v) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('pos', 'neg', 'neu');

    if (v == null) {
      el.textContent = '—';
      el.classList.add('neu');
      return;
    }

    el.textContent = (v * 100).toFixed(2) + '%';
    el.classList.add(v > 0 ? 'pos' : (v < 0 ? 'neg' : 'neu'));
  }

  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text || '—';
  }

  function setCardStatus(key, text, color) {
    const el = document.getElementById(`status-${key}`);
    if (!el) return;
    el.textContent = text || '';
    el.style.color = color || '#6b7280';
  }

  function setPeriodText(key, start8, end8) {
    const el = document.getElementById(`period-${key}`);
    if (!el) return;
    if (!start8 || !end8) {
      el.textContent = '—';
      return;
    }
    el.textContent = `${start8} - ${end8}`;
  }

  function setRowVisible(key, rowKey, visible) {
    const row = document.getElementById(`row-${rowKey}-${key}`);
    if (row) row.style.display = visible ? 'grid' : 'none';
  }

  function resetAll(key) {
    const keys = ['wk1','wk2','wk3','wk4','m2','m3','m4','m5','m6','y1','y2','y3','y4','y5','y6'];
    keys.forEach(k => {
      setText(`${k}-range-${key}`, '—');
      setVal(`${k}-${key}`, null);
      setAvg(`${k}-avg-${key}`, null);
      setRowVisible(key, k, true);
    });
  }

  const WANT = {
    "0807": /0807/i,
    "1001": /1001/i,
    "1001pp": /1001plus/i,
    "0313": /0313/i
  };

  const RANGE_RE = /\b(20\d{6})-(20\d{6})\b/;

  function extractRangeFromPath(p) {
    const m = String(p || '').match(RANGE_RE);
    if (!m) return null;
    const a = +m[1];
    const b = +m[2];
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
    return { start: a, end: b };
  }

  function addDaysYmd(ymd, days) {
    const s = String(ymd);
    const dt = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
    dt.setDate(dt.getDate() + days);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return +(String(y) + m + d);
  }

  function chooseChainByRange(files) {
    const segs = files
      .map(f => {
        const r = extractRangeFromPath(f.fullPath) || extractRangeFromPath(f.name);
        return r ? { ...f, r } : null;
      })
      .filter(Boolean);

    if (!segs.length) return null;

    segs.sort((a, b) => {
      if (a.r.start !== b.r.start) return a.r.start - b.r.start;
      if (a.r.end !== b.r.end) return b.r.end - a.r.end;
      return (b.metadata?.size || 0) - (a.metadata?.size || 0);
    });

    const earliestStart = segs[0].r.start;
    const baseCandidates = segs.filter(s => s.r.start === earliestStart);
    baseCandidates.sort((a, b) => {
      if (a.r.end !== b.r.end) return b.r.end - a.r.end;
      return (b.metadata?.size || 0) - (a.metadata?.size || 0);
    });

    const chain = [baseCandidates[0]];
    let curEnd = chain[0].r.end;

    while (true) {
      const allowStart = addDaysYmd(curEnd, 7);
      const cands = segs.filter(s => s.r.start <= allowStart && s.r.end > curEnd);
      if (!cands.length) break;

      cands.sort((a, b) => {
        if (a.r.end !== b.r.end) return b.r.end - a.r.end;
        const ta = Date.parse(a.updated_at || 0) || 0;
        const tb = Date.parse(b.updated_at || 0) || 0;
        if (ta !== tb) return tb - ta;
        return (b.metadata?.size || 0) - (a.metadata?.size || 0);
      });

      const pick = cands[0];
      if (!chain.some(x => x.fullPath === pick.fullPath)) chain.push(pick);
      curEnd = Math.max(curEnd, pick.r.end);
    }

    chain.sort((a, b) => a.r.start - b.r.start);

    return {
      chain,
      start: Math.min(...chain.map(x => x.r.start)),
      end: Math.max(...chain.map(x => x.r.end))
    };
  }

  function mergeCanonTexts(canonTexts) {
    const seen = new Set();
    const rows = [];

    for (const txt of canonTexts) {
      if (!txt) continue;
      for (const line of String(txt).split('\n')) {
        const m = line.match(CANON_RE);
        if (!m) continue;
        if (seen.has(line)) continue;
        seen.add(line);
        rows.push({ ts: m[1], line });
      }
    }

    rows.sort((a, b) => a.ts.localeCompare(b.ts));
    return rows.map(r => r.line).join('\n');
  }

  function shortErrMsg(e) {
    if (!e) return '未知錯誤';
    const s = String(e && e.message ? e.message : e);
    return s.length > 80 ? s.slice(0, 80) + '…' : s;
  }

  async function loadDepsAndRun(slipPerSide) {
    try {
      await loadScript('https://unpkg.com/@supabase/supabase-js@2');
      await loadScript('shared.js?v=txfee45tax2');
    } catch (e) {
      ['0807','1001','1001pp','0313'].forEach(k => {
        setCardStatus(k, '錯誤：' + shortErrMsg(e), '#b91c1c');
      });
      return;
    }

    const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { fetch: (u, o = {}) => fetch(u, { ...o, cache: 'no-store' }) }
    });

    async function listDir(prefix) {
      const p = (prefix && !prefix.endsWith('/')) ? prefix + '/' : (prefix || '');
      const { data, error } = await sb.storage.from(BUCKET).list(p, {
        limit: 1000,
        sortBy: { column: 'name', order: 'asc' }
      });
      if (error) throw error;
      return (data || []).map(it => ({ ...it, fullPath: p + it.name }));
    }

    async function listDeepN(prefix, depth, maxDepth, out) {
      if (depth > maxDepth) return;
      const entries = await listDir(prefix);
      for (const it of entries) {
        if (!it.id && !it.metadata) {
          await listDeepN(it.fullPath, depth + 1, maxDepth, out);
        } else {
          out.push(it);
        }
      }
    }

    async function listAllFilesByRegex(keyRegex) {
      const all = [];
      await listDeepN('', 0, 8, all);
      return all.filter(it => {
        if (!it.metadata) return false;
        const n = (it.name || '');
        const p = (it.fullPath || '');
        return keyRegex.test(p) || keyRegex.test(n);
      });
    }

    function pickLatestByUpdate(files) {
      if (!files.length) return null;
      const xs = files.slice();
      xs.sort((a, b) => {
        const ta = Date.parse(a.updated_at || 0) || 0;
        const tb = Date.parse(b.updated_at || 0) || 0;
        if (ta !== tb) return tb - ta;
        return (b.metadata?.size || 0) - (a.metadata?.size || 0);
      });
      return xs[0];
    }

    async function downloadCanon(fullPath) {
      const { data, error } = await sb.storage.from(BUCKET).download(fullPath);
      if (error) throw error;
      if (!data) throw new Error('download 無資料');
      return await blobToCanon(data);
    }

    async function resolveMergedForKey(key) {
      const files = await listAllFilesByRegex(WANT[key]);
      if (!files.length) return null;

      const chainInfo = chooseChainByRange(files);

      if (!chainInfo) {
        const latest = pickLatestByUpdate(files);
        if (!latest) return null;
        const canonObj = await downloadCanon(latest.fullPath);
        return {
          canon: canonObj.canon,
          periodStart: null
        };
      }

      const canonTexts = [];
      for (const f of chainInfo.chain) {
        const { canon } = await downloadCanon(f.fullPath);
        canonTexts.push(canon);
      }

      const mergedCanon = mergeCanonTexts(canonTexts);

      return {
        canon: mergedCanon,
        periodStart: String(chainInfo.start)
      };
    }

    function applyVisibleRows(key, coverageStartDate, coverageEndDate) {
      const totalSpanDays = (coverageEndDate - coverageStartDate) / (1000 * 60 * 60 * 24);

      setRowVisible(key, 'wk1', totalSpanDays >= 7);
      setRowVisible(key, 'wk2', totalSpanDays >= 14);
      setRowVisible(key, 'wk3', totalSpanDays >= 21);
      setRowVisible(key, 'wk4', totalSpanDays >= 28);

      setRowVisible(key, 'm2', totalSpanDays >= 60);
      setRowVisible(key, 'm3', totalSpanDays >= 90);
      setRowVisible(key, 'm4', totalSpanDays >= 120);
      setRowVisible(key, 'm5', totalSpanDays >= 150);
      setRowVisible(key, 'm6', totalSpanDays >= 180);

      setRowVisible(key, 'y1', totalSpanDays >= 365);
      setRowVisible(key, 'y2', totalSpanDays >= 365 * 2);
      setRowVisible(key, 'y3', totalSpanDays >= 365 * 3);
      setRowVisible(key, 'y4', totalSpanDays >= 365 * 4);
      setRowVisible(key, 'y5', totalSpanDays >= 365 * 5);
      setRowVisible(key, 'y6', totalSpanDays >= 365 * 6);
    }

    async function fillCard(key) {
      setCardStatus(key, `讀取中（滑點 ${slipPerSide} 點）...`, '#6b7280');

      try {
        const merged = await resolveMergedForKey(key);
        if (!merged || !merged.canon) {
          resetAll(key);
          setPeriodText(key, null, null);
          setCardStatus(key, '無資料', '#b45309');
          return;
        }

        const rows = parseCanon(merged.canon);
        if (!rows.length) throw new Error('canonical 交易列為空');

        const coverageStart8 = merged.periodStart || rows[0].ts.slice(0, 8);
        const coverageStartDate = d8ToDate(coverageStart8);
        const coverageEndDate = getAnchorWeekEnd();

        setPeriodText(key, coverageStart8, fmtYmd8(coverageEndDate));

        const dayMap = dailySeriesFromMerged(merged.canon, slipPerSide);
        const covered = makeCoveredSeries(dayMap, coverageStartDate, coverageEndDate);
        const pref = buildPrefix(covered.vals);

        applyVisibleRows(key, coverageStartDate, coverageEndDate);

        const weekDefs = [['wk1',1],['wk2',2],['wk3',3],['wk4',4]];
        const monthDefs = [['m2',2],['m3',3],['m4',4],['m5',5],['m6',6]];
        const yearDefs = [['y1',1],['y2',2],['y3',3],['y4',4],['y5',5],['y6',6]];

        weekDefs.forEach(([k,n]) => {
          const r = weekReturnUser(covered.days, covered.vals, pref, coverageStartDate, coverageEndDate, n);
          if (r.ret == null) {
            setRowVisible(key, k, false);
            return;
          }
          setText(`${k}-range-${key}`, r.range);
          setVal(`${k}-${key}`, r.ret);
          setAvg(`${k}-avg-${key}`, null);
        });

        monthDefs.forEach(([k,n]) => {
          const r = monthReturnUser(covered.days, covered.vals, pref, coverageStartDate, coverageEndDate, n);
          if (r.ret == null) {
            setRowVisible(key, k, false);
            return;
          }
          setText(`${k}-range-${key}`, r.range);
          setVal(`${k}-${key}`, r.ret);
          setAvg(`${k}-avg-${key}`, null);
        });

        yearDefs.forEach(([k,n]) => {
          const r = yearReturnUser(covered.days, covered.vals, pref, coverageStartDate, coverageEndDate, n);
          if (r.ret == null) {
            setRowVisible(key, k, false);
            return;
          }
          const avg = r.ret / n;
          setText(`${k}-range-${key}`, r.range);
          setVal(`${k}-${key}`, r.ret);
          setAvg(`${k}-avg-${key}`, avg);
        });

        setCardStatus(key, `已完成（滑點 ${slipPerSide} 點）`, '#15803d');
      } catch (e) {
        console.error('fillCard error', key, e);
        resetAll(key);
        setPeriodText(key, null, null);
        setCardStatus(key, '錯誤：' + shortErrMsg(e), '#b91c1c');
      }
    }

    for (const key of ['0807','1001','1001pp','0313']) {
      await fillCard(key);
    }
  }
})();
