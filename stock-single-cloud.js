// 股票｜雲端單檔分析（KPI49，0807 表格樣式，tw-1031 明細口徑，ES5 相容）
(function(){
  'use strict';

  // ===== 小工具 =====
  var $ = function(s){ return document.querySelector(s); };
  var fmtInt = function(n){ return Math.round(n||0).toLocaleString(); };
  var pct = function(v){ return (v==null||!isFinite(v)) ? '—' : (v*100).toFixed(2)+'%'; };
  var setText = function(sel,t){ var el=$(sel); if(el) el.textContent=t; };

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

  // chips
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
  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, { global:{ fetch:function(u,o){ o=o||{}; o.cache='no-store'; return fetch(u,o); } } });

  // ===== UI 綁定 =====
  var fileInput=$('#file'), btnClip=$('#btn-clip'), prefix=$('#cloudPrefix');
  var btnList=$('#btnCloudList'), pick=$('#cloudSelect'), btnPrev=$('#btnCloudPreview'), btnImp=$('#btnCloudImport');
  var meta=$('#cloudMeta'), prev=$('#cloudPreview');

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
      f.arrayBuffer().then(function(buf){ var best=decodeBest(buf); runAll(best.txt); });
    });
  }
  if(btnList) btnList.addEventListener('click', listCloud);
  if(btnPrev) btnPrev.addEventListener('click', previewCloud);
  if(btnImp)  btnImp.addEventListener('click', importCloud);

  function listCloud(){
    prev.textContent=''; meta.textContent='';
    pick.innerHTML='<option value="">載入中…</option>';
    var p=(prefix.value||'').trim();
    var fixed = p && p.charAt(p.length-1)!=='/' ? (p+'/') : p;
    sb.storage.from(BUCKET).list(fixed,{limit:1000,sortBy:{column:'name',order:'asc'}}).then(function(r){
      if(r.error){ pick.innerHTML='<option>讀取失敗：'+r.error.message+'</option>'; return; }
      var data=r.data||[], i,it,path,opt,kb;
      if(!data.length){ pick.innerHTML='<option>（無檔案）</option>'; return; }
      pick.innerHTML='';
      for(i=0;i<data.length;i++){
        it=data[i];
        if(it.id===null && !it.metadata) continue;
        path=(fixed||'')+it.name; opt=document.createElement('option');
        kb=it.metadata&&it.metadata.size ? (it.metadata.size/1024).toFixed(1) : '-';
        opt.value=path; opt.textContent=path+' ('+kb+' KB)'; pick.appendChild(opt);
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
      if(!r){return null;} if(!r.ok){ prev.textContent='HTTP '+r.status; return null; }
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
      if(!r){return null;} if(!r.ok){ alert('HTTP '+r.status); return null; }
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
      .split('\n').map(function(s){ return s.replace(/\s+/g,' ').trim(); })
      .filter(function(x){ return !!x; });
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

  // ===== 手續費/稅（先定義，避免未定義錯誤） =====
  function fee(amount){ return Math.max(CFG.minFee, Math.ceil(amount*CFG.feeRate)); }
  function tax(amount){ return Math.max(0, Math.ceil(amount*CFG.taxRate)); }

  // ===== 回測（股票口徑｜輸出欄位與 tw-1031 一致） =====
  function backtest(rows){
    var shares=0, cash=CFG.capital, cumCost=0, pnlCum=0;
    var trades=[], weeks=new Map(), dayPnL=new Map();

    for(var i=0;i<rows.length;i++){
      var r=rows[i];

      if(r.act==='新買'){
        var px  = r.px + CFG.slip;
        var amt = px * CFG.unit;               // 買進金額(不含手續費)
        var f   = fee(amt);                    // 手續費(買)
        var cost= amt + f;                     // 成本(本筆)
        if(cash >= cost){
          cash    -= cost;
          shares  += CFG.unit;
          cumCost += cost;                     // 累計成本(僅買方手續費)
          var costAvgDisp = cumCost / shares;  // 成本均價(顯示用)

          trades.push({
            ts:r.ts, kind:'BUY', price:px, shares:CFG.unit,
            buyAmount:amt, sellAmount:0, fee:f, tax:0,
            cost:cost, costAvgDisp:costAvgDisp, cumCost:cumCost,
            cumCostDisp:null, priceDiff:null, pnlFull:null, retPctUnit:null, cumPnlFull:pnlCum
          });
        }

      }else if(r.act==='平賣' && shares>0){
        var spx = r.px - CFG.slip;
        var sam = spx * shares;               // 賣出金額(不含費稅)
        var ff  = fee(sam);                    // 手續費(賣)
        var tt  = tax(sam);                    // 交易稅(賣)
        cash   += (sam - ff - tt);

        var sellCumCostDisp = cumCost + ff + tt; // 顯示「累計成本」= 買進累計成本 + 賣方費+稅
        var sellCostAvgDisp = sellCumCostDisp / shares;
        var buyCostAvgBase  = cumCost / shares;
        var priceDiff       = sellCostAvgDisp - buyCostAvgBase;
        var pnlFull         = (sam - ff - tt) - cumCost;
        pnlCum += pnlFull;

        // 週次/日損益（以賣出時點入帳）
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

        // 歸零
        shares=0; cumCost=0;
      }
    }

    return { trades:trades, weeks:weeks, dayPnL:dayPnL, endingCash:cash, openShares:shares, pnlCum:pnlCum };
  }

  // ===== 週次鍵（近似 ISO 週） =====
  function weekKey(day){
    var dt=new Date(day.slice(0,4)+'-'+day.slice(4,6)+'-'+day.slice(6,8)+'T00:00:00');
    var y=dt.getFullYear(), oneJan=new Date(y,0,1);
    var week=Math.ceil((((dt-oneJan)/86400000)+oneJan.getDay()+1)/7);
    return y+'-W'+(week<10?('0'+week):week);
  }

  // ===== KPI（49） =====
  function seriesFromDayPnL(dayPnL){
    var days=Array.from(dayPnL.keys()).sort();
    var pnl=days.map(function(d){ return dayPnL.get(d)||0; });
    var eq=[], acc=0; for(var i=0;i<pnl.length;i++){ acc+=pnl[i]; eq.push(acc); }
    return {days:days, pnl:pnl, eq:eq};
  }
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
    for(i=0;i<eq.length;i++){ if(eq[i]>peak) peak=eq[i]; dd=eq[i]-peak; if(dd<mdd) mdd=dd; }
    return { mdd:mdd };
  }
  function timeUnderwater(eq){
    var peak=eq[0]||0, cur=0, maxTU=0, totalTU=0, i, v;
    for(i=0;i<eq.length;i++){
      v=eq[i];
      if(v>=peak){ peak=v; if(cur>0){ totalTU+=cur; cur=0; } }
      else{ cur++; if(cur>maxTU) maxTU=cur; }
    }
    if(cur>0) totalTU+=cur;
    return { maxTU:maxTU, totalTU:totalTU };
  }
  function ulcerIndex(eq){ var peak=eq[0]||0,sum=0,i; for(i=0;i<eq.length;i++){ if(eq[i]>peak) peak=eq[i]; var d=eq[i]-peak; sum+=d*d; } return Math.sqrt(sum/Math.max(1,eq.length)); }
  function martin(eq){ var ui=ulcerIndex(eq); var last=eq.length?eq[eq.length-1]:0; return ui>0? last/ui : 0; }
  function downsideStd(rets){
    var n=rets.length,i,neg=new Array(n); for(i=0;i<n;i++) neg[i]=Math.min(0,rets[i]);
    var mean=0; for(i=0;i<n;i++) mean+=neg[i]; mean/=n;
    var varD=0; for(i=0;i<n;i++) varD+=Math.pow(Math.min(0,rets[i])-mean,2); varD/=n; return Math.sqrt(varD);
  }
  function sharpe(annRet, annVol, rf){ return annVol>0 ? (annRet-rf)/annVol : 0; }
  function sortino(annRet, annDown, rf){ return annDown>0 ? (annRet-rf)/annDown : 0; }
  function calmar(annRet, mdd){ return mdd<0 ? (annRet/Math.abs(mdd)) : 0; }
  function omega(rets,thr){ if(thr===void 0) thr=0; var pos=0,neg=0,i,r; for(i=0;i<rets.length;i++){ r=rets[i]; if(r>thr) pos+=r-thr; else neg+=thr-r; } return neg>0? pos/neg : Infinity; }
  function streaks(arr){ var win=0,loss=0,maxW=0,maxL=0,i,x; for(i=0;i<arr.length;i++){ x=arr[i]; if(x>0){ win++; loss=0; if(win>maxW) maxW=win; } else if(x<0){ loss++; win=0; if(loss>maxL) maxL=loss; } else { win=0; loss=0; } } return {maxWinStreak:maxW,maxLossStreak:maxL}; }

  function computeKPI(bt){
    var sells=bt.trades.filter(function(x){return x.kind==='SELL';});
    var tradePnl=sells.map(function(x){return x.pnlFull||0;});

    var S=seriesFromDayPnL(bt.dayPnL), days=S.days, eqIncr=S.pnl, eq=S.eq;
    var annualFactor=252;
    var total = eq.length? eq[eq.length-1] : 0;
    var totalReturn = CFG.capital? total/CFG.capital : 0;

    var dailyRet = eqIncr.map(function(v){ return v/CFG.capital; });
    var R = statsBasic(dailyRet);
    var annRet = R.mean*annualFactor;
    var annVol = R.std*Math.sqrt(annualFactor);
    var dStd   = downsideStd(dailyRet)*Math.sqrt(annualFactor);

    var mdd=maxDrawdown(eq).mdd, ui=ulcerIndex(eq);
    var sr=sharpe(annRet,annVol,CFG.rf), so=sortino(annRet,dStd,CFG.rf);
    var cal=calmar(annRet,mdd), mar=annRet/Math.max(1,Math.abs(mdd)), mart=martin(eq), omg=omega(dailyRet,0);

    var nTrades=sells.length, hits=sells.filter(function(s){return (s.pnlFull||0)>0;}).length;
    var hitRate=nTrades? hits/nTrades : 0;
    var grossWin=sells.filter(function(s){return (s.pnlFull||0)>0;}).reduce(function(a,b){return a+(b.pnlFull||0);},0);
    var grossLoss=sells.filter(function(s){return (s.pnlFull||0)<0;}).reduce(function(a,b){return a+(b.pnlFull||0);},0);
    var pf=grossLoss<0? (grossWin/Math.abs(grossLoss)) : (grossWin>0?Infinity:0);
    var avgWin=hits? grossWin/hits : 0;
    var avgLoss=(nTrades-hits)? Math.abs(grossLoss)/(nTrades-hits) : 0;
    var payoff=avgLoss>0? avgWin/avgLoss : Infinity;
    var expectancy=nTrades? (grossWin+grossLoss)/nTrades : 0;

    var weeklyVals=Array.from(bt.weeks.values());
    var volWeekly=statsBasic(weeklyVals).std;
    var bestWeek=weeklyVals.length? Math.max.apply(null,weeklyVals):0;
    var worstWeek=weeklyVals.length? Math.min.apply(null,weeklyVals):0;

    var TU=timeUnderwater(eq), ST=streaks(tradePnl);

    var grossBuy=bt.trades.filter(function(t){return t.kind==='BUY';}).reduce(function(a,b){return a+b.price*b.shares;},0);
    var grossSell=bt.trades.filter(function(t){return t.kind==='SELL';}).reduce(function(a,b){return a+b.price*b.shares;},0);
    var feeSum=bt.trades.reduce(function(a,b){return a+(b.fee||0);},0);
    var taxSum=bt.trades.reduce(function(a,b){return a+(b.tax||0);},0);
    var turnover=CFG.capital? (grossBuy+grossSell)/CFG.capital : 0;
    var costRatio=(grossBuy+grossSell)>0? (feeSum+taxSum)/(grossBuy+grossSell) : 0;
    var avgTrade=nTrades? tradePnl.reduce(function(a,b){return a+b;},0)/nTrades : 0;
    var medTrade=(function(){ var s=[].concat(tradePnl).sort(function(a,b){return a-b;}); if(!s.length) return 0; var m=Math.floor(s.length/2); return s.length%2? s[m] : (s[m-1]+s[m])/2; })();

    return {
      // Return (8)
      total:total,totalReturn:totalReturn,annRet:annRet,bestWeek:bestWeek,worstWeek:worstWeek,avgTrade:avgTrade,medTrade:medTrade,payoff:payoff,
      // Risk (9)
      mdd:mdd,annVol:annVol,dStd:dStd,ui:ui,mart:mart,volWeekly:volWeekly,min:R.min,max:R.max,std:R.std,
      // Efficiency (9)
      sr:sr,so:so,cal:cal,mar:mar,pf:pf,expectancy:expectancy,hitRate:hitRate,avgWin:avgWin,avgLoss:avgLoss,
      // Stability (7)
      maxTU:TU.maxTU,totalTU:TU.totalTU,maxWinStreak:ST.maxWinStreak,maxLossStreak:ST.maxLossStreak,skew:R.skew,kurt:R.kurt,days:days.length,
      // Cost / Activity (8)
      grossBuy:grossBuy,grossSell:grossSell,feeSum:feeSum,taxSum:taxSum,turnover:turnover,costRatio:costRatio,totalExecs:bt.trades.length,unitShares:CFG.unit,
      // Distribution (8)
      tradeCount:nTrades,
      posCount:tradePnl.filter(function(x){return x>0;}).length,
      zeroCount:tradePnl.filter(function(x){return x===0;}).length,
      negCount:tradePnl.filter(function(x){return x<0;}).length,
      posRatio:nTrades? tradePnl.filter(function(x){return x>0;}).length/nTrades : 0,
      negRatio:nTrades? tradePnl.filter(function(x){return x<0;}).length/nTrades : 0,
      omega:omg,
      pnlStd:statsBasic(tradePnl).std
    };
  }

  // ===== 週次圖（浮動長條 + 折線） =====
  var chWeekly=null;
  function renderWeeklyChart(weeks){
    var labels=Array.from(weeks.keys());
    var weekly=labels.map(function(k){ return weeks.get(k)||0; });
    var cum=[], s=0; for(var i=0;i<weekly.length;i++){ s+=weekly[i]; cum.push(s); }
    var floatBars=[], p=0; for(var j=0;j<cum.length;j++){ floatBars.push([p,cum[j]]); p=cum[j]; }

    var ctx=$('#chWeekly');
    if(chWeekly) chWeekly.destroy();
    chWeekly=new Chart(ctx,{
      data:{ labels:labels, datasets:[
        { type:'bar',  label:'每週獲利（浮動長條）', data:floatBars, borderWidth:1, backgroundColor:'rgba(13,110,253,0.30)', borderColor:'#0d6efd' },
        { type:'line', label:'累積淨利',            data:cum,        borderWidth:2, borderColor:'#f43f5e', tension:0.2, pointRadius:0 }
      ]},
      options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:true}},
        scales:{
          y:{ suggestedMin:Math.min(0, Math.min.apply(null, cum.concat([0]))*1.1),
              suggestedMax:Math.max(1, Math.max.apply(null, cum.concat([0]))*1.05) },
          x:{ ticks:{ maxTicksLimit:12 } }
        }
      }
    });
  }

  // ===== KPI 表（0807 風格） =====
  function bandTxt(score){ return score===0?'Strong（強）':(score===1?'Adequate（可接受）':'Improve（優化）'); }
  function scoreMetric(key,raw){
    if(key==='annVol' || key==='dStd' || key==='mdd' || key==='costRatio'){ return raw<=0.15?0:(raw<=0.25?1:2); }
    if(key==='sr' || key==='so' || key==='cal' || key==='mar' || key==='pf'){ return raw>=1.5?0:(raw>=1.0?1:2); }
    if(key==='hitRate'){ return raw>=0.55?0:(raw>=0.45?1:2); }
    if(key==='totalReturn' || key==='annRet'){ return raw>=0.10?0:(raw>=0.05?1:2); }
    return 1;
  }
  function theadHTML(){ return '<thead><tr><th>指標</th><th>數值</th><th>建議</th><th>機構評語</th><th>參考區間</th></tr></thead>'; }
  function trHTML(name, valObj, key, ref){
    var raw=valObj.raw; var disp=valObj.disp;
    var sc=scoreMetric(key,raw); var cls=sc===2?'improve-row':(sc===0?'ok-row':'');
    return '<tr class="'+cls+'"><td>'+name+'</td><td>'+disp+'</td><td>'+(sc===2?'建議優化':'維持監控')+'</td><td>'+bandTxt(sc)+'</td><td>'+ref+'</td></tr>';
  }
  function fillTable(sel, rows){
    var el=$(sel); if(!el) return;
    el.innerHTML = theadHTML();
    var tb=document.createElement('tbody'); var html=''; var i;
    for(i=0;i<rows.length;i++){ html+=trHTML(rows[i][0], rows[i][1], rows[i][2], rows[i][3]); }
    tb.innerHTML=html; el.appendChild(tb);
  }

  function renderKPI(k){
    // Top 建議 3 指標
    var tbTop=$('#kpiTop tbody');
    tbTop.innerHTML = trHTML('波動率（Volatility, ann.）', {disp:pct(k.annVol),raw:k.annVol}, 'annVol', '愈低愈好 ≤15%')
                   + trHTML('PF（獲利因子）', {disp:(isFinite(k.pf)?k.pf.toFixed(2):'∞'),raw:k.pf}, 'pf', '愈高愈好 ≥1.5')
                   + trHTML('最大回撤（MaxDD）', {disp:fmtInt(k.mdd),raw:Math.abs(k.mdd)/CFG.capital}, 'mdd', '相對資本 ≤15%');

    // Return（8）
    fillTable('#kpiReturn', [
      ['總報酬（Total Return）', {disp:pct(k.totalReturn), raw:k.totalReturn}, 'totalReturn', '—'],
      ['CAGR（年化報酬）',       {disp:pct(k.annRet),      raw:k.annRet},      'annRet',      '≥10%'],
      ['平均損益（Expectancy/Trade）', {disp:fmtInt(k.avgTrade), raw:k.avgTrade}, 'avgTrade', '—'],
      ['年化報酬（Arithmetic）',  {disp:pct(k.annRet),      raw:k.annRet},      'annRet',      '—'],
      ['勝率（Hit Ratio）',       {disp:pct(k.hitRate),     raw:k.hitRate},     'hitRate',     '≥50%'],
      ['最佳週損益',             {disp:fmtInt(k.bestWeek), raw:k.bestWeek},    'bestWeek',    '—'],
      ['最差週損益',             {disp:fmtInt(k.worstWeek),raw:k.worstWeek},   'worstWeek',   '—'],
      ['Payoff（AvgWin/AvgLoss）',{disp:(isFinite(k.payoff)?k.payoff.toFixed(2):'∞'), raw:k.payoff}, 'payoff', '≥1.2']
    ]);

    // Risk（9）
    fillTable('#kpiRisk', [
      ['最大回撤（MaxDD）',           {disp:fmtInt(k.mdd),    raw:Math.abs(k.mdd)/CFG.capital}, 'mdd',        '≤15%資本'],
      ['水下時間 MaxTU（天）',        {disp:k.maxTU,          raw:k.maxTU},                      'maxTU',      '愈低愈好'],
      ['水下時間 TotalTU（天）',      {disp:k.totalTU,        raw:k.totalTU},                    'totalTU',    '愈低愈好'],
      ['波動率（Volatility, ann.）',  {disp:pct(k.annVol),    raw:k.annVol},                    'annVol',     '≤15%'],
      ['下行波動（Downside, ann.）',  {disp:pct(k.dStd),      raw:k.dStd},                      'dStd',       '≤10%'],
      ['Ulcer Index',                 {disp:k.ui.toFixed(2),  raw:k.ui},                        'ui',         '愈低愈好'],
      ['Martin Ratio',                {disp:k.mart.toFixed(2),raw:k.mart},                      'mart',       '≥1.0'],
      ['每日最差報酬',               {disp:pct(k.min),       raw:k.min},                       'min',        '—'],
      ['每日最佳報酬',               {disp:pct(k.max),       raw:k.max},                       'max',        '—']
    ]);

    // Efficiency（9）
    fillTable('#kpiEff', [
      ['Sharpe',    {disp:k.sr.toFixed(2),  raw:k.sr},  'sr',  '≥1.5'],
      ['Sortino',   {disp:k.so.toFixed(2),  raw:k.so},  'so',  '≥1.5'],
      ['Calmar',    {disp:k.cal.toFixed(2), raw:k.cal}, 'cal', '≥0.5'],
      ['MAR',       {disp:k.mar.toFixed(2), raw:k.mar}, 'mar', '≥0.3'],
      ['Profit Factor', {disp:(isFinite(k.pf)?k.pf.toFixed(2):'∞'), raw:k.pf}, 'pf', '≥1.5'],
      ['Expectancy', {disp:fmtInt(k.expectancy), raw:k.expectancy}, 'expectancy', '—'],
      ['Hit Rate',  {disp:pct(k.hitRate), raw:k.hitRate}, 'hitRate','≥50%'],
      ['Avg Win',   {disp:fmtInt(k.avgWin), raw:k.avgWin}, 'avgWin', '—'],
      ['Avg Loss',  {disp:fmtInt(-k.avgLoss), raw:-k.avgLoss}, 'avgLoss', '—']
    ]);

    // Stability（7）
    fillTable('#kpiStab', [
      ['Max Win Streak',  {disp:k.maxWinStreak, raw:k.maxWinStreak}, 'maxWinStreak',  '愈高愈好'],
      ['Max Loss Streak', {disp:k.maxLossStreak,raw:k.maxLossStreak}, 'maxLossStreak', '愈低愈好'],
      ['Skewness',        {disp:k.skew.toFixed(2), raw:k.skew},       'skew',          '—'],
      ['Kurtosis',        {disp:k.kurt.toFixed(2), raw:k.kurt},       'kurt',          '—'],
      ['Trading Days',    {disp:k.days, raw:k.days},                  'days',          '—'],
      ['Weekly PnL Vol',  {disp:fmtInt(k.volWeekly), raw:k.volWeekly},'volWeekly',     '愈低愈好'],
      ['Daily Std',       {disp:pct(k.std), raw:k.std},               'std',           '愈低愈好']
    ]);

    // Cost / Activity（8）
    fillTable('#kpiCost', [
      ['Gross Buy',   {disp:fmtInt(k.grossBuy),  raw:k.grossBuy},  'grossBuy',  '—'],
      ['Gross Sell',  {disp:fmtInt(k.grossSell), raw:k.grossSell}, 'grossSell', '—'],
      ['Fee Sum',     {disp:fmtInt(k.feeSum),    raw:k.feeSum},    'feeSum',    '—'],
      ['Tax Sum',     {disp:fmtInt(k.taxSum),    raw:k.taxSum},    'taxSum',    '—'],
      ['Turnover ×',  {disp:k.turnover.toFixed(2)+'×', raw:k.turnover}, 'turnover', '—'],
      ['Cost Ratio',  {disp:pct(k.costRatio), raw:k.costRatio},        'costRatio','≤0.3%'],
      ['Total Exec Rows', {disp:k.totalExecs, raw:k.totalExecs},   'totalExecs','—'],
      ['Unit Shares', {disp:k.unitShares, raw:k.unitShares},       'unitShares','—']
    ]);

    // Distribution（8）
    fillTable('#kpiDist', [
      ['#Trades (SELL)', {disp:k.tradeCount, raw:k.tradeCount}, 'tradeCount', '—'],
      ['Wins / Zeros / Losses', {disp:(k.posCount+' / '+k.zeroCount+' / '+k.negCount), raw:k.posCount}, 'posCount', '—'],
      ['Win Ratio',  {disp:pct(k.posRatio), raw:k.posRatio}, 'posRatio','≥50%'],
      ['Loss Ratio', {disp:pct(k.negRatio), raw:k.negRatio}, 'negRatio','愈低愈好'],
      ['Omega (0)',  {disp:(isFinite(k.omega)?k.omega.toFixed(2):'∞'), raw:k.omega}, 'omega','≥1.2'],
      ['Trade PnL Std', {disp:fmtInt(k.pnlStd), raw:k.pnlStd}, 'pnlStd','愈低愈好'],
      ['—', {disp:'—',raw:0}, 'na','—'],
      ['—', {disp:'—',raw:0}, 'na','—']
    ]);
  }

  // ===== 交易明細（tw-1031 欄位） =====
  function renderTrades(list){
    var th = document.querySelector('#tradeTable thead');
    var tb = document.querySelector('#tradeTable tbody');
    if(!th || !tb) return;

    th.innerHTML = ''
      + '<tr>'
      +   '<th>日期</th><th>種類</th><th>成交價格</th><th>成交數量</th>'
      +   '<th>買進金額</th><th>賣出金額</th><th>手續費</th><th>交易稅</th>'
      +   '<th>成本</th><th>成本均價</th><th>累計成本</th><th>價格差</th>'
      +   '<th>損益</th><th>報酬率</th><th>累計損益</th>'
      + '</tr>';

    var html='', i, e, isSell, pnlCell, cumCell, retCell, priceDiffCell, costAvgCell, cumCostCell, costCell,
        buyAmtCell, sellAmtCell, ts;

    for(i=0;i<list.length;i++){
      e = list[i]; isSell = e.kind === 'SELL'; ts = e.ts;

      buyAmtCell   = fmtInt(e.buyAmount || 0);
      sellAmtCell  = fmtInt(e.sellAmount || 0);
      costCell     = fmtInt(e.cost || 0);
      costAvgCell  = (e.costAvgDisp!=null) ? Number(e.costAvgDisp).toFixed(2) : '—';
      cumCostCell  = isSell ? fmtInt(e.cumCostDisp!=null?e.cumCostDisp:(e.cumCost + (e.fee||0) + (e.tax||0))) : fmtInt(e.cumCost || 0);
      priceDiffCell= isSell && e.priceDiff!=null ? e.priceDiff.toFixed(2) : '—';
      pnlCell      = (isSell && e.pnlFull!=null) ? (e.pnlFull>0 ? '<span class="pnl-pos">'+fmtInt(e.pnlFull)+'</span>' : '<span class="pnl-neg">'+fmtInt(e.pnlFull)+'</span>') : '—';
      retCell      = (isSell && e.retPctUnit!=null) ? (e.retPctUnit*100).toFixed(2)+'%' : '—';
      cumCell      = (isSell && e.cumPnlFull!=null) ? (e.cumPnlFull>0 ? '<span class="pnl-pos">'+fmtInt(e.cumPnlFull)+'</span>' : '<span class="pnl-neg">'+fmtInt(e.cumPnlFull)+'</span>') : '—';

      html += ''
        + '<tr class="'+(isSell?'sell-row':'buy-row')+'">'
        +   '<td>'+ ts.slice(0,4)+'/'+ts.slice(4,6)+'/'+ts.slice(6,8)+' '+ts.slice(8,10)+':'+ts.slice(10,12) +'</td>'
        +   '<td>'+ (isSell?'賣出':'買進') +'</td>'
        +   '<td>'+ Number(e.price).toFixed(2) +'</td>'
        +   '<td>'+ fmtInt(e.shares || 0) +'</td>'

        +   '<td>'+ buyAmtCell +'</td>'
        +   '<td>'+ sellAmtCell +'</td>'
        +   '<td>'+ fmtInt(e.fee || 0) +'</td>'
        +   '<td>'+ fmtInt(e.tax || 0) +'</td>'

        +   '<td>'+ costCell +'</td>'
        +   '<td>'+ costAvgCell +'</td>'
        +   '<td>'+ cumCostCell +'</td>'
        +   '<td>'+ priceDiffCell +'</td>'

        +   '<td>'+ pnlCell +'</td>'
        +   '<td>'+ retCell +'</td>'
        +   '<td>'+ cumCell +'</td>'
        + '</tr>';
    }
    tb.innerHTML = html;
  }

  // ===== 主流程 =====
  function runAll(rawText){
    var canon=toCanon(normalize(rawText));
    var bt=backtest(canon);
    renderWeeklyChart(bt.weeks);
    renderTrades(bt.trades);
    renderKPI(computeKPI(bt));
  }
})();
