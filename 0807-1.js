// 0807-1.js — 基準合併 + 自動分析（修正版）
// 修正點：
// A) 近1週/近2週：以最後交易日為錨，週一為起點
// B) 切區間後主圖「從0開始」只 rebase 累積損益線，不動最高/最低點 marker
// C) 不再在切區間時改 periodText（避免污染 UI / KPI）

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

  // Supabase 設定
  const SUPABASE_URL  = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET        = "reports";

  const sb = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { fetch: (u, o = {}) => fetch(u, { ...o, cache: 'no-store' }) }
  });

  const WANT          = /0807/i;
  const MANIFEST_PATH = "manifests/0807.json";

  // canonical 3 欄
  const CANON_RE   = /^(\d{14})\.0{6}\s+(\d+\.\d{6})\s+(新買|平賣|新賣|平買|強制平倉)\s*$/;
  const EXTRACT_RE = /.*?(\d{14})(?:\.0{1,6})?\s+(\d+(?:\.\d{1,6})?)\s*(新買|平賣|新賣|平買|強制平倉)\s*$/;

  function setStatus(msg, bad = false) {
    if (!status) return;
    status.textContent = msg;
    status.style.color = bad ? '#c62828' : '#666';
  }

  // ===== 確保首次計算就用 slip=2 =====
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

    s = s.replace(/\r\n?/g, '\n')
         .replace(/\u3000/g, ' ');

    const lines = s
      .split('\n')
      .map(l => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

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
    const lines = (text || '')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);

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

    if (window.__singleTrades_setFile) {
      window.__singleTrades_setFile(file);
    }

    if (fileInput) {
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    safeClickRun(4);
  }

  async function readManifest() {
    try {
      const { data, error } = await sb.storage.from(BUCKET).download(MANIFEST_PATH);
      if (error || !data) return null;
      const text = await data.text();
      return JSON.parse(text);
    } catch (e) {
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

  // ======================================================================
  // 區間篩選 + rebasing
  // ======================================================================
  const SNAP = {
    ready: false,
    eq: null,
    wk: null,
    trades: null,
    endYMD: null,
    endDate: null
  };

  function pad2(n){ return String(n).padStart(2,'0'); }
  function dateToYMD(d){ return `${d.getFullYear()}${pad2(d.getMonth()+1)}${pad2(d.getDate())}`; }
  function ymdToDate(ymd) {
    if (!ymd || ymd.length !== 8) return null;
    const y = Number(ymd.slice(0,4));
    const m = Number(ymd.slice(4,6));
    const d = Number(ymd.slice(6,8));
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d);
  }

  function parseAnyDate(x) {
    if (!x) return null;
    if (x instanceof Date) return x;
    if (typeof x === 'number') {
      const d = new Date(x);
      return isNaN(d.getTime()) ? null : d;
    }
    const s = String(x).trim();

    // 先抓 YYYY/MM/DD or YYYY-MM-DD（tooltip 會是這種）
    let m = s.match(/\b(20\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/);
    if (m) return new Date(+m[1], +m[2]-1, +m[3]);

    // 再抓 YYYYMMDD（容錯）
    m = s.match(/\b(20\d{6})\b/);
    if (m) return ymdToDate(m[1]);

    // YYYY/MM or YYYY-MM（軸上可能是這種）
    m = s.match(/\b(20\d{2})[\/\-](\d{1,2})\b/);
    if (m) return new Date(+m[1], +m[2]-1, 1);

    return null;
  }

  function mondayOfWeek(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const day = x.getDay(); // 0=Sun..6=Sat
    const delta = (day === 0) ? -6 : (1 - day);
    x.setDate(x.getDate() + delta);
    return x;
  }

  function rangeStartDate(endDate, code) {
    if (!endDate) return null;
    if (code === 'ALL') return null;

    if (code === '1W') return mondayOfWeek(endDate);

    if (code === '2W') {
      const m = mondayOfWeek(endDate);
      m.setDate(m.getDate() - 7);
      return m;
    }

    const daysMap = { '1M':30, '2M':60, '3M':91, '6M':182, '1Y':365 };
    const n = daysMap[code] || 0;
    if (!n) return null;
    const s = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate());
    s.setDate(s.getDate() - n);
    return s;
  }

  function snapshotOnce() {
    if (SNAP.ready) return true;

    const eq = equityCanvas ? Chart.getChart(equityCanvas) : null;
    const wk = weeklyCanvas ? Chart.getChart(weeklyCanvas) : null;
    if (!eq || !eq.data?.labels?.length || !eq.data?.datasets?.length) return false;

    SNAP.eq = {
      labels: eq.data.labels.slice(),
      datasets: eq.data.datasets.map(ds => ({
        // 只存 data，避免破壞 single-trades.js 的 styling
        data: Array.isArray(ds.data) ? ds.data.slice() : []
      }))
    };

    if (wk && wk.data?.labels?.length && wk.data?.datasets?.length) {
      SNAP.wk = {
        labels: wk.data.labels.slice(),
        datasets: wk.data.datasets.map(ds => ({ data: Array.isArray(ds.data) ? ds.data.slice() : [] }))
      };
    }

    // 交易明細快照 + 取得最後交易日（以明細為準）
    const tradeRows = Array.from(tradesBody?.querySelectorAll('tr') || []);
    const rows = tradeRows.map(tr => {
      const tds = tr.querySelectorAll('td');
      const dtText = (tds && tds[1]) ? tds[1].textContent.trim() : '';
      const m = dtText.match(/\b(20\d{12})\b/);
      const ts14 = m ? m[1] : '';
      const ymd = ts14 ? ts14.slice(0,8) : '';
      return { ymd, html: tr.outerHTML };
    });

    SNAP.trades = { rows };

    let endYMD = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const ymd = rows[i].ymd;
      if (ymd && ymd.length === 8) { endYMD = ymd; break; }
    }

    let endDate = endYMD ? ymdToDate(endYMD) : null;

    // fallback：用 labels 最後可解析日期
    if (!endDate) {
      for (let i = SNAP.eq.labels.length - 1; i >= 0; i--) {
        const dt = parseAnyDate(SNAP.eq.labels[i]);
        if (dt) { endDate = dt; endYMD = dateToYMD(dt); break; }
      }
    }

    if (!endDate) endDate = new Date();
    if (!endYMD) endYMD = dateToYMD(endDate);

    SNAP.endYMD  = endYMD;
    SNAP.endDate = endDate;
    SNAP.ready = true;
    return true;
  }

  function setActiveRangeBtn(code) {
    if (!rangeRow) return;
    const btns = Array.from(rangeRow.querySelectorAll('.range-btn'));
    btns.forEach(b => b.classList.toggle('active', (b.dataset.range === code)));
  }

  // 只 rebase 「累積損益線」，不要動 marker（最高/最低點）
  function shouldRebaseDataset(chart, datasetIndex) {
    const ds = chart.data.datasets?.[datasetIndex];
    if (!ds) return false;
    const label = String(ds.label || '');

    // 不動最高/最低點 marker
    if (/最高|最低/.test(label)) return false;

    // 只對「累積/淨損益/損益」之類線做 rebase
    // 你 legend 裡是「含滑價總損益、多頭含滑價、空頭含滑價…」這些要 rebase
    if (/損益|淨值|累積/.test(label)) return true;

    // 其他一律不動（保守）
    return false;
  }

  function rebaseSeries(dataArr) {
    if (!Array.isArray(dataArr) || dataArr.length === 0) return dataArr;

    const first = dataArr[0];

    // number
    if (typeof first === 'number') {
      const base = first;
      if (!Number.isFinite(base)) return dataArr;
      return dataArr.map(v => (Number.isFinite(v) ? v - base : v));
    }

    // object {x,y} or {t,y}
    if (first && typeof first === 'object') {
      const baseY = Number(first.y);
      if (!Number.isFinite(baseY)) return dataArr;
      return dataArr.map(p => {
        if (!p || typeof p !== 'object') return p;
        const y = Number(p.y);
        if (!Number.isFinite(y)) return p;
        return { ...p, y: y - baseY };
      });
    }

    return dataArr;
  }

  function applyFilter(rangeCode) {
    if (!snapshotOnce()) return;

    const eq = equityCanvas ? Chart.getChart(equityCanvas) : null;
    const wk = weeklyCanvas ? Chart.getChart(weeklyCanvas) : null;
    if (!eq) return;

    const endDate = SNAP.endDate;
    const startDate = rangeStartDate(endDate, rangeCode);
    const startYMD = startDate ? dateToYMD(startDate) : null;

    // === 主圖：用 labels 日期篩選；切片後僅對累積損益線 rebase ===
    const L = SNAP.eq.labels;
    let keepIdx = [];

    if (!startDate) {
      keepIdx = L.map((_, i) => i);
    } else {
      for (let i = 0; i < L.length; i++) {
        const dt = parseAnyDate(L[i]);
        if (dt && dt >= startDate && dt <= endDate) keepIdx.push(i);
      }

      // fallback：若 labels 解析不到（避免空）
      if (keepIdx.length === 0) {
        // 近1週=5交易日、近2週=10交易日
        const fb = ({ '1W':5, '2W':10, '1M':22, '2M':44, '3M':66, '6M':132, '1Y':260 })[rangeCode] || 0;
        const start = fb ? Math.max(0, L.length - fb) : 0;
        for (let i = start; i < L.length; i++) keepIdx.push(i);
      }
    }

    eq.data.labels = keepIdx.map(i => L[i]);

    eq.data.datasets.forEach((ds, k) => {
      const orig = SNAP.eq.datasets[k]?.data || [];
      const sliced = keepIdx.map(i => orig[i]);

      // 只對指定 dataset rebase
      ds.data = shouldRebaseDataset(eq, k) ? rebaseSeries(sliced) : sliced;
    });

    eq.update('none');

    // === 週圖：只切，不強制 rebase（避免柱狀週損益失真）===
    if (wk && SNAP.wk) {
      const WL = SNAP.wk.labels;
      let wKeep = [];

      if (!startDate) {
        wKeep = WL.map((_, i) => i);
      } else {
        for (let i = 0; i < WL.length; i++) {
          // 週圖 label 多半不是每日，解析不到很正常，所以用 fallback 為主
          const dt = parseAnyDate(WL[i]);
          if (dt && dt >= startDate && dt <= endDate) wKeep.push(i);
        }
        if (wKeep.length === 0) {
          const wkN = ({ '1W':4, '2W':8, '1M':13, '2M':26, '3M':39, '6M':78, '1Y':104 })[rangeCode] || 0;
          const start = wkN ? Math.max(0, WL.length - wkN) : 0;
          for (let i = start; i < WL.length; i++) wKeep.push(i);
        }
      }

      wk.data.labels = wKeep.map(i => WL[i]);
      wk.data.datasets.forEach((ds, k) => {
        const orig = SNAP.wk.datasets[k]?.data || [];
        ds.data = wKeep.map(i => orig[i]);
      });
      wk.update('none');
    }

    // === 交易明細：用 ymd（以最後交易日為錨、週一起算） ===
    if (tradesBody && SNAP.trades) {
      const rows = SNAP.trades.rows;

      if (!startYMD) {
        tradesBody.innerHTML = rows.map(r => r.html).join('');
      } else {
        const kept = rows.filter(r => !r.ymd || r.ymd >= startYMD);
        tradesBody.innerHTML = kept.map(r => r.html).join('');
      }

      // 重新編號
      const trs = Array.from(tradesBody.querySelectorAll('tr'));
      trs.forEach((tr, i) => {
        const td0 = tr.querySelector('td');
        if (td0) td0.textContent = String(i + 1);
      });
    }

    setActiveRangeBtn(rangeCode);
  }

  function hookRangeButtons() {
    if (!rangeRow) return;
    rangeRow.addEventListener('click', (e) => {
      const btn = e.target.closest('.range-btn');
      if (!btn) return;
      applyFilter(btn.dataset.range || 'ALL');
    });
  }

  function waitAndInitFilter() {
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (snapshotOnce()) {
        clearInterval(timer);
        hookRangeButtons();
        applyFilter('ALL');
      }
      if (tries > 200) clearInterval(timer);
    }, 100);
  }

  // ======================================================================
  // 主流程
  // ======================================================================
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

      // 1) 決定最新檔
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

      // 2) 決定基準檔
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

      // 3) 下載最新檔
      setStatus('下載最新 0807 檔案並解碼中…');
      const latestUrl = latest.from === 'url' ? latest.fullPath : pubUrl(latest.fullPath);
      const rNew = await fetchSmart(latestUrl);
      if (rNew.ok === 0) { setStatus(`最新檔沒有合法交易行（解碼=${rNew.enc}）。`, true); return; }

      let mergedText = rNew.canon;

      if (base) {
        setStatus('下載基準檔並進行合併…');
        const baseUrl = base.from === 'url' ? base.fullPath : pubUrl(base.fullPath);
        const rBase   = await fetchSmart(baseUrl);
        mergedText = mergeByBaseline(rBase.canon, rNew.canon).combined;
      }

      // 4) 設基準按鈕
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

      // 5) 插入假的 INPOS + header，餵 single-trades.js
      const mergedWithInpos = addFakeInpos(mergedText);
      const finalText       = '0807 MERGED\n' + mergedWithInpos;

      setStatus('已載入（合併後）資料，開始分析…');
      await feedToSingleTrades(latest.name, finalText);
      setStatus('分析完成（可調整本頁「本金／滑點」即時重算 KPI）。');

      // 6) 等圖表/表格完成後，啟用區間按鈕
      waitAndInitFilter();
    } catch (err) {
      console.error(err);
      setStatus('初始化失敗：' + (err.message || err), true);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
