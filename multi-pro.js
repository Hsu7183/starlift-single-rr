// multi-pro.js
// 三劍客量化科技機構級多檔分析（期貨版 - 多檔排名 + 頂檔資產曲線）
// 最終版：
// 1. 自動判斷 UTF-8 / Big5
// 2. 嚴格依 action 語義配對（新買/新賣/平賣/平買/強制平倉）
// 3. 與 single-trades.js 使用相同的核心解析邏輯
// 4. 避免空單被誤翻成多單
// 5. 頂檔圖表顯示分數最高那一檔的含滑價累積損益

(function () {
  'use strict';

  const PRODUCT_PROFILES = {
    tx: {
      market: 'tx',
      label: '大台',
      pointValue: 200,
      feePerSide: 45,
      capital: 1000000
    },
    mini: {
      market: 'mini',
      label: '小台',
      pointValue: 50,
      feePerSide: 18,
      capital: 250000
    }
  };

  function resolveProductProfile() {
    const urlMarket = new URL(location.href).searchParams.get('market');
    const configured = window.FUTURES_PRODUCT_PROFILE || {};
    const market = configured.market || window.FUTURES_MARKET || urlMarket || 'tx';
    const base = PRODUCT_PROFILES[market] || PRODUCT_PROFILES.tx;
    return { ...base, ...configured };
  }

  const PRODUCT_PROFILE = resolveProductProfile();

  // ===== DOM =====
  const $ = (s) => document.querySelector(s);

  const capitalInput = $('#capitalInput');
  const slipInput    = $('#slipInput');
  const fileInput    = $('#fileInput');
  const runBtn       = $('#runBtn');
  const statusLine   = $('#statusLine');
  const table        = $('#resultTable');
  const tbody        = table.querySelector('tbody');
  const scoreChartEl = $('#scoreChart');
  const chartTitleEl = $('#chartTitle');

  // ===== 全域狀態 =====
  const CFG = {
    pointValue: PRODUCT_PROFILE.pointValue,
    feePerSide: PRODUCT_PROFILE.feePerSide,
    taxRate: 0.00002,
    slipPerSide: 0,
    capital: PRODUCT_PROFILE.capital
  };

  function applyProductChrome() {
    if (capitalInput) {
      capitalInput.value = String(PRODUCT_PROFILE.capital);
      capitalInput.step = PRODUCT_PROFILE.market === 'mini' ? '5000' : '10000';
    }

    if (PRODUCT_PROFILE.market !== 'mini') return;

    if (!document.title.includes('小台')) {
      document.title = document.title.replace('多檔分析', '小台多檔分析');
    }
    const h1 = $('h1');
    if (h1 && !h1.textContent.includes('小台')) {
      h1.textContent = h1.textContent.replace('機構級多檔分析', '機構級小台多檔分析');
    }
  }

  let gResults = [];
  let gSort = { key: 'score', dir: 'desc' };
  let gChart = null;
  let gFilters = {};

  const KPI_FILTER_KEYS = [
    'nTrades', 'costRatio', 'riskOfRuin', 'pf', 'winRate', 'avgTrade',
    'maxDdPct', 'worstDay', 'worstWeek', 'ulcer', 'totalReturn', 'cagr',
    'sharpe', 'sortino', 'calmar', 'score'
  ];
  const PERCENT_FILTER_KEYS = new Set([
    'costRatio', 'riskOfRuin', 'winRate', 'maxDdPct', 'totalReturn', 'cagr'
  ]);

  // ===== 小工具 =====
  const fmtInt = (n) => {
    if (n == null || !isFinite(n)) return '—';
    return Math.round(n).toLocaleString('en-US');
  };

  const fmtPct = (p) => {
    if (p == null || !isFinite(p)) return '—';
    return (p * 100).toFixed(2) + '%';
  };

  const fmtFloat = (x, d) => {
    if (x == null || !isFinite(x)) return '—';
    return x.toFixed(d);
  };

  function makeCompactTag(name) {
    const m = name.match(/(\d{8})_(\d{6})/);
    if (!m) return name;
    const day = m[1].slice(6, 8);
    return `${day}_${m[2]}`;
  }

  function headerToValues(header) {
    if (!header) return '';
    return header.split(',').map(seg => {
      const idx = seg.indexOf('=');
      return idx >= 0 ? seg.slice(idx + 1) : seg;
    }).join(',');
  }

  const MODE_FORMULAS = {
    UseM00: { title: '基準', long: '直接通過', short: '直接通過' },
    UseM01: { title: '同向破高低', long: 'O > H[1] 且 C[1] > O[1]', short: 'O < L[1] 且 C[1] < O[1]' },
    UseM02: { title: '同向 M1', long: 'O > M1 且 C[1] > O[1]', short: 'O < M1 且 C[1] < O[1]' },
    UseM03: { title: '同向未破', long: 'O < H[1] 且 C[1] > O[1]', short: 'O > L[1] 且 C[1] < O[1]' },
    UseM04: { title: '同向未 M1', long: 'O < M1 且 C[1] > O[1]', short: 'O > M1 且 C[1] < O[1]' },
    UseM05: { title: '同向區間', long: 'M1 < O < H[1] 且 C[1] > O[1]', short: 'L[1] < O < M1 且 C[1] < O[1]' },
    UseM06: { title: '反向破高低', long: 'O > H[1] 且 C[1] < O[1]', short: 'O < L[1] 且 C[1] > O[1]' },
    UseM07: { title: '反向 M1', long: 'O > M1 且 C[1] < O[1]', short: 'O < M1 且 C[1] > O[1]' },
    UseM08: { title: '反向 BM1', long: 'O > BM1 且 C[1] < O[1]', short: 'O < BM1 且 C[1] > O[1]' },
    UseM09: { title: '反向 O[1]', long: 'O > O[1] 且 C[1] < O[1]', short: 'O < O[1] 且 C[1] > O[1]' },
    UseM10: { title: '反向未破', long: 'O < H[1] 且 C[1] < O[1]', short: 'O > L[1] 且 C[1] > O[1]' },
    UseM11: { title: '反向未 M1', long: 'O < M1 且 C[1] < O[1]', short: 'O > M1 且 C[1] > O[1]' },
    UseM12: { title: '反向未 BM1', long: 'O < BM1 且 C[1] < O[1]', short: 'O > BM1 且 C[1] > O[1]' },
    UseM13: { title: '反向未 O[1]', long: 'O < O[1] 且 C[1] < O[1]', short: 'O > O[1] 且 C[1] > O[1]' },
    UseM14: { title: '反向 M1-H[1]', long: 'M1 < O < H[1] 且 C[1] < O[1]', short: 'L[1] < O < M1 且 C[1] > O[1]' },
    UseM15: { title: '反向 M1-BM1', long: 'M1 < O < BM1 且 C[1] < O[1]', short: 'BM1 < O < M1 且 C[1] > O[1]' },
    UseM16: { title: '反向 M1-O[1]', long: 'M1 < O < O[1] 且 C[1] < O[1]', short: 'O[1] < O < M1 且 C[1] > O[1]' },
    UseM17: { title: '反向 BM1-H[1]', long: 'BM1 < O < H[1] 且 C[1] < O[1]', short: 'L[1] < O < BM1 且 C[1] > O[1]' },
    UseM18: { title: '反向 BM1-M1', long: 'BM1 < O < M1 且 C[1] < O[1]', short: 'M1 < O < BM1 且 C[1] > O[1]' },
    UseM19: { title: '反向 BM1-O[1]', long: 'BM1 < O < O[1] 且 C[1] < O[1]', short: 'O[1] < O < BM1 且 C[1] > O[1]' },
    UseM20: { title: '反向 O[1]-H[1]', long: 'O[1] < O < H[1] 且 C[1] < O[1]', short: 'L[1] < O < O[1] 且 C[1] > O[1]' },
    UseM21: { title: '反向 O[1]-M1', long: 'O[1] < O < M1 且 C[1] < O[1]', short: 'M1 < O < O[1] 且 C[1] > O[1]' }
  };

  const MODE_BRIEF_FORMULAS = {
    UseM00: { long: 'ON', short: 'ON' },
    UseM01: { long: 'O>H[1]', short: 'O<L[1]' },
    UseM02: { long: 'O>M1', short: 'O<M1' },
    UseM03: { long: 'O<H[1]', short: 'O>L[1]' },
    UseM04: { long: 'O<M1', short: 'O>M1' },
    UseM05: { long: 'M1<O<H[1]', short: 'L[1]<O<M1' },
    UseM06: { long: 'O>H[1]', short: 'O<L[1]' },
    UseM07: { long: 'O>M1', short: 'O<M1' },
    UseM08: { long: 'O>BM1', short: 'O<BM1' },
    UseM09: { long: 'O>O[1]', short: 'O<O[1]' },
    UseM10: { long: 'O<H[1]', short: 'O>L[1]' },
    UseM11: { long: 'O<M1', short: 'O>M1' },
    UseM12: { long: 'O<BM1', short: 'O>BM1' },
    UseM13: { long: 'O<O[1]', short: 'O>O[1]' },
    UseM14: { long: 'M1<O<H[1]', short: 'L[1]<O<M1' },
    UseM15: { long: 'M1<O<BM1', short: 'BM1<O<M1' },
    UseM16: { long: 'M1<O<O[1]', short: 'O[1]<O<M1' },
    UseM17: { long: 'BM1<O<H[1]', short: 'L[1]<O<BM1' },
    UseM18: { long: 'BM1<O<M1', short: 'M1<O<BM1' },
    UseM19: { long: 'BM1<O<O[1]', short: 'O[1]<O<BM1' },
    UseM20: { long: 'O[1]<O<H[1]', short: 'L[1]<O<O[1]' },
    UseM21: { long: 'O[1]<O<M1', short: 'M1<O<O[1]' }
  };

  function parseHeaderParams(header) {
    const map = {};
    if (!header) return map;
    header.split(',').forEach(seg => {
      const part = String(seg || '').trim();
      if (!part) return;
      const idx = part.indexOf('=');
      if (idx < 0) return;
      map[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    });
    return map;
  }

  function formatTimeParam(value) {
    const digits = String(value == null ? '' : value).replace(/\D/g, '');
    if (!digits) return '—';
    const padded = digits.padStart(6, '0');
    return `${padded.slice(0, 2)}:${padded.slice(2, 4)}`;
  }

  function activeModesFromHeader(headerMap, fileName) {
    const modes = Object.keys(headerMap)
      .filter(key => /^UseM\d{2}$/.test(key) && Number(headerMap[key]) === 1)
      .sort();

    if (modes.length) return modes;

    const found = String(fileName || '').match(/UseM\d{2}/g);
    if (found && found.length) return Array.from(new Set(found)).sort();
    return [];
  }

  function buildParamSummary(header, fileName) {
    const headerMap = parseHeaderParams(header);
    const rawValues = headerToValues(header);
    const activeModes = activeModesFromHeader(headerMap, fileName);
    const formulas = activeModes.map(mode => {
      const brief = MODE_BRIEF_FORMULAS[mode];
      if (!brief) return { mode, long: mode, short: '' };
      return { mode, long: brief.long, short: brief.short };
    });

    return {
      raw: rawValues,
      formulas: formulas.length ? formulas : [{ mode: '', long: 'No UseM', short: '' }]
    };
  }

  function renderParamSummaryCell(td, summary) {
    td.classList.add('param-cell');
    td.title = summary.raw || '';
    const wrap = document.createElement('div');
    wrap.className = 'param-brief';

    (summary.formulas || []).forEach((formula, idx) => {
      if (idx > 0) {
        const modeSep = document.createElement('span');
        modeSep.className = 'param-mode-sep';
        modeSep.textContent = '; ';
        wrap.appendChild(modeSep);
      }

      const longSpan = document.createElement('span');
      longSpan.className = 'param-long';
      longSpan.textContent = formula.long;
      wrap.appendChild(longSpan);

      if (formula.short) {
        const sep = document.createElement('span');
        sep.className = 'param-sep';
        sep.textContent = ' / ';
        wrap.appendChild(sep);

        const shortSpan = document.createElement('span');
        shortSpan.className = 'param-short';
        shortSpan.textContent = formula.short;
        wrap.appendChild(shortSpan);
      }
    });

    td.appendChild(wrap);
  }

  // ===== 時間工具 =====
  function tsToDate(ts) {
    if (!ts) return null;
    const clean = ts.replace(/\D/g, '');
    if (clean.length < 8) return null;
    const y = parseInt(clean.slice(0, 4), 10);
    const m = parseInt(clean.slice(4, 6), 10) - 1;
    const d = parseInt(clean.slice(6, 8), 10);
    const hh = clean.length >= 10 ? parseInt(clean.slice(8, 10), 10) : 0;
    const mm = clean.length >= 12 ? parseInt(clean.slice(10, 12), 10) : 0;
    return new Date(y, m, d, hh, mm, 0);
  }

  function tsDayKey(ts) {
    if (!ts) return '';
    const clean = ts.replace(/\D/g, '');
    return clean.slice(0, 8);
  }

  function dateWeekKey(d) {
    if (!d) return '';
    const tmp = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = tmp.getUTCDay() || 7;
    tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
    return tmp.getUTCFullYear() + '-W' + (weekNo < 10 ? '0' + weekNo : weekNo);
  }

  // ===== action 工具 =====
  function normAction(s) {
    return (s || '').trim();
  }

  function dirFromAction(action) {
    const a = normAction(action);
    if (a === '新買') return 1;
    if (a === '新賣') return -1;
    return null;
  }

  function isEntryAction(action) {
    const a = normAction(action);
    return a === '新買' || a === '新賣';
  }

  function isExitAction(action) {
    const a = normAction(action);
    return a === '平賣' || a === '平買' || a === '強制平倉';
  }

  function exitDirFromAction(action, openDir) {
    const a = normAction(action);
    if (a === '平賣') return 1;
    if (a === '平買') return -1;
    if (a === '強制平倉') return openDir;
    return openDir;
  }

  function getDirFromInpos(lines, startIdx) {
    const maxLookAhead = 300;
    const total = lines.length;

    for (let j = startIdx + 1; j < total && j <= startIdx + maxLookAhead; j++) {
      const line = lines[j];
      const ps = line.split(/\s+/);
      if (!ps.length) continue;

      if (ps.length >= 6 && ps[ps.length - 1] === 'INPOS') {
        const dir = parseInt(ps[3], 10);
        if (dir === 1 || dir === -1) return dir;
      }

      if (ps.length === 3 && ps[ps.length - 1] !== 'INPOS') {
        break;
      }
    }
    return 1;
  }

  // ===== 智慧讀檔：UTF-8 / Big5 =====
  async function readFileTextSmart(file) {
    const ab = await file.arrayBuffer();

    let textUtf8 = '';
    try {
      textUtf8 = new TextDecoder('utf-8', { fatal: false }).decode(ab);
    } catch (e) {
      textUtf8 = '';
    }

    if (
      textUtf8.includes('新買') ||
      textUtf8.includes('新賣') ||
      textUtf8.includes('平買') ||
      textUtf8.includes('平賣') ||
      textUtf8.includes('強制平倉')
    ) {
      return textUtf8;
    }

    try {
      const textBig5 = new TextDecoder('big5', { fatal: false }).decode(ab);
      if (
        textBig5.includes('新買') ||
        textBig5.includes('新賣') ||
        textBig5.includes('平買') ||
        textBig5.includes('平賣') ||
        textBig5.includes('強制平倉')
      ) {
        return textBig5;
      }
    } catch (e) {
      // ignore
    }

    return textUtf8;
  }

  // ===== 解析 TXT：與 single-trades.js 同步 =====
  function parseTxt(text) {
    const allLines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!allLines.length) return { header: null, trades: [] };

    const header = allLines[0];
    const lines  = allLines.slice(1);

    const trades = [];
    let open = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const ps   = line.split(/\s+/);
      if (ps.length < 2) continue;

      const ts = ps[0];
      const px = parseFloat(ps[1]);
      if (!isFinite(px)) continue;

      if (ps[ps.length - 1] === 'INPOS') continue;
      if (ps.length !== 3) continue;

      const action  = normAction(ps[2]);
      const isEntry = isEntryAction(action);
      const isExit  = isExitAction(action);

      if (!isEntry && !isExit) continue;

      if (!open) {
        if (!isEntry) continue;

        let dir = dirFromAction(action);
        if (dir == null) dir = getDirFromInpos(lines, i);
        if (dir !== 1 && dir !== -1) continue;

        open = { ts, px, dir, action };
        continue;
      }

      if (!isExit) {
        let dir = dirFromAction(action);
        if (dir == null) dir = getDirFromInpos(lines, i);
        if (dir !== 1 && dir !== -1) {
          open = null;
          continue;
        }
        open = { ts, px, dir, action };
        continue;
      }

      const openDir    = open.dir;
      const entryPx    = open.px;
      const exitPx     = px;
      const exitAction = action;

      if (
        exitAction !== '強制平倉' &&
        !((openDir > 0 && exitAction === '平賣') ||
          (openDir < 0 && exitAction === '平買'))
      ) {
        continue;
      }

      const dirForPnl = exitDirFromAction(exitAction, openDir);

      const points = dirForPnl > 0
        ? (exitPx - entryPx)
        : (entryPx - exitPx);

      const gross = points * CFG.pointValue;
      const fee   = CFG.feePerSide * 2;
      const taxIn = Math.round(entryPx * CFG.pointValue * CFG.taxRate);
      const taxOut= Math.round(exitPx  * CFG.pointValue * CFG.taxRate);
      const tax   = taxIn + taxOut;
      const theoNet = gross - fee - tax;

      trades.push({
        entry: { ts: open.ts, px: open.px, action: open.action },
        exit:  { ts, px: exitPx, action: exitAction },
        dir: openDir,
        points,
        fee,
        tax,
        theoNet
      });

      open = null;
    }

    return { header, trades };
  }

  // ===== KPI 計算 =====
  function calcKpi(trades, pnls, equity) {
    const n = pnls.length;
    if (!n) return null;

    let sum = 0;
    let sumSq = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let wins = 0;
    let losses = 0;
    let largestWin = null;
    let largestLoss = null;

    pnls.forEach(p => {
      sum += p;
      sumSq += p * p;
      if (p > 0) {
        grossProfit += p;
        wins++;
        if (largestWin === null || p > largestWin) largestWin = p;
      } else if (p < 0) {
        grossLoss += p;
        losses++;
        if (largestLoss === null || p < largestLoss) largestLoss = p;
      }
    });

    const totalNet = sum;
    const avg      = sum / n;
    const winRate  = wins / n;
    const avgWin   = wins   ? grossProfit / wins   : 0;
    const avgLoss  = losses ? grossLoss  / losses  : 0;
    const payoff   = (avgLoss < 0) ? (avgWin / Math.abs(avgLoss)) : null;
    const pf       = grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : null;

    const mean   = avg;
    const varT   = n > 1 ? (sumSq / n - mean * mean) : 0;
    const stdev  = varT > 0 ? Math.sqrt(varT) : 0;

    const sharpeTrade  = stdev > 0 ? (mean / stdev) * Math.sqrt(n) : null;

    let downsideSq = 0;
    let downsideCnt = 0;
    pnls.forEach(p => {
      if (p < 0) {
        downsideSq += p * p;
        downsideCnt++;
      }
    });
    const downsideDev   = downsideCnt > 0 ? Math.sqrt(downsideSq / downsideCnt) : 0;
    const sortinoTrade  = downsideDev > 0 ? (mean / downsideDev) * Math.sqrt(n) : null;

    let peak = 0;
    let maxDd = 0;
    let maxDdStartIdx = 0;
    let maxDdEndIdx   = 0;
    let curPeakIdx    = 0;
    for (let i = 0; i < equity.length; i++) {
      const v = equity[i];
      if (v > peak) {
        peak = v;
        curPeakIdx = i;
      }
      const dd = peak - v;
      if (dd > maxDd) {
        maxDd = dd;
        maxDdStartIdx = curPeakIdx;
        maxDdEndIdx   = i;
      }
    }

    const totalReturnPct = CFG.capital > 0 ? totalNet / CFG.capital : null;
    const maxDdPct       = CFG.capital > 0 ? maxDd   / CFG.capital : null;

    const exitDates = trades.map(t => tsToDate(t.exit.ts));
    let cagr = null;
    if (exitDates.length) {
      const first = exitDates[0];
      const last  = exitDates[exitDates.length - 1];
      if (first && last && last > first && CFG.capital > 0) {
        const days  = (last - first) / 86400000;
        const years = days / 365;
        if (years > 0) {
          const finalNav = CFG.capital + totalNet;
          const ratio    = finalNav / CFG.capital;
          cagr = Math.pow(ratio, 1 / years) - 1;
        }
      }
    }

    const calmar = (maxDdPct != null && maxDdPct > 0 && cagr != null)
      ? (cagr / maxDdPct)
      : null;

    const timeToRecoveryTrades =
      maxDdEndIdx > maxDdStartIdx ? (maxDdEndIdx - maxDdStartIdx) : 0;

    const nav = equity.map(v => CFG.capital + v);
    let peakNav = 0;
    let sumDdSq = 0;
    for (let i = 0; i < nav.length; i++) {
      const v = nav[i];
      if (v > peakNav) peakNav = v;
      const ddPct = peakNav > 0 ? (peakNav - v) / peakNav : 0;
      sumDdSq += ddPct * ddPct;
    }
    const ulcerIndex    = nav.length ? Math.sqrt(sumDdSq / nav.length) : null;
    const recoveryFactor= maxDd > 0 ? totalNet / maxDd : null;

    const dayMap = {};
    const weekMap = {};
    pnls.forEach((p, i) => {
      const t  = trades[i];
      const dk = tsDayKey(t.exit.ts);
      if (dk) dayMap[dk] = (dayMap[dk] || 0) + p;
      const d = exitDates[i];
      if (d) {
        const wk = dateWeekKey(d);
        weekMap[wk] = (weekMap[wk] || 0) + p;
      }
    });

    const worstDayPnl  = Object.values(dayMap).reduce((m, v) => (v < m ? v : m), 0);
    const worstWeekPnl = Object.values(weekMap).reduce((m, v) => (v < m ? v : m), 0);

    const sortedPnls = pnls.slice().sort((a, b) => a - b);
    const alpha = 0.95;
    const idx   = Math.floor((1 - alpha) * sortedPnls.length);
    const varLoss = sortedPnls.length
      ? -sortedPnls[Math.min(idx, sortedPnls.length - 1)]
      : null;

    let tailSum = 0;
    let tailCnt = 0;
    for (let i = 0; i <= idx && i < sortedPnls.length; i++) {
      tailSum += sortedPnls[i];
      tailCnt++;
    }
    const cvarLoss = tailCnt > 0 ? -(tailSum / tailCnt) : null;

    const expectancy = avg;
    let kelly = null;
    if (payoff != null && payoff > 0 && winRate > 0 && winRate < 1) {
      const p = winRate;
      const q = 1 - winRate;
      kelly = p - q / payoff;
    }

    let riskOfRuin = null;
    if (varT <= 0) {
      riskOfRuin = null;
    } else if (avg <= 0) {
      riskOfRuin = 1;
    } else {
      const mu     = avg;
      const sigma2 = varT;
      const exponent = -2 * mu * CFG.capital / sigma2;
      const r = Math.exp(exponent);
      riskOfRuin = Math.min(1, Math.max(0, r));
    }

    let totalFee  = 0;
    let totalTax  = 0;
    let notionalTraded = 0;
    const slipPerTradeMoney = CFG.pointValue * CFG.slipPerSide * 2;

    trades.forEach(t => {
      totalFee  += t.fee;
      totalTax  += t.tax;
      notionalTraded += t.entry.px * CFG.pointValue;
    });

    const totalSlipCost = slipPerTradeMoney * trades.length;
    const totalCost     = totalFee + totalTax + totalSlipCost;
    const totalGrossAbs = grossProfit + Math.abs(grossLoss);
    const turnover      = CFG.capital > 0 ? (notionalTraded / CFG.capital) : null;
    const costRatio     = totalGrossAbs > 0 ? (totalCost / totalGrossAbs) : null;

    const tradingDays = Object.keys(dayMap).length;
    const tradesPerDay= tradingDays > 0 ? n / tradingDays : null;

    let totalHoldMin = 0;
    trades.forEach(t => {
      const dIn  = tsToDate(t.entry.ts);
      const dOut = tsToDate(t.exit.ts);
      if (dIn && dOut && dOut >= dIn) {
        totalHoldMin += (dOut - dIn) / 60000;
      }
    });
    const avgHoldMin = n > 0 ? totalHoldMin / n : null;

    let stabilityR2 = null;
    if (nav.length >= 3) {
      const xs = nav.map((_, i) => i + 1);
      const ys = nav;
      const N  = xs.length;
      const sumX  = xs.reduce((a, v) => a + v, 0);
      const sumY  = ys.reduce((a, v) => a + v, 0);
      const sumXY = xs.reduce((a, v, i) => a + v * ys[i], 0);
      const sumX2 = xs.reduce((a, v) => a + v * v, 0);
      const meanY = sumY / N;
      const ssTot = ys.reduce((a, v) => a + (v - meanY) * (v - meanY), 0);
      const slope = (N * sumXY - sumX * sumY) / (N * sumX2 - sumX * sumX);
      const intercept = meanY - slope * (sumX / N);
      let ssRes = 0;
      for (let i = 0; i < N; i++) {
        const yhat = slope * xs[i] + intercept;
        ssRes += (ys[i] - yhat) * (ys[i] - yhat);
      }
      stabilityR2 = ssTot > 0 ? 1 - (ssRes / ssTot) : null;
    }

    return {
      totalNet,
      totalReturnPct,
      cagr,
      maxDd,
      maxDdPct,
      ulcerIndex,
      recoveryFactor,
      timeToRecoveryTrades,
      worstDayPnl,
      worstWeekPnl,
      varLoss,
      cvarLoss,
      riskOfRuin,
      volPerTrade: stdev,
      sharpeTrade,
      sortinoTrade,
      calmar,
      nTrades: n,
      winRate,
      avg,
      avgWin,
      avgLoss,
      payoff,
      expectancy,
      pf,
      grossProfit,
      grossLoss,
      largestWin,
      largestLoss,
      kelly,
      stabilityR2,
      tradingDays,
      tradesPerDay,
      avgHoldMin,
      turnover,
      totalFee,
      totalTax,
      totalSlipCost,
      totalCost,
      costRatio
    };
  }

  // ===== KPI 評級 =====
  function rateMetric(key, value) {
    if (value == null || !isFinite(value)) return null;

    let label = 'Adequate';
    let css   = 'rating-adequate';

    switch (key) {
      case 'maxdd_pct':
        if (value <= 0.20)       { label = 'Strong';  css = 'rating-strong';  }
        else if (value <= 0.30)  { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;
      case 'total_return':
      case 'cagr':
        if (value >= 0.15)       { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 0.05)  { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;
      case 'pf':
        if (value >= 1.5)        { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 1.1)   { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;
      case 'winrate':
        if (value >= 0.55)       { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 0.45)  { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;
      case 'sharpe':
        if (value >= 1.5)        { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 0.8)   { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;
      case 'sortino':
        if (value >= 2)          { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 1)     { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;
      case 'calmar':
        if (value >= 0.5)        { label = 'Strong';  css = 'rating-strong';  }
        else if (value >= 0.2)   { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;
      case 'risk_ruin':
        if (value <= 0.05)       { label = 'Strong';  css = 'rating-strong';  }
        else if (value <= 0.20)  { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;
      case 'cost_ratio':
        if (value <= 0.20)       { label = 'Strong';  css = 'rating-strong';  }
        else if (value <= 0.40)  { label = 'Adequate'; }
        else                     { label = 'Improve'; css = 'rating-improve'; }
        break;
      default:
        return null;
    }
    return { label, cssClass: css };
  }

  function computeScore(k) {
    if (!k) return null;
    const metrics = [
      { key: 'maxdd_pct',    v: k.maxDdPct },
      { key: 'total_return', v: k.totalReturnPct },
      { key: 'cagr',         v: k.cagr },
      { key: 'pf',           v: k.pf },
      { key: 'winrate',      v: k.winRate },
      { key: 'sharpe',       v: k.sharpeTrade },
      { key: 'sortino',      v: k.sortinoTrade },
      { key: 'calmar',       v: k.calmar },
      { key: 'risk_ruin',    v: k.riskOfRuin },
      { key: 'cost_ratio',   v: k.costRatio }
    ];

    let sum = 0;
    let cnt = 0;

    metrics.forEach(m => {
      const r = rateMetric(m.key, m.v);
      if (!r) return;
      let pts = 0;
      if (r.label === 'Strong') pts = 90;
      else if (r.label === 'Adequate') pts = 75;
      else pts = 60;
      sum += pts;
      cnt++;
    });

    if (!cnt) return null;
    return sum / cnt;
  }

  function scoreBadgeClass(score) {
    if (score == null || !isFinite(score)) return 'score-badge score-improve';
    if (score >= 85) return 'score-badge score-strong';
    if (score >= 70) return 'score-badge score-adequate';
    return 'score-badge score-improve';
  }

  function metricValueForKey(row, key) {
    const k = row.kpi || {};
    switch (key) {
      case 'score':       return row.score || 0;
      case 'cagr':        return k.cagr;
      case 'totalReturn': return k.totalReturnPct;
      case 'maxDdPct':    return k.maxDdPct;
      case 'pf':          return k.pf;
      case 'winRate':     return k.winRate;
      case 'sharpe':      return k.sharpeTrade;
      case 'sortino':     return k.sortinoTrade;
      case 'calmar':      return k.calmar;
      case 'riskOfRuin':  return k.riskOfRuin;
      case 'costRatio':   return k.costRatio;
      case 'nTrades':     return k.nTrades;
      case 'avgTrade':    return k.avg;
      case 'worstDay':    return k.worstDayPnl;
      case 'worstWeek':   return k.worstWeekPnl;
      case 'ulcer':       return k.ulcerIndex;
      default:            return null;
    }
  }

  function parseFilterNumber(key, raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text) return null;
    const value = Number(text.replace(/[%,$,]/g, ''));
    if (!isFinite(value)) return null;
    return PERCENT_FILTER_KEYS.has(key) ? value / 100 : value;
  }

  function refreshFiltersFromInputs() {
    const next = {};
    table.querySelectorAll('.kpi-filter').forEach(input => {
      const key = input.dataset.key;
      const bound = input.dataset.bound;
      const value = parseFilterNumber(key, input.value);
      if (!key || !bound || value == null) return;
      if (!next[key]) next[key] = {};
      next[key][bound] = value;
    });
    gFilters = next;
  }

  function hasActiveFilters() {
    return Object.keys(gFilters).length > 0;
  }

  function passesFilters(row) {
    for (const [key, rule] of Object.entries(gFilters)) {
      const value = metricValueForKey(row, key);
      if (value == null || !isFinite(value)) return false;
      if (rule.min != null && value < rule.min) return false;
      if (rule.max != null && value > rule.max) return false;
    }
    return true;
  }

  function filteredResults() {
    return gResults.filter(passesFilters);
  }

  function updateFilterStatus(visibleCount) {
    if (!gResults.length) return;
    if (hasActiveFilters()) {
      statusLine.textContent = `完成：顯示 ${visibleCount} / ${gResults.length} 檔（已套用篩選）。`;
    } else {
      statusLine.textContent = `完成：共計算 ${gResults.length} 檔。`;
    }
  }

  // ===== 主流程 =====
  async function runAnalysis() {
    const files = Array.prototype.slice.call(fileInput.files || []);
    if (!files.length) {
      alert('請先選擇至少一個 TXT 檔案');
      return;
    }

    CFG.capital     = Number(capitalInput.value) || PRODUCT_PROFILE.capital;
    CFG.slipPerSide = Number(slipInput.value) || 0;

    runBtn.disabled = true;
    fileInput.disabled = true;
    statusLine.textContent = `讀取與計算中……（共 ${files.length} 檔）`;

    gResults = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      try {
        // eslint-disable-next-line no-await-in-loop
        const text = await readFileTextSmart(f);
        const parsed = parseTxt(text);
        const trades = parsed.trades;

        if (!trades.length) {
          console.warn('[multi-pro] no trades parsed:', f.name);
          continue;
        }

        let cumTheo = 0;
        let cumAct  = 0;
        const theoPnls   = [];
        const theoEquity = [];
        const actPnls    = [];
        const actEquity  = [];
        const slipCostPerTrade = CFG.pointValue * CFG.slipPerSide * 2;

        const eqX = [0];
        const eqY = [0];
        let cumForEq = 0;

        trades.forEach((t, idx) => {
          cumTheo += t.theoNet;
          const actualNet = t.theoNet - slipCostPerTrade;
          cumAct  += actualNet;

          theoPnls.push(t.theoNet);
          theoEquity.push(cumTheo);

          actPnls.push(actualNet);
          actEquity.push(cumAct);

          cumForEq += actualNet;
          eqX.push(idx + 1);
          eqY.push(cumForEq);
        });

        const kpiTheo = calcKpi(trades, theoPnls, theoEquity);
        const kpiAct  = calcKpi(trades, actPnls, actEquity);
        const score   = computeScore(kpiAct);

        gResults.push({
          fileName: f.name,
          dateTag:  makeCompactTag(f.name),
          params:   headerToValues(parsed.header),
          paramSummary: buildParamSummary(parsed.header, f.name),
          score,
          kpi: kpiAct,
          kpiTheo,
          equitySeries: { x: eqX, y: eqY }
        });

        statusLine.textContent = `計算中…… ${i + 1} / ${files.length}`;
      } catch (e) {
        console.error('[multi-pro] 讀取檔案錯誤：', f.name, e);
      }
    }

    gSort = { key: 'score', dir: 'desc' };
    sortAndRender();

    updateFilterStatus(filteredResults().length);
    runBtn.disabled = false;
    fileInput.disabled = false;
  }

  // ===== 表格 =====
  function renderTable() {
    tbody.innerHTML = '';
    const rows = filteredResults();

    if (!rows.length && gResults.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = table.querySelectorAll('thead tr:first-child th').length;
      td.className = 'empty-row';
      td.textContent = '沒有符合篩選條件的結果';
      tr.appendChild(td);
      tbody.appendChild(tr);
      updateFilterStatus(0);
      return;
    }

    rows.forEach(r => {
      const k = r.kpi || {};
      const tr = document.createElement('tr');

      const tdDate = document.createElement('td');
      tdDate.textContent = r.dateTag;
      tr.appendChild(tdDate);

      const tdParam = document.createElement('td');
      renderParamSummaryCell(tdParam, r.paramSummary || { raw: r.params });
      tr.appendChild(tdParam);

      function kpiCell(value, fmt, ratingKey) {
        const td = document.createElement('td');
        let txt = '—';
        if (fmt === 'pct') txt = fmtPct(value);
        else if (fmt === 'int') txt = fmtInt(value);
        else if (fmt === 'f2') txt = fmtFloat(value, 2);
        else if (fmt === 'f3') txt = fmtFloat(value, 3);

        td.textContent = txt;

        if (ratingKey) {
          const rating = rateMetric(ratingKey, value);
          if (rating) td.classList.add(rating.cssClass);
        }
        return td;
      }

      tr.appendChild(kpiCell(k.nTrades,        'int'));
      tr.appendChild(kpiCell(k.costRatio,      'pct', 'cost_ratio'));
      tr.appendChild(kpiCell(k.riskOfRuin,     'pct', 'risk_ruin'));
      tr.appendChild(kpiCell(k.pf,             'f2',  'pf'));
      tr.appendChild(kpiCell(k.winRate,        'pct', 'winrate'));
      tr.appendChild(kpiCell(k.avg,            'int'));
      tr.appendChild(kpiCell(k.maxDdPct,       'pct', 'maxdd_pct'));
      tr.appendChild(kpiCell(k.worstDayPnl,    'int'));
      tr.appendChild(kpiCell(k.worstWeekPnl,   'int'));
      tr.appendChild(kpiCell(k.ulcerIndex,     'f3'));
      tr.appendChild(kpiCell(k.totalReturnPct, 'pct', 'total_return'));
      tr.appendChild(kpiCell(k.cagr,           'pct', 'cagr'));
      tr.appendChild(kpiCell(k.sharpeTrade,    'f2',  'sharpe'));
      tr.appendChild(kpiCell(k.sortinoTrade,   'f2',  'sortino'));
      tr.appendChild(kpiCell(k.calmar,         'f2',  'calmar'));

      const tdScore = document.createElement('td');
      const span = document.createElement('span');
      span.textContent = r.score != null && isFinite(r.score) ? r.score.toFixed(1) : '—';
      span.className = scoreBadgeClass(r.score);
      tdScore.appendChild(span);
      tr.appendChild(tdScore);

      tbody.appendChild(tr);
    });

    updateFilterStatus(rows.length);

    const ths = table.querySelectorAll('th.sortable');
    ths.forEach(th => {
      th.removeAttribute('data-sort-dir');
      const key = th.dataset.key;
      if (key === gSort.key) {
        th.setAttribute('data-sort-dir', gSort.dir);
      }
    });
  }

  // ===== 圖表 =====
  function renderChart() {
    if (!scoreChartEl || !window.Chart) return;

    if (gChart) {
      gChart.destroy();
      gChart = null;
    }

    const rows = filteredResults();
    if (!rows.length) {
      chartTitleEl.textContent = '頂檔資產曲線（含滑價累積損益）';
      return;
    }

    const top = rows[0];
    const eq = top.equitySeries || { x: [], y: [] };
    const labels = eq.x;
    const data   = eq.y;

    const ctx = scoreChartEl.getContext('2d');

    chartTitleEl.textContent =
      `頂檔資產曲線（含滑價累積損益）｜${top.fileName}`;

    gChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: '含滑價累積損益',
          data,
          borderWidth: 2,
          pointRadius: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => `累積損益：${fmtInt(ctx.parsed.y)}`
            }
          }
        },
        scales: {
          x: {
            title: { display: true, text: '交易序號' }
          },
          y: {
            title: { display: true, text: '累積損益（含滑價）' }
          }
        }
      }
    });
  }

  // ===== 排序 =====
  function sortAndRender() {
    const key = gSort.key;
    const dir = gSort.dir === 'asc' ? 1 : -1;

    gResults.sort((a, b) => {
      let va, vb;

      if (key === 'dateTag') {
        va = a.dateTag;
        vb = b.dateTag;
        if (va < vb) return -1 * dir;
        if (va > vb) return 1 * dir;
        return 0;
      }

      va = metricValueForKey(a, key);
      vb = metricValueForKey(b, key);

      if (!isFinite(va) && !isFinite(vb)) return 0;
      if (!isFinite(va)) return 1;
      if (!isFinite(vb)) return -1;
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });

    renderTable();
    renderChart();
  }

  function initFilterRow() {
    const headRow = table.querySelector('thead tr');
    if (!headRow || table.querySelector('.kpi-filter-row')) return;

    const row = document.createElement('tr');
    row.className = 'kpi-filter-row';

    Array.from(headRow.cells).forEach((th, idx) => {
      const cell = document.createElement('th');
      const key = th.dataset.key;

      if (KPI_FILTER_KEYS.includes(key)) {
        cell.className = 'kpi-filter-cell';

        const wrap = document.createElement('div');
        wrap.className = 'kpi-filter-pair';

        ['min', 'max'].forEach(bound => {
          const input = document.createElement('input');
          input.className = 'kpi-filter';
          input.type = 'number';
          input.inputMode = 'decimal';
          input.dataset.key = key;
          input.dataset.bound = bound;
          input.placeholder = bound === 'min' ? '低' : '高';
          input.title = `${th.textContent}${bound === 'min' ? '最低' : '最高'}`;
          wrap.appendChild(input);
        });

        cell.appendChild(wrap);
      } else if (idx === 0) {
        const clearBtn = document.createElement('button');
        clearBtn.type = 'button';
        clearBtn.className = 'filter-clear';
        clearBtn.textContent = '清除';
        clearBtn.title = '清除所有 KPI 篩選';
        clearBtn.addEventListener('click', () => {
          table.querySelectorAll('.kpi-filter').forEach(input => { input.value = ''; });
          refreshFiltersFromInputs();
          sortAndRender();
        });
        cell.appendChild(clearBtn);
      }

      row.appendChild(cell);
    });

    row.addEventListener('input', event => {
      if (!event.target.classList.contains('kpi-filter')) return;
      refreshFiltersFromInputs();
      sortAndRender();
    });

    headRow.after(row);
  }

  // ===== 事件 =====
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length > 0) {
      runBtn.disabled = false;
      statusLine.textContent = `已選擇 ${fileInput.files.length} 檔 TXT，可按「計算」。`;
    } else {
      runBtn.disabled = true;
      statusLine.textContent = '說明：一次可選擇多個期貨 TXT（含 INPOS），將依單檔分析的 KPI 與分數邏輯計算。';
    }
  });

  capitalInput.addEventListener('change', () => {
    CFG.capital = Number(capitalInput.value) || PRODUCT_PROFILE.capital;
  });

  slipInput.addEventListener('change', () => {
    CFG.slipPerSide = Number(slipInput.value) || 0;
  });

  runBtn.addEventListener('click', () => {
    runAnalysis();
  });

  initFilterRow();

  const ths = table.querySelectorAll('th.sortable');
  ths.forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.key;
      if (!key) return;
      if (gSort.key === key) {
        gSort.dir = gSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        gSort.key = key;
        gSort.dir = key === 'dateTag' ? 'asc' : 'desc';
      }
      sortAndRender();
    });
  });

  applyProductChrome();

})();
