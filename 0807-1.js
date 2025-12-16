// 0807-1.js — 0807-1
// 修正點：補回 readManifest()（之前漏掉會直接壞）
// 功能：
// 1) 滑點預設強制=2，確保第一次自動分析吃得到
// 2) 時區用圖表首行 chips（直接點）
// 3) 點選時區立即重算；非「全」隱藏 KPI
// 4) 主資產曲線補齊交易日（週一~週五），缺日用前值持平
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);

  const status   = $('#autostatus');
  const elLatest = $('#latestName');
  const elBase   = $('#baseName');
  const elPeriod = $('#periodText');
  const btnBase  = $('#btnSetBaseline');

  const scoreCard  = $('#scoreCard');
  const kpiBadCard = $('#kpiBadCard');
  const kpiAllCard = $('#kpiAllCard');

  const rangeChips = $('#rangeChips');

  if (status) status.style.whiteSpace = 'pre-wrap';

  const SUPABASE_URL  = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET        = "reports";

  const sb = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { fetch: (u, o = {}) => fetch(u, { ...o, cache: 'no-store' }) }
  });

  const WANT          = /0807/i;
  const MANIFEST_PATH = "manifests/0807.json";

  const CANON_RE   = /^(\d{14})\.0{6}\s+(\d+\.\d{6})\s+(新買|平賣|新賣|平買|強制平倉)\s*$/;
  const EXTRACT_RE = /.*?(\d{14})(?:\.0{1,6})?\s+(\d+(?:\.\d{1,6})?)\s*(新買|平賣|新賣|平買|強制平倉)\s*$/;

  function setStatus(msg, bad = false) {
    if (!status) return;
    status.textContent = msg;
    status.style.color = bad ? '#c62828' : '#666';
  }

  function forceSlipDefault2() {
    const slip = $('#slipInput');
    if (!slip) return;
    slip.value = '2';
    slip.dispatchEvent(new Event('input', { bubbles: true }));
    slip.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setKpiVisible(isAll) {
    const hide = !isAll;
    if (scoreCard)  scoreCard.classList.toggle('kpi-hidden', hide);
    if (kpiBadCard) kpiBadCard.classList.toggle('kpi-hidden', hide);
    if (kpiAllCard) kpiAllCard.classList.toggle('kpi-hidden', hide);
  }

  function pubUrl(path) {
    const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
    return data?.publicUrl || '#';
  }

  async function listOnce(prefix) {
    const p = (prefix && !prefix.endsWith('/')) ? (prefix + '/') : (prefix || '');
    const { data, error } = await sb.storage.from(BUCKET).list(p, {
      limit : 1000,
      sortBy: { column: 'name', order: 'asc' }
    });
    if (error) throw new Error(error.message);
    return (data || [])
      .filter(it => !(it.id === null && !it.metadata))
      .map(it => ({
        name    : it.name,
        fullPath: p + it.name,
        updatedAt: it.updated_at ? Date.parse(it.updated_at) : 0,
        size    : it.metadata?.size || 0
      }));
  }

  async function listCandidates() {
    const u      = new URL(location.href);
    const prefix = u.searchParams.get('prefix') || '';
    return listOnce(prefix);
  }

  function lastDateScore(name) {
    const m = String(name).match(/\b(20\d{6})\b/g);
    if (!m || !m.length) return 0;
    return Math.max(...m.map(s => +s || 0));
  }

  function normalizeText(raw) {
    let s = raw
      .replace(/\ufeff/gi, '')
      .replace(/\u200b|\u200c|\u200d/gi, '')
      .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '');
    s = s.replace(/\r\n?/g, '\n').replace(/\u3000/g, ' ');
    const lines = s.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
    return lines.join('\n');
  }

  function canonicalize(txt) {
    const out = [];
    const lines = (txt || '').split('\n');
    let ok = 0;

    for (const l of lines) {
      const m = l.match(EXTRACT_RE);
      if (m) {
        const ts  = m[1];
        const pxN = Number(m[2]);
        const px6 = Number.isFinite(pxN) ? pxN.toFixed(6) : m[2];
        const act = m[3];
        out.push(`${ts}.000000 ${px6} ${act}`);
        ok++;
      }
    }
    return { canon: out.join('\n'), ok };
  }

  async function fetchSmart(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();

    for (const enc of ['utf-8', 'big5', 'utf-16le', 'utf-16be']) {
      try {
        const td   = new TextDecoder(enc, { fatal: false });
        const norm = normalizeText(td.decode(buf));
        const { canon, ok } = canonicalize(norm);
        if (ok > 0) return { enc, canon, ok };
      } catch (e) {}
    }

    const td   = new TextDecoder('utf-8');
    const norm = normalizeText(td.decode(buf));
    const { canon, ok } = canonicalize(norm);
    return { enc: 'utf-8', canon, ok };
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

  function mergeByBaseline(baseText, latestText) {
    const A = parseCanon(baseText);
    const B = parseCanon(latestText);

    const baseMin = A.length ? A[0].ts.slice(0, 8) : (B.length ? B[0].ts.slice(0, 8) : '');
    const baseMax = A.length ? A[A.length - 1].ts : '';

    const added = baseMax ? B.filter(x => x.ts > baseMax).map(x => x.line) : B.map(x => x.line);
    const mergedLines = [...A.map(x => x.line), ...added];

    const endDay = mergedLines.length
      ? mergedLines[mergedLines.length - 1].match(CANON_RE)[1].slice(0, 8)
      : baseMin;

    return { combined: mergedLines.join('\n'), start8: baseMin, end8: endDay };
  }

  function addFakeInpos(text) {
    const lines = (text || '').split('\n').map(s => s.trim()).filter(Boolean);
    const out = [];
    for (const line of lines) {
      const m = line.match(CANON_RE);
      if (!m) continue;

      const ts  = m[1];
      const act = m[3];

      if (act === '新買' || act === '新賣') {
        const dir = (act === '新買') ? 1 : -1;
        out.push(line);
        out.push(`${ts}.000000 0 0 ${dir} 0 INPOS`);
      } else {
        out.push(line);
      }
    }
    return out.join('\n');
  }

  async function feedToSingleTrades(filename, text) {
    const fileInput = $('#fileInput');
    const runBtn    = $('#runBtn');

    const file = new File([text], filename || '0807.txt', { type: 'text/plain' });

    if (window.__singleTrades_setFile) window.__singleTrades_setFile(file);

    if (fileInput) {
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    if (runBtn) runBtn.click();
  }

  // ===== manifest（修正：readManifest 原本漏掉）=====
  async function readManifest() {
    try {
      const { data, error } = await sb.storage.from(BUCKET).download(MANIFEST_PATH);
      if (error || !data) return null;
      return JSON.parse(await data.text());
    } catch {
      return null;
    }
  }

  async function writeManifest(obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const { error } = await sb.storage.from(BUCKET).upload(
      MANIFEST_PATH,
      blob,
      { upsert: true, cacheControl: '0', contentType: 'application/json' }
    );
    if (error) throw new Error(error.message);
  }

  // ===== 日期工具（UTC）=====
  function ymdToDate(ymd) {
    const y = +ymd.slice(0, 4), m = +ymd.slice(4, 6), d = +ymd.slice(6, 8);
    return new Date(Date.UTC(y, m - 1, d));
  }
  function dateToYmd(dt) {
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const d = String(dt.getUTCDate()).padStart(2, '0');
    return `${y}${m}${d}`;
  }
  function dowMon1(dt) { const x = dt.getUTCDay(); return x === 0 ? 7 : x; }
  function nextMondayIfWeekend(dt) {
    const d = new Date(dt.getTime());
    const dow = dowMon1(d);
    if (dow === 6) d.setUTCDate(d.getUTCDate() + 2);
    if (dow === 7) d.setUTCDate(d.getUTCDate() + 1);
    return d;
  }
  function startOfWeekMonday(endDt) {
    const d = new Date(endDt.getTime());
    const dow = dowMon1(d);
    d.setUTCDate(d.getUTCDate() - (dow - 1));
    return d;
  }
  function addMonthsUTC(dt, deltaMonths) {
    const y = dt.getUTCFullYear(), m = dt.getUTCMonth(), d = dt.getUTCDate();
    const t = new Date(Date.UTC(y, m + deltaMonths, 1));
    const lastDay = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    t.setUTCDate(Math.min(d, lastDay));
    return t;
  }
  function calcRangeStart(endYmd, key) {
    const endDt = ymdToDate(endYmd);
    if (key === 'all') return null;
    if (key === 'w1') return startOfWeekMonday(endDt);
    if (key === 'w2') { const mon = startOfWeekMonday(endDt); mon.setUTCDate(mon.getUTCDate() - 7); return mon; }
    if (key === 'm1') return nextMondayIfWeekend(addMonthsUTC(endDt, -1));
    if (key === 'm2') return nextMondayIfWeekend(addMonthsUTC(endDt, -2));
    if (key === 'm3') return nextMondayIfWeekend(addMonthsUTC(endDt, -3));
    if (key === 'm6') return nextMondayIfWeekend(addMonthsUTC(endDt, -6));
    if (key === 'y1') return nextMondayIfWeekend(addMonthsUTC(endDt, -12));
    return null;
  }

  function filterCanonByRange(fullCanon, rangeKey) {
    const rows = parseCanon(fullCanon);
    if (!rows.length) return { text: fullCanon, start8: '', end8: '' };

    const end8 = rows[rows.length - 1].ts.slice(0, 8);
    const startDt = calcRangeStart(end8, rangeKey);

    if (!startDt) {
      const start8 = rows[0].ts.slice(0, 8);
      return { text: fullCanon, start8, end8 };
    }

    const start8  = dateToYmd(startDt);
    const startTS = start8 + '000000';
    const endTS   = end8   + '235959';

    const picked = rows.filter(r => r.ts >= startTS && r.ts <= endTS).map(r => r.line);
    return { text: picked.join('\n'), start8, end8 };
  }

  // ===== 補齊交易日到 equityChart =====
  function tryFillBusinessDaysOnEquityChart(rangeStart8, rangeEnd8) {
    let ch = null;
    try {
      ch = window.Chart?.getChart?.('equityChart') || window.Chart?.getChart?.($('#equityChart'));
    } catch {}
    if (!ch || !ch.data) return;

    const labels = ch.data.labels || [];
    const dsList = ch.data.datasets || [];
    if (!labels.length || !dsList.length) return;

    function labelToYmd(lab) {
      const s = String(lab).trim();
      const m1 = s.match(/^(\d{4})(\d{2})(\d{2})$/);
      if (m1) return `${m1[1]}${m1[2]}${m1[3]}`;
      const m2 = s.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
      if (m2) return `${m2[1]}${m2[2]}${m2[3]}`;
      const m3 = s.match(/\b(20\d{2}\d{2}\d{2})\b/);
      return m3 ? m3[1] : null;
    }

    const firstYmd = rangeStart8 || labelToYmd(labels[0]) || '';
    const lastYmd  = rangeEnd8   || labelToYmd(labels[labels.length - 1]) || '';
    if (!firstYmd || !lastYmd) return;

    const startDt = ymdToDate(firstYmd);
    const endDt   = ymdToDate(lastYmd);

    const full = [];
    const cur = new Date(startDt.getTime());
    while (cur.getTime() <= endDt.getTime()) {
      const dow = dowMon1(cur);
      if (dow >= 1 && dow <= 5) full.push(dateToYmd(cur));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }

    const existing = new Map();
    for (let i = 0; i < labels.length; i++) {
      const ymd = labelToYmd(labels[i]);
      if (ymd) existing.set(ymd, i);
    }
    if (existing.size < 2) return;
    if (existing.size > full.length) return;

    function getValueAt(ds, idx) {
      const v = ds.data?.[idx];
      return (v === undefined || v === null || Number.isNaN(v)) ? null : v;
    }

    const newLabels = [];
    const newData = dsList.map(() => []);
    let lastKnown = dsList.map(() => null);

    for (const ymd of full) {
      if (existing.has(ymd)) {
        const idx = existing.get(ymd);
        newLabels.push(labels[idx]);
        dsList.forEach((ds, k) => {
          const v = getValueAt(ds, idx);
          newData[k].push(v);
          lastKnown[k] = v;
        });
      } else {
        const y = ymd.slice(0,4), m = ymd.slice(4,6), d = ymd.slice(6,8);
        newLabels.push(`${y}-${m}-${d}`);
        dsList.forEach((ds, k) => newData[k].push(lastKnown[k]));
      }
    }

    ch.data.labels = newLabels;
    dsList.forEach((ds, k) => { ds.data = newData[k]; });

    try { ch.update('none'); } catch { ch.update(); }
  }

  function setActiveChip(key) {
    if (!rangeChips) return;
    rangeChips.querySelectorAll('.range-chip').forEach(btn => {
      btn.classList.toggle('active', (btn.dataset.range === key));
    });
  }

  // ===== 主流程 =====
  let __FULL_CANON = '';
  let __LATEST_NAME = '0807.txt';

  async function applyRangeAndRun(rangeKey) {
    if (!__FULL_CANON) return;

    forceSlipDefault2();

    setActiveChip(rangeKey);
    setKpiVisible(rangeKey === 'all');

    const r = filterCanonByRange(__FULL_CANON, rangeKey);
    if (elPeriod) elPeriod.textContent = `期間：${r.start8 || '—'} 開始到 ${r.end8 || '—'} 結束`;

    const withInpos = addFakeInpos(r.text);
    const finalText = '0807 MERGED\n' + withInpos;

    setStatus(`套用時區：${rangeKey}，重算中…`);
    await feedToSingleTrades(__LATEST_NAME, finalText);

    setTimeout(() => {
      tryFillBusinessDaysOnEquityChart(r.start8, r.end8);
    }, 140);

    setStatus(`分析完成（時區：${rangeKey}）。`);
  }

  async function boot() {
    try {
      if (!sb) {
        setStatus('Supabase SDK 未載入，請檢查引用順序或網路。', true);
        return;
      }

      forceSlipDefault2();

      const url       = new URL(location.href);
      const paramFile = url.searchParams.get('file');

      let latest = null;
      let list   = [];

      if (paramFile) {
        latest = { name: paramFile.split('/').pop() || '0807.txt', fullPath: paramFile, from: 'url' };
      } else {
        setStatus('從 Supabase（reports）讀取清單…');
        list = (await listCandidates()).filter(f => WANT.test(f.name) || WANT.test(f.fullPath));
        if (!list.length) {
          setStatus('找不到檔名含「0807」的 TXT（可用 ?file= 指定）。', true);
          return;
        }
        list.sort((a, b) => {
          const sa = lastDateScore(a.name);
          const sb2 = lastDateScore(b.name);
          if (sa !== sb2) return sb2 - sa;
          if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
          return (b.size || 0) - (a.size || 0);
        });
        latest = list[0];
      }

      __LATEST_NAME = latest.name;
      if (elLatest) elLatest.textContent = latest.name;

      let base = null;
      if (!paramFile) {
        const manifest = await readManifest();
        if (manifest?.baseline_path) {
          base = list.find(x => x.fullPath === manifest.baseline_path) ||
                 { name: manifest.baseline_path.split('/').pop() || manifest.baseline_path, fullPath: manifest.baseline_path };
        } else {
          base = list[1] || null;
        }
      }
      if (elBase) elBase.textContent = base ? base.name : '（尚無）';

      setStatus('下載最新 0807 檔案並解碼中…');
      const latestUrl = latest.from === 'url' ? latest.fullPath : pubUrl(latest.fullPath);
      const rNew = await fetchSmart(latestUrl);
      if (rNew.ok === 0) {
        setStatus(`最新檔沒有合法交易行（解碼=${rNew.enc}）。`, true);
        return;
      }

      let mergedCanon = rNew.canon;
      let start8 = '';
      let end8   = '';

      if (base) {
        setStatus('下載基準檔並進行合併…');
        const baseUrl = base.from === 'url' ? base.fullPath : pubUrl(base.fullPath);
        const rBase = await fetchSmart(baseUrl);
        const m = mergeByBaseline(rBase.canon, rNew.canon);
        mergedCanon = m.combined;
        start8 = m.start8;
        end8   = m.end8;
      } else {
        const rows = parseCanon(rNew.canon);
        start8 = rows.length ? rows[0].ts.slice(0, 8) : '';
        end8   = rows.length ? rows[rows.length - 1].ts.slice(0, 8) : '';
      }

      __FULL_CANON = mergedCanon;
      if (elPeriod) elPeriod.textContent = `期間：${start8 || '—'} 開始到 ${end8 || '—'} 結束`;

      if (btnBase) {
        btnBase.disabled = false;
        btnBase.onclick = async () => {
          try {
            const payload = { baseline_path: latest.fullPath, updated_at: new Date().toISOString() };
            await writeManifest(payload);
            btnBase.textContent = '已設為基準';
          } catch (e) {
            setStatus('寫入基準失敗：' + (e.message || e), true);
          }
        };
      }

      if (rangeChips) {
        rangeChips.addEventListener('click', (ev) => {
          const btn = ev.target?.closest?.('.range-chip');
          if (!btn) return;
          const key = btn.dataset.range || 'all';
          applyRangeAndRun(key);
        });
      }

      setActiveChip('all');
      setKpiVisible(true);

      setStatus('已載入（合併後）資料，開始分析…');
      await applyRangeAndRun('all');

    } catch (err) {
      console.error(err);
      setStatus('初始化失敗：' + (err.message || err), true);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
