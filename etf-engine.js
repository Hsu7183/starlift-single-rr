/* ===========================================================================
 * js/etf-engine.js  (ETF/股票策略計算核心；與期貨線完全分離)
 * 專為 00909-ETF TXT（CSV + key=value）而寫。
 * 只納入「買進 / 加碼攤平 / 再加碼攤平 / 賣出」，忽略「平買 / 平賣 / 強制平倉(強平)」。
 *
 * API：
 *   const parsed = ETFEngine.parseEtfTxt(rawTxt)
 *     -> { events, trades, days, pnl, equity, rets, extras, FEE_RATE, FEE_MIN, TAX_RATE }
 *   const kpis   = ETFEngine.calcEtfKpis(parsed)
 *     -> { core, risk, trade, capacity, meta }
 *   ETFEngine.setDebug(true|false)
 * =========================================================================== */

(function (global) {
  'use strict';

  /* ======================== 依法常數（台灣） ======================== */
  var BASE_CAP = 1_000_000;        // 基準資金（每 100 萬）
  var FEE_RATE = 0.001425;         // 手續費率（單邊）
  var FEE_MIN  = 20;               // 最低手續費
  var TAX_RATE = 0.001;            // ETF 證交稅率 0.1%（僅賣出）
  function fee(amt){ return Math.max(Math.round(amt * FEE_RATE), FEE_MIN); }
  function taxOnSell(amt){ return Math.round(amt * TAX_RATE); }

  /* ======================== 開關 ======================== */
  var DEBUG = false;

  /* ======================== utils ======================== */
  function toNum(x, dflt){ var v=Number(x); return isFinite(v)? v : (dflt!=null? dflt:0); }
  function sum(a){ var s=0; for(var i=0;i<a.length;i++) s+=a[i]; return s; }
  function mean(a){ return a.length? sum(a)/a.length : 0; }
  function std(a){ if(a.length<2) return 0; var m=mean(a), s=0; for(var i=0;i<a.length;i++){ var d=a[i]-m; s+=d*d; } return Math.sqrt(s/(a.length-1)); }
  function quantile(a,q){ if(!a.length) return 0; var b=a.slice().sort(function(x,y){return x-y;}); var i=Math.min(b.length-1, Math.max(0, Math.floor(q*(b.length-1)))); return b[i]; }
  function percentile(a,p){ return quantile(a, p/100); }
  function ymdToDate(d8){ return new Date(d8.slice(0,4)+'-'+d8.slice(4,6)+'-'+d8.slice(6,8)+'T00:00:00'); }

  function maxDrawdown(eq){
    var peak=-Infinity, mdd=0, ds=0, de=0, cs=0;
    for(var i=0;i<eq.length;i++){
      var v=eq[i];
      if(v>peak){ peak=v; cs=i; }
      var dd=peak-v;
      if(dd>mdd){ mdd=dd; ds=cs; de=i; }
    }
    return { mdd:mdd, ddStart:ds, ddEnd:de, duration:Math.max(0, de-ds) };
  }
  function ulcerIndex(eq){
    if(eq.length<2) return 0;
    var peak=eq[0], s=0;
    for(var i=0;i<eq.length;i++){
      if(eq[i]>peak) peak=eq[i];
      var ddPct = peak===0? 0 : ((eq[i]-peak)/Math.abs(peak))*100;
      s += ddPct*ddPct;
    }
    return Math.sqrt(s/eq.length);
  }
  function cvarLeftTail(rets, q){
    if(!rets.length) return 0;
    var b = rets.slice().sort(function(a,b){return a-b;});
    var idx = Math.floor((1-q)*b.length);
    var tail = b.slice(0, Math.max(1, idx+1));
    return mean(tail);
  }

  /* ======================== 僅保留四種動作 ======================== */
  function mapAct(act){
    var s = String(act||'').replace(/[\uFEFF\u200B-\u200D\u00A0\u3000]/g,'').trim();
    if(/^買進$/.test(s))       return 'BUY';
    if(/^加碼攤平$/.test(s))   return 'ADD1';
    if(/^再加碼攤平$/.test(s)) return 'ADD2';
    if(/^賣出$/.test(s))       return 'SELL';
    return 'OTHER';
  }

  /* ======================== 解析 TXT ======================== */
  function parseEtfTxt(rawTxt){
    // 全域淨化
    var norm = String(rawTxt||'').replace(/\r\n?/g,'\n').replace(/[\uFEFF\u200B-\u200D]/g,'');
    var lines = norm.split('\n');
    var events = [], extras = [];

    for (var i=0; i<lines.length; i++){
      var L = (lines[i]||'').replace(/[\u00A0\u3000]/g,' ').trim();
      if (!L) continue;
      if (/^日期\s*,\s*時間\s*,\s*價格\s*,\s*動作/i.test(L)) continue;

      // 允許全/半形逗號；動作中文；尾端 key=value
      var m = L.match(/^(\d{8})[,，](\d{5,6})[,，](\d+(?:\.\d+)?)[,，]([^,，]+?)[,，](.+)$/);
      if(!m){ if(DEBUG) console.warn('[ETFEngine] 行格式無法匹配：', L); continue; }

      var d8 = m[1], t6 = m[2].padStart(6,'0'), price = toNum(m[3],0), actRaw = m[4].trim(), tail = m[5]||'';
      var ts14 = d8 + t6;
      var act = mapAct(actRaw);
      if (act === 'OTHER') continue;

      var kv = {};
      tail.split(/[,，]/).forEach(function(seg){
        seg = seg.trim(); if(!seg) return;
        var p=seg.indexOf('=');
        if(p===-1) return;
        var k=seg.slice(0,p).trim(), v=seg.slice(p+1).trim();
        kv[k]=v;
      });

      // lotsThisRow：BUY/ADD 用「本次單位」，SELL 用「總單位」
      var lotsThisRow = act==='SELL' ? toNum(kv['總單位'],0) : toNum(kv['本次單位'],0);

      kv.ts = ts14;
      kv.price = price;
      kv.actRaw = actRaw;
      kv.lotsThisRow = lotsThisRow;

      events.push({ ts:ts14, d8:d8, t6:t6, price:price, action:act, kv:kv, raw:L });
      extras.push(kv);
    }

    // 依 tid 匯成 trades
    var byTid = {};
    for (var e of events){
      var tid = e.kv.tid ? String(e.kv.tid).trim() : null;
      if(!tid) continue;
      (byTid[tid] || (byTid[tid]=[])).push(e);
    }

    var tids = Object.keys(byTid).sort(function(a,b){ return +a - +b; });
    var trades = [];

    for (var tid of tids){
      var arr = byTid[tid].sort(function(a,b){ return a.ts.localeCompare(b.ts); });
      var sell = null;
      for (var r=0;r<arr.length;r++){ if(arr[r].action==='SELL'){ sell=arr[r]; break; } }
      if(!sell) continue;

      var first = null;
      for (var f=0; f<arr.length; f++){ var a=arr[f].action; if(a==='BUY'||a==='ADD1'||a==='ADD2'){ first=arr[f]; break; } }
      if(!first) continue;

      var tsIn  = first.ts, tsOut = sell.ts;
      var pxIn  = toNum(first.price, 0);
      var pxOut = toNum(sell.price, 0);
      var qtyLots = toNum(sell.kv['總單位'], 1);
      var shares  = qtyLots * 1000;

      // 平均成本（含費），若無欄位就退化為買價
      var pxInAvg = (sell.kv['平均成本含稅']!=null) ? toNum(sell.kv['平均成本含稅']) :
                    (first.kv['avgCalc']!=null)       ? toNum(first.kv['avgCalc'])     : pxIn;

      // 若有「稅後獲利」就採用；否則依法計算
      var gainNet;
      if (sell.kv['稅後獲利']!=null){
        gainNet = Math.round(toNum(sell.kv['稅後獲利'],0));
      }else{
        var buyNet  = Math.round(pxInAvg * shares);                       // 平均成本×股數（含買側費用）
        var sellNet = Math.round(pxOut * shares - fee(pxOut*shares) - taxOnSell(pxOut*shares));
        gainNet = sellNet - buyNet;
      }

      // 其他欄位（若有）
      var mae = sell.kv['MAEpct']!=null ? toNum(sell.kv['MAEpct'], null) : null;
      var mfe = sell.kv['MFEpct']!=null ? toNum(sell.kv['MFEpct'], null) : null;
      var holdMin = sell.kv['holdMin']!=null ? toNum(sell.kv['holdMin'], null) : null;

      // 聚合 ISbps / entryNotional / ADV20 / 成交價中位
      var isbpsList=[], notionals=[], advs=[], prices=[];
      for (var ev of arr){
        if (ev.action==='BUY'||ev.action==='ADD1'||ev.action==='ADD2'||ev.action==='SELL'){
          var kvw = ev.kv;
          if (kvw['ISbps']!=null)         isbpsList.push(toNum(kvw['ISbps'],0));
          if (kvw['entryNotional']!=null) notionals.push(toNum(kvw['entryNotional'],0));
          if (kvw['ADV20']!=null)         advs.push(toNum(kvw['ADV20'],0));
          prices.push( kvw['execPx']!=null ? toNum(kvw['execPx'],ev.price) : ev.price );
        }
      }

      trades.push({
        tid:+tid,
        tsIn:tsIn, tsOut:tsOut,
        qtyLots: qtyLots,
        pxIn:pxIn, pxOut:pxOut, pxInAvg:pxInAvg,
        gainSlip: gainNet,
        maePct: mae, mfePct: mfe, holdMin: holdMin,
        ISbps: isbpsList.length? mean(isbpsList):null,
        entryNotionalSum: notionals.length? sum(notionals):0,
        ADV20avg: advs.length? mean(advs):null,
        medExecPx: prices.length? quantile(prices,0.5):null
      });
    }

    // 以出場日計入損益
    var dailyMap = {};
    for (var t of trades){
      var d8 = String(t.tsOut).slice(0,8);
      dailyMap[d8] = (dailyMap[d8]||0) + t.gainSlip;
    }
    var days = Object.keys(dailyMap).sort();
    var pnl  = days.map(function(d){ return dailyMap[d]; });

    // Equity（每百萬）
    var equity=[], acc=0;
    for (var v of pnl){ acc+=v; equity.push(acc/BASE_CAP); }
    var rets = pnl.map(function(v){ return v/BASE_CAP; });

    if (DEBUG){
      console.log('[ETFEngine] events=',events.length,' trades=',trades.length,' days=',days.length);
      if (events.length) console.log('[ETFEngine] sample event:', events[0]);
      if (trades.length) console.log('[ETFEngine] sample trade:', trades[0]);
    }

    return {
      events:events, trades:trades, days:days, pnl:pnl, equity:equity, rets:rets, extras:extras,
      FEE_RATE:FEE_RATE, FEE_MIN:FEE_MIN, TAX_RATE:TAX_RATE
    };
  }

  /* ======================== KPI 計算 ======================== */
  function calcEtfKpis(parsed){
    var days=parsed.days, pnl=parsed.pnl, eq=parsed.equity, rets=parsed.rets, T=parsed.trades;
    var N=T.length, totalRet=sum(pnl)/BASE_CAP;

    var cover=0, cagr=null;
    if(days.length){
      var d0=ymdToDate(days[0]), d1=ymdToDate(days[days.length-1]);
      cover=Math.max(1, Math.round((d1-d0)/86400000)+1);
      if(cover>365) cagr=Math.pow(1+totalRet, 365/cover)-1;
    }

    var volAnn=std(rets)*Math.sqrt(252), dn=std(rets.filter(function(x){return x<0;}))*Math.sqrt(252);
    var md=maxDrawdown(eq), sharpe=volAnn>0? (mean(rets)*252)/volAnn : null, sortino=dn>0? (mean(rets)*252)/dn : null;
    var cal=md.mdd>0? ((cagr!=null?cagr:(mean(rets)*252))/md.mdd) : null;
    var var95=percentile(rets,5), cvar95=cvarLeftTail(rets,0.95), ui=ulcerIndex(eq);

    var wins=[], loss=[];
    for(var i=0;i<N;i++){ var g=T[i].gainSlip; if(g>0) wins.push(g); else if(g<0) loss.push(-g); }
    var winRate=N? wins.length/N : 0, pf=sum(wins)/(sum(loss)||Infinity), avgTrade=N? (sum(pnl)/N)/BASE_CAP : 0;

    var MAEs=T.map(function(t){return t.maePct;}).filter(function(x){return x!=null;});
    var MFEs=T.map(function(t){return t.mfePct;}).filter(function(x){return x!=null;});
    var ISs =T.map(function(t){return t.ISbps;}).filter(function(x){return x!=null;});
    var holds=T.map(function(t){return t.holdMin;}).filter(function(x){return x!=null;});

    // 容量（粗估）
    var parts=T.map(function(t){
      var adv=t.ADV20avg, med=t.medExecPx, notional=t.entryNotionalSum;
      return (adv && med)? (notional/(adv*med)) : null;
    }).filter(function(x){return x!=null;});

    return {
      core:{ totalReturn:totalRet, CAGR:cagr, coverDays:cover, trades:N },
      risk:{ volAnn:volAnn, MDD:md.mdd, ddDuration:md.duration, UlcerIndex:ui, Sharpe:sharpe, Sortino:sortino, Calmar:cal, VaR95:var95, CVaR95:cvar95 },
      trade:{ winRate:winRate, PF:pf, avgTrade:avgTrade, avgHoldMin:mean(holds)||0, medHoldMin:holds.length? quantile(holds,0.5):0,
              avgMAEpct:mean(MAEs)||0, avgMFEpct:mean(MFEs)||0, avgISbps:mean(ISs)||0 },
      capacity:{ avgParticipation:mean(parts)||0, p75Participation:parts.length? quantile(parts.map(function(x){return x*100;}),0.75)/100 : 0 },
      meta:{ baseCapital:BASE_CAP, firstDay:days[0]||null, lastDay:days[days.length-1]||null }
    };
  }

  /* ======================== 匯出 ======================== */
  global.ETFEngine = {
    parseEtfTxt: parseEtfTxt,
    calcEtfKpis: calcEtfKpis,
    setDebug: function(flag){ DEBUG=!!flag; },
    FEE_RATE:FEE_RATE, FEE_MIN:FEE_MIN, TAX_RATE:TAX_RATE
  };

})(window);
