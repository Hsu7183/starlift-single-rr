/* ===========================================================================
 * js/etf-engine.js  (股票/ETF 專用計算核心，不依賴期貨 shared.js)
 * 解析 00909-ETF TXT（你提供的 CSV 風格；含擴充欄位），輸出機構級 KPI
 * API:
 *   - const parsed = ETFEngine.parseEtfTxt(rawTxt)
 *   - const kpis   = ETFEngine.calcEtfKpis(parsed)
 *   - parsed 內容：{ events, trades, days, pnl, equity, rets, extras }
 *   - kpis   內容：{ core, risk, trade, capacity, meta }
 * ------------------------------------------------------------------------- */

(function (global) {
  'use strict';

  var BASE_CAP = 1_000_000; // 基準資金：每 100 萬

  // --------- 小工具 ---------
  function toNum(x, dflt) {
    var v = Number(x);
    return isFinite(v) ? v : (dflt != null ? dflt : 0);
  }
  function sum(arr) { var s = 0; for (var i=0;i<arr.length;i++) s += arr[i]; return s; }
  function mean(arr) { return arr.length ? (sum(arr) / arr.length) : 0; }
  function std(arr) {
    if (arr.length < 2) return 0;
    var m = mean(arr), s = 0;
    for (var i=0;i<arr.length;i++) { var d = arr[i]-m; s += d*d; }
    return Math.sqrt(s / (arr.length-1));
  }
  function quantile(arr, q) {
    if (!arr.length) return 0;
    var b = arr.slice().sort(function(a,b){return a-b;});
    var idx = Math.min(b.length-1, Math.max(0, Math.floor(q*(b.length-1))));
    return b[idx];
  }
  function percentile(arr, p) { return quantile(arr, p/100); }

  // 最大回撤（以 equity 值計算；equity 為「每百萬」的累積）
  function maxDrawdown(eq) {
    var peak = -Infinity, mdd = 0, ddStart = 0, ddEnd = 0, curStart = 0;
    for (var i=0;i<eq.length;i++) {
      var v = eq[i];
      if (v > peak) { peak = v; curStart = i; }
      var dd = peak - v;
      if (dd > mdd) { mdd = dd; ddStart = curStart; ddEnd = i; }
    }
    return { mdd: mdd, ddStart: ddStart, ddEnd: ddEnd, duration: Math.max(0, ddEnd - ddStart) };
  }

  function ulcerIndex(eq) {
    if (eq.length < 2) return 0;
    var peak = eq[0], s = 0, n = 0;
    for (var i=0;i<eq.length;i++) {
      if (eq[i] > peak) peak = eq[i];
      var ddPct = peak === 0 ? 0 : ((eq[i]-peak) / Math.abs(peak)) * 100;
      s += ddPct * ddPct; n++;
    }
    return Math.sqrt(s / n);
  }

  function cvarLeftTail(rets, q) { // q=0.95 => 左尾 5%
    if (!rets.length) return 0;
    var sorted = rets.slice().sort(function(a,b){return a-b;});
    var idx = Math.floor((1-q) * sorted.length);
    var tail = sorted.slice(0, Math.max(1, idx+1));
    return mean(tail);
  }

  function ymdToDate(d8) { // 'YYYYMMDD' -> Date
    return new Date(d8.slice(0,4)+'-'+d8.slice(4,6)+'-'+d8.slice(6,8)+'T00:00:00');
  }

  // --------- 解析 TXT ：事件 & 交易 ---------
  function parseEtfTxt(rawTxt) {
    // 每行格式（你提供）：
    // 日期,時間,價格,動作,說明<key=value,key=value,...>
    // 動作：買進 / 加碼攤平 / 再加碼攤平 / 賣出 / 強制平倉(可能)
    var lines = String(rawTxt || '').replace(/\r\n?/g, '\n').split('\n');
    var events = [];
    var extras = []; // 保留原始 key=value 欄位（每行一份）

    function mapAct(act) {
      if (/賣出/.test(act)) return 'SELL';
      if (/買進/.test(act)) return 'BUY';
      if (/加碼攤平/.test(act)) return 'ADD';
      if (/強制平倉|強平/.test(act)) return 'FORCE';
      return 'OTHER';
    }

    for (var i=0;i<lines.length;i++) {
      var L = lines[i].trim();
      if (!L) continue;
      if (/^日期\s*,\s*時間\s*,\s*價格\s*,\s*動作/.test(L)) continue; // skip header

      // 前四欄 + 其餘 tail
      var m = L.match(/^(\d{8}),(\d{5,6}),(\d+(?:\.\d+)?),([^,]+),(.*)$/);
      if (!m) continue;

      var d = m[1];
      var t = m[2].padStart(6, '0');
      var px = toNum(m[3], 0);
      var actRaw = m[4].trim();
      var tail = m[5] || '';
      var ts14 = d + t;
      var act = mapAct(actRaw);

      // 解析 tail 的 key=value
      var kvObj = {};
      if (tail) {
        var segs = tail.split(',');
        for (var j=0;j<segs.length;j++){
          var kv = segs[j].split('=');
          if (kv.length >= 2) {
            var k = kv[0].trim();
            var v = kv.slice(1).join('=').trim();
            kvObj[k] = v;
          }
        }
      }
      kvObj.ts = ts14;
      kvObj.price = px;
      kvObj.actRaw = actRaw;

      var ev = {
        ts: ts14,
        d8: d,
        t6: t,
        price: px,
        action: act,
        raw: L,
        kv: kvObj
      };
      events.push(ev);
      extras.push(kvObj);
    }

    // 依 tid 分組為交易（同一筆：1次買進 + 0~2次加碼 + 1次賣出）
    var byTid = {};
    for (var k=0;k<events.length;k++) {
      var e = events[k];
      var tid = e.kv.tid ? String(e.kv.tid) : null;
      if (!tid) continue; // 沒有 tid 的行不列入交易（理論上每行都有）
      if (!byTid[tid]) byTid[tid] = [];
      byTid[tid].push(e);
    }
    // 生成 trades（以賣出行為錨）
    var trades = [];
    var tids = Object.keys(byTid).sort(function(a,b){ return +a - +b; });
    for (var u=0; u<tids.length; u++) {
      var tid = tids[u];
      var arr = byTid[tid].sort(function(a,b){ return a.ts.localeCompare(b.ts); });

      // 找賣出
      var sellEv = null;
      for (var r=0;r<arr.length;r++) if (arr[r].action === 'SELL') { sellEv = arr[r]; break; }
      if (!sellEv) continue; // 沒賣出不算完整交易

      // 進場（第一個 BUY/ADD 的時間/均價）
      var firstEv = arr[0];
      var tsIn = firstEv.ts;
      var tsOut = sellEv.ts;

      // 平倉價與均價（從賣出行取）
      var pxOut = toNum(sellEv.price, 0);
      var avgCalc = toNum(sellEv.kv['平均成本含稅'], null); // 若無則 null
      var pxInAvg = avgCalc != null ? avgCalc : toNum(firstEv.kv.avgCalc, 0);

      // 數量（賣出行的 總單位）
      var qty = toNum(sellEv.kv['總單位'], 1);

      // 稅後獲利（優先用賣出行提供）
      var gainNet = sellEv.kv['稅後獲利'] != null ? toNum(sellEv.kv['稅後獲利'], 0) : null;

      // 進出價（賣出行有買價/賣價）
      var pxInPrint = sellEv.kv['買價'] != null ? toNum(sellEv.kv['買價'], pxInAvg) : pxInAvg;
      var pxOutPrint= sellEv.kv['賣價'] != null ? toNum(sellEv.kv['賣價'], pxOut) : pxOut;

      // MAE/MFE/持有時間（賣出行）
      var mae = toNum(sellEv.kv['MAEpct'], null);
      var mfe = toNum(sellEv.kv['MFEpct'], null);
      var holdMin = toNum(sellEv.kv['holdMin'], null);

      // 加總該 tid 內的 ISbps、entryNotional、ADV20 等
      var isbpsList = [], notionals = [], advs = [], execPrices = [];
      for (var w=0; w<arr.length; w++) {
        var kv = arr[w].kv;
        if (kv['ISbps'] != null) isbpsList.push(toNum(kv['ISbps'], 0));
        if (kv['entryNotional'] != null) notionals.push(toNum(kv['entryNotional'], 0));
        if (kv['ADV20'] != null) advs.push(toNum(kv['ADV20'], 0));
        // 成交價/原始價作為價格集合
        if (kv['execPx'] != null) execPrices.push(toNum(kv['execPx'], arr[w].price));
        else execPrices.push(arr[w].price);
      }
      // 若缺 gain，近似估（以賣出行毛利與費稅求近似；或直接 0）
      if (gainNet == null) {
        var gross = (pxOutPrint - pxInPrint) * qty * 1000; // 張=1000股
        // 沒有更細成本時，保守設為毛利 90% 近似（避免高估）
        gainNet = 0.9 * gross;
      }

      trades.push({
        tid: +tid,
        tsIn: tsIn,
        tsOut: tsOut,
        qty: qty,
        pxIn: pxInPrint,
        pxOut: pxOutPrint,
        pxInAvg: pxInAvg,
        gainSlip: gainNet, // 已含成本稅，視為淨值
        maePct: mae,   // 單位：百分比（%）
        mfePct: mfe,   // 單位：百分比（%）
        holdMin: holdMin,
        ISbps: isbpsList.length ? mean(isbpsList) : null,
        entryNotionalSum: notionals.length ? sum(notionals) : 0,
        ADV20avg: advs.length ? mean(advs) : null,
        medExecPx: execPrices.length ? quantile(execPrices, 0.5) : null
      });
    }

    // 日損益（以出場日為損益實現）
    var dailyMap = {}; // d8 -> 元
    for (var i2=0;i2<trades.length;i2++) {
      var tr = trades[i2];
      var d8 = String(tr.tsOut).slice(0,8);
      dailyMap[d8] = (dailyMap[d8] || 0) + tr.gainSlip;
    }
    var days = Object.keys(dailyMap).sort();
    var pnl = [];
    for (var i3=0;i3<days.length;i3++) pnl.push(dailyMap[days[i3]]);

    // 收益曲線（以每百萬表示）
    var equity = [];
    var acc = 0;
    for (var e=0;e<pnl.length;e++) { acc += pnl[e]; equity.push(acc / BASE_CAP); }
    // 日報酬（小額近似）
    var rets = [];
    for (var r2=0;r2<pnl.length;r2++) rets.push(pnl[r2] / BASE_CAP);

    return {
      events: events,
      trades: trades,
      days: days,
      pnl: pnl,             // 元
      equity: equity,       // 每百萬（累積）
      rets: rets,           // 每日報酬（近似）
      extras: extras
    };
  }

  // --------- KPI 計算（機構級） ---------
  function calcEtfKpis(parsed) {
    var days = parsed.days, pnl = parsed.pnl, eq = parsed.equity, rets = parsed.rets, trades = parsed.trades;
    var N = trades.length;

    // 累積報酬（每百萬）
    var totalRet = sum(pnl) / BASE_CAP;

    // 涵蓋日數 / CAGR
    var coverDays = 0, cagr = null;
    if (days.length) {
      var d0 = ymdToDate(days[0]), d1 = ymdToDate(days[days.length-1]);
      coverDays = Math.max(1, Math.round((d1 - d0) / 86400000) + 1);
      if (coverDays > 365) cagr = Math.pow(1 + totalRet, 365/coverDays) - 1;
    }

    // 風險指標
    var volAnn = std(rets) * Math.sqrt(252);
    var downsideDaily = rets.filter(function(x){ return x < 0; });
    var downsideAnn = std(downsideDaily) * Math.sqrt(252);
    var mddObj = maxDrawdown(eq);
    var mdd = mddObj.mdd;
    var ddDuration = mddObj.duration;
    var shr = volAnn > 0 ? (mean(rets)*252)/volAnn : null;
    var sor = downsideAnn > 0 ? (mean(rets)*252)/downsideAnn : null;
    var cal = mdd > 0 ? ((cagr != null ? cagr : (mean(rets)*252)) / mdd) : null;
    var var95 = percentile(rets, 5);
    var cvar95 = cvarLeftTail(rets, 0.95);
    var ui = ulcerIndex(eq);

    // 交易層
    var wins = [], loss = [];
    for (var i=0;i<N;i++){
      var g = trades[i].gainSlip;
      if (g > 0) wins.push(g);
      else if (g < 0) loss.push(-g);
    }
    var winRate = N ? wins.length / N : 0;
    var pf = sum(wins) / (sum(loss) || Infinity);
    var avgTrade = N ? (sum(pnl)/N)/BASE_CAP : 0;
    // MAE / MFE / ISbps / 持有時間
    var MAEs=[], MFEs=[], ISs=[], holds=[];
    for (var j=0;j<N;j++){
      if (trades[j].maePct != null) MAEs.push(toNum(trades[j].maePct,0));
      if (trades[j].mfePct != null) MFEs.push(toNum(trades[j].mfePct,0));
      if (trades[j].ISbps != null)  ISs.push(toNum(trades[j].ISbps,0));
      if (trades[j].holdMin != null) holds.push(toNum(trades[j].holdMin,0));
    }
    var avgMAE = mean(MAEs), avgMFE = mean(MFEs), avgIS = mean(ISs);
    var avgHold = mean(holds), medHold = holds.length? quantile(holds, 0.5) : 0;

    // 容量/參與率（粗估）：entryNotional / (ADV20 * 中位價)
    var parts = [];
    for (var p=0;p<N;p++){
      var tr = trades[p];
      var adv = tr.ADV20avg, medPx = tr.medExecPx, notional = tr.entryNotionalSum;
      if (adv && medPx) {
        var estDailyNotional = adv * medPx; // 單位近似（若 adv 為股數、則 × 價格≈金額）
        if (estDailyNotional > 0) parts.push(notional / estDailyNotional);
      }
    }
    var avgPart = mean(parts);
    var p75Part = parts.length? quantile(parts.slice().map(function(x){return x*100;}), 0.75)/100 : 0;

    return {
      core: {
        totalReturn: totalRet,       // 每百萬
        CAGR: cagr,
        coverDays: coverDays,
        trades: N
      },
      risk: {
        volAnn: volAnn,
        MDD: mdd,
        ddDuration: ddDuration,
        UlcerIndex: ui,
        Sharpe: shr,
        Sortino: sor,
        Calmar: cal,
        VaR95: var95,
        CVaR95: cvar95
      },
      trade: {
        winRate: winRate,
        PF: pf,
        avgTrade: avgTrade,       // 每筆/每百萬
        avgHoldMin: avgHold,
        medHoldMin: medHold,
        avgMAEpct: avgMAE,        // %
        avgMFEpct: avgMFE,        // %
        avgISbps: avgIS           // bps
      },
      capacity: {
        avgParticipation: avgPart,
        p75Participation: p75Part
      },
      meta: {
        baseCapital: BASE_CAP,
        firstDay: days[0] || null,
        lastDay:  days.length? days[days.length-1] : null
      }
    };
  }

  // 匯出到全域（瀏覽器）
  global.ETFEngine = {
    parseEtfTxt: parseEtfTxt,
    calcEtfKpis: calcEtfKpis
  };

})(window);
