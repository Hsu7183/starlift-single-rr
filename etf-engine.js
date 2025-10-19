/* ===========================================================================
 * js/etf-engine.js  (ETF/股票策略計算核心；與期貨線完全分離)
 * 專為 00909-ETF TXT（你提供的 CSV＋key=value）而寫：
 * 只納入「買進 / 加碼攤平 / 再加碼攤平 / 賣出」，忽略「平買 / 平賣 / 強制平倉(強平)」。
 *
 * 主要 API：
 *   const parsed = ETFEngine.parseEtfTxt(rawTxt)
 *     -> { events, trades, days, pnl, equity, rets, extras }
 *   const kpis   = ETFEngine.calcEtfKpis(parsed)
 *     -> { core, risk, trade, capacity, meta }
 * =========================================================================== */

(function (global) {
  'use strict';

  var BASE_CAP = 1_000_000; // 基準資金：每 100 萬

  // --------- utils ---------
  function toNum(x, dflt) { var v = Number(x); return isFinite(v) ? v : (dflt != null ? dflt : 0); }
  function sum(a){ var s=0; for(var i=0;i<a.length;i++) s+=a[i]; return s; }
  function mean(a){ return a.length? sum(a)/a.length : 0; }
  function std(a){
    if(a.length<2) return 0;
    var m=mean(a), s=0; for(var i=0;i<a.length;i++){ var d=a[i]-m; s+=d*d; }
    return Math.sqrt(s/(a.length-1));
  }
  function quantile(a, q){
    if(!a.length) return 0;
    var b=a.slice().sort(function(x,y){return x-y;});
    var idx=Math.min(b.length-1, Math.max(0, Math.floor(q*(b.length-1))));
    return b[idx];
  }
  function percentile(a,p){ return quantile(a, p/100); }
  function ymdToDate(d8){ return new Date(d8.slice(0,4)+'-'+d8.slice(4,6)+'-'+d8.slice(6,8)+'T00:00:00'); }

  function maxDrawdown(eq){
    var peak=-Infinity, mdd=0, ddStart=0, ddEnd=0, curStart=0;
    for(var i=0;i<eq.length;i++){
      var v=eq[i];
      if(v>peak){ peak=v; curStart=i; }
      var dd=peak-v;
      if(dd>mdd){ mdd=dd; ddStart=curStart; ddEnd=i; }
    }
    return { mdd:mdd, ddStart:ddStart, ddEnd:ddEnd, duration:Math.max(0, ddEnd-ddStart) };
  }
  function ulcerIndex(eq){
    if(eq.length<2) return 0;
    var peak=eq[0], s=0, n=0;
    for(var i=0;i<eq.length;i++){
      if(eq[i]>peak) peak=eq[i];
      var ddPct = peak===0? 0 : ((eq[i]-peak)/Math.abs(peak))*100;
      s += ddPct*ddPct; n++;
    }
    return Math.sqrt(s/n);
  }
  function cvarLeftTail(rets, q){
    if(!rets.length) return 0;
    var sorted=rets.slice().sort(function(a,b){return a-b;});
    var idx=Math.floor((1-q)*sorted.length);
    var tail=sorted.slice(0, Math.max(1, idx+1));
    return mean(tail);
  }

  // --------- parser ---------

  // 只允許四種：買進 / 加碼攤平 / 再加碼攤平 / 賣出
  function mapAct(act) {
    var s = String(act||'').trim();
    if (/^賣出$/.test(s)) return 'SELL';
    if (/^買進$/.test(s)) return 'BUY';
    if (/^加碼攤平$/.test(s)) return 'ADD1';
    if (/^再加碼攤平$/.test(s)) return 'ADD2';
    // 明確排除：平買 / 平賣 / 強制平倉(強平) 等
    return 'OTHER';
  }

  // 主解析：把每行 TXT 轉成 event（含 kv 欄位）
  function parseEtfTxt(rawTxt) {
    var lines = String(rawTxt||'').replace(/\r\n?/g,'\n').split('\n');
    var events = [];
    var extras = [];

    for (var i=0;i<lines.length;i++){
      var L = lines[i].trim();
      if(!L) continue;
      if(/^日期\s*,\s*時間\s*,\s*價格\s*,\s*動作/.test(L)) continue; // header

      // 更寬鬆：半形或全形逗號；動作欄允許中文與空白
      var m = L.match(/^(\d{8})[,，]\s*(\d{5,6})[,，]\s*(\d+(?:\.\d+)?)\s*[,，]\s*([^,，]+?)\s*[,，](.*)$/);
      if(!m) continue;

      var d8 = m[1];
      var t6 = m[2].padStart(6,'0');
      var price = toNum(m[3], 0);
      var actionRaw = m[4].trim();
      var tail = m[5] || '';
      var ts14 = d8 + t6;

      var act = mapAct(actionRaw);    // 只留下 BUY / ADD1 / ADD2 / SELL
      if (act === 'OTHER') {
        // 例如：平賣 / 強平 → 直接忽略
        continue;
      }

      // tail: key=value,key=value,...  （允許中文 key 與小數）
      var kvObj = {};
      if (tail) {
        // 先用逗號（含全形）切；但 key 本身不包含逗號
        var segs = tail.split(/[,，]/);
        for (var j=0;j<segs.length;j++){
          var seg = segs[j];
          if (!seg) continue;
          var pos = seg.indexOf('=');
          if (pos === -1) continue;
          var k = seg.slice(0,pos).trim();
          var v = seg.slice(pos+1).trim();
          kvObj[k] = v;
        }
      }

      kvObj.ts = ts14;
      kvObj.price = price;
      kvObj.actionRaw = actionRaw;

      events.push({
        ts: ts14, d8: d8, t6: t6,
        price: price,
        action: act,
        raw: L,
        kv: kvObj
      });
      extras.push(kvObj);
    }

    // 依 tid 分組；一筆交易包含：至少一個 BUY（與可能的 ADD1/ADD2）+ 一個 SELL
    var byTid = {};
    for (var k=0;k<events.length;k++){
      var e = events[k];
      var tid = e.kv.tid ? String(e.kv.tid).trim() : null;
      if (!tid) continue;  // tid 缺失 → 放棄這行
      if (!byTid[tid]) byTid[tid] = [];
      byTid[tid].push(e);
    }

    var tids = Object.keys(byTid).sort(function(a,b){ return +a - +b; });
    var trades = [];

    for (var u=0; u<tids.length; u++){
      var tid = tids[u];
      var arr = byTid[tid].sort(function(a,b){ return a.ts.localeCompare(b.ts); });

      // 必須有 SELL 才算一筆完成交易
      var sellEv = null;
      for (var r=0;r<arr.length;r++){
        if (arr[r].action === 'SELL'){ sellEv = arr[r]; break; }
      }
      if (!sellEv) continue;

      // 進場（第一個 BUY/ADD 的時間/參考均價）
      var firstEv = null;
      for (var f=0; f<arr.length; f++){
        if (arr[f].action === 'BUY' || arr[f].action === 'ADD1' || arr[f].action === 'ADD2'){
          firstEv = arr[f]; break;
        }
      }
      if (!firstEv) continue;

      var tsIn  = firstEv.ts;
      var tsOut = sellEv.ts;

      var pxOut = toNum(sellEv.price, 0);
      var avgCalc = (sellEv.kv['平均成本含稅'] != null) ? toNum(sellEv.kv['平均成本含稅'], null)
                     : (firstEv.kv['avgCalc'] != null ? toNum(firstEv.kv['avgCalc'], null) : null);
      var pxInAvg = (avgCalc != null) ? avgCalc : toNum(firstEv.kv.avgCalc, 0);

      // 張數
      var qty = sellEv.kv['總單位'] != null ? toNum(sellEv.kv['總單位'], 1) : 1;

      // 進出價（賣出行有買價/賣價）
      var pxInPrint  = sellEv.kv['買價']  != null ? toNum(sellEv.kv['買價'],  pxInAvg) : pxInAvg;
      var pxOutPrint = sellEv.kv['賣價']  != null ? toNum(sellEv.kv['賣價'],  pxOut)   : pxOut;

      // 稅後獲利：若沒有就以毛利 * 90% 近似
      var gainNet = (sellEv.kv['稅後獲利'] != null) ? toNum(sellEv.kv['稅後獲利'], 0) : null;
      if (gainNet == null){
        var gross = (pxOutPrint - pxInPrint) * qty * 1000;
        gainNet = 0.9 * gross;
      }

      // MAE/MFE/持有時間（賣出行）
      var mae = sellEv.kv['MAEpct'] != null ? toNum(sellEv.kv['MAEpct'], null) : null;
      var mfe = sellEv.kv['MFEpct'] != null ? toNum(sellEv.kv['MFEpct'], null) : null;
      var holdMin = sellEv.kv['holdMin'] != null ? toNum(sellEv.kv['holdMin'], null) : null;

      // 聚合 ISbps / entryNotional / ADV20 / 價格中位
      var isbpsList=[], notionals=[], advs=[], execPrices=[];
      for (var w=0; w<arr.length; w++){
        var ev = arr[w];
        if (ev.action === 'BUY' || ev.action === 'ADD1' || ev.action === 'ADD2' || ev.action === 'SELL'){
          var kv=ev.kv;
          if (kv['ISbps'] != null)         isbpsList.push(toNum(kv['ISbps'], 0));
          if (kv['entryNotional'] != null) notionals.push(toNum(kv['entryNotional'], 0));
          if (kv['ADV20'] != null)         advs.push(toNum(kv['ADV20'], 0));
          if (kv['execPx'] != null)        execPrices.push(toNum(kv['execPx'], ev.price));
          else                              execPrices.push(ev.price);
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
        gainSlip: gainNet,       // 稅後獲利（或近似）
        maePct: mae,             // %
        mfePct: mfe,             // %
        holdMin: holdMin,
        ISbps: isbpsList.length ? mean(isbpsList) : null,
        entryNotionalSum: notionals.length ? sum(notionals) : 0,
        ADV20avg: advs.length ? mean(advs) : null,
        medExecPx: execPrices.length ? quantile(execPrices, 0.5) : null
      });
    }

    // 日損益（以出場日入帳）
    var dailyMap = {};
    for (var i2=0;i2<trades.length;i2++){
      var tr = trades[i2];
      var d8 = String(tr.tsOut).slice(0,8);
      dailyMap[d8] = (dailyMap[d8] || 0) + tr.gainSlip;
    }
    var days = Object.keys(dailyMap).sort();
    var pnl = []; for (var i3=0;i3<days.length;i3++) pnl.push(dailyMap[days[i3]]);

    // 收益曲線（以每 100 萬為單位）
    var equity = []; var acc=0;
    for (var e=0;e<pnl.length;e++){ acc += pnl[e]; equity.push(acc/BASE_CAP); }

    // 以日損益近似的日報酬（小額近似）
    var rets = [];
    for (var r2=0;r2<pnl.length;r2++) rets.push(pnl[r2]/BASE_CAP);

    return {
      events: events,
      trades: trades,
      days: days,
      pnl: pnl,           // 元
      equity: equity,     // 每百萬（累積）
      rets: rets,         // 每日報酬（近似）
      extras: extras
    };
  }

  // --------- KPI ---------
  function calcEtfKpis(parsed) {
    var days = parsed.days, pnl = parsed.pnl, eq = parsed.equity, rets = parsed.rets, trades = parsed.trades;
    var N = trades.length;

    // 回報
    var totalRet = sum(pnl)/BASE_CAP;
    var coverDays=0, cagr=null;
    if(days.length){
      var d0=ymdToDate(days[0]), d1=ymdToDate(days[days.length-1]);
      coverDays = Math.max(1, Math.round((d1-d0)/86400000)+1);
      if(coverDays>365) cagr = Math.pow(1+totalRet, 365/coverDays)-1;
    }

    // 風險
    var volAnn = std(rets)*Math.sqrt(252);
    var downside = std(rets.filter(function(x){return x<0;}))*Math.sqrt(252);
    var mddObj = maxDrawdown(eq);
    var shr = volAnn>0 ? (mean(rets)*252)/volAnn : null;
    var sor = downside>0 ? (mean(rets)*252)/downside : null;
    var cal = mddObj.mdd>0 ? ((cagr!=null?cagr:(mean(rets)*252))/mddObj.mdd) : null;
    var var95 = percentile(rets,5);
    var cvar95= cvarLeftTail(rets,0.95);
    var ui = ulcerIndex(eq);

    // 交易層
    var wins=[], loss=[];
    for(var i=0;i<N;i++){ var g=trades[i].gainSlip; if(g>0) wins.push(g); else if(g<0) loss.push(-g); }
    var winRate = N? wins.length/N : 0;
    var pf = sum(wins)/(sum(loss)||Infinity);
    var avgTrade = N? (sum(pnl)/N)/BASE_CAP : 0;

    var MAEs=[], MFEs=[], ISs=[], holds=[];
    for(var j=0;j<N;j++){
      if(trades[j].maePct!=null) MAEs.push(toNum(trades[j].maePct,0));
      if(trades[j].mfePct!=null) MFEs.push(toNum(trades[j].mfePct,0));
      if(trades[j].ISbps!=null)  ISs.push(toNum(trades[j].ISbps,0));
      if(trades[j].holdMin!=null) holds.push(toNum(trades[j].holdMin,0));
    }
    var avgMAE = mean(MAEs), avgMFE = mean(MFEs), avgIS = mean(ISs);
    var avgHold= mean(holds), medHold = holds.length? quantile(holds,0.5):0;

    // 容量估：entryNotional / (ADV20 * medExecPx)
    var parts=[];
    for(var p=0;p<N;p++){
      var tr=trades[p];
      var adv=tr.ADV20avg, medPx=tr.medExecPx, notional=tr.entryNotionalSum;
      if(adv && medPx){
        var est = adv*medPx; // 若 adv 是股數，×價≈金額
        if(est>0) parts.push(notional/est);
      }
    }
    var avgPart = mean(parts);
    var p75Part = parts.length? quantile(parts.map(function(x){return x*100;}),0.75)/100 : 0;

    return {
      core: { totalReturn: totalRet, CAGR:cagr, coverDays:coverDays, trades:N },
      risk: { volAnn:volAnn, MDD:mddObj.mdd, ddDuration:mddObj.duration, UlcerIndex:ui,
              Sharpe:shr, Sortino:sor, Calmar:cal, VaR95:var95, CVaR95:cvar95 },
      trade:{ winRate:winRate, PF:pf, avgTrade:avgTrade,
              avgHoldMin:avgHold, medHoldMin:medHold,
              avgMAEpct:avgMAE, avgMFEpct:avgMFE, avgISbps:avgIS },
      capacity:{ avgParticipation:avgPart, p75Participation:p75Part },
      meta:{ baseCapital:BASE_CAP, firstDay:days[0]||null, lastDay:days.length?days[days.length-1]:null }
    };
  }

  // 匯出
  global.ETFEngine = { parseEtfTxt:parseEtfTxt, calcEtfKpis:calcEtfKpis };

})(window);
