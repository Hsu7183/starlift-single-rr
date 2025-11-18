// 股票｜雲端多檔分析（多檔版，沿用 KPI49 的回測與費稅邏輯）
//
// - 支援 canonical + 1031-CSV 自動轉換，mapAct / unitsThis / lotShares 與單檔版一致
// - 稅率方案（ETF/個股/自訂）＋ URL fee/min/tax/unit/slip/cap/rf
// - 每檔各自回測，計算：Total、MaxDD、PF、Sharpe、Sortino、MAR、HitRate、AnnRet、AnnVol…
// - 上方圖：選取一檔 → 顯示其每週獲利（浮動長條）＋累積獲利（折線）
// - 下方表：可排序、點列切換上方圖

(function(){
  'use strict';

  // ===== 小工具 =====
  var $ = function(s){ return document.querySelector(s); };
  var fmt2 = function(x){ return Number(x||0).toFixed(2); };
  var pct = function(v){ return (v==null || !isFinite(v)) ? '0.00%' : (v*100).toFixed(2)+'%'; };
  var fmtInt = function(n){ return Math.round(n||0).toLocaleString('zh-TW'); };
  var cls = function(v){ return v>0 ? 'p-red' : (v<0 ? 'p-green' : ''); };
  var nowStr = function(){
    var d=new Date(), p=function(n){return String(n).padStart(2,'0');};
    return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());
  };
  var clamp = function(v,lo,hi){ return Math.max(lo,Math.min(hi,v)); };
  var setText = function(sel,t){ var el=$(sel); if(el) el.textContent=t; };

  // 檔名縮短：抓 YYYYMMDD_HHMMSS → 顯示 MMDD_HHMMSS；否則原檔名
  function shortName(name){
    var base = String(name||'').split(/[\\/]/).pop().replace(/\.[^.]+$/,'');
    var m = base.match(/(\d{8})_(\d{6})/);
    if(!m) return base;
    var mmdd = m[1].slice(4,8);
    return mmdd + '_' + m[2];
  }

  // ts → Date（用在 tradesPerMonth）
  function tsToDate(ts){
    var s=String(ts||'');
    var y=s.slice(0,4), m=s.slice(4,6), d=s.slice(6,8), hh=s.slice(8,10)||'00', mm=s.slice(10,12)||'00', ss=s.slice(12,14)||'00';
    return new Date(y+'-'+m+'-'+d+'T'+hh+':'+mm+':'+ss);
  }

  // ===== URL 參數 & 稅率、費用設定 =====
  var url = new URL(location.href);
  var CFG = {
    feeRate: +(url.searchParams.get('fee') || 0.001425),
    minFee : +(url.searchParams.get('min') || 20),
    taxRate: +(url.searchParams.get('tax') || 0.003), // 預設個股 0.3%
    unit   : +(url.searchParams.get('unit')|| 1000),  // 每單位股數（如 TXT 沒有 lotShares 時使用）
    slip   : +(url.searchParams.get('slip')|| 0),     // 每股滑價
    capital: +(url.searchParams.get('cap') || 1000000),
    rf     : +(url.searchParams.get('rf')  || 0.00)
  };

  var taxScheme = $('#taxScheme');
  var taxCustom = $('#taxCustom');
  var userForcedScheme = false;

  function refreshChips(){
    setText('#feeRateChip',(CFG.feeRate*100).toFixed(4)+'%');
    setText('#taxRateChip',(CFG.taxRate*100).toFixed(3)+'%');
    setText('#minFeeChip', String(CFG.minFee));
    setText('#unitChip'  , String(CFG.unit));
    setText('#slipChip'  , String(CFG.slip));
    setText('#rfChip'    , (CFG.rf*100).toFixed(2)+'%');
  }
  refreshChips();

  // 手續費與稅：整數進位 + 最低手續費
  function fee(amount){ return Math.max(CFG.minFee, Math.ceil(amount * CFG.feeRate)); }
  function tax(amount){ return Math.max(0, Math.ceil(amount * CFG.taxRate)); }

  // ===== 解析：canonical + 1031-CSV（沿用單檔版） =====
  var CANON_RE=/^(\d{14})\.0{6}\s+(\d+\.\d{6})\s+(新買|平賣|新賣|平買|強制平倉)\s*$/;
  var CSV_RE  = /^\s*(\d{8})\s*,\s*(\d{5,6})\s*,\s*(\d+(?:\.\d+)?)\s*,\s*([^,]+)\s*,/;

  function mapAct(s){
    s = String(s||'').trim();
    if (/^(平賣|賣出)$/i.test(s)) return '平賣';
    if (/^(強制平倉|強平)$/i.test(s)) return '強制平倉';
    if (/^(新買|買進|首買|加碼|再加碼|加碼攤平|再加碼攤平|加碼\s*攤平|再加碼\s*攤平)$/i.test(s)) return '新買';
    return s;
  }

  function pad6(t){ t=String(t||''); if(t.length===5) t='0'+t; return t.slice(0,6); }

  function normalize(txt){
    return (txt||'')
      .replace(/\ufeff/gi,'')
      .replace(/[\u200B-\u200D\uFEFF]/g,'')
      .replace(/[\x00-\x09\x0B-\x1F\x7F]/g,'')
      .replace(/\r\n?/g,'\n')
      .replace(/\s*,\s*/g, ',')
      .split('\n').map(function(s){ return s.trim(); })
      .filter(function(x){ return !!x; });
  }

  function toCanon(lines){
    var out=[], i, l, m, d8, t6, px, act, row, um, lm;
    for(i=0;i<lines.length;i++){
      l=lines[i];
      m=l.match(CANON_RE);
      if(m){
        row = { ts:m[1], px:+m[2], act:m[3] };
      }else{
        m=l.match(CSV_RE);
        if(!m) continue;
        d8=m[1]; t6=pad6(m[2]); px=+m[3]; act=mapAct(m[4]);
        if(!isFinite(px) || !/^\d{6}$/.test(t6)) continue;
        row = { ts:d8+t6, px:px, act:act };
      }

      // 讀 unitsThis（1→1→2 結構）
      um = l.match(/unitsThis\s*=\s*(\d+)/);
      if(um){
        row.units = parseInt(um[1],10);
        if(!(row.units>0)) row.units = 1;
      }else{
        row.units = 1;
      }

      // 讀 lotShares → 每單位股數
      lm = l.match(/lotShares\s*=\s*(\d+)/);
      if(lm){
        row.lotShares = parseInt(lm[1],10);
        if(!(row.lotShares>0)) row.lotShares = null;
      }

      out.push(row);
    }
    out.sort(function(a,b){ return a.ts.localeCompare(b.ts); });
    return out;
  }

  // ===== 週次 key（同單檔版） =====
  function weekKey(day){
    var dt=new Date(day.slice(0,4)+'-'+day.slice(4,6)+'-'+day.slice(6,8)+'T00:00:00');
    var y=dt.getFullYear(), oneJan=new Date(y,0,1);
    var week=Math.ceil((((dt-oneJan)/86400000)+oneJan.getDay()+1)/7);
    return y+'-W'+(week<10?('0'+week):week);
  }

  // ===== Backtest（多檔共用；unitShares 作為參數，不再用全域 CFG.unit） =====
  function backtest(rows, unitShares){
    var shares=0, cash=CFG.capital, cumCost=0, pnlCum=0;
    var trades=[], weeks=new Map(), dayPnL=new Map();

    var i;
    for(i=0;i<rows.length;i++){
      var r=rows[i];

      if(r.act === '新買'){
        var lotUnits  = r.units || 1;
        var sharesInc = unitShares * lotUnits;

        var px  = r.px + CFG.slip;
        var amt = px * sharesInc;
        var f   = fee(amt);
        var cost= amt + f;

        if(cash >= cost){
          cash    -= cost;
          shares  += sharesInc;
          cumCost += cost;
          var costAvgDisp = cumCost / shares;

          trades.push({
            ts:r.ts, kind:'BUY', price:px, shares:sharesInc,
            buyAmount:amt, sellAmount:0, fee:f, tax:0,
            cost:cost, costAvgDisp:costAvgDisp, cumCost:cumCost,
            cumCostDisp:null, priceDiff:null, pnlFull:null, retPctUnit:null, cumPnlFull:pnlCum
          });
        }

      }else if(r.act === '平賣' && shares > 0){
        var spx = r.px - CFG.slip;
        var sam = spx * shares;
        var ff  = fee(sam);
        var tt  = tax(sam);
        cash   += (sam - ff - tt);

        var sellCumCostDisp = cumCost + ff + tt;
        var sellCostAvgDisp = sellCumCostDisp / shares;
        var priceDiff       = ((ff + tt) / shares);
        var pnlFull         = (sam - ff - tt) - cumCost;
        pnlCum += pnlFull;

        var day = r.ts.slice(0,8);
        dayPnL.set(day,(dayPnL.get(day)||0)+pnlFull);
        var wkKey = weekKey(day);
        weeks.set(wkKey,(weeks.get(wkKey)||0)+pnlFull);

        trades.push({
          ts:r.ts, kind:'SELL', price:spx, shares:shares,
          buyAmount:0, sellAmount:sam, fee:ff, tax:tt,
          cost:0, costAvgDisp:sellCostAvgDisp, cumCost:cumCost,
          cumCostDisp:sellCumCostDisp, priceDiff:priceDiff,
          pnlFull:pnlFull, retPctUnit: sellCumCostDisp>0 ? (pnlFull/sellCumCostDisp) : null, cumPnlFull:pnlCum
        });

        shares=0; cumCost=0;
      }
    }

    return { trades:trades, weeks:weeks, dayPnL:dayPnL, endingCash:cash, openShares:shares, pnlCum:pnlCum };
  }

  // ===== DayPnL → series =====
  function seriesFromDayPnL(dayPnL){
    var days = Array.from(dayPnL.keys()).sort();
    var pnl  = days.map(function(d){ return dayPnL.get(d)||0; });
    var eq   = [];
    var acc=0;
    for(var i=0;i<pnl.length;i++){ acc+=pnl[i]; eq.push(acc); }
    return {days:days, pnl:pnl, eq:eq};
  }

  // ===== 基本統計 & KPI（取自單檔版） =====
  function statsBasic(arr){
    var n=arr.length; if(!n) return {n:n,mean:0,std:0,min:0,max:0,skew:0,kurt:0};
    var i, mean=0; for(i=0;i<n;i++) mean+=arr[i]; mean/=n;
    var v=0; for(i=0;i<n;i++) v+=(arr[i]-mean)*(arr[i]-mean); v/=n;
    var std=Math.sqrt(v), min=Math.min.apply(null,arr), max=Math.max.apply(null,arr);
    var m3=0,m4=0; for(i=0;i<n;i++){ var d=arr[i]-mean; m3+=d*d*d; m4+=d*d*d*d; } m3/=n; m4/=n;
    var skew = std>0 ? (m3/Math.pow(std,3)) : 0; var kurt = std>0 ? (m4/Math.pow(std,4))-3 : 0;
    return {n:n,mean:mean,std:std,min:min,max:max,skew:skew,kurt:kurt};
  }
  function maxDrawdown(eq){
    var peak=eq[0]||0, mdd=0, i, dd;
    for(i=0;i<eq.length;i++){
      if(eq[i]>peak) peak=eq[i];
      dd=eq[i]-peak;
      if(dd<mdd) mdd=dd;
    }
    return {mdd:mdd};
  }
  function timeUnderwater(eq){
    var peak=eq[0]||0, cur=0, maxTU=0, totalTU=0, i, v;
    for(i=0;i<eq.length;i++){
      v=eq[i];
      if(v>=peak){
        peak=v;
        if(cur>0){ totalTU+=cur; cur=0; }
      }else{
        cur++;
        if(cur>maxTU) maxTU=cur;
      }
    }
    if(cur>0) totalTU+=cur;
    return {maxTU:maxTU,totalTU:totalTU};
  }
  function ulcerIndex(eq){
    var peak=eq[0]||0,sum=0,i;
    for(i=0;i<eq.length;i++){
      if(eq[i]>peak) peak=eq[i];
      var d=eq[i]-peak;
      sum+=d*d;
    }
    return Math.sqrt(sum/Math.max(1,eq.length));
  }
  function martin(eq){
    var ui=ulcerIndex(eq);
    var last=eq.length? eq[eq.length-1] : 0;
    return ui>0? last/ui : 0;
  }
  function downsideStd(rets){
    var n=rets.length,i,neg=[],m=0;
    for(i=0;i<n;i++){ neg.push(Math.min(0,rets[i])); }
    for(i=0;i<n;i++){ m+=neg[i]; }
    m/=n;
    var varD=0;
    for(i=0;i<n;i++){
      varD+=Math.pow(Math.min(0,rets[i])-m,2);
    }
    varD/=n;
    return Math.sqrt(varD);
  }
  function sharpe(annRet, annVol, rf){ return annVol>0 ? (annRet-rf)/annVol : 0; }
  function sortino(annRet, annDown, rf){ return annDown>0 ? (annRet-rf)/annDown : 0; }
  function calmar(annRet, mdd){ return mdd<0 ? (annRet/Math.abs(mdd)) : 0; }
  function omega(rets,thr){
    if(thr===void 0) thr=0;
    var pos=0,neg=0,i,r;
    for(i=0;i<rets.length;i++){
      r=rets[i];
      if(r>thr) pos+=r-thr;
      else neg+=thr-r;
    }
    return neg>0? pos/neg : Infinity;
  }
  function streaks(arr){
    var win=0,loss=0,maxW=0,maxL=0,i,x;
    for(i=0;i<arr.length;i++){
      x=arr[i];
      if(x>0){
        win++; loss=0; if(win>maxW) maxW=win;
      }else if(x<0){
        loss++; win=0; if(loss>maxL) maxL=loss;
      }else{
        win=0; loss=0;
      }
    }
    return {maxWinStreak:maxW,maxLossStreak:maxL};
  }

  // KPI 核心：沿用單檔版，另外補 tradesPerMonth（給多檔表格）
  function computeKPI(bt, unitShares){
    var sells = bt.trades.filter(function(x){return x.kind==='SELL';});
    var tradePnl = sells.map(function(x){return x.pnlFull||0;});

    var S = seriesFromDayPnL(bt.dayPnL);
    var days = S.days, eqIncr = S.pnl, eq = S.eq;

    var annualFactor = 252;
    var total = eq.length ? eq[eq.length-1] : 0;
    var totalReturn = CFG.capital ? total/CFG.capital : 0;

    var dailyRet = eqIncr.map(function(v){ return v/CFG.capital; });
    var R = statsBasic(dailyRet);
    var annRet = R.mean * annualFactor;
    var annVol = R.std  * Math.sqrt(annualFactor);
    var dStd   = downsideStd(dailyRet) * Math.sqrt(annualFactor);

    var mdd = maxDrawdown(eq).mdd;
    var ui  = ulcerIndex(eq);
    var sr  = sharpe(annRet, annVol, CFG.rf);
    var so  = sortino(annRet, dStd,  CFG.rf);
    var cal = calmar(annRet, mdd);
    var mar = annRet / Math.max(1,Math.abs(mdd));
    var mart= martin(eq);
    var omg = omega(dailyRet,0);

    var nTrades = sells.length;
    var hits    = sells.filter(function(s){return (s.pnlFull||0)>0;}).length;
    var hitRate = nTrades ? hits/nTrades : 0;

    var grossWin = sells.filter(function(s){return (s.pnlFull||0)>0;})
                        .reduce(function(a,b){return a+(b.pnlFull||0);},0);
    var grossLoss= sells.filter(function(s){return (s.pnlFull||0)<0;})
                        .reduce(function(a,b){return a+(b.pnlFull||0);},0);
    var pf = grossLoss<0 ? (grossWin/Math.abs(grossLoss)) : (grossWin>0?Infinity:0);

    var avgWin  = hits ? grossWin/hits : 0;
    var avgLoss = (nTrades-hits) ? Math.abs(grossLoss)/(nTrades-hits) : 0;
    var payoff  = avgLoss>0 ? avgWin/avgLoss : Infinity;
    var expectancy = nTrades ? (grossWin+grossLoss)/nTrades : 0;

    var weeklyVals = Array.from(bt.weeks.values());
    var volWeekly  = statsBasic(weeklyVals).std;
    var bestWeek   = weeklyVals.length ? Math.max.apply(null,weeklyVals) : 0;
    var worstWeek  = weeklyVals.length ? Math.min.apply(null,weeklyVals) : 0;

    var TU = timeUnderwater(eq);
    var ST = streaks(tradePnl);

    var grossBuy = bt.trades.filter(function(t){return t.kind==='BUY';})
                            .reduce(function(a,b){return a+b.price*b.shares;},0);
    var grossSell= bt.trades.filter(function(t){return t.kind==='SELL';})
                            .reduce(function(a,b){return a+b.price*b.shares;},0);
    var feeSum   = bt.trades.reduce(function(a,b){return a+(b.fee||0);},0);
    var taxSum   = bt.trades.reduce(function(a,b){return a+(b.tax||0);},0);
    var turnover = CFG.capital ? (grossBuy+grossSell)/CFG.capital : 0;
    var costRatio= (grossBuy+grossSell)>0 ? (feeSum+taxSum)/(grossBuy+grossSell) : 0;

    var avgTrade = nTrades ? tradePnl.reduce(function(a,b){return a+b;},0)/nTrades : 0;
    var medTrade = (function(){
      var s=[].concat(tradePnl).sort(function(a,b){return a-b;});
      if(!s.length) return 0;
      var m=Math.floor(s.length/2);
      return s.length%2 ? s[m] : (s[m-1]+s[m])/2;
    })();

    // Trade 分布
    var posCount = tradePnl.filter(function(x){return x>0;}).length;
    var zeroCount= tradePnl.filter(function(x){return x===0;}).length;
    var negCount = tradePnl.filter(function(x){return x<0;}).length;
    var posRatio = nTrades ? posCount/nTrades : 0;
    var negRatio = nTrades ? negCount/nTrades : 0;
    var pnlStd   = statsBasic(tradePnl).std;

    // 交易頻率（SELL 筆數／月）
    var tradesPerMonth = 0;
    if(sells.length>1){
      var firstTs = sells[0].ts;
      var lastTs  = sells[sells.length-1].ts;
      var msDiff = tsToDate(lastTs) - tsToDate(firstTs);
      var months = msDiff / (1000*60*60*24*30.4);
      if(months <= 0) months = 1/30.4;
      tradesPerMonth = sells.length / months;
    }

    return {
      total:total,
      totalReturn:totalReturn,
      annRet:annRet,
      annVol:annVol,
      bestWeek:bestWeek,
      worstWeek:worstWeek,
      avgTrade:avgTrade,
      medTrade:medTrade,
      payoff:payoff,
      mdd:mdd,
      dStd:dStd,
      ui:ui,
      mart:mart,
      volWeekly:volWeekly,
      min:R.min,
      max:R.max,
      std:R.std,
      sr:sr,
      so:so,
      cal:cal,
      mar:mar,
      pf:pf,
      expectancy:expectancy,
      hitRate:hitRate,
      avgWin:avgWin,
      avgLoss:avgLoss,
      maxTU:TU.maxTU,
      totalTU:TU.totalTU,
      maxWinStreak:ST.maxWinStreak,
      maxLossStreak:ST.maxLossStreak,
      skew:R.skew,
      kurt:R.kurt,
      days:days.length,
      grossBuy:grossBuy,
      grossSell:grossSell,
      feeSum:feeSum,
      taxSum:taxSum,
      turnover:turnover,
      costRatio:costRatio,
      totalExecs:bt.trades.length,
      unitShares:unitShares,
      tradeCount:nTrades,
      posCount:posCount,
      zeroCount:zeroCount,
      negCount:negCount,
      posRatio:posRatio,
      negRatio:negRatio,
      omega:omg,
      pnlStd:pnlStd,
      tradesPerMonth:tradesPerMonth
    };
  }

  // ===== 多檔狀態 =====
  var rows = [];          // 每檔的彙總紀錄（給表格與圖用）
  var currentIdx = -1;    // 目前選取 index
  var chart = null;
  var allSources = [];    // [{name,text}, ...] 方便調整稅率時重算

  // ===== 圖表：每週獲利（浮動長條）＋累積獲利（折線） =====
  function drawChartFor(rec){
    var ctx = $('#chart');
    if(!ctx || !rec) return;
    if(chart){ chart.destroy(); chart=null; }

    var weeks = rec.weeks;
    var labels = Array.from(weeks.keys());
    var weekly = labels.map(function(k){ return weeks.get(k)||0; });

    var cum=[], s=0, floatBars=[], p=0, i;
    for(i=0;i<weekly.length;i++){
      s+=weekly[i];
      cum.push(s);
      floatBars.push([p, s]);
      p=s;
    }

    chart = new Chart(ctx,{
      data:{
        labels:labels,
        datasets:[
          {
            type:'bar',
            label:'每週獲利（浮動長條）',
            data:floatBars,
            borderWidth:1,
            backgroundColor:'rgba(13,110,253,0.30)',
            borderColor:'#0d6efd'
          },
          {
            type:'line',
            label:'累積淨利',
            data:cum,
            borderWidth:2,
            borderColor:'#f43f5e',
            tension:0.2,
            pointRadius:0
          }
        ]
      },
      options:{
        responsive:true,
        maintainAspectRatio:false,
        plugins:{ legend:{display:true} },
        scales:{
          y:{
            suggestedMin:Math.min(0, Math.min.apply(null, cum.concat([0]))*1.1),
            suggestedMax:Math.max(1, Math.max.apply(null, cum.concat([0]))*1.05)
          },
          x:{ ticks:{ maxTicksLimit:12 } }
        }
      }
    });

    $('#chartCaption').textContent =
      '目前：' + rec.shortName +
      '｜Total=' + fmtInt(rec.total) +
      '，MaxDD=' + fmtInt(rec.maxDDAbs) +
      '，PF=' + fmt2(rec.pf);
  }

  // ===== 表格渲染與排序 =====
  function renderTable(){
    var tb = $('#sumTable tbody');
    if(!tb) return;
    var html='', i, r, pnlCls;
    for(i=0;i<rows.length;i++){
      r = rows[i];
      pnlCls = cls(r.total);
      html += '<tr data-idx="'+i+'" class="'+(i===currentIdx?'active-row':'')+'">'
           +  '<td>'+r.shortName+'</td>'
           +  '<td class="num">'+r.tradeCount+'</td>'
           +  '<td class="num">'+pct(r.hitRate)+'</td>'
           +  '<td class="num '+pnlCls+'">'+fmtInt(r.total)+'</td>'
           +  '<td class="num">-'+fmtInt(r.maxDDAbs)+'</td>'
           +  '<td class="num">'+fmt2(r.pf)+'</td>'
           +  '<td class="num">'+fmt2(r.sr)+'</td>'
           +  '<td class="num">'+fmt2(r.so)+'</td>'
           +  '<td class="num">'+fmt2(r.mar)+'</td>'
           +  '<td class="num">'+fmt2(r.tradesPerMonth)+'</td>'
           +  '<td class="num">'+pct(r.annRet)+'</td>'
           +  '<td class="num">'+pct(r.annVol)+'</td>'
           +  '</tr>';
    }
    tb.innerHTML = html;

    // 綁定 click
    var trs = tb.querySelectorAll('tr');
    for(i=0;i<trs.length;i++){
      (function(idx){
        trs[i].onclick = function(){
          selectRow(idx);
        };
      })(i);
    }
  }

  function selectRow(idx){
    currentIdx = idx;
    renderTable();
    drawChartFor(rows[idx]);
  }

  function bindSort(){
    var ths = $('#sumTable thead').querySelectorAll('th');
    var i;
    for(i=0;i<ths.length;i++){
      (function(th){
        th.onclick = function(){
          var k = th.getAttribute('data-k');
          if(!k) return;
          var asc = th.getAttribute('data-asc') !== '1';
          rows.sort(function(a,b){
            if(k === 'shortName'){
              return asc ? a.shortName.localeCompare(b.shortName)
                         : b.shortName.localeCompare(a.shortName);
            }
            var x = Number(a[k]||0), y = Number(b[k]||0);
            return asc ? (x-y) : (y-x);
          });
          th.setAttribute('data-asc', asc ? '1' : '0');
          // 維持原選取（依 id 尋找）
          if(currentIdx>=0){
            var curId = rows[currentIdx].__id;
            var newIdx = -1, j;
            for(j=0;j<rows.length;j++){
              if(rows[j].__id === curId){ newIdx=j; break; }
            }
            currentIdx = newIdx;
          }
          renderTable();
        };
      })(ths[i]);
    }
  }

  // ===== 稅率方案自動偵測（與單檔概念相同） =====
  function autoPickSchemeByContent(sourceName, txt){
    if(userForcedScheme) return;
    var s=(sourceName||'')+' '+(txt||'');
    var isETF   = /(?:^|[^0-9])(?:00909|00910|0050)(?:[^0-9]|$)/.test(s);
    var isStock = /(?:^|[^0-9])(?:2603)(?:[^0-9]|$)|長榮/.test(s);

    if(isETF && !isStock){
      taxScheme.value='ETF'; CFG.taxRate=0.001; taxCustom.disabled=true;
    }else if(isStock && !isETF){
      taxScheme.value='STOCK'; CFG.taxRate=0.003; taxCustom.disabled=true;
    }else{
      if(CFG.taxRate===0.001){ taxScheme.value='ETF';   taxCustom.disabled=true; }
      else if(CFG.taxRate===0.003){ taxScheme.value='STOCK'; taxCustom.disabled=true; }
      else{ taxScheme.value='CUSTOM'; taxCustom.disabled=false; taxCustom.value=CFG.taxRate.toFixed(4); }
    }
    refreshChips();
  }

  // ===== 主處理：多檔 TXT → rows =====
  function handleTexts(nameTextPairs){
    allSources = nameTextPairs.slice(); // 存起來，方便之後重算
    rows = [];
    currentIdx = -1;

    var i;
    for(i=0;i<nameTextPairs.length;i++){
      var src = nameTextPairs[i];
      var lines = normalize(src.text);
      if(!lines.length) continue;

      autoPickSchemeByContent(src.name, src.text);

      var canon = toCanon(lines);

      // 依檔案內的 lotShares 覆蓋 unitShares（每檔自己的）
      var j, unitShares = CFG.unit;
      for(j=0;j<canon.length;j++){
        if(canon[j].lotShares && canon[j].lotShares>0){
          unitShares = canon[j].lotShares;
          break;
        }
      }

      var bt = backtest(canon, unitShares);
      var k  = computeKPI(bt, unitShares);

      // 把 weekly Map 留在 rec 裡，給圖用
      rows.push({
        __id: Math.random().toString(36).slice(2),
        name: src.name,
        shortName: shortName(src.name),
        weeks: bt.weeks,
        // 彙總指標：
        tradeCount: k.tradeCount,
        hitRate:    k.hitRate,
        total:      k.total,
        maxDDAbs:   Math.abs(k.mdd||0),
        pf:         isFinite(k.pf)?k.pf:0,
        sr:         k.sr,
        so:         k.so,
        mar:        k.mar,
        tradesPerMonth: k.tradesPerMonth,
        annRet:     k.annRet,
        annVol:     k.annVol
      });
    }

    if(rows.length){
      selectRow(0);
    }else{
      renderTable();
      if(chart){ chart.destroy(); chart=null; }
      $('#chartCaption').textContent = '尚未載入檔案。';
    }

    $('#fileCount').textContent = String(rows.length);
    $('#importAt').textContent  = nowStr();
    bindSort();
  }

  // ===== 事件：剪貼簿、多檔選擇、稅率切換 =====
  var btnClip = $('#btn-clip');
  var filesInp= $('#files');

  if(btnClip){
    btnClip.addEventListener('click', function(){
      if(!navigator.clipboard || !navigator.clipboard.readText){
        alert('瀏覽器不支援剪貼簿 API，請改用「選擇檔案」。');
        return;
      }
      navigator.clipboard.readText().then(function(txt){
        if(!txt){ alert('剪貼簿沒有文字'); return; }
        // 多份 TXT 用「------」分隔
        var parts = txt.split(/\n-{5,}\n/);
        var pairs = [];
        for(var i=0;i<parts.length;i++){
          var t = parts[i].trim();
          if(t) pairs.push({name:'CLIP_'+(i+1)+'.txt', text:t});
        }
        if(!pairs.length){ alert('剪貼簿內容無法解析，請確認格式。'); return; }
        handleTexts(pairs);
      }).catch(function(){
        alert('無法讀取剪貼簿內容，請改用「選擇檔案」。');
      });
    });
  }

  if(filesInp){
    filesInp.addEventListener('change', function(e){
      var fs = e.target.files || [];
      if(!fs.length) return;
      var pending = fs.length;
      var pairs = [];

      var readOne = function(f){
        var reader = new FileReader();
        reader.onload = function(){
          pairs.push({name:f.name, text:reader.result||''});
          pending--;
          if(pending===0){
            handleTexts(pairs);
          }
        };
        reader.readAsText(f); // 這裡直接用瀏覽器判斷編碼；如果要多編碼偵測可再強化
      };

      for(var i=0;i<fs.length;i++){
        readOne(fs[i]);
      }
    });
  }

  if(taxScheme){
    taxScheme.addEventListener('change', function(){
      userForcedScheme = true;
      if(taxScheme.value === 'ETF'){
        CFG.taxRate = 0.001; taxCustom.disabled = true;
      }else if(taxScheme.value === 'STOCK'){
        CFG.taxRate = 0.003; taxCustom.disabled = true;
      }else{
        taxCustom.disabled = false;
        var v=parseFloat(taxCustom.value);
        if(isFinite(v)) CFG.taxRate = clamp(v,0,1);
      }
      refreshChips();
      if(allSources.length) handleTexts(allSources);
    });
  }

  if(taxCustom){
    taxCustom.addEventListener('input', function(){
      if(taxScheme.value!=='CUSTOM') return;
      var v=parseFloat(taxCustom.value);
      if(isFinite(v)){
        CFG.taxRate = clamp(v,0,1);
        refreshChips();
        if(allSources.length) handleTexts(allSources);
      }
    });
  }

})();
