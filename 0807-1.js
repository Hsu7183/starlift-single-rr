// 0807.js — 0807-1
// 1) 自動找最新 0807 + 基準合併，餵給 single-trades.js 做 KPI/表格
// 2) 圖表改由本檔接手：以「每日」序列（補齊無交易日=0），上下圖交易日對齊
// 3) 增加時區快選：近1週/2週/1~6月/1年/全；只有「全」顯示 KPI
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const status   = $('#autostatus');
  const elLatest = $('#latestName');
  const elBase   = $('#baseName');
  const elPeriod = $('#periodText');
  const btnBase  = $('#btnSetBaseline');
  const elHint   = $('#rangeHint');

  const wrapScore = $('#scoreCard');
  const wrapBad   = $('#kpiBadWrap');
  const wrapAll   = $('#kpiAllWrap');

  const tradesBody = $('#tradesBody');

  if (status) status.style.whiteSpace = 'pre-wrap';

  // Supabase 設定（與其他頁一致）
  const SUPABASE_URL  = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET        = "reports";

  const sb = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { fetch: (u, o = {}) => fetch(u, { ...o, cache: 'no-store' }) }
  });

  const WANT          = /0807/i;
  const MANIFEST_PATH = "manifests/0807.json";

  // canonical 3 欄行
  const CANON_RE   = /^(\d{14})\.0{6}\s+(\d+\.\d{6})\s+(新買|平賣|新賣|平買|強制平倉)\s*$/;
  const EXTRACT_RE = /.*?(\d{14})(?:\.0{1,6})?\s+(\d+(?:\.\d{1,6})?)\s*(新買|平賣|新賣|平買|強制平倉)\s*$/;

  // ======== 全域快取（single-trades 產出的交易明細→我們拿來做每日圖 & 區間切換） ========
  const CACHE = {
    ready: false,
    // from rendered table
    trades: [],   // [{idx, tsStr, date8, dtText, price, side, pts, fee, tax, theo, act}]
    // full-range bounds (from merged canon)
    fullStart8: '',
    fullEnd8: '',
    // latestEnd date object (for anchor)
    anchorEnd: null,
    // chart instances
    eqChart: null,
    pnlChart: null,
    // current range key
    rangeKey: 'all'
  };

  function setStatus(msg, bad = false) {
    if (!status) return;
    status.textContent = msg;
    status.style.color = bad ? '#c62828' : '#666';
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
        name     : it.name,
        fullPath : p + it.name,
        updatedAt: it.updated_at ? Date.parse(it.updated_at) : 0,
        size     : it.metadata?.size || 0
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

  // ===== 文字正規化 & canonical 行抽取 =====
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

  // combined = base 全部 + (latest 裡 ts > baseMax 的行)
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

  // 插入假的 INPOS 行（維持你原本邏輯）
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
    const runBtn    = $('#runBtn');

    const fname = filename || '0807.txt';
    const file  = new File([mergedText], fname, { type: 'text/plain' });

    if (window.__singleTrades_setFile) {
      window.__singleTrades_setFile(file);
    }

    if (fileInput) {
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    if (runBtn) runBtn.click();
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

  // =========================
  // 區間計算（以最新日為錨）
  // =========================
  function ymdToDate(yyyymmdd) {
    const y = +yyyymmdd.slice(0, 4);
    const m = +yyyymmdd.slice(4, 6) - 1;
    const d = +yyyymmdd.slice(6, 8);
    return new Date(y, m, d);
  }

  function dateToYMD(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${dd}`;
  }

  function fmtYMD(yyyymmdd) {
    if (!yyyymmdd || yyyymmdd.length !== 8) return '—';
    return `${yyyymmdd.slice(0,4)}/${yyyymmdd.slice(4,6)}/${yyyymmdd.slice(6,8)}`;
  }

  function mondayOfWeek(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const day = x.getDay(); // 0=Sun..6=Sat
    const delta = (day === 0) ? -6 : (1 - day);
    x.setDate(x.getDate() + delta);
    return x;
  }

  function addMonths(d, n) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const targetMonth = x.getMonth() + n;
    const y = x.getFullYear() + Math.floor(targetMonth / 12);
    const m = ((targetMonth % 12) + 12) % 12;
    // 盡量保持「同日」，若該月沒有該日，JS 會自動進位；我們要拉回月底
    const day = x.getDate();
    const t = new Date(y, m, 1);
    const lastDay = new Date(y, m + 1, 0).getDate();
    t.setDate(Math.min(day, lastDay));
    return t;
  }

  function calcRange(rangeKey) {
    const end = CACHE.anchorEnd;
    if (!end) return { start8: CACHE.fullStart8, end8: CACHE.fullEnd8 };

    let startDate = null;

    if (rangeKey === 'all') {
      return { start8: CACHE.fullStart8, end8: CACHE.fullEnd8 };
    }

    if (rangeKey === '1w') {
      startDate = mondayOfWeek(end);
    } else if (rangeKey === '2w') {
      const prevWeek = new Date(end.getFullYear(), end.getMonth(), end.getDate());
      prevWeek.setDate(prevWeek.getDate() - 7);
      startDate = mondayOfWeek(prevWeek);
    } else if (rangeKey === '1m') {
      startDate = addMonths(end, -1);
    } else if (rangeKey === '2m') {
      startDate = addMonths(end, -2);
    } else if (rangeKey === '3m') {
      startDate = addMonths(end, -3);
    } else if (rangeKey === '6m') {
      startDate = addMonths(end, -6);
    } else if (rangeKey === '1y') {
      startDate = addMonths(end, -12);
    } else {
      startDate = ymdToDate(CACHE.fullStart8);
    }

    const start8 = dateToYMD(startDate);
    const end8   = dateToYMD(end);
    return { start8, end8 };
  }

  function isWeekend(yyyymmdd) {
    const d = ymdToDate(yyyymmdd);
    const w = d.getDay();
    return (w === 0 || w === 6);
  }

  function buildTradingDays(start8, end8) {
    const days = [];
    let d = ymdToDate(start8);
    const end = ymdToDate(end8);
    while (d <= end) {
      const ymd = dateToYMD(d);
      if (!isWeekend(ymd)) days.push(ymd);
      d.setDate(d.getDate() + 1);
    }
    return days;
  }

  // =========================
  // 從交易明細表抓資料（single-trades 渲染後）
  // =========================
  function parseNumberLike(s) {
    if (s == null) return 0;
    const t = String(s).replace(/,/g, '').trim();
    if (!t) return 0;
    const v = Number(t);
    return Number.isFinite(v) ? v : 0;
  }

  function captureRenderedTrades() {
    const rows = $$('#tradesBody tr');
    if (!rows.length) return false;

    const parsed = [];
    for (const tr of rows) {
      const tds = Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim());
      // 期望欄位：# / 日期時間 / 成交點位 / 類別 / 點數 / 手續費 / 交易稅 / 理論淨損益 / 累積理論 / 實際淨損益 / 累積實際
      if (tds.length < 11) continue;

      const idx = parseNumberLike(tds[0]);
      const dtText = tds[1];
      // dtText 可能是 YYYY/MM/DD HH:MM:SS 或 YYYY-MM-DD ...；抓出 8 碼日期
      const m = dtText.match(/(20\d{2})[\/\-](\d{2})[\/\-](\d{2})/);
      const date8 = m ? `${m[1]}${m[2]}${m[3]}` : '';

      parsed.push({
        idx,
        dtText,
        date8,
        price: parseNumberLike(tds[2]),
        side : tds[3],
        pts  : parseNumberLike(tds[4]),
        fee  : parseNumberLike(tds[5]),
        tax  : parseNumberLike(tds[6]),
        theo : parseNumberLike(tds[7]),
        act  : parseNumberLike(tds[9]),
      });
    }

    // 依 idx 排序
    parsed.sort((a,b) => a.idx - b.idx);

    CACHE.trades = parsed;
    CACHE.ready = true;

    // anchorEnd 以「最後一筆交易日期」為準（你要的是 114/12/12 那種最新日錨）
    const last = parsed.length ? parsed[parsed.length - 1] : null;
    if (last?.date8) CACHE.anchorEnd = ymdToDate(last.date8);

    return true;
  }

  // =========================
  // 交易明細：依區間重建（累積欄位要從 0 開始）
  // =========================
  function rebuildTradesTableForRange(start8, end8) {
    if (!tradesBody) return;

    const inRange = CACHE.trades.filter(x => x.date8 && x.date8 >= start8 && x.date8 <= end8);

    let cumTheo = 0;
    let cumAct  = 0;

    const html = inRange.map((x, i) => {
      cumTheo += x.theo;
      cumAct  += x.act;

      const clsTheo = x.theo >= 0 ? 'num-pos' : 'num-neg';
      const clsCumTheo = cumTheo >= 0 ? 'num-pos' : 'num-neg';
      const clsAct = x.act >= 0 ? 'num-pos' : 'num-neg';
      const clsCumAct = cumAct >= 0 ? 'num-pos' : 'num-neg';

      return `
        <tr>
          <td>${i + 1}</td>
          <td style="text-align:left;">${x.dtText}</td>
          <td>${x.price ? x.price.toFixed(0) : ''}</td>
          <td style="text-align:center;">${x.side || ''}</td>
          <td>${Number.isFinite(x.pts) ? x.pts.toFixed(0) : ''}</td>
          <td>${Number.isFinite(x.fee) ? x.fee.toFixed(0) : ''}</td>
          <td>${Number.isFinite(x.tax) ? x.tax.toFixed(0) : ''}</td>
          <td class="${clsTheo}">${Number.isFinite(x.theo) ? x.theo.toFixed(0) : ''}</td>
          <td class="${clsCumTheo}">${cumTheo.toFixed(0)}</td>
          <td class="${clsAct}">${Number.isFinite(x.act) ? x.act.toFixed(0) : ''}</td>
          <td class="${clsCumAct}">${cumAct.toFixed(0)}</td>
        </tr>
      `;
    }).join('');

    tradesBody.innerHTML = html || `<tr><td colspan="11" style="text-align:center;color:#777;">（此區間沒有交易）</td></tr>`;
  }

  // =========================
  // 每日序列：補齊交易日（無交易=0）
  // =========================
  function buildDailySeries(start8, end8) {
    const days = buildTradingDays(start8, end8);

    // 先把每日損益聚合起來（用「實際淨損益 act」）
    const map = new Map(); // date8 -> dailyAct
    for (const t of CACHE.trades) {
      if (!t.date8) continue;
      if (t.date8 < start8 || t.date8 > end8) continue;
      map.set(t.date8, (map.get(t.date8) || 0) + (t.act || 0));
    }

    const labels = [];
    const dailyPnl = [];
    const equity = [];

    let cum = 0;
    for (const d8 of days) {
      const v = map.get(d8) || 0;
      cum += v;
      labels.push(fmtYMD(d8));
      dailyPnl.push(v);
      equity.push(cum);
    }
    return { labels, dailyPnl, equity };
  }

  // =========================
  // 圖表渲染（上下同交易日）
  // =========================
  function ensureChartsDestroyed() {
    try { CACHE.eqChart?.destroy(); } catch (e) {}
    try { CACHE.pnlChart?.destroy(); } catch (e) {}
    CACHE.eqChart = null;
    CACHE.pnlChart = null;
  }

  function renderChartsForRange(start8, end8) {
    const c1 = $('#equityChart');
    const c2 = $('#weeklyPnlChart');
    if (!c1 || !c2) return;

    const { labels, dailyPnl, equity } = buildDailySeries(start8, end8);

    ensureChartsDestroyed();

    // 上：累積實際淨損益
    CACHE.eqChart = new Chart(c1, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: '累積實際淨損益（每日）',
          data: equity,
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.15
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: true }
        },
        scales: {
          x: {
            ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }
          },
          y: {
            ticks: { callback: (v) => String(Math.round(v)) }
          }
        }
      }
    });

    // 下：每日實際淨損益（無交易=0）
    CACHE.pnlChart = new Chart(c2, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: '每日實際淨損益（無交易=0）',
          data: dailyPnl,
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: true } },
        scales: {
          x: {
            ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }
          },
          y: {
            ticks: { callback: (v) => String(Math.round(v)) }
          }
        }
      }
    });
  }

  // =========================
  // KPI 顯示規則：只有 all 顯示
  // =========================
  function toggleKPI(show) {
    if (wrapScore) wrapScore.style.display = show ? '' : 'none';
    if (wrapBad)   wrapBad.style.display   = show ? '' : 'none';
    if (wrapAll)   wrapAll.style.display   = show ? '' : 'none';
  }

  function setRangeButtonsActive(key) {
    $$('.range-btn').forEach(btn => {
      const k = btn.getAttribute('data-range');
      btn.classList.toggle('active', k === key);
    });
  }

  function applyRange(rangeKey) {
    if (!CACHE.ready) return;

    CACHE.rangeKey = rangeKey;
    setRangeButtonsActive(rangeKey);

    const { start8, end8 } = calcRange(rangeKey);

    // periodText：固定以選定區間顯示
    if (elPeriod) elPeriod.textContent = `期間：${fmtYMD(start8)} ~ ${fmtYMD(end8)}`;

    // hint：顯示「以最新日為錨」與交易日筆數
    if (elHint) {
      const days = buildTradingDays(start8, end8);
      elHint.textContent = `錨定最新日：${fmtYMD(dateToYMD(CACHE.anchorEnd))}｜交易日：${days.length} 天`;
    }

    // KPI：只有 all 顯示
    toggleKPI(rangeKey === 'all');

    // 交易明細：依區間重建（累積從 0 開始）
    rebuildTradesTableForRange(start8, end8);

    // 圖表：每日序列（補齊無交易日=0）上下對齊
    renderChartsForRange(start8, end8);
  }

  function bindRangeButtons() {
    $$('.range-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-range') || 'all';
        applyRange(key);
      });
    });
  }

  // =========================
  // 主流程 boot
  // =========================
  async function boot() {
    try {
      if (!sb) {
        setStatus('Supabase SDK 未載入', true);
        return;
      }

      bindRangeButtons();

      const url       = new URL(location.href);
      const paramFile = url.searchParams.get('file');

      let latest = null;
      let list   = [];

      // 1) 決定最新檔
      if (paramFile) {
        latest = {
          name    : paramFile.split('/').pop() || '0807.txt',
          fullPath: paramFile,
          from    : 'url'
        };
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

      // 2) 決定基準檔
      let base = null;
      if (!paramFile) {
        const manifest = await readManifest();
        if (manifest?.baseline_path) {
          base = list.find(x => x.fullPath === manifest.baseline_path) || {
            name: manifest.baseline_path.split('/').pop() || manifest.baseline_path,
            fullPath: manifest.baseline_path
          };
        } else {
          base = list[1] || null;
        }
      }

      if (elBase) elBase.textContent = base ? base.name : '（尚無）';

      // 3) 下載最新檔 & 基準檔，canonical 化與合併
      setStatus('下載最新 0807 檔案並解碼中…');

      const latestUrl = latest.from === 'url' ? latest.fullPath : pubUrl(latest.fullPath);
      const rNew = await fetchSmart(latestUrl);

      if (rNew.ok === 0) {
        setStatus(`最新檔沒有合法交易行（解碼=${rNew.enc}）。`, true);
        return;
      }

      let mergedText = rNew.canon;
      let start8 = '';
      let end8   = '';

      if (base) {
        setStatus('下載基準檔並進行合併…');
        const baseUrl = base.from === 'url' ? base.fullPath : pubUrl(base.fullPath);
        const rBase   = await fetchSmart(baseUrl);

        const m = mergeByBaseline(rBase.canon, rNew.canon);
        mergedText = m.combined;
        start8     = m.start8;
        end8       = m.end8;
      } else {
        const rows = parseCanon(rNew.canon);
        start8 = rows.length ? rows[0].ts.slice(0, 8) : '';
        end8   = rows.length ? rows[rows.length - 1].ts.slice(0, 8) : '';
      }

      CACHE.fullStart8 = start8;
      CACHE.fullEnd8   = end8;

      // 先暫時顯示「全區間」
      if (elPeriod) elPeriod.textContent = `期間：${fmtYMD(start8)} ~ ${fmtYMD(end8)}`;

      // 設基準按鈕
      if (btnBase) {
        btnBase.disabled = false;
        btnBase.onclick = async () => {
          try {
            const payload = {
              baseline_path: latest.fullPath,
              updated_at: new Date().toISOString()
            };
            await writeManifest(payload);
            btnBase.textContent = '已設為基準';
          } catch (e) {
            setStatus('寫入基準失敗：' + (e.message || e), true);
          }
        };
      }

      // 4) 餵給 single-trades：合併後 + fake INPOS + header
      const mergedWithInpos = addFakeInpos(mergedText);
      const finalText       = '0807 MERGED\n' + mergedWithInpos;

      setStatus('已載入（合併後）資料，開始分析…');
      await feedToSingleTrades(latest.name, finalText);

      // 5) 等 single-trades 渲染完成後，抓交易表→建立快取→套用預設區間（全）
      //    用 requestAnimationFrame + 短延遲，避免某些機器 DOM 還沒填完
      const tryCapture = async () => {
        for (let i = 0; i < 20; i++) {
          await new Promise(r => requestAnimationFrame(() => setTimeout(r, 50)));
          if (captureRenderedTrades()) return true;
        }
        return false;
      };

      const ok = await tryCapture();
      if (!ok) {
        setStatus('已完成 single-trades 計算，但抓不到交易明細表（tradesBody）。', true);
        return;
      }

      // 預設：全（但你也可以改成預設近1週；目前照你的習慣先全）
      applyRange('all');

      setStatus('分析完成（可用時區快選切換；本金/滑點重算仍由 single-trades 控制）。');
    } catch (err) {
      console.error(err);
      setStatus('初始化失敗：' + (err.message || err), true);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
