// 0807-1.js — 基準合併 + 自動分析（修正版）
// 修正：
// 1) 近1週/近2週以最後交易日為錨（週一）
// 2) 不依賴 14 碼時間：交易明細/labels 皆可抓到 endYmd
// 3) Range 按鈕「一定會動」：snapshot 未完成也會自動重試後套用
// 4) KPI 顏色/美化補回：依 Strong/Adequate/Improve 文字補 class（不重算 KPI）

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
  const weeklyCanvas = $('#weeklyPnlChart');

  const slipInput = $('#slipInput');
  const runBtn    = $('#runBtn');

  if (status) status.style.whiteSpace = 'pre-wrap';

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

  function setStatus(msg, bad = false) {
    if (!status) return;
    status.textContent = msg;
    status.style.color = bad ? '#c62828' : '#666';
  }

  // slip=2 保險
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

  // Supabase
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

  // TXT decode
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
  // Range slicing state
  // -----------------------------
  const SNAP = {
    ready: false,
    eqLabels: null,
    eqDataArrays: null,
    wkLabels: null,
    wkDataArrays: null,
    tradeRows: null,      // {ymd, html}
    tradeYmdList: null,   // unique sorted
    endYmd: null
  };

  function pad2(n){ return String(n).padStart(2,'0'); }
  function ymdToDate(ymd){
    if (!ymd || ymd.length !== 8) return null;
    const y=+ymd.slice(0,4), m=+ymd.slice(4,6), d=+ymd.slice(6,8);
    if (!y||!m||!d) return null;
    return new Date(y, m-1, d);
  }
  function dateToYmd(d){
    return `${d.getFullYear()}${pad2(d.getMonth()+1)}${pad2(d.getDate())}`;
  }

  // 從各種文字抽 YYYYMMDD（最穩，避免 1969/1970）
  function parseYmdFromText(text){
    const s = String(text || '').trim();

    // 1) 先抓 14 碼（YYYYMMDDhhmmss）
    let m = s.match(/\b(20\d{12})\b/);
    if (m) return m[1].slice(0,8);

    // 2) 再抓 8 碼（YYYYMMDD）
    m = s.match(/\b(20\d{6})\b/);
    if (m) return m[1];

    // 3) 再抓 YYYY/MM/DD 或 YYYY-MM-DD
    m = s.match(/\b(20\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/);
    if (m) return `${m[1]}${pad2(m[2])}${pad2(m[3])}`;

    return '';
  }

  function getChart(canvas){
    if (!canvas || !window.Chart) return null;
    try { return window.Chart.getChart(canvas) || null; } catch { return null; }
  }

  function snapshotOnce(){
    if (SNAP.ready) return true;

    const eq = getChart(equityCanvas);
    if (!eq || !eq.data?.labels?.length || !eq.data?.datasets?.length) return false;

    SNAP.eqLabels = eq.data.labels.slice();
    SNAP.eqDataArrays = eq.data.datasets.map(ds => Array.isArray(ds.data) ? ds.data.slice() : []);

    const wk = getChart(weeklyCanvas);
    if (wk && wk.data?.labels?.length && wk.data?.datasets?.length) {
      SNAP.wkLabels = wk.data.labels.slice();
      SNAP.wkDataArrays = wk.data.datasets.map(ds => Array.isArray(ds.data) ? ds.data.slice() : []);
    } else {
      SNAP.wkLabels = null;
      SNAP.wkDataArrays = null;
    }

    // trades table
    const trs = Array.from(tradesBody?.querySelectorAll('tr') || []);
    if (!trs.length) return false;

    const rows = trs.map(tr => {
      const tds = tr.querySelectorAll('td');
      const dtText = (tds && tds[1]) ? tds[1].textContent.trim() : '';
      const ymd = parseYmdFromText(dtText);
      return { ymd, html: tr.outerHTML };
    });

    // endYmd: last non-empty
    let endYmd = '';
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].ymd) { endYmd = rows[i].ymd; break; }
    }

    // fallback: from eq labels (tooltip may have YYYY/MM/DD)
    if (!endYmd && SNAP.eqLabels?.length) {
      for (let i = SNAP.eqLabels.length - 1; i >= 0; i--) {
        const y = parseYmdFromText(SNAP.eqLabels[i]);
        if (y) { endYmd = y; break; }
      }
    }

    if (!endYmd) return false;

    // unique ymd list
    const uniq = new Set();
    for (const r of rows) if (r.ymd) uniq.add(r.ymd);
    const ymdList = Array.from(uniq).sort();

    SNAP.tradeRows = rows;
    SNAP.tradeYmdList = ymdList;
    SNAP.endYmd = endYmd;
    SNAP.ready = true;

    return true;
  }

  function mondayOfWeek(d){
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const day = x.getDay(); // 0 Sun..6 Sat
    const delta = (day === 0) ? -6 : (1 - day);
    x.setDate(x.getDate() + delta);
    return x;
  }

  // 你指定規則：近1週=本週一~最後交易日；近2週=上週一~最後交易日
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

  function countTradingDays(ymdList, startYmd, endYmd){
    if (!startYmd) return ymdList.length;
    let c = 0;
    for (const y of ymdList) if (y >= startYmd && y <= endYmd) c++;
    return c;
  }

  function setActiveRangeBtn(code){
    if (!rangeRow) return;
    const btns = Array.from(rangeRow.querySelectorAll('.range-btn'));
    btns.forEach(b => b.classList.toggle('active', (b.dataset.range === code)));
  }

  // KPI 顏色補回（不動數值、不重算）
  function ensureKpiStyling(){
    // 依文字補 class（適用於機構評語欄位）
    const cells = Array.from(document.querySelectorAll('td'));
    for (const td of cells) {
      const t = (td.textContent || '').trim();
      if (t === 'Strong') td.classList.add('rating-strong');
      else if (t === 'Adequate') td.classList.add('rating-adequate');
      else if (t === 'Improve') td.classList.add('rating-improve');
    }
  }

  function shouldRebaseLabel(label){
    const s = String(label || '');
    if (/最高|最低/.test(s)) return false;
    return /損益|淨值|累積/.test(s);
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

  function applyFilter(rangeCode){
    // snapshot 未 ready 時也要能按：自動重試
    if (!snapshotOnce()) {
      setStatus('區間切換：資料尚未就緒，正在重試…');
      setTimeout(() => applyFilter(rangeCode), 150);
      return;
    }

    const endYmd = SNAP.endYmd;
    const startYmd = rangeStartYmd(endYmd, rangeCode);

    // 1) trades：精準按日期切（你要的週一錨定）
    const keptTrades = (!startYmd)
      ? SNAP.tradeRows
      : SNAP.tradeRows.filter(r => !r.ymd || (r.ymd >= startYmd && r.ymd <= endYmd));

    if (tradesBody) {
      tradesBody.innerHTML = keptTrades.map(r => r.html).join('');
      const trs = Array.from(tradesBody.querySelectorAll('tr'));
      trs.forEach((tr, i) => {
        const td0 = tr.querySelector('td');
        if (td0) td0.textContent = String(i + 1);
      });
    }

    // 2) 主圖/週圖：labels 非逐日 → 用「交易日比例」切，確保會動
    const totalDays = SNAP.tradeYmdList.length || 1;
    const keptDays  = countTradingDays(SNAP.tradeYmdList, startYmd, endYmd);

    const ratio = Math.max(0.02, Math.min(1, keptDays / totalDays));
    const totalPoints = SNAP.eqLabels.length;

    const keepPoints = Math.max(12, Math.min(totalPoints, Math.ceil(totalPoints * ratio)));
    const startIdx = Math.max(0, totalPoints - keepPoints);

    const eq = getChart(equityCanvas);
    if (eq) {
      eq.data.labels = SNAP.eqLabels.slice(startIdx);

      // 只改 ds.data，不替換 dataset 物件（保留顏色/線型/圖例）
      eq.data.datasets.forEach((ds, k) => {
        const orig = SNAP.eqDataArrays[k] || [];
        let sliced = orig.slice(startIdx);
        if (shouldRebaseLabel(ds.label)) sliced = rebaseArray(sliced); // 從0開始
        ds.data = sliced;
      });

      eq.update('none');
    }

    const wk = getChart(weeklyCanvas);
    if (wk && SNAP.wkLabels && SNAP.wkDataArrays) {
      const wkTotal = SNAP.wkLabels.length;
      const wkKeep = Math.max(8, Math.min(wkTotal, Math.ceil(wkTotal * ratio)));
      const wkStart = Math.max(0, wkTotal - wkKeep);

      wk.data.labels = SNAP.wkLabels.slice(wkStart);
      wk.data.datasets.forEach((ds, k) => {
        const orig = SNAP.wkDataArrays[k] || [];
        ds.data = orig.slice(wkStart); // 週圖不 rebase（避免週損益柱狀失真）
      });
      wk.update('none');
    }

    setActiveRangeBtn(rangeCode);
    ensureKpiStyling(); // 補回 KPI 顏色
    setStatus(`已套用區間：${rangeCode}（${startYmd || '全段'} ~ ${endYmd}）`);
  }

  function hookRangeButtons(){
    if (!rangeRow) return;
    rangeRow.addEventListener('click', (e) => {
      const btn = e.target.closest('.range-btn');
      if (!btn) return;
      const code = btn.dataset.range || 'ALL';
      applyFilter(code);
    });
  }

  function waitAndInit(){
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (snapshotOnce()) {
        clearInterval(timer);
        hookRangeButtons();
        ensureKpiStyling();
        applyFilter('ALL');
      }
      if (tries > 240) clearInterval(timer);
    }, 120);
  }

  // =========================
  // 主流程
  // =========================
  async function boot() {
    try {
      if (!sb) {
        setStatus('Supabase SDK 未載入或初始化失敗。', true);
        return;
      }

      forceSlip2();

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

      if (!latest) { setStatus('找不到可分析的 0807 檔案。', true); return; }
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

      // download newest
      setStatus('下載最新 0807 檔案並解碼中…');
      const latestUrl = latest.from === 'url' ? latest.fullPath : pubUrl(latest.fullPath);
      const rNew = await fetchSmart(latestUrl);
      if (rNew.ok === 0) { setStatus(`最新檔沒有合法交易行（解碼=${rNew.enc}）。`, true); return; }

      let mergedText = rNew.canon;

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

      // feed to single-trades.js
      const mergedWithInpos = addFakeInpos(mergedText);
      const finalText       = '0807 MERGED\n' + mergedWithInpos;

      setStatus('已載入（合併後）資料，開始分析…');
      await feedToSingleTrades(latest.name, finalText);
      setStatus('分析完成（可調整本頁「本金／滑點」即時重算 KPI）。');

      // init range
      waitAndInit();
    } catch (err) {
      console.error(err);
      setStatus('初始化失敗：' + (err.message || err), true);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
