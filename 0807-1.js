// 0807-1.js — 0807 精進版（區間切換 + 圖表歸零 + KPI 顏色補回 + 明細正確過濾）
// 核心原則：
// - 不碰 single-trades.js 的 KPI 計算，只做「前端視覺切片」
// - 不替換 Chart datasets 物件，只改 ds.data（避免顏色/線型被洗掉）
// - 交易明細不重編號、不改任何 td 內容（避免欄位錯位）
// - 區間以最後交易日為錨：
//   近1週：本週週一~最後交易日；近2週：上週週一~最後交易日；其餘用日數回推

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

  // Supabase
  const SUPABASE_URL  = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET        = "reports";
  const WANT          = /0807/i;
  const MANIFEST_PATH = "manifests/0807.json";

  const sb = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { fetch: (u, o = {}) => fetch(u, { ...o, cache: 'no-store' }) }
  });

  // canonical 3 欄
  const CANON_RE   = /^(\d{14})\.0{6}\s+(\d+\.\d{6})\s+(新買|平賣|新賣|平買|強制平倉)\s*$/;
  const EXTRACT_RE = /.*?(\d{14})(?:\.0{1,6})?\s+(\d+(?:\.\d{1,6})?)\s*(新買|平賣|新賣|平買|強制平倉)\s*$/;

  function setStatus(msg, bad = false) {
    if (!status) return;
    status.textContent = msg;
    status.style.color = bad ? '#c62828' : '#666';
  }

  // =========================
  // slip=2 保險（保持你 0807-1 的需求）
  // =========================
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

  // =========================
  // Supabase helpers
  // =========================
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

  // =========================
  // TXT decode
  // =========================
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

  // 給 single-trades.js 判方向用
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

  // =========================
  // Range slicing state
  // =========================
  const SNAP = {
    ready: false,
    eqLabels: null,
    eqDataArrays: null,
    wkLabels: null,
    wkDataArrays: null,
    tradeRows: null,     // {ymd, html}
    tradeYmdList: null,  // unique sorted
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

  // 從任意文字抓 YYYYMMDD：支援
  // - 20xxxxxxxxxxxx（14碼）
  // - 20xxxxxx（8碼）
  // - 2025/12/12、2025-12-12
  function parseYmdFromText(text){
    const s = String(text || '').trim();

    let m = s.match(/\b(20\d{12})\b/);
    if (m) return m[1].slice(0,8);

    m = s.match(/\b(20\d{6})\b/);
    if (m) return m[1];

    m = s.match(/\b(20\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/);
    if (m) return `${m[1]}${pad2(m[2])}${pad2(m[3])}`;

    return '';
  }

  // 從一整列 tr 抓日期（不要假設是哪一欄，避免欄位改版造成失效）
  function parseYmdFromRow(tr){
    if (!tr) return '';
    const tds = Array.from(tr.querySelectorAll('td'));
    for (const td of tds) {
      const ymd = parseYmdFromText(td.textContent);
      if (ymd) return ymd;
    }
    // 最後 fallback：整列文字
    return parseYmdFromText(tr.textContent);
  }

  function getChart(canvas){
    if (!canvas || !window.Chart) return null;
    try { return window.Chart.getChart(canvas) || null; } catch { return null; }
  }

  // KPI 顏色補回（Strong=紅, Adequate=黃, Improve=綠）
  function ensureKpiRatingColors(){
    const map = {
      'Strong': 'rating-strong',
      'Adequate': 'rating-adequate',
      'Improve': 'rating-improve'
    };

    // 只補「文字等於 Strong/Adequate/Improve」的 cell
    const tds = Array.from(document.querySelectorAll('td'));
    for (const td of tds) {
      const t = (td.textContent || '').trim();
      const cls = map[t];
      if (!cls) continue;
      td.classList.remove('rating-strong','rating-adequate','rating-improve');
      td.classList.add(cls);
    }

    // 綜合分數卡（如果 single-trades.js 有更新它但沒帶 class，也補）
    const scoreVal = document.querySelector('#scoreCard .score-value');
    const scoreDesc = document.querySelector('#scoreCard .score-desc');
    if (scoreVal && scoreDesc) {
      // 若 scoreVal 已有 strong/adequate/improve 就不動
      const has = scoreVal.classList.contains('strong') ||
                  scoreVal.classList.contains('adequate') ||
                  scoreVal.classList.contains('improve');
      if (!has) {
        // 以 scoreDesc 文字含 Strong/Adequate/Improve 判斷
        const d = scoreDesc.textContent || '';
        if (/Strong/i.test(d)) scoreVal.classList.add('strong');
        else if (/Adequate/i.test(d)) scoreVal.classList.add('adequate');
        else if (/Improve/i.test(d)) scoreVal.classList.add('improve');
      }
    }
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

    // 交易明細快照
    const trs = Array.from(tradesBody?.querySelectorAll('tr') || []);
    if (!trs.length) return false;

    const rows = trs.map(tr => ({
      ymd: parseYmdFromRow(tr),
      html: tr.outerHTML
    }));

    // endYmd
    let endYmd = '';
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].ymd) { endYmd = rows[i].ymd; break; }
    }
    if (!endYmd) return false;

    const uniq = new Set();
    for (const r of rows) if (r.ymd) uniq.add(r.ymd);
    const ymdList = Array.from(uniq).sort();

    SNAP.tradeRows = rows;
    SNAP.tradeYmdList = ymdList;
    SNAP.endYmd = endYmd;
    SNAP.ready = true;
    return true;
  }

  // 週一錨定
  function mondayOfWeek(d){
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const day = x.getDay(); // 0 Sun..6 Sat
    const delta = (day === 0) ? -6 : (1 - day);
    x.setDate(x.getDate() + delta);
    return x;
  }

  // 你指定的週區間規則 + 其他區間
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

  // 圖表歸零規則：總/多頭/空頭 都要歸零；不動最高/最低 marker
  function shouldRebaseLabel(label){
    const s = String(label || '');
    if (/最高|最低/.test(s)) return false;
    // 多頭/空頭/總損益（含滑價/理論）都要歸零
    return /(損益|淨值|累積|多頭|空頭|總)/.test(s);
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
    // 尚未 ready 也要能按（自動重試）
    if (!snapshotOnce()) {
      setStatus('區間切換：資料尚未就緒，正在重試…');
      setTimeout(() => applyFilter(rangeCode), 180);
      return;
    }

    const endYmd = SNAP.endYmd;
    const startYmd = rangeStartYmd(endYmd, rangeCode);

    // 1) 交易明細：顯示區間內每筆交易（不改任何欄位，不重編號）
    const keptTrades = (!startYmd)
      ? SNAP.tradeRows
      : SNAP.tradeRows.filter(r => !r.ymd || (r.ymd >= startYmd && r.ymd <= endYmd));

    if (tradesBody) {
      tradesBody.innerHTML = keptTrades.map(r => r.html).join('');
    }

    // 2) 圖表：labels 非逐日 → 以交易日比例切，確保近2週也一定會動
    const totalDays = SNAP.tradeYmdList.length || 1;
    const keptDays  = countTradingDays(SNAP.tradeYmdList, startYmd, endYmd);
    const ratio = Math.max(0.02, Math.min(1, keptDays / totalDays));

    // 主圖
    const eq = getChart(equityCanvas);
    if (eq) {
      const totalPoints = SNAP.eqLabels.length;
      const keepPoints = Math.max(12, Math.min(totalPoints, Math.ceil(totalPoints * ratio)));
      const startIdx = Math.max(0, totalPoints - keepPoints);

      eq.data.labels = SNAP.eqLabels.slice(startIdx);

      // 只改 ds.data，不替換 dataset 物件（保留顏色/線型/圖例）
      eq.data.datasets.forEach((ds, k) => {
        const orig = SNAP.eqDataArrays[k] || [];
        let sliced = orig.slice(startIdx);
        if (shouldRebaseLabel(ds.label)) sliced = rebaseArray(sliced); // 歸0
        ds.data = sliced;
      });

      eq.update('none');
    }

    // 週圖（不強制歸0，避免週損益柱狀失真；但也要能切）
    const wk = getChart(weeklyCanvas);
    if (wk && SNAP.wkLabels && SNAP.wkDataArrays) {
      const wkTotal = SNAP.wkLabels.length;
      const wkKeep = Math.max(8, Math.min(wkTotal, Math.ceil(wkTotal * ratio)));
      const wkStart = Math.max(0, wkTotal - wkKeep);

      wk.data.labels = SNAP.wkLabels.slice(wkStart);
      wk.data.datasets.forEach((ds, k) => {
        const orig = SNAP.wkDataArrays[k] || [];
        ds.data = orig.slice(wkStart);
      });
      wk.update('none');
    }

    setActiveRangeBtn(rangeCode);

    // 3) KPI：補回紅/黃/綠（Strong/Adequate/Improve）
    ensureKpiRatingColors();

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
        ensureKpiRatingColors();
        applyFilter('ALL');
      }
      if (tries > 260) clearInterval(timer);
    }, 120);
  }

  // =========================
  // 主流程（沿用 0807.js 合併餵檔方式）
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

      // 1) 最新檔
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

      // 2) 基準檔
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

      // 3) 下載最新
      setStatus('下載最新 0807 檔案並解碼中…');
      const latestUrl = latest.from === 'url' ? latest.fullPath : pubUrl(latest.fullPath);
      const rNew = await fetchSmart(latestUrl);
      if (rNew.ok === 0) { setStatus(`最新檔沒有合法交易行（解碼=${rNew.enc}）。`, true); return; }

      let mergedText = rNew.canon;

      // 4) 合併基準
      if (base) {
        setStatus('下載基準檔並進行合併…');
        const baseUrl = base.from === 'url' ? base.fullPath : pubUrl(base.fullPath);
        const rBase   = await fetchSmart(baseUrl);
        mergedText = mergeByBaseline(rBase.canon, rNew.canon);
      }

      // 5) 設基準按鈕
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

      // 6) 餵給 single-trades.js
      const mergedWithInpos = addFakeInpos(mergedText);
      const finalText = '0807 MERGED\n' + mergedWithInpos;

      setStatus('已載入（合併後）資料，開始分析…');
      await feedToSingleTrades(latest.name, finalText);
      setStatus('分析完成（可調整本頁「本金／滑點」即時重算 KPI）。');

      // 7) 等 single-trades.js 完成渲染後再啟用區間
      waitAndInit();
    } catch (err) {
      console.error(err);
      setStatus('初始化失敗：' + (err.message || err), true);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
