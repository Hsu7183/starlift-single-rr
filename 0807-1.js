// 0807-1.js — 最終版（依你最新規格）
// 規格：
// 1) 全區間：維持 single-trades.js 原樣（含 KPI 計算與顯示）
// 2) 其他區間：不重算 KPI、不碰 KPI；只切「主圖 + 下方日損益圖 + 交易明細」
// 3) 區間以「全區間最後交易日」為錨：
//    - 近1週：該週週一 ~ 最後交易日（例：全區間到 2025/12/10 → 近1週=2025/12/08~2025/12/10）
//    - 近2週：上週週一 ~ 最後交易日
//    - 近1月/2月/3月/6月/1年：以天數回推 ~ 最後交易日
// 4) 主圖與下方圖（你稱週圖但實際是日損益圖）用「同一套日期區間」切片，確保對齊
// 5) 交易明細：只顯示區間內每筆交易（不改欄位、不改累計、不改 KPI）

(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);

  const status   = $('#autostatus');
  const elLatest = $('#latestName');
  const elBase   = $('#baseName');
  const btnBase  = $('#btnSetBaseline');

  const rangeRow     = $('#rangeRow');
  const tradesBody   = $('#tradesBody');
  const equityCanvas = $('#equityChart');
  const dailyCanvas  = $('#weeklyPnlChart'); // 此圖在你頁面是日損益圖

  const slipInput = $('#slipInput');
  const runBtn    = $('#runBtn');

  if (status) status.style.whiteSpace = 'pre-wrap';

  function setStatus(msg, bad = false) {
    if (!status) return;
    status.textContent = msg;
    status.style.color = bad ? '#c62828' : '#666';
  }

  // -----------------------------
  // slip=2：開頁即算（沿用你 0807-1 的需求）
  // -----------------------------
  function forceSlip2() {
    if (!slipInput) return;
    slipInput.value = '2';
    slipInput.dispatchEvent(new Event('input', { bubbles: true }));
    slipInput.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function safeClickRun(times = 4) {
    if (!runBtn) return;
    const delays = [0, 80, 250, 600];
    for (let i = 0; i < Math.min(times, delays.length); i++) {
      setTimeout(() => { forceSlip2(); runBtn.click(); }, delays[i]);
    }
  }
  document.addEventListener('DOMContentLoaded', () => forceSlip2());

  // -----------------------------
  // Supabase + merge（對齊 0807.js）
  // -----------------------------
  const SUPABASE_URL  = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET        = "reports";
  const WANT          = /0807/i;
  const MANIFEST_PATH = "manifests/0807.json";

  const sb = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { fetch: (u, o = {}) => fetch(u, { ...o, cache: 'no-store' }) }
  });

  const CANON_RE   = /^(\d{14})\.0{6}\s+(\d+\.\d{6})\s+(新買|平賣|新賣|平買|強制平倉)\s*$/;
  const EXTRACT_RE = /.*?(\d{14})(?:\.0{1,6})?\s+(\d+(?:\.\d{1,6})?)\s*(新買|平賣|新賣|平買|強制平倉)\s*$/;

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
        name     : it.name,
        fullPath : p + it.name,
        updatedAt: it.updated_at ? Date.parse(it.updated_at) : 0,
        size     : it.metadata?.size || 0
      }));
  }

  async function listCandidates() {
    const u = new URL(location.href);
    const prefix = u.searchParams.get('prefix') || '';
    return listOnce(prefix);
  }

  function lastDateScore(name) {
    const m = String(name).match(/\b(20\d{6})\b/g);
    if (!m || !m.length) return 0;
    return Math.max(...m.map(s => +s || 0));
  }

  async function readManifest() {
    try {
      const { data, error } = await sb.storage.from(BUCKET).download(MANIFEST_PATH);
      if (error || !data) return null;
      return JSON.parse(await data.text());
    } catch { return null; }
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
      } catch {}
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
    const baseMax = A.length ? A[A.length - 1].ts : '';
    const added = baseMax ? B.filter(x => x.ts > baseMax).map(x => x.line) : B.map(x => x.line);
    return [...A.map(x => x.line), ...added].join('\n');
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

  async function feedToSingleTrades(filename, mergedText) {
    const fileInput = $('#fileInput');
    const fname = filename || '0807.txt';
    const file  = new File([mergedText], fname, { type: 'text/plain' });

    forceSlip2();
    if (window.__singleTrades_setFile) window.__singleTrades_setFile(file);

    if (fileInput) {
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    safeClickRun(4);
  }

  // -----------------------------
  // Date parsing for labels/rows
  // -----------------------------
  function pad2(n){ return String(n).padStart(2,'0'); }
  function ymdToDate(ymd){
    if (!ymd || ymd.length !== 8) return null;
    const y=+ymd.slice(0,4), m=+ymd.slice(4,6), d=+ymd.slice(6,8);
    if (!y||!m||!d) return null;
    return new Date(y, m-1, d);
  }
  function dateToYmd(d){ return `${d.getFullYear()}${pad2(d.getMonth()+1)}${pad2(d.getDate())}`; }
  function mondayOfWeek(d){
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const day = x.getDay();
    const delta = (day === 0) ? -6 : (1 - day);
    x.setDate(x.getDate() + delta);
    return x;
  }

  function parseYmdFromText(text){
    const s = String(text || '').trim();

    let m = s.match(/\b(20\d{12})\b/);
    if (m) return m[1].slice(0,8);

    m = s.match(/\b(20\d{6})\b/);
    if (m) return m[1];

    m = s.match(/\b(20\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/);
    if (m) return `${m[1]}${pad2(m[2])}${pad2(m[3])}`;

    // YYYY/M → 月初
    m = s.match(/\b(20\d{2})[\/\-](\d{1,2})\b/);
    if (m) return `${m[1]}${pad2(m[2])}01`;

    return '';
  }

  function parseYmdFromRow(tr){
    if (!tr) return '';
    const tds = Array.from(tr.querySelectorAll('td'));
    for (const td of tds) {
      const ymd = parseYmdFromText(td.textContent);
      if (ymd) return ymd;
    }
    return parseYmdFromText(tr.textContent);
  }

  // -----------------------------
  // Chart helpers
  // -----------------------------
  function getChart(canvas){
    if (!canvas || !window.Chart) return null;
    try { return window.Chart.getChart(canvas) || null; } catch { return null; }
  }

  // -----------------------------
  // Snapshot originals (for non-ALL restore)
  // -----------------------------
  const SNAP = {
    ready: false,
    endYmd: null,
    tradeYmdList: null,
    tradesHTML: null,
    eq: { labels:null, datasetsData:null },
    dy: { labels:null, datasetsData:null }
  };

  function snapshotOnce(){
    if (SNAP.ready) return true;

    const eq = getChart(equityCanvas);
    const dy = getChart(dailyCanvas);
    if (!eq || !eq.data?.labels?.length || !eq.data?.datasets?.length) return false;
    if (!dy || !dy.data?.labels?.length || !dy.data?.datasets?.length) return false;
    if (!tradesBody) return false;

    // trade days from table (truth source)
    const trs = Array.from(tradesBody.querySelectorAll('tr'));
    const yset = new Set();
    for (const tr of trs) {
      const ymd = parseYmdFromRow(tr);
      if (ymd) yset.add(ymd);
    }
    const ymdList = Array.from(yset).sort();
    if (!ymdList.length) return false;

    SNAP.tradeYmdList = ymdList;
    SNAP.endYmd = ymdList[ymdList.length - 1]; // max day
    SNAP.tradesHTML = tradesBody.innerHTML;

    // chart originals (store data arrays only; don't replace dataset objects later)
    SNAP.eq.labels = eq.data.labels.slice();
    SNAP.eq.datasetsData = eq.data.datasets.map(ds => Array.isArray(ds.data) ? ds.data.slice() : []);

    SNAP.dy.labels = dy.data.labels.slice();
    SNAP.dy.datasetsData = dy.data.datasets.map(ds => Array.isArray(ds.data) ? ds.data.slice() : []);

    SNAP.ready = true;
    return true;
  }

  // -----------------------------
  // Range start rule (end = last trading day)
  // -----------------------------
  function rangeStartYmd(endYmd, code){
    if (code === 'ALL') return '';
    const endDate = ymdToDate(endYmd);
    if (!endDate) return '';

    if (code === '1W') return dateToYmd(mondayOfWeek(endDate));
    if (code === '2W') {
      const m = mondayOfWeek(endDate);
      m.setDate(m.getDate() - 7);
      return dateToYmd(m);
    }

    const daysMap = { '1M':30, '2M':60, '3M':91, '6M':182, '1Y':365 };
    const n = daysMap[code] || 0;
    if (!n) return '';
    const s = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
    s.setDate(s.getDate() - n);
    return dateToYmd(s);
  }

  function setActiveRangeBtn(code){
    if (!rangeRow) return;
    const btns = Array.from(rangeRow.querySelectorAll('.range-btn'));
    btns.forEach(b => b.classList.toggle('active', (b.dataset.range === code)));
  }

  // -----------------------------
  // Apply range:
  // - ALL: restore everything; KPI stays as computed by single-trades.js
  // - Others: only slice charts + daily pnl + trades. KPI untouched.
  // -----------------------------
  function applyRange(code){
    if (!snapshotOnce()) {
      setStatus('區間切換：資料尚未就緒，正在重試…');
      setTimeout(() => applyRange(code), 200);
      return;
    }

    const eq = getChart(equityCanvas);
    const dy = getChart(dailyCanvas);
    if (!eq || !dy) return;

    // restore originals first
    eq.data.labels = SNAP.eq.labels.slice();
    eq.data.datasets.forEach((ds, k) => ds.data = (SNAP.eq.datasetsData[k] || []).slice());
    eq.update('none');

    dy.data.labels = SNAP.dy.labels.slice();
    dy.data.datasets.forEach((ds, k) => ds.data = (SNAP.dy.datasetsData[k] || []).slice());
    dy.update('none');

    tradesBody.innerHTML = SNAP.tradesHTML;

    const endYmd = SNAP.endYmd;
    const startYmd = rangeStartYmd(endYmd, code);

    if (code === 'ALL' || !startYmd) {
      setActiveRangeBtn('ALL');
      setStatus(`全區間：~ ${endYmd}（KPI 只在全區間計算）`);
      return;
    }

    // 交易日序列（真實日期）→ 近1週/近2週正確落在最後交易週
    const ymdRange = SNAP.tradeYmdList.filter(y => y >= startYmd && y <= endYmd);

    // --- 交易明細：只顯示區間內每筆交易（不改累計、不改 KPI）
    const trs = Array.from(tradesBody.querySelectorAll('tr'));
    const kept = trs.filter(tr => {
      const ymd = parseYmdFromRow(tr);
      if (!ymd) return true; // 日期抓不到就保留，避免誤刪
      return (ymd >= startYmd && ymd <= endYmd);
    });
    tradesBody.innerHTML = kept.map(tr => tr.outerHTML).join('');

    // --- 主圖/日損益圖：用同一套 ymdRange 找 index → 保證對齊
    const eqYmds = SNAP.eq.labels.map(l => parseYmdFromText(l));
    const dyYmds = SNAP.dy.labels.map(l => parseYmdFromText(l));

    const eqIdx = [];
    const dyIdx = [];
    for (const y of ymdRange) {
      const i1 = eqYmds.indexOf(y);
      const i2 = dyYmds.indexOf(y);
      if (i1 >= 0) eqIdx.push(i1);
      if (i2 >= 0) dyIdx.push(i2);
    }

    // fallback：若圖表 labels 不含日，只取尾端 N（仍會「有反應」）
    const fbN = Math.min(12, SNAP.eq.labels.length);
    const eqUse = (eqIdx.length >= 2) ? eqIdx : (() => {
      const start = Math.max(0, SNAP.eq.labels.length - fbN);
      return Array.from({length: fbN}, (_,k)=>start+k);
    })();
    const fbN2 = Math.min(12, SNAP.dy.labels.length);
    const dyUse = (dyIdx.length >= 2) ? dyIdx : (() => {
      const start = Math.max(0, SNAP.dy.labels.length - fbN2);
      return Array.from({length: fbN2}, (_,k)=>start+k);
    })();

    eq.data.labels = eqUse.map(i => SNAP.eq.labels[i]);
    eq.data.datasets.forEach((ds, k) => {
      const orig = SNAP.eq.datasetsData[k] || [];
      ds.data = eqUse.map(i => orig[i]);
    });
    eq.update('none');

    dy.data.labels = dyUse.map(i => SNAP.dy.labels[i]);
    dy.data.datasets.forEach((ds, k) => {
      const orig = SNAP.dy.datasetsData[k] || [];
      ds.data = dyUse.map(i => orig[i]);
    });
    dy.update('none');

    setActiveRangeBtn(code);
    setStatus(`區間：${code}（${startYmd} ~ ${endYmd}）｜非全區間：不重算 KPI`);
  }

  // -----------------------------
  // Bind buttons
  // -----------------------------
  function hookRangeButtons(){
    if (!rangeRow) return;
    rangeRow.addEventListener('click', (e) => {
      const btn = e.target.closest('.range-btn');
      if (!btn) return;
      const code = btn.dataset.range || 'ALL';
      applyRange(code);
    });
  }

  function waitAndInit(){
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (snapshotOnce()) {
        clearInterval(timer);
        hookRangeButtons();
        // 初始維持 ALL（KPI 只在全區間）
        applyRange('ALL');
      }
      if (tries > 320) clearInterval(timer);
    }, 120);
  }

  // -----------------------------
  // Boot: merge + feed to single-trades.js (same as 0807.js)
  // -----------------------------
  async function boot(){
    try{
      if (!sb) {
        setStatus('Supabase SDK 未載入或初始化失敗。', true);
        return;
      }

      forceSlip2();

      const url = new URL(location.href);
      const paramFile = url.searchParams.get('file');

      let latest = null;
      let list = [];

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

      if (!latest) {
        setStatus('找不到可分析的 0807 檔案。', true);
        return;
      }
      if (elLatest) elLatest.textContent = latest.name;

      // baseline
      let base = null;
      if (!paramFile) {
        const manifest = await readManifest();
        if (manifest?.baseline_path) {
          base =
            list.find(x => x.fullPath === manifest.baseline_path) ||
            { name: manifest.baseline_path.split('/').pop() || manifest.baseline_path, fullPath: manifest.baseline_path };
        } else {
          base = list[1] || null;
        }
      }
      if (elBase) elBase.textContent = base ? base.name : '（尚無）';

      // download latest
      setStatus('下載最新 0807 檔案並解碼中…');
      const latestUrl = latest.from === 'url' ? latest.fullPath : pubUrl(latest.fullPath);
      const rNew = await fetchSmart(latestUrl);
      if (rNew.ok === 0) {
        setStatus(`最新檔沒有合法交易行（解碼=${rNew.enc}）。`, true);
        return;
      }

      let mergedText = rNew.canon;

      // merge baseline
      if (base) {
        setStatus('下載基準檔並進行合併…');
        const baseUrl = base.from === 'url' ? base.fullPath : pubUrl(base.fullPath);
        const rBase   = await fetchSmart(baseUrl);
        mergedText = mergeByBaseline(rBase.canon, rNew.canon);
      }

      // baseline button
      if (btnBase) {
        btnBase.disabled = false;
        btnBase.onclick = async () => {
          try {
            await writeManifest({ baseline_path: latest.fullPath, updated_at: new Date().toISOString() });
            btnBase.textContent = '已設為基準';
          } catch (e) {
            setStatus('寫入基準失敗：' + (e.message || e), true);
          }
        };
      }

      // feed
      const mergedWithInpos = addFakeInpos(mergedText);
      const finalText = '0807 MERGED\n' + mergedWithInpos;

      setStatus('已載入（合併後）資料，開始分析…');
      await feedToSingleTrades(latest.name, finalText);
      setStatus('分析完成（全區間含 KPI；其他區間僅顯示圖表/日損益/明細）。');

      // init after render
      waitAndInit();
    } catch (err) {
      console.error(err);
      setStatus('初始化失敗：' + (err.message || err), true);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
