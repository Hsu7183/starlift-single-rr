// 股票｜雲端單檔分析（KPI49，tw-1031 版型，ES5 相容）
(function(){
  'use strict';

  // ===== 工具 =====
  var $ = function(s){ return document.querySelector(s); };
  var fmtInt = function(n){ return Math.round(n||0).toLocaleString(); };
  var pct = function(v){ return (v==null||!isFinite(v)) ? '—' : (v*100).toFixed(2)+'%'; };
  var setText = function(sel, t){ var el=$(sel); if(el) el.textContent=t; };

  // ===== URL 參數 =====
  var url = new URL(location.href);
  var CFG = {
    feeRate: +(url.searchParams.get('fee') || 0.001425),
    minFee : +(url.searchParams.get('min') || 20),
    taxRate: +(url.searchParams.get('tax') || 0.003),
    unit   : +(url.searchParams.get('unit')|| 1000),
    slip   : +(url.searchParams.get('slip')|| 0),
    capital: +(url.searchParams.get('cap') || 1000000),
    rf     : +(url.searchParams.get('rf')  || 0.00)
  };

  // Chips
  setText('#feeRateChip',(CFG.feeRate*100).toFixed(4)+'%');
  setText('#taxRateChip',(CFG.taxRate*100).toFixed(3)+'%');
  setText('#minFeeChip', String(CFG.minFee));
  setText('#unitChip'  , String(CFG.unit));
  setText('#slipChip'  , String(CFG.slip));
  setText('#rfChip'    , (CFG.rf*100).toFixed(2)+'%');

  // ===== Supabase =====
  var SUPABASE_URL  = "https://byhbmmnacezzgkwfkozs.supabase.co";
  var SUPABASE_ANON = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  var BUCKET        = "reports";
  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    global:{ fetch:function(u,o){ o=o||{}; o.cache='no-store'; return fetch(u,o); } }
  });

  // ===== UI =====
  var fileInput = $('#file');
  var btnClip   = $('#btn-clip');
  var prefix    = $('#cloudPrefix');
  var btnList   = $('#btnCloudList');
  var pick      = $('#cloudSelect');
  var btnPrev   = $('#btnCloudPreview');
  var btnImp    = $('#btnCloudImport');
  var meta      = $('#cloudMeta');
  var prev      = $('#cloudPreview');

  if(btnClip){
    btnClip.addEventListener('click', function(){
      navigator.clipboard.readText().then(function(txt){
        if(!txt){ alert('剪貼簿沒有文字'); return; }
        runAll(txt);
      }).catch(function(){ alert('無法讀取剪貼簿內容'); });
    });
  }
  if(fileInput){
    fileInput.addEventListener('change', function(){
      var f=fileInput.files&&fileInput.files[0]; if(!f) return;
      f.arrayBuffer().then(function(buf){
        var best=decodeBest(buf);
        runAll(best.txt);
      });
    });
  }
  if(btnList) btnList.addEventListener('click', listCloud);
  if(btnPrev) btnPrev.addEventListener('click', previewCloud);
  if(btnImp)  btnImp.addEventListener('click', importCloud);

  function listCloud(){
    prev.textContent=''; meta.textContent='';
    pick.innerHTML = '<option value="">載入中…</option>';
    var p=(prefix.value||'').trim();
    var fixed = p && p.charAt(p.length-1)!=='/' ? (p+'/') : p;
    sb.storage.from(BUCKET).list(fixed,{limit:1000,sortBy:{column:'name',order:'asc'}}).then(function(r){
      if(r.error){ pick.innerHTML='<option>讀取失敗：'+r.error.message+'</option>'; return; }
      var data=r.data||[];
      var i, it, path, opt, kb;
      if(!data.length){ pick.innerHTML='<option>（無檔案）</option>'; return; }
      pick.innerHTML='';
      for(i=0;i<data.length;i++){
        it=data[i];
        if(it.id===null && !it.metadata) continue; // 資料夾
        path=(fixed||'')+it.name;
        opt=document.createElement('option');
        kb = it.metadata&&it.metadata.size ? (it.metadata.size/1024).toFixed(1) : '-';
        opt.value=path; opt.textContent=path+' ('+kb+' KB)';
        pick.appendChild(opt);
      }
    });
  }
  function getUrl(path){
    return sb.storage.from(BUCKET).createSignedUrl(path,3600).then(function(r){
      if(r && r.data && r.data.signedUrl) return r.data.signedUrl;
      var pub=sb.storage.from(BUCKET).getPublicUrl(path);
      return pub && pub.data ? pub.data.publicUrl : '';
    });
  }
  function decodeBest(ab){
    var encs=['utf-8','big5','gb18030'], best={txt:'',bad:1e9,enc:''};
    for(var i=0;i<encs.length;i++){
      try{
        var t=new TextDecoder(encs[i],{fatal:false}).decode(ab);
        var bad=(t.match(/\uFFFD/g)||[]).length;
        if(bad<best.bad) best={txt:t,bad:bad,enc:encs[i]};
      }catch(_){}
    }
    return best;
  }
  function previewCloud(){
    prev.textContent=''; meta.textContent='';
    var path=pick.value; if(!path) return;
    getUrl(path).then(function(u){
      if(!u){ prev.textContent='取得連結失敗'; return null; }
      return fetch(u,{cache:'no-store'});
    }).then(function(r){
      if(!r){ return null; }
      if(!r.ok){ prev.textContent='HTTP '+r.status; return null; }
      return r.arrayBuffer();
    }).then(function(ab){
      if(!ab) return;
      var best=decodeBest(ab);
      meta.textContent='來源：'+path+'（編碼：'+best.enc+'）';
      var lines=best.txt.split(/\r?\n/);
      prev.textContent=lines.slice(0,500).join('\n')+(lines.length>500?('\n...（共 '+lines.length+' 行）'):'');
    });
  }
  function importCloud(){
    var path=pick.value; if(!path) return alert('請先選檔');
    getUrl(path).then(function(u){
      if(!u){ alert('取得連結失敗'); return null; }
      return fetch(u,{cache:'no-store'});
    }).then(function(r){
      if(!r){ return null; }
      if(!r.ok){ alert('HTTP '+r.status); return null; }
      return r.arrayBuffer();
    }).then(function(ab){
      if(!ab) return;
      var best=decodeBest(ab);
      runAll(best.txt);
    });
  }

  // ===== 解析：canonical + 1031-CSV =====
  var CANON_RE=/^(\d{14})\.0{6}\s+(\d+\.\d{6})\s+(新買|平賣|新賣|平買|強制平倉)\s*$/;
  var CSV_RE  =/^(\d{8}),(\d{5,6}),(\d+(?:\.\d+)?),([^,]+),/;
  function mapAct(s){
    s=String(s||'').trim();
    if(/^賣出$/i.test(s)) return '平賣';
    if(/^(買進|加碼|再加碼|加碼攤平)$/i.test(s)) return '新買';
    if(/^強平$/i.test(s)) return '強制平倉';
    return s;
  }
  function pad6(t){ t=String(t||''); if(t.length===5) t='0'+t; return t.slice(0,6); }
  function normalize(txt){
    return (txt||'')
      .replace(/\ufeff/gi,'').replace(/[\u200B-\u200D\uFEFF]/g,'')
      .replace(/[\x00-\x09\x0B-\x1F\x7F]/g,'')
      .replace(/\r\n?/g,'\n')
      .split('\n').map(function(s){ return s.replace(/\s+/g,' ').trim(); }).filter(function(x){ return !!x; });
  }
  function toCanon(lines){
    var out=[], i, l, m, d8, t6, px, act;
    for(i=0;i<lines.length;i++){
      l=lines[i];
      m=l.match(CANON_RE);
      if(m){ out.push({ts:m[1], px:+m[2], act:m[3]}); continue; }
      m=l.match(CSV_RE);
      if(m){
        d8=m[1]; t6=pad6(m[2]); px=+m[3]; act=mapAct(m[4]);
        if(isFinite(px) && /^\d{6}$/.test(t6)) out.push({ts:d8+t6, px:px, act:act});
      }
    }
    out.sort(function(a,b){ return a.ts.localeCompare(b.ts); });
    return out;
  }

  // ===== 回測（股票口徑） =====
  var d8 = function(ts){ return ts.slice(0,8); };
  var ceilInt=function(n){ return Math.ceil(n); };
  var fee=function(amount){ return Math.max(CFG.minFee, ceilInt(amount*CFG.feeRate)); };
  var tax=function(amount){ return Math.max(0, ceilInt(amount*CFG.taxRate)); };

  function weekKey(day){
    var dt=new Date(day.slice(0,4)+'-'+day.slice(4,6)+'-'+day.slice(6,8)+'T00:00:00');
    var y=dt.getFullYear(), oneJan=new Date(y,0,1);
    var week=Math.ceil((((dt-oneJan)/86400000)+oneJan.getDay()+1)/7);
    return y+'-W'+(week<10?('0'+week):week);
  }
  function backtest(rows){
    var shares=0, cash=CFG.capital, cumCost=0, pnlCum=0;
    var trades=[], weeks=new Map(), dayPnL=new Map();
    var i, r;
    for(i=0;i<rows.length;i++){
      r=rows[i];
      if(r.act==='新買'){
        var px=r.px+CFG.slip, amt=px*CFG.unit, f=fee(amt);
        if(cash>=amt+f){
          cash -= (amt+f); shares += CFG.unit; cumCost += (amt+f);
          trades.push({ts:r.ts, kind:'BUY', px:px, shares:CFG.unit, fee:f, tax:0, cash:cash, pnl:null, pnlCum:pnlCum, d8:d8(r.ts)});
        }
      }else if(r.act==='平賣' && shares>0){
        var sp=r.px-CFG.slip, sam=sp*shares, ff=fee(sam), tt=tax(sam);
        cash += (sam-ff-tt);
        var avg = cumCost/shares;
        var pnl = (sam-ff-tt) - avg*shares;
        pnlCum += pnl;
        var day=d8(r.ts);
        dayPnL.set(day,(dayPnL.get(day)||0)+pnl);
        var wk=weekKey(day); weeks.set(wk,(weeks.get(wk)||0)+pnl);
        trades.push({ts:r.ts, kind:'SELL', px:sp, shares:shares, fee:ff, tax:tt, cash:cash, pnl:pnl, pnlCum:pnlCum, d8:day});
        shares=0; cumCost=0;
      }
    }
    return { trades:trades, weeks:weeks, dayPnL:dayPnL, endingCash:cash, openShares:shares, pnlCum:pnlCum };
  }

  // ===== KPI 相關 =====
  function seriesFromDayPnL(dayPnL){
    var days = Array.from(dayPnL.keys()).sort();
    var pnl  = days.map(function(d){ return dayPnL.get(d)||0; });
    var eq=[], acc=0; for(var i=0;i<pnl.length;i++){ acc+=pnl[i]; eq.push(acc); }
    return {days:days, pnl:pnl, eq:eq};
  }
  function statsBasic(arr){
    var n=arr.length; if(!n) return {n:n,mean:0,std:0,min:0,max:0,skew:0,kurt:0};
    var i, mean=0; for(i=0;i<n;i++) mean+=arr[i]; mean/=n;
    var v=0; for(i=0;i<n;i++) v+=(arr[i]-mean)*(arr[i]-mean); v/=n;
    var std=Math.sqrt(v);
    var min=Math.min.apply(null,arr), max=Math.max.apply(null,arr);
    var m3=0, m4=0; for(i=0;i<n;i++){ var d=arr[i]-mean; m3+=d*d*d; m4+=d*d*d*d; }
    m3/=n; m4/=n;
    var skew = std>0 ? (m3/Math.pow(std,3)) : 0;
    var kurt = std>0 ? (m4/Math.pow(std,4)) - 3 : 0;
    return {n:n,mean:mean,std:std,min:min,max:max,skew:skew,kurt:kurt};
  }
  function maxDrawdown(eq){
    var peak=eq[0]||0, mdd=0, i, dd;
    for(i=0;i<eq.length;i++){ if(eq[i]>peak) peak=eq[i]; dd=eq[i]-peak; if(dd<mdd) mdd=dd; }
    return { mdd:mdd };
  }
  function timeUnderwater(eq){
    var peak=eq[0]||0, cur=0, maxTU=0, totalTU=0, i, v;
    for(i=0;i<eq.length;i++){
      v=eq[i];
      if(v>=peak){ peak=v; if(cur>0){ totalTU+=cur; cur=0; } }
      else { cur++; if(cur>maxTU) maxTU=cur; }
    }
    if(cur>0) totalTU+=cur;
    return { maxTU:maxTU, totalTU:totalTU };
  }
  function ulcerIndex(eq){
    var peak=eq[0]||0, sum=0, i;
    for(i=0;i<eq.length;i++){ if(eq[i]>peak) peak=eq[i]; var d=eq[i]-peak; sum+=d*d; }
    return Math.sqrt(sum/Math.max(1,eq.length));
  }
  function martin(eq){ var ui=ulcerIndex(eq); var last=eq.length?eq[eq.length-1]:0; return ui>0 ? last/ui : 0; }
  function downsideStd(rets){
    var n=rets.length, i, neg=new Array(n);
    for(i=0;i<n;i++) neg[i]=Math.min(0,rets[i]);
    var mean=0; for(i=0;i<n;i++) mean+=neg[i]; mean/=n;
    var varD=0; for(i=0;i<n;i++) varD+=Math.pow(Math.min(0,rets[i])-mean,2); varD/=n;
    return Math.sqrt(varD);
  }
  function sharpe(annRet, annVol, rf){ return annVol>0 ? (annRet-rf)/annVol : 0; }
  function sortino(annRet, annDown, rf){ return annDown>0 ? (annRet-rf)/annDown : 0; }
  function calmar(annRet, mdd){ return mdd<0 ? (annRet/Math.abs(mdd)) : 0; }
  function omega(rets, thr){
    if(thr===void 0) thr=0;
    var pos=0,neg=0, i, r;
    for(i=0;i<rets.length;i++){ r=rets[i]; if(r>thr) pos+=r-thr; else neg+=thr-r; }
    return neg>0 ? pos/neg : Infinity;
  }
  function streaks(arr){
    var win=0,loss=0,maxW=0,maxL=0, i, x;
    for(i=0;i<arr.length;i++){
      x=arr[i];
      if(x>0){ win++; loss=0; if(win>maxW) maxW=win; }
      else if(x<0){ loss++; win=0; if(loss>maxL) maxL=loss; }
      else { win=0; loss=0; }
    }
    return { maxWinStreak:maxW, maxLossStreak:maxL };
  }

  function computeKPI(bt){
    var sells = bt.trades.filter(function(x){ return x.kind==='SELL'; });
    var tradePnl = sells.map(function(x){ return x.pnl||0; });

    var S = seriesFromDayPnL(bt.dayPnL), days=S.days, eqIncr=S.pnl, eq=S.eq;

    var annualFactor=252;
    var total = eq.length ? eq[eq.length-1] : 0;
    var totalReturn = CFG.capital ? total/CFG.capital : 0;

    var dailyRet = eqIncr.map(function(v){ return v/CFG.capital; });
    var R = statsBasic(dailyRet);
    var annRet = R.mean * annualFactor;
    var annVol = R.std  * Math.sqrt(annualFactor);

    var dStd = downsideStd(dailyRet) * Math.sqrt(annualFactor);
    var mdd  = maxDrawdown(eq).mdd;
    var ui   = ulcerIndex(eq);
    var mar  = annRet / Math.max(1, Math.abs(mdd));
    var sr   = sharpe(annRet, annVol, CFG.rf);
    var so   = sortino(annRet, dStd, CFG.rf);
    var cal  = calmar(annRet, mdd);
    var mart = martin(eq);
    var omg  = omega(dailyRet, 0);

    var nTrades = sells.length;
    var hits = sells.filter(function(s){ return s.pnl>0; }).length;
    var hitRate = nTrades? hits/nTrades : 0;
    var grossWin = sells.filter(function(s){return s.pnl>0;}).reduce(function(a,b){return a+b.pnl;},0);
    var grossLoss= sells.filter(function(s){return s.pnl<0;}).reduce(function(a,b){return a+b.pnl;},0);
    var pf = grossLoss<0 ? (grossWin/Math.abs(grossLoss)) : (grossWin>0?Infinity:0);
    var avgWin = hits? grossWin/hits : 0;
    var avgLoss= (nTrades-hits)? Math.abs(grossLoss)/(nTrades-hits) : 0;
    var payoff = avgLoss>0 ? avgWin/avgLoss : Infinity;
    var expectancy = nTrades? (grossWin+grossLoss)/nTrades : 0;

    var weeklyVals = Array.from(bt.weeks.values());
    var volWeekly = statsBasic(weeklyVals).std;
    var bestWeek  = weeklyVals.length ? Math.max.apply(null,weeklyVals) : 0;
    var worstWeek = weeklyVals.length ? Math.min.apply(null,weeklyVals) : 0;

    var TU = timeUnderwater(eq);
    var ST = streaks(tradePnl);

    var grossBuy = bt.trades.filter(function(t){return t.kind==='BUY';}).reduce(function(a,b){return a+b.px*b.shares;},0);
    var grossSell= bt.trades.filter(function(t){return t.kind==='SELL';}).reduce(function(a,b){return a+b.px*b.shares;},0);
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

    return {
      // Return (8)
      total:total, totalReturn:totalReturn, annRet:annRet, bestWeek:bestWeek, worstWeek:worstWeek, avgTrade:avgTrade, medTrade:medTrade, payoff:payoff,
      // Risk (9)
      mdd:mdd, annVol:annVol, dStd:dStd, ui:ui, mart:mart, volWeekly:volWeekly, min:R.min, max:R.max, std:R.std,
      // Efficiency (9)
      sr:sr, so:so, cal:cal, mar:mar, pf:pf, expectancy:expectancy, hitRate:hitRate, avgWin:avgWin, avgLoss:avgLoss,
      // Stability (7)
      maxTU:TU.maxTU, totalTU:TU.totalTU, maxWinStreak:ST.maxWinStreak, maxLossStreak:ST.maxLossStreak, skew:R.skew, kurt:R.kurt, days:days.length,
      // Cost/Activity (8)
      grossBuy:grossBuy, grossSell:grossSell, feeSum:feeSum, taxSum:taxSum, turnover:turnover, costRatio:costRatio, totalExecs:bt.trades.length, unitShares:CFG.unit,
      // Distribution (8)
      tradeCount:nTrades,
      posCount: tradePnl.filter(function(x){return x>0;}).length,
      zeroCount:tradePnl.filter(function(x){return x===0;}).length,
      negCount: tradePnl.filter(function(x){return x<0;}).length,
      posRatio: nTrades? tradePnl.filter(function(x){return x>0;}).length/nTrades : 0,
      negRatio: nTrades? tradePnl.filter(function(x){return x<0;}).length/nTrades : 0,
      omega:omg,
      pnlStd: statsBasic(tradePnl).std
    };
  }

  // ===== 圖表（週次浮動長條 + 折線） =====
  var chWeekly=null;
  function renderWeeklyChart(weeks){
    var labels = Array.from(weeks.keys());
    var weekly = labels.map(function(k){ return weeks.get(k)||0; });
    var cum=[], s=0; for(var i=0;i<weekly.length;i++){ s+=weekly[i]; cum.push(s); }
    var floatBars=[], p=0; for(var j=0;j<cum.length;j++){ floatBars.push([p,cum[j]]); p=cum[j]; }

    var ctx=$('#chWeekly');
    if(chWeekly) chWeekly.destroy();
    chWeekly = new Chart(ctx,{
      data:{ labels:labels, datasets:[
        { type:'bar',  label:'每週獲利（浮動長條）', data:floatBars, borderWidth:1, backgroundColor:'rgba(13,110,253,0.30)', borderColor:'#0d6efd' },
        { type:'line', label:'累積淨利', data:cum,       borderWidth:2, borderColor:'#f43f5e', tension:0.2, pointRadius:0 }
      ]},
      options:{
        responsive:true, maintainAspectRatio:false, plugins:{legend:{display:true}},
        scales:{
          y :{ suggestedMin:Math.min(0, Math.min.apply(null, cum.concat([0]))*1.1),
               suggestedMax:Math.max(1, Math.max.apply(null, cum.concat([0]))*1.05) },
          x :{ ticks:{ maxTicksLimit:12 } }
        }
      }
    });
  }

  // ===== KPI Render（六卡） =====
  function putKV(id, rows){
    var el=$(id); if(!el) return;
    var html='', i;
    for(i=0;i<rows.length;i++){
      html += '<div class="k"><b>'+rows[i][0]+'</b></div><div class="v">'+rows[i][1]+'</div>';
    }
    el.innerHTML=html;
  }
  function renderKPI(k){
    putKV('#kpiReturn', [
      ['Total PnL(元)', fmtInt(k.total)],
      ['Total Return', pct(k.totalReturn)],
      ['Annualized Return', pct(k.annRet)],
      ['Best Week PnL', fmtInt(k.bestWeek)],
      ['Worst Week PnL', fmtInt(k.worstWeek)],
      ['Avg Trade PnL', fmtInt(k.avgTrade)],
      ['Median Trade PnL', fmtInt(k.medTrade)],
      ['Payoff (AvgWin/AvgLoss)', isFinite(k.payoff)?k.payoff.toFixed(2):'∞']
    ]);
    putKV('#kpiRisk', [
      ['Max Drawdown', fmtInt(k.mdd)],
      ['Volatility (ann.)', pct(k.annVol)],
      ['Downside Vol (ann.)', pct(k.dStd)],
      ['Ulcer Index', k.ui.toFixed(2)],
      ['Martin Ratio', k.mart.toFixed(2)],
      ['Weekly PnL Vol', fmtInt(k.volWeekly)],
      ['Worst Daily Ret', pct(k.min)],
      ['Best Daily Ret', pct(k.max)],
      ['Daily Std (alt.)', pct(k.std)]
    ]);
    putKV('#kpiEff', [
      ['Sharpe', k.sr.toFixed(2)],
      ['Sortino', k.so.toFixed(2)],
      ['Calmar', k.cal.toFixed(2)],
      ['MAR', k.mar.toFixed(2)],
      ['Profit Factor', isFinite(k.pf)?k.pf.toFixed(2):'∞'],
      ['Expectancy (per trade)', fmtInt(k.expectancy)],
      ['Hit Rate', pct(k.hitRate)],
      ['Avg Win', fmtInt(k.avgWin)],
      ['Avg Loss', fmtInt(-k.avgLoss)]
    ]);
    putKV('#kpiStab', [
      ['Max Time Underwater (days)', k.maxTU],
      ['Total Time Underwater (days)', k.totalTU],
      ['Max Win Streak', k.maxWinStreak],
      ['Max Loss Streak', k.maxLossStreak],
      ['Skewness (daily ret)', k.skew.toFixed(2)],
      ['Kurtosis (daily ret)', k.kurt.toFixed(2)],
      ['Trading Days', k.days]
    ]);
    putKV('#kpiCost', [
      ['Gross Buy', fmtInt(k.grossBuy)],
      ['Gross Sell', fmtInt(k.grossSell)],
      ['Fee Sum', fmtInt(k.feeSum)],
      ['Tax Sum', fmtInt(k.taxSum)],
      ['Turnover / Capital', k.turnover.toFixed(2)+'×'],
      ['Cost Ratio (Fee+Tax / Turnover)', pct(k.costRatio)],
      ['Total Exec Rows', k.totalExecs],
      ['Unit Shares', k.unitShares]
    ]);
    putKV('#kpiDist', [
      ['#Trades (SELL)', k.tradeCount],
      ['Wins / Zeros / Losses', k.posCount+' / '+k.zeroCount+' / '+k.negCount],
      ['Win Ratio', pct(k.posRatio)],
      ['Loss Ratio', pct(k.negRatio)],
      ['Omega (0)', isFinite(k.omega)?k.omega.toFixed(2):'∞'],
      ['Trade PnL Std', fmtInt(k.pnlStd)],
      ['—','—'],
      ['—','—']
    ]);
  }

  // ===== 明細表 =====
  function renderTrades(t){
    var th = $('#tradeTable thead'), tb=$('#tradeTable tbody');
    th.innerHTML = '<tr>'
      +'<th>時間</th><th>種類</th><th>價格</th><th>股數</th>'
      +'<th>手續費</th><th>交易稅</th><th>現金餘額</th><th>單筆損益</th><th>累積損益</th>'
      +'</tr>';
    var i, r, rows='';
    for(i=0;i<t.length;i++){
      r=t[i];
      rows += '<tr class="'+(r.kind==='SELL'?'sell-row':'buy-row')+'">'
            + '<td>'+r.ts+'</td><td>'+r.kind+'</td><td>'+r.px.toFixed(3)+'</td>'
            + '<td>'+r.shares+'</td><td>'+(r.fee||0)+'</td><td>'+(r.tax||0)+'</td>'
            + '<td>'+fmtInt(r.cash)+'</td>'
            + '<td>'+(r.pnl==null?'—':(r.pnl>0?'<span class="pnl-pos">'+fmtInt(r.pnl)+'</span>':'<span class="pnl-neg">'+fmtInt(r.pnl)+'</span>'))+'</td>'
            + '<td>'+(r.pnlCum==null?'—':(r.pnlCum>0?'<span class="pnl-pos">'+fmtInt(r.pnlCum)+'</span>':'<span class="pnl-neg">'+fmtInt(r.pnlCum)+'</span>'))+'</td>'
            + '</tr>';
    }
    tb.innerHTML = rows;
  }

  // ===== 主流程 =====
  function runAll(rawText){
    var canon = toCanon(normalize(rawText));
    var bt = backtest(canon);
    renderWeeklyChart(bt.weeks);
    renderKPI(computeKPI(bt));
    renderTrades(bt.trades);
  }
})();
