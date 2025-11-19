// 股票｜雲端多檔分析（指標 TXT 版） - 多檔 KPI + Score 儀表板版
// - 解析每檔 TXT 中含「稅後損益=」「累積損益=」的行（賣出）
// - Summary（表格）：
//   * Score：依 PF / MAR / MaxDD / Sharpe / Sortino / Expectancy / Payoff / HitRate / TradesPerMonth 綜合評分（0–100）
//   * PF / MAR / MaxDD / Total / Sharpe / Sortino / 期望值 / Payoff / 勝率 / 月筆數 / 年化報酬 / 年化波動 / 筆數
// - 詳細 KPI（下方文字）：
//   * 月勝率 / Ulcer Index / Recovery Days / Cost 結構等
// - 上方圖：每週稅後損益（浮動長條）＋累積稅後損益（折線）

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
  var setText = function(sel,t){ var el=$(sel); if(el) el.textContent=t; };

  function shortName(name){
    var base = String(name||'').split(/[\\/]/).pop().replace(/\.[^.]+$/,'');
    var m = base.match(/(\d{8})_(\d{6})/);
    if(!m) return base;
    var mmdd = m[1].slice(4,8);
    return mmdd + '_' + m[2];
  }

  function tsToDate(ts){
    var s=String(ts||'');
    var y=s.slice(0,4), m=s.slice(4,6), d=s.slice(6,8), hh=s.slice(8,10)||'00', mm=s.slice(10,12)||'00', ss=s.slice(12,14)||'00';
    return new Date(y+'-'+m+'-'+d+'T'+hh+':'+mm+':'+ss);
  }

  // ===== URL & 參數（capital / rf 會影響年化計算） =====
  var url = new URL(location.href);
  var CFG = {
    feeRate: +(url.searchParams.get('fee') || 0.001425),
    minFee : +(url.searchParams.get('min') || 20),
    // ✅ 交易稅預設固定為 0.1%（0.001）
    taxRate: +(url.searchParams.get('tax') || 0.001),
    unit   : +(url.searchParams.get('unit')|| 1000),
    slip   : +(url.searchParams.get('slip')|| 0),
    capital: +(url.searchParams.get('cap') || 1000000),
    rf     : +(url.searchParams.get('rf')  || 0.00)
  };

  function refreshChips(){
    setText('#feeRateChip',(CFG.feeRate*100).toFixed(4)+'%');
    setText('#taxRateChip',(CFG.taxRate*100).toFixed(3)+'%');
    setText('#minFeeChip', String(CFG.minFee));
    setText('#unitChip'  , String(CFG.unit));
  }
  refreshChips();

  // ===== 多編碼解碼（UTF-8 / Big5 / GB18030 / UTF-16） =====
  function decodeBest(ab){
    var encs = ['utf-8','big5','gb18030','utf-16le','utf-16be'];
    var best = { txt:'', bad:1e9, enc:'' };
    for(var i=0;i<encs.length;i++){
      try{
        var txt = new TextDecoder(encs[i], {fatal:false}).decode(ab);
        var bad = (txt.match(/\uFFFD/g)||[]).length;
        if(bad < best.bad){
          best = { txt:txt, bad:bad, enc:encs[i] };
          if(bad === 0) break;
        }
      }catch(e){}
    }
    return best;
  }

  function normalize(txt){
    return (txt||'')
      .replace(/\ufeff/gi,'')
      .replace(/[\u200B-\u200D\uFEFF]/g,'')
      .replace(/[\x00-\x09\x0B-\x1F\x7F]/g,'')
      .replace(/\r\n?/g,'\n')
      .split('\n').map(function(s){ return s.trim(); })
      .filter(function(x){ return !!x; });
  }

  // 行首：日期,時間,...
  var ROW_RE  = /^\s*(\d{8})\s*,\s*(\d{5,6})\s*,/;
  var PNL_RE  = /稅後損益\s*=\s*(-?\d+)/;
  var CUM_RE  = /累積損益\s*=\s*(-?\d+)/;

  function pad6(t){ t=String(t||''); if(t.length===5) t='0'+t; return t.slice(0,6); }

  function weekKey(day){
    var dt=new Date(day.slice(0,4)+'-'+day.slice(4,6)+'-'+day.slice(6,8)+'T00:00:00');
    var y=dt.getFullYear(), oneJan=new Date(y,0,1);
    var week=Math.ceil((((dt-oneJan)/86400000)+oneJan.getDay()+1)/7);
    return y+'-W'+(week<10?('0'+week):week);
  }

  // ===== 統計工具 =====
  function seriesFromDayPnL(dayPnL){
    var days = Array.from(dayPnL.keys()).sort();
    var pnl  = days.map(function(d){ return dayPnL.get(d)||0; });
    var eq   = [];
    var acc=0;
    for(var i=0;i<pnl.length;i++){ acc+=pnl[i]; eq.push(acc); }
    return {days:days, pnl:pnl, eq:eq};
  }

  function statsBasic(arr){
    var n=arr.length; if(!n) return {n:n,mean:0,std:0,min:0,max:0};
    var i, mean=0; for(i=0;i<n;i++) mean+=arr[i]; mean/=n;
    var v=0; for(i=0;i<n;i++) v+=(arr[i]-mean)*(arr[i]-mean); v/=n;
    var std=Math.sqrt(v), min=Math.min.apply(null,arr), max=Math.max.apply(null,arr);
    return {n:n,mean:mean,std:std,min:min,max:max};
  }

  function maxDrawdown(eq){
    if(!eq.length) return {mdd:0};
    var peak=eq[0]||0, mdd=0, i, dd;
    for(i=0;i<eq.length;i++){
      if(eq[i]>peak) peak=eq[i];
      dd=eq[i]-peak;
      if(dd<mdd) mdd=dd;
    }
    return {mdd:mdd};
  }

  // Ulcer Index（%）
  function ulcerIndex(eq){
    var n=eq.length;
    if(!n) return 0;
    var maxEq = eq[0];
    var sumSq = 0;
    var i, dd;
    for(i=0;i<n;i++){
      if(eq[i]>maxEq) maxEq = eq[i];
      if(maxEq === 0){
        dd = 0;
      }else{
        dd = ((eq[i]-maxEq)/maxEq)*100; // drawdown %
      }
      if(dd < 0){
        sumSq += dd*dd;
      }
    }
    return Math.sqrt(sumSq/n);
  }

  // Recovery Days：從最大回撤點回到前高所需「天數」（以日績效序列）
  function recoveryDays(eq){
    var n = eq.length;
    if(!n) return 0;
    var i, peak = eq[0], peakIdx = 0;
    var mdd = 0, mddIdx = -1;

    for(i=0;i<n;i++){
      if(eq[i] > peak){
        peak = eq[i];
        peakIdx = i;
      }
      var dd = eq[i] - peak;
      if(dd < mdd){
        mdd = dd;
        mddIdx = i;
      }
    }
    if(mddIdx < 0) return 0;

    for(i=mddIdx+1;i<n;i++){
      if(eq[i] >= peak) return i - mddIdx;
    }
    return n - mddIdx - 1;
  }

  function downsideStd(rets){
    var n=rets.length,i,neg=[],m=0;
    if(!n) return 0;
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

  // ===== 解析單檔 TXT：只抓有稅後損益 / 累積損益的行 =====
  function parseFile(text){
    var lines = normalize(text);
    var trades = [];      // {ts,date,pnl,cum}
    var dayPnL = new Map();
    var weeks  = new Map();

    var lastCum = 0;

    for(var i=0;i<lines.length;i++){
      var l = lines[i];
      var m = ROW_RE.exec(l);
      if(!m) continue;

      var date = m[1];
      var time = pad6(m[2]);

      var pnlMatch = PNL_RE.exec(l);
      if(!pnlMatch) continue;

      var cumMatch = CUM_RE.exec(l);

      var pnl = parseInt(pnlMatch[1],10);
      var cum = cumMatch ? parseInt(cumMatch[1],10) : (lastCum + pnl);
      lastCum = cum;

      var ts = date + time;
      trades.push({ ts:ts, date:date, pnl:pnl, cum:cum });

      dayPnL.set(date, (dayPnL.get(date)||0) + pnl);
      var wKey = weekKey(date);
      weeks.set(wKey, (weeks.get(wKey)||0) + pnl);
    }

    return { trades:trades, dayPnL:dayPnL, weeks:weeks };
  }

  // ===== 用 TXT 損益算 KPI =====
  function computeKPI(dayPnL, trades){
    var S = seriesFromDayPnL(dayPnL);
    var eqIncr = S.pnl;
    var eq     = S.eq;

    var annualFactor = 252;
    var total = eq.length ? eq[eq.length-1] : 0;
    var totalReturn = CFG.capital ? total/CFG.capital : 0;

    var dailyRet = eqIncr.map(function(v){ return v/CFG.capital; });
    var R = statsBasic(dailyRet);
    var annRet = R.mean * annualFactor;
    var annVol = R.std  * Math.sqrt(annualFactor);
    var dStd   = downsideStd(dailyRet) * Math.sqrt(annualFactor);

    var mddTrades = maxDrawdown(trades.map(function(t){return t.cum;})).mdd;
    var sr  = sharpe(annRet, annVol, CFG.rf);
    var so  = sortino(annRet, dStd,  CFG.rf);
    var mar = annRet / Math.max(1,Math.abs(mddTrades));

    var nTrades = trades.length;
    var hits = trades.filter(function(t){return t.pnl>0;}).length;
    var hitRate = nTrades ? hits/nTrades : 0;

    var posPnL = trades.filter(function(t){return t.pnl>0;})
                       .reduce(function(a,b){return a+b.pnl;},0);
    var negPnL = trades.filter(function(t){return t.pnl<0;})
                       .reduce(function(a,b){return a+b.pnl;},0);
    var pf = negPnL<0 ? (posPnL/Math.abs(negPnL)) : (posPnL>0?Infinity:0);

    var expectancy = nTrades ? total/nTrades : 0;

    var avgWin = 0, avgLoss = 0, payoff = 0;
    if(hits>0) avgWin = posPnL / hits;
    var lossTrades = trades.filter(function(t){return t.pnl<0;});
    var lossCount = lossTrades.length;
    if(lossCount>0) avgLoss = Math.abs(negPnL) / lossCount;
    if(avgLoss>0) payoff = avgWin / avgLoss;

    var tradesPerMonth = 0;
    if(nTrades>1){
      var firstTs = trades[0].ts;
      var lastTs  = trades[nTrades-1].ts;
      var msDiff = tsToDate(lastTs) - tsToDate(firstTs);
      var months = msDiff / (1000*60*60*24*30.4);
      if(months <= 0) months = 1/30.4;
      tradesPerMonth = nTrades/months;
    }

    // 月度績效（穩定度）
    var monthMap = new Map();
    dayPnL.forEach(function(v,day){
      var mKey = day.slice(0,6); // YYYYMM
      monthMap.set(mKey, (monthMap.get(mKey)||0) + v);
    });
    var monthKeys = Array.from(monthMap.keys()).sort();
    var monthPnL = monthKeys.map(function(k){ return monthMap.get(k)||0; });
    var M = statsBasic(monthPnL);
    var posM = monthPnL.filter(function(x){return x>0;}).length;
    var monthHit = monthKeys.length ? posM/monthKeys.length : 0;

    var ui  = ulcerIndex(eq);
    var rec = recoveryDays(eq);

    return {
      total: total,
      totalReturn: totalReturn,
      annRet: annRet,
      annVol: annVol,
      sr: sr,
      so: so,
      mar: mar,
      hitRate: hitRate,
      pf: pf,
      expectancy: expectancy,
      payoff: payoff,
      tradesPerMonth: tradesPerMonth,
      maxDDAbs: Math.abs(mddTrades||0),
      ulcer: ui,
      recoveryDays: rec,
      monthHit: monthHit,
      monthStd: M.std
    };
  }

  // ===== 多檔狀態 =====
  var rows = [];
  var currentIdx = -1;
  var chart = null;

  // ===== Score 計算（依重要性加權） =====
  function computeScores(){
    if(rows.length === 0) return;

    var keysPos = ['pf','mar','total','sr','so','expectancy','payoff','hitRate','tradesPerMonth'];
    var keysNeg = ['maxDDAbs']; // 越小越好

    var stats = {};
    var i, k, v;

    for(i=0;i<keysPos.length;i++){
      k = keysPos[i];
      var minP = Infinity, maxP = -Infinity;
      rows.forEach(function(r){
        var val = Number(r[k]||0);
        if(!isFinite(val)) val = 0;
        if(val < minP) minP = val;
        if(val > maxP) maxP = val;
      });
      stats[k] = {min:minP, max:maxP};
    }

    for(i=0;i<keysNeg.length;i++){
      k = keysNeg[i];
      var minN = Infinity, maxN = -Infinity;
      rows.forEach(function(r){
        var val = Number(r[k]||0);
        if(!isFinite(val)) val = 0;
        if(val < minN) minN = val;
        if(val > maxN) maxN = val;
      });
      stats[k] = {min:minN, max:maxN};
    }

    function normPos(val, key){
      var s = stats[key];
      if(!s || !isFinite(val)) return 0.5;
      if(s.max === s.min) return 0.5;
      return Math.max(0, Math.min(1, (val - s.min) / (s.max - s.min)));
    }

    function normNeg(val, key){
      var s = stats[key];
      if(!s || !isFinite(val)) return 0.5;
      if(s.max === s.min) return 0.5;
      // 越小越好：反過來
      return Math.max(0, Math.min(1, (s.max - val) / (s.max - s.min)));
    }

    // 權重依你之前的重要性排序設計（總和約 = 1）
    var W = {
      pf:           0.20,
      mar:          0.18,
      maxDDAbs:     0.15,
      total:        0.12,
      sr:           0.10,
      so:           0.08,
      expectancy:   0.07,
      payoff:       0.04,
      hitRate:      0.03,
      tradesPerMonth:0.03
    };

    rows.forEach(function(r){
      var score = 0;

      score += W.pf           * normPos(Number(r.pf||0),           'pf');
      score += W.mar          * normPos(Number(r.mar||0),          'mar');
      score += W.maxDDAbs     * normNeg(Number(r.maxDDAbs||0),     'maxDDAbs');
      score += W.total        * normPos(Number(r.total||0),        'total');
      score += W.sr           * normPos(Number(r.sr||0),           'sr');
      score += W.so           * normPos(Number(r.so||0),           'so');
      score += W.expectancy   * normPos(Number(r.expectancy||0),   'expectancy');
      score += W.payoff       * normPos(Number(r.payoff||0),       'payoff');
      score += W.hitRate      * normPos(Number(r.hitRate||0),      'hitRate');
      score += W.tradesPerMonth*normPos(Number(r.tradesPerMonth||0),'tradesPerMonth');

      r.score = score * 100; // 0–100
    });
  }

  // ===== 圖表 =====
  function drawChartFor(rec){
    var ctx = $('#chart');
    if(!ctx || !rec) return;
    if(chart){ chart.destroy(); chart=null; }

    var weeks = rec.weeks;
    var labels = Array.from(weeks.keys());
    var weekly = labels.map(function(k){ return weeks.get(k)||0; });

    var cum=[], s=0, floatBars=[], p=0;
    var i;
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
        plugins:{ legend:{display:true } },
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
      '｜Total(累積損益)=' + fmtInt(rec.total) +
      '｜PF=' + fmt2(rec.pf) +
      '｜Sharpe=' + fmt2(rec.sr);
  }

  // ===== 詳細 KPI 區塊 =====
  function renderDetail(rec){
    var box = $('#kpiDetail');
    var nameEl = $('#kpiName');
    var bodyEl = $('#kpiBody');
    if(!box || !nameEl || !bodyEl || !rec) return;

    box.style.display = 'block';
    nameEl.textContent = rec.shortName + ' 的詳細 KPI';

    var html = ''
      + 'Score：' + fmt2(rec.score) 
      + '｜總淨利：' + fmtInt(rec.total)
      + '｜MaxDD：' + fmtInt(rec.maxDDAbs)
      + '｜交易筆數：' + rec.tradeCount + '<br>'
      + '年化報酬：' + pct(rec.annRet)
      + '｜年化波動：' + pct(rec.annVol)
      + '｜Sharpe：' + fmt2(rec.sr)
      + '｜Sortino：' + fmt2(rec.so)
      + '｜MAR：' + fmt2(rec.mar) + '<br>'
      + '勝率：' + pct(rec.hitRate)
      + '｜PF：' + fmt2(rec.pf)
      + '｜期望值(每筆)：' + fmt2(rec.expectancy)
      + '｜Payoff：' + fmt2(rec.payoff) + '<br>'
      + '月度勝率：' + pct(rec.monthHit)
      + '｜Ulcer Index：' + fmt2(rec.ulcer)
      + '｜Recovery Days：' + fmtInt(rec.recoveryDays);

    bodyEl.innerHTML = html;
  }

  // ===== 最佳參數卡片 =====
  function renderBestCard(){
    var card = $('#bestCard');
    var main = $('#bestMain');
    var sub  = $('#bestSub');
    if(!card || !main || !sub) return;

    if(!rows.length){
      card.style.display = 'none';
      return;
    }

    var best = rows[0];
    var i;
    for(i=1;i<rows.length;i++){
      if(Number(rows[i].score||0) > Number(best.score||0)){
        best = rows[i];
      }
    }

    card.style.display = 'block';
    main.innerHTML =
      best.shortName +
      '｜Score：<strong>' + fmt2(best.score) + '</strong>' +
      '｜PF：' + fmt2(best.pf) +
      '｜MAR：' + fmt2(best.mar) +
      '｜MaxDD：' + fmtInt(best.maxDDAbs) +
      '｜總淨利：' + fmtInt(best.total);

    sub.innerHTML =
      'Sharpe：' + fmt2(best.sr) +
      '｜Sortino：' + fmt2(best.so) +
      '｜期望值/筆：' + fmt2(best.expectancy) +
      '｜Payoff：' + fmt2(best.payoff) +
      '｜勝率：' + pct(best.hitRate) +
      '｜交易頻率（月）：' + fmt2(best.tradesPerMonth);
  }

  // ===== 表格渲染 & 排序 =====
  function renderTable(){
    var tb = $('#sumTable tbody');
    if(!tb) return;
    var html='', i, r, pnlCls;
    for(i=0;i<rows.length;i++){
      r = rows[i];
      pnlCls = cls(r.total);
      html += '<tr data-idx="'+i+'" class="'+(i===currentIdx?'active-row':'')+'">'
           +  '<td>'+r.shortName+'</td>'
           +  '<td class="num">'+fmt2(r.score)+'</td>'
           +  '<td class="num">'+fmt2(r.pf)+'</td>'
           +  '<td class="num">'+fmt2(r.mar)+'</td>'
           +  '<td class="num">'+fmtInt(r.maxDDAbs)+'</td>'
           +  '<td class="num '+pnlCls+'">'+fmtInt(r.total)+'</td>'
           +  '<td class="num">'+fmt2(r.sr)+'</td>'
           +  '<td class="num">'+fmt2(r.so)+'</td>'
           +  '<td class="num">'+fmt2(r.expectancy)+'</td>'
           +  '<td class="num">'+fmt2(r.payoff)+'</td>'
           +  '<td class="num">'+pct(r.hitRate)+'</td>'
           +  '<td class="num">'+fmt2(r.tradesPerMonth)+'</td>'
           +  '<td class="num">'+pct(r.annRet)+'</td>'
           +  '<td class="num">'+pct(r.annVol)+'</td>'
           +  '<td class="num">'+r.tradeCount+'</td>'
           +  '</tr>';
    }
    tb.innerHTML = html;

    var trs = tb.querySelectorAll('tr');
    for(i=0;i<trs.length;i++){
      (function(idx){
        trs[idx].onclick = function(){ selectRow(idx); };
      })(i);
    }
  }

  function selectRow(idx){
    currentIdx = idx;
    renderTable();
    drawChartFor(rows[idx]);
    renderDetail(rows[idx]);
  }

  function bindSort(){
    var thead = $('#sumTable thead');
    if(!thead) return;
    var ths = thead.querySelectorAll('th');
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
          if(currentIdx>=0){
            var curId = rows[currentIdx].__id;
            var newIdx = -1;
            var j;
            for(j=0;j<rows.length;j++){
              if(rows[j].__id === curId){ newIdx=j; break; }
            }
            currentIdx = newIdx;
          }
          renderTable();
          // 排序不影響最佳參數卡（Score 是全域 best）
        };
      })(ths[i]);
    }
  }

  // ===== 主流程：多檔 TXT → rows =====
  function handleTexts(nameTextPairs){
    rows = [];
    currentIdx = -1;

    var i;
    for(i=0;i<nameTextPairs.length;i++){
      var src = nameTextPairs[i];
      var parsed = parseFile(src.text);

      var rec;
      if(parsed.trades.length){
        var kpi = computeKPI(parsed.dayPnL, parsed.trades);
        rec = {
          __id: Math.random().toString(36).slice(2),
          name: src.name,
          shortName: shortName(src.name),
          weeks: parsed.weeks,
          tradeCount: parsed.trades.length,
          hitRate:    kpi.hitRate,
          total:      kpi.total,
          sr:         kpi.sr,
          so:         kpi.so,
          pf:         kpi.pf,
          mar:        kpi.mar,
          tradesPerMonth: kpi.tradesPerMonth,
          annRet:     kpi.annRet,
          annVol:     kpi.annVol,
          maxDDAbs:   kpi.maxDDAbs,
          expectancy: kpi.expectancy,
          payoff:     kpi.payoff,
          ulcer:      kpi.ulcer,
          recoveryDays: kpi.recoveryDays,
          monthHit:   kpi.monthHit,
          score:      0
        };
      }else{
        // 🔎 解析不到稅後損益也要顯示一列，方便 debug
        rec = {
          __id: Math.random().toString(36).slice(2),
          name: src.name,
          shortName: shortName(src.name),
          weeks: new Map(),
          tradeCount: 0,
          hitRate: 0,
          total: 0,
          sr: 0,
          so: 0,
          pf: 0,
          mar: 0,
          tradesPerMonth: 0,
          annRet: 0,
          annVol: 0,
          maxDDAbs: 0,
          expectancy: 0,
          payoff: 0,
          ulcer: 0,
          recoveryDays: 0,
          monthHit: 0,
          score: 0
        };
      }
      rows.push(rec);
    }

    if(rows.length){
      // 先計算 Score，再依 Score 排序（由高到低）
      computeScores();
      rows.sort(function(a,b){ return (b.score||0) - (a.score||0); });
      selectRow(0);
      renderBestCard();
    }else{
      renderTable();
      if(chart){ chart.destroy(); chart=null; }
      $('#chartCaption').textContent = '尚未載入檔案或找不到「稅後損益=」資料行。';
      var box = $('#kpiDetail');
      if(box) box.style.display = 'none';
      var card = $('#bestCard');
      if(card) card.style.display = 'none';
    }

    $('#fileCount').textContent = String(rows.length);
    $('#importAt').textContent  = nowStr();
    bindSort();
  }

  // ===== 檔案載入事件（只保留「選擇檔案」） =====
  var filesInp= $('#files');

  if(filesInp){
    filesInp.addEventListener('change', function(e){
      var fs = e.target.files || [];
      if(!fs.length) return;
      var pending = fs.length;
      var pairs = [];

      function readOne(f){
        f.arrayBuffer().then(function(ab){
          var best = decodeBest(ab);
          pairs.push({name:f.name, text:best.txt});
          pending--;
          if(pending===0){
            handleTexts(pairs);
          }
        }).catch(function(){
          pending--;
        });
      }

      var i;
      for(i=0;i<fs.length;i++){
        readOne(fs[i]);
      }
    });
  }

})();
