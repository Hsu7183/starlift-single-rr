(function () {
  'use strict';

  // ====== 基本常數 ======
  const SUPABASE_URL = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ5aGJtbW5hY2V6emdrd2Zrb3pzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1OTE0NzksImV4cCI6MjA3NDE2NzQ3OX0.VCSye3-fKrQphejdJSWAM6iRzv_7gkl8MLe7NeVszR0";
  const BUCKET = "reports";

  const PASS_HASH = "0f2b9305e317408510dc9878381e953630ed9fa3d2aadf95f1b8eb47941b18b9";
  const KEY_OK = '__auth_ok__', FAIL_KEY = '__auth_fail__', LOCK_UNTIL_KEY = '__auth_lock_until__';
  const IDLE_MS = 30 * 60 * 1000;

  const $ = s => document.querySelector(s);
  const shield = $('#shield'), gate = $('#gate'), app = $('#app');
  const pwd = $('#pwd'), btnLogin = $('#btnLogin'), btnClear = $('#btnClear'), err = $('#err');

  // ====== 反嵌入 + 防開發者工具 ======
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

  // ====== 密碼門檻 ======
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
      location.reload();
    };
    const bump = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(kick, IDLE_MS);
    };
    ['click', 'keydown', 'mousemove', 'touchstart', 'scroll']
      .forEach(ev => document.addEventListener(ev, bump, { passive: true }));
    bump();
  }

  function enableDevtoolsWatchAfterLogin() {
    let suspect = 0;
    function trig() { if (++suspect >= 3) shield.style.display = 'flex'; }
    setInterval(() => {
      if (Math.abs(window.outerWidth - window.innerWidth) > 250 ||
          Math.abs(window.outerHeight - window.innerHeight) > 250) trig();
      else suspect = 0;
    }, 1000);
    (function loop(p) {
      const n = performance.now();
      if (n - p > 1200) trig(); else suspect = 0;
      requestAnimationFrame(() => loop(performance.now()));
    })(performance.now());
  }

  async function sha256Hex(t) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
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
      sessionStorage.setItem(KEY_OK, '1'); resetFails();
      gate.classList.add('hidden'); app.classList.remove('hidden');
      startIdleLogout(); enableDevtoolsWatchAfterLogin(); loadDepsAndRun();
    } else {
      const delay = 1000 + Math.random() * 600 - (Date.now() - t0);
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
      addFailAndMaybeLock();
      err.textContent = '密碼錯誤，請再試一次。/ Incorrect password.';
      err.style.display = '';
    }
  }

  btnLogin.addEventListener('click', enter);
  btnClear.addEventListener('click', () => {
    pwd.value = '';
    err.style.display = 'none';
    resetFails();
    sessionStorage.removeItem(KEY_OK);
    pwd.focus();
  });
  pwd.addEventListener('keydown', e => { if (e.key === 'Enter') enter(); });

  (function boot() {
    if (sessionStorage.getItem(KEY_OK) === '1') {
      gate.classList.add('hidden'); app.classList.remove('hidden');
      startIdleLogout(); enableDevtoolsWatchAfterLogin(); loadDepsAndRun();
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

  // ====== 報酬率計算相關 ======
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
    s = s.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '')
         .replace(/\r\n?/g, '\n')
         .replace(/\u3000/g, ' ');
    return s.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  }

  function padTime6(t) {
    t = String(t || '').trim();
    return t.padStart(6, '0').slice(0, 6);
  }

  function canonicalize(txt) {
    const out = []; let ok = 0;
    const lines = txt.split('\n');
    for (const l of lines) {
      let m = l.match(EXTRACT_RE);
      if (m) {
        const ts = m[1], px = Number(m[2]);
        out.push(`${ts}.000000 ${px.toFixed(6)} ${m[3]}`);
        ok++; continue;
      }
      m = l.match(CSV_LINE_RE);
      if (m) {
        const d8 = m[1], t6 = padTime6(m[2]), px = Number(m[3]), act0 = m[4].trim();
        if (Number.isFinite(px)) {
          out.push(`${d8}${t6}.000000 ${px.toFixed(6)} ${mapAction(act0)}`);
          ok++; continue;
        }
      }
    }
    return { canon: out.join('\n'), ok };
  }

  async function fetchSmart(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    for (const enc of ['utf-8', 'big5', 'utf-16le', 'utf-16be']) {
      try {
        const td = new TextDecoder(enc);
        const norm = normalizeText(td.decode(buf));
        const { canon, ok } = canonicalize(norm);
        if (ok > 0) return { canon, ok };
      } catch { }
    }
    const td = new TextDecoder('utf-8');
    const norm = normalizeText(td.decode(buf));
    const { canon, ok } = canonicalize(norm);
    return { canon, ok };
  }

  function parseCanon(text) {
    const rows = []; if (!text) return rows;
    for (const line of text.split('\n')) {
      const m = line.match(CANON_RE);
      if (m) rows.push({ ts: m[1], line });
    }
    rows.sort((a, b) => a.ts.localeCompare(b.ts));
    return rows;
  }

  function dailySeriesFromMerged(mergedTxt) {
    const parsed = window.SHARED.parseTXT(mergedTxt);
    const report = window.SHARED.buildReport(parsed.rows);
    const m = new Map();
    for (const t of report.trades) {
      const d = String(t.tsOut).slice(0, 8);
      m.set(d, (m.get(d) || 0) + t.gainSlip);
    }
    const days = [...m.keys()].sort();
    const vals = days.map(d => m.get(d));
    return { days, vals };
  }

  const d8 = s => new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00`);
  const fmtD8 = s => `${s.slice(0, 4)}/${s.slice(4, 6)}/${s.slice(6, 8)}`;

  function buildPrefix(vals) {
    const p = [0];
    for (const v of vals) p.push(p[p.length - 1] + v);
    return p;
  }

  // 近 N 週：那一週星期一起算，迄今
  function weekReturnFixed(days, vals, weekIndex) {
    if (!days.length) return { ret: null, range: '---' };
    const pref = buildPrefix(vals);
    const lastIdx = days.length - 1;
    const lastDate = d8(days[lastIdx]);

    const dow = lastDate.getDay();
    const offsetToMonday = (dow + 6) % 7;
    const baseMonday = new Date(
      lastDate.getFullYear(),
      lastDate.getMonth(),
      lastDate.getDate() - offsetToMonday
    );

    const startDate = new Date(baseMonday.getTime() - (weekIndex - 1) * 7 * 86400000);
    const endDate = lastDate;

    if (endDate < startDate) return { ret: null, range: '---' };
    if (endDate < d8(days[0]) || startDate > d8(days[lastIdx])) return { ret: null, range: '---' };

    let i = 0;
    while (i <= lastIdx && d8(days[i]) < startDate) i++;
    if (i > lastIdx) return { ret: null, range: '---' };

    let j = lastIdx;
    while (j >= 0 && d8(days[j]) > endDate) j--;
    if (j < i) return { ret: null, range: '---' };

    const sum = pref[j + 1] - pref[i];
    const startStr = fmtD8(days[i]);
    const endStr = fmtD8(days[j]);

    return { ret: sum / 1_000_000, range: `${startStr}~${endStr}` };
  }

  // 近 N 月：該月1號起算，迄今
  function monthReturnFixed(days, vals, monthIndex) {
    if (!days.length) return { ret: null, range: '---' };
    const pref = buildPrefix(vals);
    const lastIdx = days.length - 1;
    const lastDate = d8(days[lastIdx]);

    const tmp = new Date(lastDate.getFullYear(), lastDate.getMonth(), 1);
    tmp.setMonth(tmp.getMonth() - (monthIndex - 1));

    const startDate = new Date(tmp.getFullYear(), tmp.getMonth(), 1);
    const endDate = lastDate;

    if (endDate < startDate) return { ret: null, range: '---' };
    if (endDate < d8(days[0]) || startDate > d8(days[lastIdx])) return { ret: null, range: '---' };

    let i = 0;
    while (i <= lastIdx && d8(days[i]) < startDate) i++;
    if (i > lastIdx) return { ret: null, range: '---' };

    let j = lastIdx;
    while (j >= 0 && d8(days[j]) > endDate) j--;
    if (j < i) return { ret: null, range: '---' };

    const sum = pref[j + 1] - pref[i];
    const startStr = fmtD8(days[i]);
    const endStr = fmtD8(days[j]);

    return { ret: sum / 1_000_000, range: `${startStr}~${endStr}` };
  }

  // 近 N 年：該年 1/1 起算，迄今；資料不滿 N 年就當無資料
  function yearReturnFixed(days, vals, yearIndex) {
    if (!days.length) return { ret: null, range: '---' };
    const pref = buildPrefix(vals);
    const firstDate = d8(days[0]);
    const lastIdx = days.length - 1;
    const lastDate = d8(days[lastIdx]);

    const coverDays = Math.round((lastDate - firstDate) / 86400000) + 1;
    const minCover = 365 * yearIndex - 60; // 預留 60 天誤差
    if (coverDays < minCover) return { ret: null, range: '---' };

    const tmp = new Date(lastDate.getFullYear(), 0, 1);
    tmp.setFullYear(tmp.getFullYear() - (yearIndex - 1));

    const startDate = new Date(tmp.getFullYear(), 0, 1);
    const endDate = lastDate;

    if (endDate < startDate) return { ret: null, range: '---' };
    if (endDate < firstDate || startDate > lastDate) return { ret: null, range: '---' };

    let i = 0;
    while (i <= lastIdx && d8(days[i]) < startDate) i++;
    if (i > lastIdx) return { ret: null, range: '---' };

    let j = lastIdx;
    while (j >= 0 && d8(days[j]) > endDate) j--;
    if (j < i) return { ret: null, range: '---' };

    const sum = pref[j + 1] - pref[i];
    const startStr = fmtD8(days[i]);
    const endStr = fmtD8(days[j]);

    return { ret: sum / 1_000_000, range: `${startStr}~${endStr}` };
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
  function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text || '—';
  }

  const WEEK_KEYS = ['wk1', 'wk2', 'wk3', 'wk4'];
  const MONTH_KEYS = ['m2', 'm3', 'm4', 'm5', 'm6'];
  const YEAR_KEYS = ['y1', 'y2', 'y3', 'y4', 'y5'];
  const ALL_KEYS = WEEK_KEYS.concat(MONTH_KEYS).concat(YEAR_KEYS);

  function resetAll(key) {
    ALL_KEYS.forEach(k => {
      setText(`${k}-range-${key}`, '—');
      setVal(`${k}-${key}`, null);
    });
    YEAR_KEYS.forEach(k => {
      const row = document.getElementById(`row-${k}-${key}`);
      if (row) row.style.display = 'none';
    });
  }

  const WANT = {
    "0807": /(0807)/i,
    "1001": /(1001)/i,
    "00909": /(00909|etf[-_]?00909)/i
  };

  // ====== 新增：用檔名/路徑抓分段起訖，串檔合併 ======
  const RANGE_RE = /\b(20\d{6})-(20\d{6})\b/;

  function extractRangeFromPath(p) {
    const m = String(p || '').match(RANGE_RE);
    if (!m) return null;
    const a = +m[1], b = +m[2];
    if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) return null;
    return { start: a, end: b };
  }

  // 允許一點空窗（例如週末/無交易日），用「日」做簡單容忍
  function addDaysYmd(ymd, days) {
    const s = String(ymd);
    const dt = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
    dt.setDate(dt.getDate() + days);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return +(String(y) + m + d);
  }

  // 從所有候選檔中，挑出「能從最早一路延伸到最晚」的一串檔（避免重複下載全重疊大檔）
  function chooseChainByRange(files) {
    const segs = files
      .map(f => {
        const r = extractRangeFromPath(f.fullPath) || extractRangeFromPath(f.name);
        return r ? { ...f, r } : null;
      })
      .filter(Boolean);

    if (!segs.length) return null;

    // 先找最早 start
    segs.sort((a, b) => {
      if (a.r.start !== b.r.start) return a.r.start - b.r.start;
      if (a.r.end !== b.r.end) return b.r.end - a.r.end;
      return (b.metadata?.size || 0) - (a.metadata?.size || 0);
    });

    const earliestStart = segs[0].r.start;

    // base：同樣 earliestStart 中 end 最大者
    const baseCandidates = segs.filter(s => s.r.start === earliestStart);
    baseCandidates.sort((a, b) => {
      if (a.r.end !== b.r.end) return b.r.end - a.r.end;
      return (b.metadata?.size || 0) - (a.metadata?.size || 0);
    });

    const chain = [baseCandidates[0]];
    let curEnd = chain[0].r.end;

    // 反覆找能把 end 往後推的檔
    // 條件：start <= curEnd(+7天容忍) 且 end > curEnd
    // 選擇：在符合者中挑 end 最大（同 end 比大小/更新）
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

      // 去重：同一路徑就不再加
      if (!chain.some(x => x.fullPath === pick.fullPath)) {
        chain.push(pick);
      }
      curEnd = Math.max(curEnd, pick.r.end);
    }

    // chain 依 start 排序（下載/合併順序比較直覺）
    chain.sort((a, b) => a.r.start - b.r.start);

    return {
      chain,
      start: Math.min(...chain.map(x => x.r.start)),
      end: Math.max(...chain.map(x => x.r.end))
    };
  }

  // 合併多檔 canonical：去重、依 ts 排序
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

  async function loadDepsAndRun() {
    await loadScript('https://unpkg.com/@supabase/supabase-js@2');
    await loadScript('shared.js?v=txfee45tax2');

    (async function () {
      const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { fetch: (u, o = {}) => fetch(u, { ...o, cache: 'no-store' }) }
      });

      const pubUrl = (path) => sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

      async function listDir(prefix) {
        const p = (prefix && !prefix.endsWith('/')) ? prefix + '/' : (prefix || '');
        const { data } = await sb.storage.from(BUCKET).list(p, {
          limit: 1000,
          sortBy: { column: 'name', order: 'asc' }
        });
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

      async function readManifest(name) {
        const tries = [name, `tw-${name}`];
        for (const n of tries) {
          try {
            const { data } = await sb.storage.from(BUCKET).download(`manifests/${n}.json`);
            if (data) return JSON.parse(await data.text());
          } catch { }
        }
        return null;
      }

      async function listAllFilesByRegex(keyRegex) {
        const all = [];
        await listDeepN('', 0, 8, all);
        return all.filter(it => {
          const n = (it.name || ''), p = (it.fullPath || '');
          // 只要是檔案
          if (!it.metadata) return false;
          return keyRegex.test(p) || keyRegex.test(n);
        });
      }

      function pickLatestByUpdate(files) {
        if (!files.length) return null;
        files = files.slice();
        files.sort((a, b) => {
          const ta = Date.parse(a.updated_at || 0) || 0;
          const tb = Date.parse(b.updated_at || 0) || 0;
          if (ta !== tb) return tb - ta;
          return (b.metadata?.size || 0) - (a.metadata?.size || 0);
        });
        return files[0];
      }

      async function resolveMergedForKey(key) {
        // 仍保留 manifest（若你未來要強制指定 prefix 或 latest_path）
        const mf = await readManifest(key);

        // 先拿候選清單
        let files = [];
        if (mf && mf.prefix) {
          const all = [];
          await listDeepN(mf.prefix, 0, 8, all);
          files = all.filter(it => it.metadata && (WANT[key].test(it.fullPath) || WANT[key].test(it.name)));
        } else {
          files = await listAllFilesByRegex(WANT[key]);
        }

        if (!files.length && mf && mf.latest_path) {
          // fallback：manifest 明確指定單檔
          return {
            canon: (await fetchSmart(pubUrl(mf.latest_path))).canon,
            periodStart: null,
            periodEnd: null
          };
        }

        if (!files.length) return null;

        // 優先用「起訖期間」串檔；若檔名無日期範圍，退回抓最新檔
        const chainInfo = chooseChainByRange(files);

        if (!chainInfo) {
          const latest = pickLatestByUpdate(files);
          if (!latest) return null;
          const canon = (await fetchSmart(pubUrl(latest.fullPath))).canon;
          return { canon, periodStart: null, periodEnd: null };
        }

        const canonTexts = [];
        for (const f of chainInfo.chain) {
          const { canon } = await fetchSmart(pubUrl(f.fullPath));
          canonTexts.push(canon);
        }

        const mergedCanon = mergeCanonTexts(canonTexts);

        return {
          canon: mergedCanon,
          periodStart: String(chainInfo.start),
          periodEnd: String(chainInfo.end)
        };
      }

      async function fillCard(key) {
        const setPeriod = text => {
          const el = document.getElementById(`period-${key}`);
          if (el) el.textContent = text;
        };

        try {
          const merged = await resolveMergedForKey(key);
          if (!merged || !merged.canon) {
            resetAll(key);
            setPeriod('—');
            return;
          }

          const mergedText = merged.canon;

          // 期間顯示：優先用檔名/路徑的起訖（你圖2的起訖），若抓不到才用交易列首尾
          const rows = parseCanon(mergedText);
          const start8_fallback = rows.length ? rows[0].ts.slice(0, 8) : '';
          const end8_fallback = rows.length ? rows[rows.length - 1].ts.slice(0, 8) : '';

          const start8 = merged.periodStart || start8_fallback || '—';
          const end8 = merged.periodEnd || end8_fallback || '—';

          const { days, vals } = dailySeriesFromMerged(mergedText);

          // 4 週
          const W = {
            wk1: weekReturnFixed(days, vals, 1),
            wk2: weekReturnFixed(days, vals, 2),
            wk3: weekReturnFixed(days, vals, 3),
            wk4: weekReturnFixed(days, vals, 4)
          };
          WEEK_KEYS.forEach(k => {
            const r = W[k];
            setText(`${k}-range-${key}`, r.range);
            setVal(`${k}-${key}`, r.ret);
          });

          // 2~6 月
          const M = {
            m2: monthReturnFixed(days, vals, 2),
            m3: monthReturnFixed(days, vals, 3),
            m4: monthReturnFixed(days, vals, 4),
            m5: monthReturnFixed(days, vals, 5),
            m6: monthReturnFixed(days, vals, 6)
          };
          MONTH_KEYS.forEach(k => {
            const r = M[k];
            setText(`${k}-range-${key}`, r.range);
            setVal(`${k}-${key}`, r.ret);
          });

          // 年：有資料才顯示
          const Y = {
            y1: yearReturnFixed(days, vals, 1),
            y2: yearReturnFixed(days, vals, 2),
            y3: yearReturnFixed(days, vals, 3),
            y4: yearReturnFixed(days, vals, 4),
            y5: yearReturnFixed(days, vals, 5)
          };
          YEAR_KEYS.forEach(k => {
            const r = Y[k];
            const row = document.getElementById(`row-${k}-${key}`);
            if (!r || r.ret == null) {
              if (row) row.style.display = 'none';
            } else {
              if (row) row.style.display = 'grid';
              setText(`${k}-range-${key}`, r.range);
              setVal(`${k}-${key}`, r.ret);
            }
          });

          setPeriod(`${start8} - ${end8}`);
        } catch (e) {
          resetAll(key);
          setPeriod('—');
        }
      }

      await Promise.all([
        fillCard("0807"),
        fillCard("1001"),
        fillCard("00909")
      ]);
    })();
  }

  // 啟動載入（在 boot() 成功登入後會呼叫 loadDepsAndRun）
})();
