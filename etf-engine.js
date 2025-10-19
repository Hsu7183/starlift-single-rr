/* ===========================================================================
 * js/etf-engine.js  (ETF/股票策略計算核心；與期貨線完全分離)
 * 專為你的 00909-ETF TXT（CSV + key=value）而寫。
 * 只納入「買進 / 加碼攤平 / 再加碼攤平 / 賣出」，忽略「平買 / 平賣 / 強制平倉(強平)」。
 *
 * 公開 API：
 *   const parsed = ETFEngine.parseEtfTxt(rawTxt)
 *     -> { events, trades, days, pnl, equity, rets, extras }
 *   const kpis   = ETFEngine.calcEtfKpis(parsed)
 *     -> { core, risk, trade, capacity, meta }
 *
 * 使用方式：於 HTML 以 <script src="etf-engine.js"></script> 載入後，使用全域物件 window.ETFEngine。
 * =========================================================================== */

(function (global) {
  'use strict';

  /* ======================== 參數 / 選項 ======================== */
  /** 基準資金（每 100 萬） */
  var BASE_CAP = 1_000_000;

  /** 偵錯開關（false：不輸出；true：在 Console 印解析訊息） */
  var DEBUG = false;

  /* ======================== 小工具 ======================== */
  function toNum(x, dflt) {
    var v = Number(x);
    return isFinite(v) ? v : (dflt != null ? dflt : 0);
  }
  function sum(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s; }
  function mean(a) { return a.length ? sum(a) / a.length : 0; }
  function std(a) {
    if (a.length < 2) return 0;
    var m = mean(a), s = 0;
    for (var i = 0; i < a.length; i++) { var d = a[i] - m; s += d * d; }
    return Math.sqrt(s / (a.length - 1));
  }
  function quantile(a, q) {
    if (!a.length) return 0;
    var b = a.slice().sort(function (x, y) { return x - y; });
    var idx = Math.min(b.length - 1, Math.max(0, Math.floor(q * (b.length - 1))));
    return b[idx];
  }
  function percentile(a, p) { return quantile(a, p / 100); }
  function ymdToDate(d8) { return new Date(d8.slice(0, 4) + '-' + d8.slice(4, 6) + '-' + d8.slice(6, 8) + 'T00:00:00'); }

  function maxDrawdown(eq) {
    var peak = -Infinity, mdd = 0, ddStart = 0, ddEnd = 0, curStart = 0;
    for (var i = 0; i < eq.length; i++) {
      var v = eq[i];
      if (v > peak) { peak = v; curStart = i; }
      var dd = peak - v;
      if (dd > mdd) { mdd = dd; ddStart = curStart; ddEnd = i; }
    }
    return { mdd: mdd, ddStart: ddStart, ddEnd: ddEnd, duration: Math.max(0, ddEnd - ddStart) };
  }
  function ulcerIndex(eq) {
    if (eq.length < 2) return 0;
    var peak = eq[0], s = 0;
    for (var i = 0; i < eq.length; i++) {
      if (eq[i] > peak) peak = eq[i];
      var ddPct = peak === 0 ? 0 : ((eq[i] - peak) / Math.abs(peak)) * 100;
      s += ddPct * ddPct;
    }
    return Math.sqrt(s / eq.length);
  }
  function cvarLeftTail(rets, q) {
    if (!rets.length) return 0;
    var sorted = rets.slice().sort(function (a, b) { return a - b; });
    var idx = Math.floor((1 - q) * sorted.length);
    var tail = sorted.slice(0, Math.max(1, idx + 1));
    return mean(tail);
  }

  /* ======================== 動作過濾（只保留四種） ======================== */
  function mapAct(act) {
    var s = String(act || '').trim();
    if (s === '買進') return 'BUY';
    if (s === '加碼攤平') return 'ADD1';
    if (s === '再加碼攤平') return 'ADD2';
    if (s === '賣出') return 'SELL';
    // 明確排除：平買 / 平賣 / 強平 / 強制平倉 / 其他字樣
    return 'OTHER';
  }

  /* ======================== TXT 解析 ======================== */
  /**
   * 解析 00909-ETF TXT（CSV + key=value）
   * 回傳：{ events, trades, days, pnl, equity, rets, extras }
   */
  function parseEtfTxt(rawTxt) {
    var lines = String(rawTxt || '').replace(/\r\n?/g, '\n').split('\n');
    var events = [];
    var extras = [];

    for (var i = 0; i < lines.length; i++) {
      var L0 = lines[i];
      if (!L0) continue;
      var L = L0.trim();
      if (!L) continue;
      if (/^日期\s*,\s*時間\s*,\s*價格\s*,\s*動作/.test(L)) continue; // header

      // 允許半形/全形逗號、動作中文；tail 允許任意字元（含中文）
      var m = L.match(/^(\d{8})[,，](\d{5,6})[,，](\d+(?:\.\d+)?)[,，]([^,，]+?)[,，](.+)$/);
      if (!m) { if (DEBUG) console.warn('[ETFEngine] 無法解析行：', L); continue; }

      var d8 = m[1];
      var t6 = m[2].padStart(6, '0');
      var price = toNum(m[3], 0);
      var actRaw = m[4].trim();
      var tail = m[5] || '';
      var ts14 = d8 + t6;

      var act = mapAct(actRaw);
      if (act === 'OTHER') continue; // 排除非四種動作

      // 解析 key=value ，支援中文 key 與小數；分隔符容許全/半形逗號
      var kv = {};
      tail.split(/[,，]/).forEach(function (seg) {
        seg = (seg || '').trim();
        if (!seg) return;
        var p = seg.indexOf('=');
        if (p === -1) return;
        var k = seg.slice(0, p).trim();
        var v = seg.slice(p + 1).trim();
        kv[k] = v;
      });
      kv.ts = ts14;
      kv.price = price;
      kv.actRaw = actRaw;

      events.push({ ts: ts14, d8: d8, t6: t6, price: price, action: act, kv: kv, raw: L });
      extras.push(kv);
    }

    // 依 tid 分組 → 交易（需有 SELL 才算完成）
    var byTid = {};
    for (var k = 0; k < events.length; k++) {
      var e = events[k];
      var tid = e.kv.tid ? String(e.kv.tid).trim() : null;
      if (!tid) continue;  // tid 缺失就忽略
      if (!byTid[tid]) byTid[tid] = [];
      byTid[tid].push(e);
    }

    var tids = Object.keys(byTid).sort(function (a, b) { return +a - +b; });
    var trades = [];

    for (var u = 0; u < tids.length; u++) {
      var tid = tids[u];
      var arr = byTid[tid].sort(function (a, b) { return a.ts.localeCompare(b.ts); });

      var sellEv = null;
      for (var r = 0; r < arr.length; r++) if (arr[r].action === 'SELL') { sellEv = arr[r]; break; }
      if (!sellEv) continue;

      var firstEv = null;
      for (var f = 0; f < arr.length; f++) if (arr[f].action === 'BUY' || arr[f].action === 'ADD1' || arr[f].action === 'ADD2') { firstEv = arr[f]; break; }
      if (!firstEv) continue;

      var tsIn = firstEv.ts;
      var tsOut = sellEv.ts;

      var pxOut = toNum(sellEv.price, 0);
      var avgCalc = (sellEv.kv['平均成本含稅'] != null) ? toNum(sellEv.kv['平均成本含稅'], null)
        : (firstEv.kv.avgCalc != null ? toNum(firstEv.kv.avgCalc, null) : null);
      var pxInAvg = (avgCalc != null) ? avgCalc : toNum(firstEv.kv.avgCalc, 0);

      var qty = (sellEv.kv['總單位'] != null) ? toNum(sellEv.kv['總單位'], 1) : 1;

      var pxInPrint = (sellEv.kv['買價'] != null) ? toNum(sellEv.kv['買價'], pxInAvg) : pxInAvg;
      var pxOutPrint = (sellEv.kv['賣價'] != null) ? toNum(sellEv.kv['賣價'], pxOut) : pxOut;

      var gainNet = (sellEv.kv['稅後獲利'] != null) ? toNum(sellEv.kv['稅後獲利'], 0) : null;
      if (gainNet == null) {
        var gross = (pxOutPrint - pxInPrint) * qty * 1000;
        gainNet = 0.9 * gross; // 保守估（缺乏費稅時）
      }

      var mae = (sellEv.kv['MAEpct'] != null) ? toNum(sellEv.kv['MAEpct'], null) : null;
      var mfe = (sellEv.kv['MFEpct'] != null) ? toNum(sellEv.kv['MFEpct'], null) : null;
      var holdMin = (sellEv.kv['holdMin'] != null) ? toNum(sellEv.kv['holdMin'], null) : null;

      // 聚合 ISbps / entryNotional / ADV20 / 成交價
      var isbpsList = [], notionals = [], advs = [], execPrices = [];
      for (var w = 0; w < arr.length; w++) {
        var ev = arr[w];
        if (ev.action === 'BUY' || ev.action === 'ADD1' || ev.action === 'ADD2' || ev.action === 'SELL') {
          var kvw = ev.kv;
          if (kvw['ISbps'] != null) isbpsList.push(toNum(kvw['ISbps'], 0));
          if (kvw['entryNotional'] != null) notionals.push(toNum(kvw['entryNotional'], 0));
          if (kvw['ADV20'] != null) advs.push(toNum(kvw['ADV20'], 0));
          execPrices.push(kvw['execPx'] != null ? toNum(kvw['execPx'], ev.price) : ev.price);
        }
      }

      trades.push({
        tid: +tid,
        tsIn: tsIn,
        tsOut: tsOut,
        qty: qty,
        pxIn: pxInPrint,
        pxOut: pxOutPrint,
        pxInAvg: pxInAvg,
        gainSlip: gainNet,
        maePct: mae,
        mfePct: mfe,
        holdMin: holdMin,
        ISbps: isbpsList.length ? mean(isbpsList) : null,
        entryNotionalSum: notionals.length ? sum(notionals) : 0,
        ADV20avg: advs.length ? mean(advs) : null,
        medExecPx: execPrices.length ? quantile(execPrices, 0.5) : null
      });
    }

    // 日損益（以出場日入帳）
    var dailyMap = {};
    for (var i2 = 0; i2 < trades.length; i2++) {
      var d8key = String(trades[i2].tsOut).slice(0, 8);
      dailyMap[d8key] = (dailyMap[d8key] || 0) + trades[i2].gainSlip;
    }
    var days = Object.keys(dailyMap).sort();
    var pnl = []; for (var i3 = 0; i3 < days.length; i3++) pnl.push(dailyMap[days[i3]]);

    // 收益曲線（每百萬）
    var equity = [];
    var acc = 0;
    for (var e = 0; e < pnl.length; e++) { acc += pnl[e]; equity.push(acc / BASE_CAP); }

    // 以日損益近似的日報酬
    var rets = [];
    for (var r2 = 0; r2 < pnl.length; r2++) rets.push(pnl[r2] / BASE_CAP);

    if (DEBUG) {
      console.log('[ETFEngine] events:', events.length, ' trades:', trades.length, ' days:', days.length);
      if (events.length) console.log('[ETFEngine] sample event:', events[0]);
      if (trades.length) console.log('[ETFEngine] sample trade:', trades[0]);
    }

    return { events: events, trades: trades, days: days, pnl: pnl, equity: equity, rets: rets, extras: extras };
  }

  /* ======================== KPI 計算 ======================== */
  function calcEtfKpis(parsed) {
    var days = parsed.days, pnl = parsed.pnl, eq = parsed.equity, rets = parsed.rets, trades = parsed.trades;
    var N = trades.length;

    // 回報
    var totalRet = sum(pnl) / BASE_CAP;
    var coverDays = 0, cagr = null;
    if (days.length) {
      var d0 = ymdToDate(days[0]), d1 = ymdToDate(days[days.length - 1]);
      coverDays = Math.max(1, Math.round((d1 - d0) / 86400000) + 1);
      if (coverDays > 365) cagr = Math.pow(1 + totalRet, 365 / coverDays) - 1;
    }

    // 風險 & 風險調整
    var volAnn = std(rets) * Math.sqrt(252);
    var downside = std(rets.filter(function (x) { return x < 0; })) * Math.sqrt(252);
    var mddObj = maxDrawdown(eq);
    var sharpe = volAnn > 0 ? (mean(rets) * 252) / volAnn : null;
    var sortino = downside > 0 ? (mean(rets) * 252) / downside : null;
    var calmar = mddObj.mdd > 0 ? ((cagr != null ? cagr : (mean(rets) * 252)) / mddObj.mdd) : null;
    var var95 = percentile(rets, 5);
    var cvar95 = cvarLeftTail(rets, 0.95);
    var ui = ulcerIndex(eq);

    // 交易層
    var wins = [], loss = [];
    for (var i = 0; i < N; i++) {
      var g = trades[i].gainSlip;
      if (g > 0) wins.push(g); else if (g < 0) loss.push(-g);
    }
    var winRate = N ? wins.length / N : 0;
    var pf = sum(wins) / (sum(loss) || Infinity);
    var avgTrade = N ? (sum(pnl) / N) / BASE_CAP : 0;

    var MAEs = trades.map(function (t) { return t.maePct; }).filter(function (x) { return x != null; });
    var MFEs = trades.map(function (t) { return t.mfePct; }).filter(function (x) { return x != null; });
    var ISs = trades.map(function (t) { return t.ISbps; }).filter(function (x) { return x != null; });
    var holds = trades.map(function (t) { return t.holdMin; }).filter(function (x) { return x != null; });

    var avgMAE = mean(MAEs), avgMFE = mean(MFEs), avgIS = mean(ISs);
    var avgHold = mean(holds), medHold = holds.length ? quantile(holds, 0.5) : 0;

    // 容量（粗估）：entryNotional / (ADV20 × medExecPx)
    var parts = trades.map(function (t) {
      var adv = t.ADV20avg, medPx = t.medExecPx, notional = t.entryNotionalSum;
      return (adv && medPx) ? (notional / (adv * medPx)) : null;
    }).filter(function (x) { return x != null; });
    var avgPart = mean(parts);
    var p75Part = parts.length ? quantile(parts.map(function (x) { return x * 100; }), 0.75) / 100 : 0;

    return {
      core:      { totalReturn: totalRet, CAGR: cagr, coverDays: coverDays, trades: N },
      risk:      { volAnn: volAnn, MDD: mddObj.mdd, ddDuration: mddObj.duration, UlcerIndex: ui,
                   Sharpe: sharpe, Sortino: sortino, Calmar: calmar, VaR95: var95, CVaR95: cvar95 },
      trade:     { winRate: winRate, PF: pf, avgTrade: avgTrade,
                   avgHoldMin: avgHold, medHoldMin: medHold,
                   avgMAEpct: avgMAE, avgMFEpct: avgMFE, avgISbps: avgIS },
      capacity:  { avgParticipation: avgPart, p75Participation: p75Part },
      meta:      { baseCapital: BASE_CAP, firstDay: days[0] || null, lastDay: days[days.length - 1] || null }
    };
  }

  /* ======================== 匯出 ======================== */
  global.ETFEngine = {
    /** 解析 00909-ETF TXT → 交易、日損益、收益曲線等 */
    parseEtfTxt: parseEtfTxt,
    /** 計算機構級 KPI（核心/風險/風調/交易/容量） */
    calcEtfKpis: calcEtfKpis,
    /** （可選）打開/關閉 Console 偵錯 */
    setDebug: function (flag) { DEBUG = !!flag; }
  };

})(window);
