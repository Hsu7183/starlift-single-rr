/* ===========================================================================
 * js/etf-engine.js  (ETF/股票策略計算核心；與期貨線完全分離)
 * 專為 00909-ETF TXT（CSV + key=value）而寫。
 * 只納入「買進 / 加碼攤平 / 再加碼攤平 / 賣出」，忽略「平買 / 平賣 / 強制平倉(強平)」。
 *
 * API：
 *   const parsed = ETFEngine.parseEtfTxt(rawTxt)
 *     -> { events, trades, days, pnl, equity, rets, extras }
 *   const kpis   = ETFEngine.calcEtfKpis(parsed)
 *     -> { core, risk, trade, capacity, meta }
 * =========================================================================== */

(function (global) {
  'use strict';

  /* ======================== 常數與法規參數 ======================== */
  const BASE_CAP = 1_000_000;   // 基準資金（每 100 萬）
  const FEE_RATE = 0.001425;    // 手續費率（單邊）
  const FEE_MIN  = 20;          // 最低手續費
  const TAX_RATE = 0.001;       // ETF 證交稅率 0.1%（僅賣出）

  function fee(amt) { return Math.max(Math.round(amt * FEE_RATE), FEE_MIN); }
  function taxOnSell(amt) { return Math.round(amt * TAX_RATE); }

  /* ======================== 工具函數 ======================== */
  const toNum = (x, d) => {
    const v = Number(x);
    return isFinite(v) ? v : (d != null ? d : 0);
  };
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const mean = (a) => (a.length ? sum(a) / a.length : 0);
  const std = (a) => {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(sum(a.map((v) => (v - m) ** 2)) / (a.length - 1));
  };
  const quantile = (a, q) => {
    if (!a.length) return 0;
    const b = a.slice().sort((x, y) => x - y);
    const i = Math.min(b.length - 1, Math.max(0, Math.floor(q * (b.length - 1))));
    return b[i];
  };
  const percentile = (a, p) => quantile(a, p / 100);
  const ymdToDate = (d8) => new Date(`${d8.slice(0,4)}-${d8.slice(4,6)}-${d8.slice(6,8)}T00:00:00`);

  const maxDrawdown = (eq) => {
    let peak = -Infinity, mdd = 0, ds = 0, de = 0, cs = 0;
    for (let i = 0; i < eq.length; i++) {
      const v = eq[i];
      if (v > peak) { peak = v; cs = i; }
      const dd = peak - v;
      if (dd > mdd) { mdd = dd; ds = cs; de = i; }
    }
    return { mdd, ddStart: ds, ddEnd: de, duration: Math.max(0, de - ds) };
  };

  const ulcerIndex = (eq) => {
    if (eq.length < 2) return 0;
    let peak = eq[0], s = 0;
    for (let i = 0; i < eq.length; i++) {
      if (eq[i] > peak) peak = eq[i];
      const ddPct = peak === 0 ? 0 : ((eq[i] - peak) / Math.abs(peak)) * 100;
      s += ddPct ** 2;
    }
    return Math.sqrt(s / eq.length);
  };

  const cvarLeftTail = (rets, q) => {
    if (!rets.length) return 0;
    const b = rets.slice().sort((a, b) => a - b);
    const idx = Math.floor((1 - q) * b.length);
    const tail = b.slice(0, Math.max(1, idx + 1));
    return mean(tail);
  };

  /* ======================== 動作過濾 ======================== */
  function mapAct(act) {
    const s = String(act || '').replace(/[\uFEFF\u200B-\u200D\u00A0\u3000]/g, '').trim();
    if (/^買進$/.test(s)) return 'BUY';
    if (/^加碼攤平$/.test(s)) return 'ADD1';
    if (/^再加碼攤平$/.test(s)) return 'ADD2';
    if (/^賣出$/.test(s)) return 'SELL';
    return 'OTHER';
  }

  /* ======================== 主解析函式 ======================== */
  function parseEtfTxt(rawTxt) {
    const norm = String(rawTxt || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\uFEFF\u200B-\u200D]/g, '');
    const lines = norm.split('\n');

    const events = [], extras = [];

    for (let L of lines) {
      L = (L || '').replace(/[\u00A0\u3000]/g, ' ').trim();
      if (!L) continue;
      if (/^日期\s*,\s*時間\s*,\s*價格/i.test(L)) continue;

      const m = L.match(/^(\d{8})[,，](\d{5,6})[,，](\d+(?:\.\d+)?)[,，]([^,，]+?)[,，](.+)$/);
      if (!m) continue;

      const d8 = m[1], t6 = m[2].padStart(6, '0'), price = toNum(m[3], 0), actRaw = m[4], tail = m[5] || '';
      const ts14 = d8 + t6;
      const act = mapAct(actRaw);
      if (act === 'OTHER') continue;

      const kv = {};
      tail.split(/[,，]/).forEach(seg => {
        seg = seg.trim(); if (!seg) return;
        const p = seg.indexOf('=');
        if (p === -1) return;
        const k = seg.slice(0, p).trim(), v = seg.slice(p + 1).trim();
        kv[k] = v;
      });
      kv.ts = ts14; kv.price = price; kv.actRaw = actRaw;
      kv.lotsThisRow = (act === 'SELL') ? toNum(kv['總單位'], 0) : toNum(kv['本次單位'], 0);

      events.push({ ts: ts14, d8, t6, price, action: act, kv });
      extras.push(kv);
    }

    // === 分組：tid → trades ===
    const byTid = {};
    for (const e of events) {
      const tid = e.kv.tid ? String(e.kv.tid).trim() : null;
      if (!tid) continue;
      (byTid[tid] || (byTid[tid] = [])).push(e);
    }

    const tids = Object.keys(byTid).sort((a, b) => +a - +b);
    const trades = [];

    for (const tid of tids) {
      const arr = byTid[tid].sort((a, b) => a.ts.localeCompare(b.ts));
      const sell = arr.find(x => x.action === 'SELL');
      if (!sell) continue;
      const first = arr.find(x => ['BUY', 'ADD1', 'ADD2'].includes(x.action));
      if (!first) continue;

      const tsIn = first.ts, tsOut = sell.ts;
      const pxIn = toNum(first.price, 0);
      const pxOut = toNum(sell.price, 0);
      const qtyLots = toNum(sell.kv['總單位'], 1);
      const shares = qtyLots * 1000;

      // 平均成本含費（若無欄位則退化為買價）
      const pxInAvg = (sell.kv['平均成本含稅'] != null)
        ? toNum(sell.kv['平均成本含稅'])
        : (first.kv['avgCalc'] != null ? toNum(first.kv['avgCalc']) : pxIn);

      // 若無「稅後獲利」→依法計算
      let gainNet;
      if (sell.kv['稅後獲利'] != null) {
        gainNet = Math.round(toNum(sell.kv['稅後獲利'], 0));
      } else {
        const buyNet = Math.round(pxInAvg * shares);
        const sellNet = Math.round(pxOut * shares - fee(pxOut * shares) - taxOnSell(pxOut * shares));
        gainNet = sellNet - buyNet;
      }

      const mae = sell.kv['MAEpct'] != null ? toNum(sell.kv['MAEpct'], null) : null;
      const mfe = sell.kv['MFEpct'] != null ? toNum(sell.kv['MFEpct'], null) : null;
      const holdMin = sell.kv['holdMin'] != null ? toNum(sell.kv['holdMin'], null) : null;

      trades.push({
        tid: +tid, tsIn, tsOut,
        qtyLots, pxIn, pxOut, pxInAvg,
        gainSlip: gainNet,
        maePct: mae, mfePct: mfe, holdMin: holdMin
      });
    }

    // === 日損益 ===
    const daily = {};
    trades.forEach(t => {
      const d8 = String(t.tsOut).slice(0, 8);
      daily[d8] = (daily[d8] || 0) + t.gainSlip;
    });
    const days = Object.keys(daily).sort();
    const pnl = days.map(d => daily[d]);

    // === Equity / Returns ===
    const equity = []; let acc = 0;
    pnl.forEach(v => { acc += v; equity.push(acc / BASE_CAP); });
    const rets = pnl.map(v => v / BASE_CAP);

    return { events, trades, days, pnl, equity, rets, extras, FEE_RATE, FEE_MIN, TAX_RATE };
  }

  /* ======================== KPI 計算 ======================== */
  function calcEtfKpis(parsed) {
    const { days, pnl, equity: eq, rets } = parsed;
    const N = parsed.trades.length;
    const totalRet = sum(pnl) / BASE_CAP;

    let cover = 0, cagr = null;
    if (days.length) {
      const d0 = ymdToDate(days[0]), d1 = ymdToDate(days.at(-1));
      cover = Math.max(1, Math.round((d1 - d0) / 86400000) + 1);
      if (cover > 365) cagr = Math.pow(1 + totalRet, 365 / cover) - 1;
    }

    const volAnn = std(rets) * Math.sqrt(252);
    const downside = std(rets.filter(x => x < 0)) * Math.sqrt(252);
    const md = maxDrawdown(eq);
    const sharpe = volAnn > 0 ? (mean(rets) * 252) / volAnn : null;
    const sortino = downside > 0 ? (mean(rets) * 252) / downside : null;
    const calmar = md.mdd > 0 ? ((cagr ?? mean(rets) * 252) / md.mdd) : null;
    const var95 = percentile(rets, 5);
    const cvar95 = cvarLeftTail(rets, 0.95);
    const ui = ulcerIndex(eq);

    return {
      core: { totalReturn, CAGR: cagr, coverDays: cover, trades: N },
      risk: { volAnn, MDD: md.mdd, ddDuration: md.duration, UlcerIndex: ui, Sharpe: sharpe, Sortino: sortino, Calmar: calmar, VaR95: var95, CVaR95: cvar95 }
    };
  }

  /* ======================== 匯出 ======================== */
  global.ETFEngine = {
    parseEtfTxt,
    calcEtfKpis,
    FEE_RATE, FEE_MIN, TAX_RATE,
    setDebug: flag => (window.__ETF_DEBUG__ = !!flag)
  };

})(window);
