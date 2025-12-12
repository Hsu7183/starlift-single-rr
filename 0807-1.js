// 0807-1.js — 最終版（區間＝以最後交易日為錨；近1週/近2週週一錨定）
// 需求達成：
// 1) 主圖 + 下方「日損益圖」皆以「日序列」切片，日對齊（不再比例切、不再猜）
// 2) 主圖多頭/空頭/總損益（含滑價/理論）切區間後都「歸0」；期間最高/最低點不歸0
// 3) KPI 的 Strong/Adequate/Improve 以紅/黃/綠顯示（補 class）
// 4) 交易明細顯示區間內每筆交易，且「累積」從區間起點重新歸0累加
// 5) 其他區間可用（近1年/6月/3月/2月/1月/近2週/近1週），近2週必有反應
//
// 注意：不改 single-trades.js；只在其渲染完成後做「前端視覺切片 + 欄位重算」

(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);

  // -----------------------------
  // DOM
  // -----------------------------
  const status   = $('#autostatus');
  const elLatest = $('#latestName');
  const elBase   = $('#baseName');
  const btnBase  = $('#btnSetBaseline');

  const rangeRow     = $('#rangeRow');
  const tradesBody   = $('#tradesBody');
  const equityCanvas = $('#equityChart');
  const weeklyCanvas = $('#weeklyPnlChart'); // 注意：這張在你頁面其實是「每日」損益圖

  const slipInput = $('#slipInput');
  const runBtn    = $('#runBtn');

  if (status) status.style.whiteSpace = 'pre-wrap';

  function setStatus(msg, bad = false) {
    if (!status) return;
    status.textContent = msg;
    status.style.color = bad ? '#c62828' : '#666';
  }

  // -----------------------------
  // slip=2 保險（開頁即算）
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
  // Supabase + merge（沿用 0807.js 的正確思路）
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
  // 日期/數字工具
  // -----------------------------
  function pad2(n){ return String(n).padStart(2,'0'); }

  function ymdToDate(ymd){
    if (!ymd || ymd.length !== 8) return null;
    const y=+ymd.slice(0,4), m=+ymd.slice(4,6), d=+ymd.slice(6,8);
    if (!y || !m || !d) return null;
    return new Date(y, m-1, d);
  }

  function dateToYmd(d){
    return `${d.getFullYear()}${pad2(d.getMonth()+1)}${pad2(d.getDate())}`;
  }

  function mondayOfWeek(d){
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const day = x.getDay(); // 0 Sun..6 Sat
    const delta = (day === 0) ? -6 : (1 - day);
    x.setDate(x.getDate() + delta);
    return x;
  }

  function parseYmdFromText(text){
    const s = String(text || '').trim();

    // 14碼（YYYYMMDDhhmmss）
    let m = s.match(/\b(20\d{12})\b/);
    if (m) return m[1].slice(0,8);

    // 8碼（YYYYMMDD）
    m = s.match(/\b(20\d{6})\b/);
    if (m) return m[1];

    // YYYY/MM/DD or YYYY-MM-DD
    m = s.match(/\b(20\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/);
    if (m) return `${m[1]}${pad2(m[2])}${pad2(m[3])}`;

    // YYYY/MM or YYYY-MM（只到月：當作月初，仍可用於 slicing）
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

  function parseNum(text){
    const s = String(text || '').trim();
    if (!s || s === '—' || s === '-') return NaN;
    const v = Number(s.replace(/,/g,''));
    return Number.isFinite(v) ? v : NaN;
  }

  function formatNum(n){
    if (!Number.isFinite(n)) return '—';
    const sign = n < 0 ? '-' : '';
    const x = Math.abs(Math.round(n));
    return sign + x.toLocaleString('en-US');
  }

  // -----------------------------
  // KPI 顏色（紅/黃/綠）
  // -----------------------------
  function ensureKpiRatingColors(){
    const map = { Strong:'rating-strong', Adequate:'rating-adequate', Improve:'rating-improve' };
    const tds = Array.from(document.querySelectorAll('td'));
    for (const td of tds) {
      const t = (td.textContent || '').trim();
      const cls = map[t];
      if (!cls) continue;
      td.classList.remove('rating-strong','rating-adequate','rating-improve');
      td.classList.add(cls);
    }
    // score card（保守補）
    const scoreVal = document.querySelector('#scoreCard .score-value');
    if (scoreVal) {
      scoreVal.classList.remove('strong','adequate','improve');
      // 嘗試從頁面中找 Strong/Adequate/Improve 次數最多者當色（最小侵入）
      const strongN = document.querySelectorAll('td.rating-strong').length;
      const adqN    = document.querySelectorAll('td.rating-adequate').length;
      const impN    = document.querySelectorAll('td.rating-improve').length;
      if (strongN >= adqN && strongN >= impN) scoreVal.classList.add('strong');
      else if (adqN >= strongN && adqN >= impN) scoreVal.classList.add('adequate');
      else scoreVal.classList.add('improve');
    }
  }

  // -----------------------------
  // Chart slicing（用「日序列」索引切，不用比例）
  // -----------------------------
  function getChart(canvas){
    if (!canvas || !window.Chart) return null;
    try { return window.Chart.getChart(canvas) || null; } catch { return null; }
  }

  function shouldRebaseLabel(label){
    const s = String(label || '');
    // 期間最高/最低點不要歸0
    if (/最高|最低/.test(s)) return false;
    // 總損益/多頭/空頭 皆要歸0
    return /(損益|多頭|空頭|總)/.test(s);
  }

  function rebaseArray(arr){
    if (!Array.isArray(arr) || arr.length === 0) return arr;
    const first = arr[0];

    if (typeof first === 'number') {
      const base = first;
      if (!Number.isFinite(base)) return arr;
      return arr.map(v => Number.isFinite(v) ? (v - base) : v);
    }

    if (first && typeof first === 'object') {
      const baseY = Number(first.y);
      if (!Number.isFinite(baseY)) return arr;
      return arr.map(p => {
        if (!p || typeof p !== 'object') return p;
        const y = Number(p.y);
        if (!Number.isFinite(y)) return p;
        return { ...p, y: y - baseY };
      });
    }
    return arr;
  }

  // -----------------------------
  // Trade table reset cum from 0 within range
  // -----------------------------
  function rebuildTradeTableCums(startYmd, endYmd){
    const table = tradesBody?.closest('table');
    if (!table) return;

    const head = table.querySelector('thead');
    const ths = Array.from(head?.querySelectorAll('th') || []).map(th => (th.textContent || '').trim());

    // 找欄位 index（以中文標題為準；若找不到就不做重算）
    const idxTheo      = ths.findIndex(t => t.includes('理論淨損益'));
    const idxCumTheo   = ths.findIndex(t => t.includes('累積理論淨損益'));
    const idxReal      = ths.findIndex(t => t.includes('實際淨損益'));
    const idxCumReal   = ths.findIndex(t => t.includes('累積實際淨損益'));
    const idxDateTime  = ths.findIndex(t => t.includes('日期時間'));

    if (idxTheo < 0 || idxCumTheo < 0 || idxReal < 0 || idxCumReal < 0) return;

    const rows = Array.from(tradesBody.querySelectorAll('tr'));

    // 先找區間內 row
    const kept = [];
    for (const tr of rows) {
      const tds = Array.from(tr.querySelectorAll('td'));
      if (!tds.length) continue;

      // 優先用 日期時間欄位；找不到就用整列
      const dtText = (idxDateTime >= 0 && tds[idxDateTime]) ? tds[idxDateTime].textContent : tr.textContent;
      const ymd = parseYmdFromText(dtText);

      // 若 ymd 抓不到，不濾掉（避免誤刪），但累計就不改
      if (ymd && startYmd && endYmd) {
        if (ymd < startYmd || ymd > endYmd) continue;
      }
      kept.push(tr);
    }

    // 用 kept 重新填 tbody
    tradesBody.innerHTML = kept.map(tr => tr.outerHTML).join('');

    // 重新取一次 rows
    const newRows = Array.from(tradesBody.querySelectorAll('tr'));

    let cumTheo = 0;
    let cumReal = 0;

    for (const tr of newRows) {
      const tds = Array.from(tr.querySelectorAll('td'));
      if (!tds.length) continue;

      const theo = parseNum(tds[idxTheo]?.textContent);
      const real = parseNum(tds[idxReal]?.textContent);

      // 有些「新買」列可能是 —，跳過累加但仍把累積顯示為目前累計
      if (Number.isFinite(theo)) cumTheo += theo;
      if (Number.isFinite(real)) cumReal += real;

      if (tds[idxCumTheo]) tds[idxCumTheo].textContent = formatNum(cumTheo);
      if (tds[idxCumReal]) tds[idxCumReal].textContent = formatNum(cumReal);
    }

    // 重新寫回（因為我們改了 td.textContent）
    tradesBody.innerHTML = newRows.map(tr => tr.outerHTML).join('');
  }

  // -----------------------------
  // Snapshot originals（只做一次）
  // -----------------------------
  const SNAP = {
    ready: false,
    eq: { labels:null, dataArrays:null },
    wk: { labels:null, dataArrays:null },
    tradesHTML: null, // 原始 tbody HTML
    tradeYmdList: null,
    endYmd: null
  };

  function snapshotOnce(){
    if (SNAP.ready) return true;

    const eq = getChart(equityCanvas);
    const wk = getChart(weeklyCanvas);
    if (!eq || !eq.data?.labels?.length || !eq.data?.datasets?.length) return false;
    if (!wk || !wk.data?.labels?.length || !wk.data?.datasets?.length) return false;
    if (!tradesBody) return false;

    // Chart originals
    SNAP.eq.labels = eq.data.labels.slice();
    SNAP.eq.dataArrays = eq.data.datasets.map(ds => Array.isArray(ds.data) ? ds.data.slice() : []);

    SNAP.wk.labels = wk.data.labels.slice();
    SNAP.wk.dataArrays = wk.data.datasets.map(ds => Array.isArray(ds.data) ? ds.data.slice() : []);

    // Trade originals
    SNAP.tradesHTML = tradesBody.innerHTML;

    // trade ymd list & endYmd from table rows
    const trs = Array.from(tradesBody.querySelectorAll('tr'));
    const yset = new Set();
    let endYmd = '';
    for (const tr of trs) {
      const ymd = parseYmdFromRow(tr);
      if (ymd) yset.add(ymd);
      endYmd = ymd || endYmd;
    }
    // 若上述 endYmd 不穩（最後幾列可能是空），再從後往前找
    if (!endYmd) {
      for (let i = trs.length - 1; i >= 0; i--) {
        const ymd = parseYmdFromRow(trs[i]);
        if (ymd) { endYmd = ymd; break; }
      }
    }
    const ymdList = Array.from(yset).sort();

    if (!endYmd || !ymdList.length) return false;

    SNAP.tradeYmdList = ymdList;
    SNAP.endYmd = endYmd;
    SNAP.ready = true;
    return true;
  }

  // -----------------------------
  // Range start rule
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
  // Apply range (the real work)
  // -----------------------------
  function applyRange(code){
    if (!snapshotOnce()) {
      setStatus('區間切換：資料尚未就緒，正在重試…');
      setTimeout(() => applyRange(code), 180);
      return;
    }

    const endYmd = SNAP.endYmd;
    const startYmd = rangeStartYmd(endYmd, code);

    // 1) restore originals first
    const eq = getChart(equityCanvas);
    const wk = getChart(weeklyCanvas);
    if (!eq || !wk) return;

    // restore chart full
    eq.data.labels = SNAP.eq.labels.slice();
    eq.data.datasets.forEach((ds, k) => ds.data = (SNAP.eq.dataArrays[k] || []).slice());
    eq.update('none');

    wk.data.labels = SNAP.wk.labels.slice();
    wk.data.datasets.forEach((ds, k) => ds.data = (SNAP.wk.dataArrays[k] || []).slice());
    wk.update('none');

    // restore trades full
    tradesBody.innerHTML = SNAP.tradesHTML;

    // 2) If ALL: only fix KPI colors and done
    if (!startYmd) {
      // ALL 也要確保 KPI 顏色有
      ensureKpiRatingColors();
      setActiveRangeBtn(code);
      setStatus(`已套用區間：全段（~ ${endYmd}）`);
      return;
    }

    // 3) Slice charts by actual daily ymd indices
    const eqLabels = SNAP.eq.labels;
    const wkLabels = SNAP.wk.labels;

    // 建索引（labels -> ymd）
    const eqYmds = eqLabels.map(l => parseYmdFromText(l));
    const wkYmds = wkLabels.map(l => parseYmdFromText(l));

    const eqKeep = [];
    for (let i = 0; i < eqYmds.length; i++) {
      const y = eqYmds[i];
      if (!y) continue; // label 沒日期就跳過
      if (y >= startYmd && y <= endYmd) eqKeep.push(i);
    }

    const wkKeep = [];
    for (let i = 0; i < wkYmds.length; i++) {
      const y = wkYmds[i];
      if (!y) continue;
      if (y >= startYmd && y <= endYmd) wkKeep.push(i);
    }

    // 若 keep 太少（避免空白）：至少保留最後 12 / 8 筆
    const eqIdx = (eqKeep.length >= 2) ? eqKeep : (() => {
      const n = Math.min(eqLabels.length, 12);
      const start = Math.max(0, eqLabels.length - n);
      return Array.from({length:n}, (_,k)=>start+k);
    })();

    const wkIdx = (wkKeep.length >= 2) ? wkKeep : (() => {
      const n = Math.min(wkLabels.length, 8);
      const start = Math.max(0, wkLabels.length - n);
      return Array.from({length:n}, (_,k)=>start+k);
    })();

    // apply slice to eq + rebase all long/short/total
    eq.data.labels = eqIdx.map(i => eqLabels[i]);
    eq.data.datasets.forEach((ds, k) => {
      const orig = SNAP.eq.dataArrays[k] || [];
      let sliced = eqIdx.map(i => orig[i]);
      if (shouldRebaseLabel(ds.label)) sliced = rebaseArray(sliced);
      ds.data = sliced;
    });
    eq.update('none');

    // apply slice to daily pnl chart (wk canvas) — do NOT rebase bars/values (keep true daily pnl)
    wk.data.labels = wkIdx.map(i => wkLabels[i]);
    wk.data.datasets.forEach((ds, k) => {
      const orig = SNAP.wk.dataArrays[k] || [];
      ds.data = wkIdx.map(i => orig[i]);
    });
    wk.update('none');

    // 4) Trade details: show only trades in range AND reset cum from 0
    rebuildTradeTableCums(startYmd, endYmd);

    // 5) KPI colors
    ensureKpiRatingColors();

    setActiveRangeBtn(code);
    setStatus(`已套用區間：${code}（${startYmd} ~ ${endYmd}）`);
  }

  function hookRangeButtons(){
    if (!rangeRow) return;
    rangeRow.addEventListener('click', (e) => {
      const btn = e.target.closest('.range-btn');
      if (!btn) return;
      const code = btn.dataset.range || 'ALL';
      applyRange(code);
    });
  }

  // -----------------------------
  // Wait for render
  // -----------------------------
  function waitAndInit(){
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      const ok = snapshotOnce();
      if (ok) {
        clearInterval(timer);
        hookRangeButtons();
        ensureKpiRatingColors();
        applyRange('ALL');
      }
      if (tries > 280) clearInterval(timer);
    }, 120);
  }

  // -----------------------------
  // Boot: fetch + merge + feed (same as 0807.js)
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

      // baseline from manifest or second newest
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

      setStatus('下載最新 0807 檔案並解碼中…');
      const latestUrl = latest.from === 'url' ? latest.fullPath : pubUrl(latest.fullPath);
      const rNew = await fetchSmart(latestUrl);
      if (rNew.ok === 0) {
        setStatus(`最新檔沒有合法交易行（解碼=${rNew.enc}）。`, true);
        return;
      }

      let mergedText = rNew.canon;

      if (base) {
        setStatus('下載基準檔並進行合併…');
        const baseUrl = base.from === 'url' ? base.fullPath : pubUrl(base.fullPath);
        const rBase   = await fetchSmart(baseUrl);
        mergedText = mergeByBaseline(rBase.canon, rNew.canon);
      }

      // set baseline button
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

      const mergedWithInpos = addFakeInpos(mergedText);
      const finalText = '0807 MERGED\n' + mergedWithInpos;

      setStatus('已載入（合併後）資料，開始分析…');
      await feedToSingleTrades(latest.name, finalText);
      setStatus('分析完成（可調整本頁「本金／滑點」即時重算 KPI）。');

      // init range after render
      waitAndInit();
    } catch (err) {
      console.error(err);
      setStatus('初始化失敗：' + (err.message || err), true);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
