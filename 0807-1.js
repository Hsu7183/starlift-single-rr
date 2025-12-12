// 0807-1.js — 最終穩定版（以交易日序列切片；近1週/近2週週一錨定；圖表日對齊；明細累計歸0；KPI紅黃綠）
//
// 你要的行為：
// 1) 近1週：以「最後交易日」為錨，區間=本週週一~最後交易日（例：2025/12/08~2025/12/12）
// 2) 主圖與下方「日損益圖」同一套交易日切片，確保每日對齊
// 3) 主圖多頭/空頭/總損益（含滑價/理論）切區間後都歸0；期間最高/最低點不歸0
// 4) 交易明細僅顯示區間內每筆交易；累積理論/累積實際從區間起點歸0累加
// 5) KPI Strong/Adequate/Improve 以紅/黃/綠顯示（補 class）
// 6) 其他區間（近1年/6月/3月/2月/1月/近2週/近1週）都可用，必定有反應

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
  const dailyCanvas  = $('#weeklyPnlChart'); // 你的頁面此圖實際為「每日損益圖」

  const slipInput = $('#slipInput');
  const runBtn    = $('#runBtn');

  if (status) status.style.whiteSpace = 'pre-wrap';

  function setStatus(msg, bad = false) {
    if (!status) return;
    status.textContent = msg;
    status.style.color = bad ? '#c62828' : '#666';
  }

  // -----------------------------
  // slip=2：開頁即算
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
  // Supabase + merge（對齊你 0807.js 的做法）
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
  // Utils: ymd/date/number
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
    const day = x.getDay(); // 0 Sun..6 Sat
    const delta = (day === 0) ? -6 : (1 - day);
    x.setDate(x.getDate() + delta);
    return x;
  }

  // 支援：YYYY/MM/DD、YYYY-MM-DD、YYYYMMDD、YYYYMMDDhhmmss、YYYY/M
  function parseYmdFromText(text){
    const s = String(text || '').trim();

    let m = s.match(/\b(20\d{12})\b/);
    if (m) return m[1].slice(0,8);

    m = s.match(/\b(20\d{6})\b/);
    if (m) return m[1];

    m = s.match(/\b(20\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/);
    if (m) return `${m[1]}${pad2(m[2])}${pad2(m[3])}`;

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
  }

  // -----------------------------
  // Chart ops
  // -----------------------------
  function getChart(canvas){
    if (!canvas || !window.Chart) return null;
    try { return window.Chart.getChart(canvas) || null; } catch { return null; }
  }

  function shouldRebaseLabel(label){
    const s = String(label || '');
    if (/最高|最低/.test(s)) return false;
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
  // Trade table: filter + reset cum
  // -----------------------------
  function rebuildTradeTableCums(startYmd, endYmd){
    const table = tradesBody?.closest('table');
    if (!table) return;

    const head = table.querySelector('thead');
    const ths = Array.from(head?.querySelectorAll('th') || []).map(th => (th.textContent || '').trim());

    const idxDateTime = ths.findIndex(t => t.includes('日期時間'));
    const idxTheo     = ths.findIndex(t => t.includes('理論淨損益'));
    const idxCumTheo  = ths.findIndex(t => t.includes('累積理論淨損益'));
    const idxReal     = ths.findIndex(t => t.includes('實際淨損益'));
    const idxCumReal  = ths.findIndex(t => t.includes('累積實際淨損益'));

    if (idxTheo < 0 || idxCumTheo < 0 || idxReal < 0 || idxCumReal < 0) {
      // 欄位找不到就只做過濾，不重算
      const rows0 = Array.from(tradesBody.querySelectorAll('tr'));
      const kept0 = rows0.filter(tr => {
        const tds = Array.from(tr.querySelectorAll('td'));
        const text = (idxDateTime >= 0 && tds[idxDateTime]) ? tds[idxDateTime].textContent : tr.textContent;
        const ymd = parseYmdFromText(text);
        if (!ymd) return true;
        return (!startYmd) ? true : (ymd >= startYmd && ymd <= endYmd);
      });
      tradesBody.innerHTML = kept0.map(tr => tr.outerHTML).join('');
      return;
    }

    // 先過濾區間內 row（保留所有交易）
    const rows = Array.from(tradesBody.querySelectorAll('tr'));
    const kept = rows.filter(tr => {
      const tds = Array.from(tr.querySelectorAll('td'));
      const text = (idxDateTime >= 0 && tds[idxDateTime]) ? tds[idxDateTime].textContent : tr.textContent;
      const ymd = parseYmdFromText(text);
      if (!ymd) return true;
      return (!startYmd) ? true : (ymd >= startYmd && ymd <= endYmd);
    });

    tradesBody.innerHTML = kept.map(tr => tr.outerHTML).join('');

    // 再重算累積（區間起點歸0）
    const newRows = Array.from(tradesBody.querySelectorAll('tr'));
    let cumTheo = 0;
    let cumReal = 0;

    for (const tr of newRows) {
      const tds = Array.from(tr.querySelectorAll('td'));
      const theo = parseNum(tds[idxTheo]?.textContent);
      const real = parseNum(tds[idxReal]?.textContent);

      if (Number.isFinite(theo)) cumTheo += theo;
      if (Number.isFinite(real)) cumReal += real;

      if (tds[idxCumTheo]) tds[idxCumTheo].textContent = formatNum(cumTheo);
      if (tds[idxCumReal]) tds[idxCumReal].textContent = formatNum(cumReal);
    }

    tradesBody.innerHTML = newRows.map(tr => tr.outerHTML).join('');
  }

  // -----------------------------
  // Snapshot originals
  // -----------------------------
  const SNAP = {
    ready: false,
    eq: { labels:null, dataArrays:null },
    daily: { labels:null, dataArrays:null },
    tradesHTML: null,
    tradeYmdList: null,
    endYmd: null
  };

  function snapshotOnce(){
    if (SNAP.ready) return true;

    const eq = getChart(equityCanvas);
    const dy = getChart(dailyCanvas);
    if (!eq || !eq.data?.labels?.length || !eq.data?.datasets?.length) return false;
    if (!dy || !dy.data?.labels?.length || !dy.data?.datasets?.length) return false;
    if (!tradesBody) return false;

    SNAP.eq.labels = eq.data.labels.slice();
    SNAP.eq.dataArrays = eq.data.datasets.map(ds => Array.isArray(ds.data) ? ds.data.slice() : []);

    SNAP.daily.labels = dy.data.labels.slice();
    SNAP.daily.dataArrays = dy.data.datasets.map(ds => Array.isArray(ds.data) ? ds.data.slice() : []);

    SNAP.tradesHTML = tradesBody.innerHTML;

    // 以交易明細產生交易日清單與 endYmd（取最大日期，避免最後一列不是最後交易日）
    const trs = Array.from(tradesBody.querySelectorAll('tr'));
    const yset = new Set();
    for (const tr of trs) {
      const ymd = parseYmdFromRow(tr);
      if (ymd) yset.add(ymd);
    }
    const ymdList = Array.from(yset).sort();
    if (!ymdList.length) return false;

    SNAP.tradeYmdList = ymdList;
    SNAP.endYmd = ymdList[ymdList.length - 1]; // 取最大交易日
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

    // 月/年：日數回推（你若要月初錨定可再加）
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
  // Apply range (核心)
  // -----------------------------
  function applyRange(code){
    if (!snapshotOnce()) {
      setStatus('區間切換：資料尚未就緒，正在重試…');
      setTimeout(() => applyRange(code), 180);
      return;
    }

    const endYmd = SNAP.endYmd;
    const startYmd = rangeStartYmd(endYmd, code);

    // restore originals
    const eq = getChart(equityCanvas);
    const dy = getChart(dailyCanvas);
    if (!eq || !dy) return;

    eq.data.labels = SNAP.eq.labels.slice();
    eq.data.datasets.forEach((ds, k) => ds.data = (SNAP.eq.dataArrays[k] || []).slice());
    eq.update('none');

    dy.data.labels = SNAP.daily.labels.slice();
    dy.data.datasets.forEach((ds, k) => ds.data = (SNAP.daily.dataArrays[k] || []).slice());
    dy.update('none');

    tradesBody.innerHTML = SNAP.tradesHTML;

    // ALL：只補 KPI 顏色
    if (!startYmd) {
      ensureKpiRatingColors();
      setActiveRangeBtn(code);
      setStatus(`已套用區間：全段（~ ${endYmd}）`);
      return;
    }

    // 建立 ymdRange（以交易日清單為準，確保近1週=週一~週五）
    const ymdRange = SNAP.tradeYmdList.filter(y => y >= startYmd && y <= endYmd);
    if (!ymdRange.length) {
      ensureKpiRatingColors();
      setActiveRangeBtn(code);
      setStatus(`區間內無交易日：${startYmd} ~ ${endYmd}`, true);
      return;
    }

    // 以 ymdRange 對齊切片：主圖與日損益圖都用同一套 ymdRange
    const eqLabelY = SNAP.eq.labels.map(l => parseYmdFromText(l));
    const dyLabelY = SNAP.daily.labels.map(l => parseYmdFromText(l));

    const eqIdx = [];
    const dyIdx = [];

    for (const ymd of ymdRange) {
      const i1 = eqLabelY.indexOf(ymd);
      if (i1 >= 0) eqIdx.push(i1);

      const i2 = dyLabelY.indexOf(ymd);
      if (i2 >= 0) dyIdx.push(i2);
    }

    // 若 chart labels 不完整（找不到日），至少保留尾端 N 日（仍保持兩圖同長度）
    const fallbackN = Math.min(ymdRange.length, 12);
    const eqUse = (eqIdx.length >= 2) ? eqIdx : (() => {
      const n = Math.min(SNAP.eq.labels.length, fallbackN);
      const start = Math.max(0, SNAP.eq.labels.length - n);
      return Array.from({length:n}, (_,k)=>start+k);
    })();

    const dyUse = (dyIdx.length >= 2) ? dyIdx : (() => {
      const n = Math.min(SNAP.daily.labels.length, fallbackN);
      const start = Math.max(0, SNAP.daily.labels.length - n);
      return Array.from({length:n}, (_,k)=>start+k);
    })();

    // apply eq slice + rebase（多/空/總都歸0）
    eq.data.labels = eqUse.map(i => SNAP.eq.labels[i]);
    eq.data.datasets.forEach((ds, k) => {
      const orig = SNAP.eq.dataArrays[k] || [];
      let sliced = eqUse.map(i => orig[i]);
      if (shouldRebaseLabel(ds.label)) sliced = rebaseArray(sliced);
      ds.data = sliced;
    });
    eq.update('none');

    // apply daily pnl slice（不歸0，保持真實每日損益；但日對齊）
    dy.data.labels = dyUse.map(i => SNAP.daily.labels[i]);
    dy.data.datasets.forEach((ds, k) => {
      const orig = SNAP.daily.dataArrays[k] || [];
      ds.data = dyUse.map(i => orig[i]);
    });
    dy.update('none');

    // trades: filter + reset cum from 0 within range
    rebuildTradeTableCums(startYmd, endYmd);

    // KPI colors
    ensureKpiRatingColors();

    setActiveRangeBtn(code);
    setStatus(`已套用區間：${code}（${startYmd} ~ ${endYmd}）`);
  }

  function hookRangeButtons(){
    if (!rangeRow) return;
    rangeRow.addEventListener('click', (e) => {
      const btn = e.target.closest('.range-btn');
      if (!btn) return;
      applyRange(btn.dataset.range || 'ALL');
    });
  }

  function waitAndInit(){
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (snapshotOnce()) {
        clearInterval(timer);
        hookRangeButtons();
        ensureKpiRatingColors();
        applyRange('ALL');
      }
      if (tries > 320) clearInterval(timer);
    }, 120);
  }

  // -----------------------------
  // Boot
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
      setStatus('分析完成（可調整本頁「本金／滑點」即時重算 KPI）。');

      // init after render
      waitAndInit();
    } catch (err) {
      console.error(err);
      setStatus('初始化失敗：' + (err.message || err), true);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
