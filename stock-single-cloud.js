// 股票雲端單檔分析（1031 TXT 版 + 每筆交易直條圖）
// - 讀取 1031 指標 TXT（首行參數 + 買進/加碼/再加碼/賣出 + 日線 closeD）
// - 依首行參數設定：FeeRate / MinFee / UnitSharesBase / IsETF / TaxRateOverride
// - 回測：模擬現金與持股成本
// - 圖表：每筆交易一組直條圖：成本 (NT$)、單筆最大 MAE 金額 (NT$)、實現盈虧 (NT$)
// - KPI：49 指標 + Score（以本金 CFG.capital 為基準）

(function(){
  'use strict';

  // ===== 小工具 =====
  var $ = function(s){ return document.querySelector(s); };
  var fmtInt = function(n){ return Math.round(n||0).toLocaleString(); };
  var pct = function(v){ return (v==null||!isFinite(v)) ? '—' : (v*100).toFixed(2)+'%'; };
  var setText = function(sel,t){ var el=$(sel); if(el) el.textContent=t; };

  // ===== URL 參數 / 基本設定 =====
  var url = new URL(location.href);
  var CFG = {
    feeRate: +(url.searchParams.get('fee') || 0.001425),
    minFee : +(url.searchParams.get('min') || 20),
    taxRate: +(url.searchParams.get('tax') || 0.001), // 預設 ETF 0.1%
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

  // ===== Supabase（保留雲端選檔功能） =====
  var SUPABASE_URL  = "https://byhbmmnacezzgkwfkozs.supabase.co";
  var SUPABASE_ANON = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  var BUCKET        = "reports";
  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    global:{ fetch:function(u,o){ o=o||{}; o.cache='no-store'; return fetch(u,o); } }
  });

  // ===== 狀態 =====
  var currentRaw = null;
  var chTrades = null;

  // ===== UI 綁定 =====
  var fileInput=$('#file'), btnClip=$('#btn-clip'), prefix=$('#cloudPrefix');
  var btnList=$('#btnCloudList'), pick=$('#cloudSelect'), btnPrev=$('#btnCloudPreview'), btnImp=$('#btnCloudImport');
  var meta=$('#cloudMeta'), prev=$('#cloudPreview');

  if(btnClip){
    btnClip.addEventListener('click', function(){
      navigator.clipboard.readText().then(function(txt){
        if(!txt){ alert('剪貼簿沒有文字'); return; }
        currentRaw = txt;
        runAll(txt);
      }).catch(function(){ alert('無法讀取剪貼簿內容'); });
    });
  }
  if(fileInput){
    fileInput.addEventListener('change', function(){
      var f=fileInput.files&&fileInput.files[0]; if(!f) return;
      f.arrayBuffer().then(function(buf){
        var best=decodeBest(buf);
        currentRaw = best.txt;
        runAll(best.txt);
      });
    });
  }
  if(btnList) btnList.addEventListener('click', listCloud);
  if(btnPrev) btnPrev.addEventListener('click', previewCloud);
  if(btnImp)  btnImp.addEventListener('click', importCloud);

  function listCloud(){
    if(!prefix) return;
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
  function previewCloud(){
    if(!pick) return;
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
    if(!pick) return;
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
      currentRaw = best.txt;
      runAll(best.txt);
    });
  }

  // ===== 解析用 Regex =====
  var CANON_RE=/^(.+?)\s+(\d+\.\d{6})\s+(新買|平賣|新賣|平買|強制平倉)\s*$/;
  var MAE_RE  = /MAE%\s*=\s*(-?\d+(?:\.\d+)?)/;
  var ROW_HEAD_RE = /^\s*(\d{8})\s*,\s*(\d{5,6})\s*,/;

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
      .split('\n').map(function(s){ return s.trim(); })
      .filter(function(x){ return !!x; });
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

  // ===== 解析首行參數 =====
  function applyHeaderParams(headerLine){
    if(!headerLine) return;
    var m;

    m = headerLine.match(/_FeeRate=([\d.]+)/);
    if(m && isFinite(+m[1])) CFG.feeRate = +m[1];

    m = headerLine.match(/_MinFee=(\d+)/);
    if(m && isFinite(+m[1])) CFG.minFee = +m[1];

    m = headerLine.match(/_UnitSharesBase=(\d+)/);
    if(m && isFinite(+m[1])) CFG.unit = +m[1];

    var isETF = null;
    m = headerLine.match(/_IsETF=(\d+)/);
    if(m && isFinite(+m[1])) isETF = (+m[1]===1);

    var taxOverride = null;
    m = headerLine.match(/_TaxRateOverride=([\d.]+)/);
    if(m && isFinite(+m[1]) && +m[1]>0) taxOverride = +m[1];

    if(taxOverride!=null){
      CFG.taxRate = taxOverride;
    }else if(isETF===true){
      CFG.taxRate = 0.001;
    }else if(isETF===false){
      CFG.taxRate = 0.003;
    }
  }

  function renderParams(headerLine){
    var box = $('#paramBox');
    if(!box) return;
    if(!headerLine){
      box.textContent = '';
      return;
    }
    var params = [];
    var re = /_(\w+)=([^,]+)/g, m;
    while((m = re.exec(headerLine)) !== null){
      params.push(m[1] + '=' + m[2]);
    }
    box.innerHTML = params.join(' ｜ ');
  }

  // ===== 解析交易行（ignore 日線 closeD） =====
  function toCanon(lines){
    var out = [];
    for(var i=0;i<lines.length;i++){
      var l = lines[i];
      if(!l) continue;

      // canonical 形式（不太會用到，保留）
      var m = l.match(CANON_RE);
      if(m){
        out.push({
          ts : m[1].replace(/\D/g,''),
          px : +m[2],
          act: m[3],
          units: 1,
          lotShares: null
        });
        continue;
      }

      var head = ROW_HEAD_RE.exec(l);
      if(!head) continue;
      var d8 = head[1];
      var t6 = pad6(head[2]);
      var parts = l.split(',');
      if(parts.length < 4) continue;
      var px = parseFloat(parts[2]);
      if(!isFinite(px)) continue;

      var actRaw = (parts[3] || '').trim();
      // 日線 closeD 行的動作是「日線」，這裡直接跳過
      if(actRaw === '日線') continue;

      var act = mapAct(actRaw);
      var row = { ts:d8+t6, px:px, act:act };

      var um = l.match(/本次單位\s*=\s*(\d+)/) || l.match(/unitsThis\s*=\s*(\d+)/);
      if(um){
        row.units = parseInt(um[1],10);
        if(!(row.units>0)) row.units=1;
      }else{
        row.units = 1;
      }

      var lm = l.match(/lotShares\s*=\s*(\d+)/);
      if(lm){
        row.lotShares = parseInt(lm[1],10);
        if(!(row.lotShares>0)) row.lotShares = null;
      }

      out.push(row);
    }

    out.sort(function(a,b){ return a.ts.localeCompare(b.ts); });
    return out;
  }

  // 只取 MAE% 列表（每遇到一個 MAE% 視為下一筆 SELL 的 MAE）
  function extractMaeList(lines){
    var arr = [];
    for(var i=0;i<lines.length;i++){
      var l = lines[i];
      var m = MAE_RE.exec(l);
      if(m){
        var v = parseFloat(m[1]);
        if(isFinite(v)) arr.push(v);
      }
    }
    return arr;
  }

  // ===== 手續費/稅 =====
  function fee(amount){ return Math.max(CFG.minFee, Math.ceil(amount*CFG.feeRate)); }
  function tax(amount){ return Math.max(0, Math.ceil(amount*CFG.taxRate)); }

  // ===== 回測：回傳 trades / weeks / dayPnL =====
  function backtest(rows){
    var shares=0, cash=CFG.capital, cumCost=0, pnlCum=0;
    var trades=[], weeks=new Map(), dayPnL=new Map();

    for(var i=0;i<rows.length;i++){
      var r=rows[i];
      var day = r.ts.slice(0,8);

      if(r.act==='新買'){
        var lotUnits  = r.units || 1;
        var unitSize  = r.lotShares || CFG.unit;
        var sharesInc = unitSize * lotUnits;

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

      }else if(r.act==='平賣' && shares>0){
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

  function weekKey(day){
    var dt=new Date(day.slice(0,4)+'-'+day.slice(4,6)+'-'+day.slice(6,8)+'T00:00:00');
    var y=dt.getFullYear(), oneJan=new Date(y,0,1);
    var week=Math.ceil((((dt-oneJan)/86400000)+oneJan.getDay()+1)/7);
    return y+'-W'+(week<10?('0'+week):week);
  }

  // ===== KPI 計算（沿用舊版） =====
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
  function recoveryDays(eq){
    var n=eq.length; if(!n) return 0;
    var peak=eq[0], peakIdx=0, mdd=0, mddIdx=-1, i, dd;
    for(i=0;i<n;i++){
      if(eq[i]>peak){ peak=eq[i]; peakIdx=i; }
      dd = eq[i]-peak;
      if(dd<mdd){ mdd=dd; mddIdx=i; }
    }
    if(mddIdx<0) return 0;
    for(i=mddIdx+1;i<n;i++){
      if(eq[i]>=peak) return i-mddIdx;
    }
    return n-mddIdx-1;
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
    var last=eq.length?eq[eq.length-1]:0;
    return ui>0? last/ui : 0;
  }
  function downsideStd(rets){
    var n=rets.length,i,neg=new Array(n);
    for(i=0;i<n;i++) neg[i]=Math.min(0,rets[i]);
    var mean=0; for(i=0;i<n;i++) mean+=neg[i]; mean/=n;
    var varD=0;
    for(i=0;i<n;i++) varD+=Math.pow(Math.min(0,rets[i])-mean,2);
    varD/=n; return Math.sqrt(varD);
  }
  function sharpe(annRet, annVol, rf){ return annVol>0 ? (annRet-rf)/annVol : 0; }
  function sortino(annRet, annDown, rf){ return annDown>0 ? (annRet-rf)/annDown : 0; }
  function calmar(annRet, mdd){ return mdd<0 ? (annRet/Math.abs(mdd)) : 0; }
  function omega(rets,thr){ if(thr===void 0) thr=0; var pos=0,neg=0,i,r; for(i=0;i<rets.length;i++){ r=rets[i]; if(r>thr) pos+=r-thr; else neg+=thr-r; } return neg>0? pos/neg : Infinity; }
  function streaks(arr){
    var win=0,loss=0,maxW=0,maxL=0,i,x;
    for(i=0;i<arr.length;i++){
      x=arr[i];
      if(x>0){ win++; loss=0; if(win>maxW) maxW=win; }
      else if(x<0){ loss++; win=0; if(loss>maxL) maxL=loss; }
      else { win=0; loss=0; }
    }
    return {maxWinStreak:maxW,maxLossStreak:maxL};
  }

  function computeKPI(bt, maeList){
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

    var mdd=maxDrawdown(eq).mdd;
    var ui=ulcerIndex(eq);
    var sr=sharpe(annRet,annVol,CFG.rf);
    var so=sortino(annRet,dStd,CFG.rf);
    var cal=calmar(annRet,mdd);
    var mar=annRet/Math.max(1,Math.abs(mdd));
    var mart=martin(eq);
    var omg=omega(dailyRet,0);

    var nTrades=sells.length;
    var hits=sells.filter(function(s){return (s.pnlFull||0)>0;}).length;
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
    var medTrade=(function(){
      var s=[].concat(tradePnl).sort(function(a,b){return a-b;});
      if(!s.length) return 0;
      var m=Math.floor(s.length/2);
      return s.length%2? s[m] : (s[m-1]+s[m])/2;
    })();

    var monthMap = new Map();
    bt.dayPnL.forEach(function(v,day){
      var mKey = day.slice(0,6);
      monthMap.set(mKey,(monthMap.get(mKey)||0)+v);
    });
    var monthKeys = Array.from(monthMap.keys());
    var monthPnL = monthKeys.map(function(k){return monthMap.get(k)||0;});
    var posM = monthPnL.filter(function(x){return x>0;}).length;
    var monthHit = monthKeys.length ? posM/monthKeys.length : 0;

    var maeAvgAbs = 0;
    var maeWorst  = 0;
    if(maeList && maeList.length){
      var sumAbs=0, minMae=maeList[0];
      for(var i=0;i<maeList.length;i++){
        var v = maeList[i];
        sumAbs += Math.abs(v);
        if(v < minMae) minMae = v;
      }
      maeAvgAbs = sumAbs/maeList.length;
      maeWorst  = minMae;
    }

    var recDays = recoveryDays(eq);

    return {
      total:total,totalReturn:totalReturn,annRet:annRet,bestWeek:bestWeek,worstWeek:worstWeek,avgTrade:avgTrade,medTrade:medTrade,payoff:payoff,
      mdd:mdd,annVol:annVol,dStd:dStd,ui:ui,mart:mart,volWeekly:volWeekly,min:R.min,max:R.max,std:R.std,
      sr:sr,so:so,cal:cal,mar:mar,pf:pf,expectancy:expectancy,hitRate:hitRate,avgWin:avgWin,avgLoss:avgLoss,
      maxTU:TU.maxTU,totalTU:TU.totalTU,maxWinStreak:ST.maxWinStreak,maxLossStreak:ST.maxLossStreak,skew:R.skew,kurt:R.kurt,days:days.length,
      grossBuy:grossBuy,grossSell:grossSell,feeSum:feeSum,taxSum:taxSum,turnover:turnover,costRatio:costRatio,totalExecs:bt.trades.length,unitShares:CFG.unit,
      tradeCount:sells.length,
      posCount:tradePnl.filter(function(x){return x>0;}).length,
      zeroCount:tradePnl.filter(function(x){return x===0;}).length,
      negCount:tradePnl.filter(function(x){return x<0;}).length,
      posRatio:sells.length? tradePnl.filter(function(x){return x>0;}).length/sells.length : 0,
      negRatio:sells.length? tradePnl.filter(function(x){return x<0;}).length/sells.length : 0,
      omega:omega(dailyRet,0),
      pnlStd:statsBasic(tradePnl).std,
      monthHit:monthHit,
      maeAvgAbs:maeAvgAbs,
      maeWorst:maeWorst,
      recoveryDays:recDays
    };
  }

  // ===== 每筆交易直條圖：成本 / Worst MAE 金額 / 實現盈虧 =====
  function renderTradeChart(bt, maeList){
    var ctx = $('#chWeekly');
    if(!ctx) return;
    if(chTrades){ chTrades.destroy(); chTrades=null; }

    var sells = bt.trades.filter(function(t){ return t.kind==='SELL'; });
    if(!sells.length){
      chTrades = new Chart(ctx,{type:'bar',data:{labels:[],datasets:[]},options:{}});
      return;
    }

    var labels=[], costArr=[], maeArr=[], pnlArr=[];
    var maeIdx=0;

    for(var i=0;i<sells.length;i++){
      var t = sells[i];
      var day = t.ts.slice(0,8);
      var label = (i+1)+'筆\n'+day.slice(0,4)+'/'+day.slice(4,6)+'/'+day.slice(6,8);
      labels.push(label);

      var tradeCost = (t.cumCost || 0) + (t.fee||0) + (t.tax||0);
      costArr.push(tradeCost);

      var maePct = 0;
      if(maeIdx<maeList.length){
        maePct = Math.abs(maeList[maeIdx]);
      }
      maeIdx++;
      var maeCash = tradeCost * maePct / 100.0;
      maeArr.push(-maeCash);      // 畫成往下的單筆最大浮虧金額

      var pnl = t.pnlFull || 0;
      pnlArr.push(pnl);
    }

    chTrades = new Chart(ctx,{
      data:{
        labels:labels,
        datasets:[
          {
            type:'bar',
            label:'成本 (NT$)',
            data:costArr,
            backgroundColor:'rgba(59,130,246,0.75)',
            borderColor:'#1d4ed8',
            borderWidth:1
          },
          {
            type:'bar',
            label:'單筆最大浮虧 (NT$)',
            data:maeArr,
            backgroundColor:'rgba(34,197,94,0.75)',
            borderColor:'#15803d',
            borderWidth:1
          },
          {
            type:'bar',
            label:'實現盈虧 (NT$)',
            data:pnlArr,
            backgroundColor:'rgba(249,115,22,0.85)',
            borderColor:'#c2410c',
            borderWidth:1
          }
        ]
      },
      options:{
        responsive:true,
        maintainAspectRatio:false,
        plugins:{
          legend:{ display:true },
          tooltip:{
            callbacks:{
              label:function(ctx){
                var v = ctx.parsed.y || 0;
                return ctx.dataset.label + '：' + fmtInt(v) + ' 元';
              }
            }
          }
        },
        scales:{
          x:{
            stacked:false,
            ticks:{ autoSkip:false, maxRotation:0, minRotation:0, font:{size:10} }
          },
          y:{
            stacked:false,
            title:{display:true,text:'金額 (NT$)'},
            ticks:{ callback:function(v){ return fmtInt(v); } }
          }
        }
      }
    });
  }

  // ===== KPI + Score（單表） =====
  function bandTxt(score){
    return score===0 ? 'Strong（強）'
         : score===1 ? 'Adequate（可接受）'
         : 'Improve（需優化）';
  }
  function bandAdvice(score){
    return score===2 ? '建議優化' : '維持監控';
  }

  function scoreMetric(key, raw){
    if(key==='annVol' || key==='dStd' || key==='mdd' || key==='costRatio'){
      return raw<=0.15 ? 0 : (raw<=0.25 ? 1 : 2);
    }
    if(key==='sr' || key==='so' || key==='cal' || key==='mar' || key==='pf'){
      return raw>=1.5 ? 0 : (raw>=1.0 ? 1 : 2);
    }
    if(key==='totalReturn' || key==='annRet'){
      return raw>=0.10 ? 0 : (raw>=0.05 ? 1 : 2);
    }
    if(key==='hitRate'){
      return raw>=0.55 ? 0 : (raw>=0.45 ? 1 : 2);
    }
    if(key==='maeAvgAbs'){
      return raw<=5 ? 0 : (raw<=10 ? 1 : 2);
    }
    if(key==='maeWorst'){
      return raw<=15 ? 0 : (raw<=25 ? 1 : 2);
    }
    if(key==='recoveryDays'){
      return raw<=60 ? 0 : (raw<=120 ? 1 : 2);
    }
    if(key==='monthHit'){
      return raw>=0.6 ? 0 : (raw>=0.5 ? 1 : 2);
    }
    return 1;
  }

  var KPI_WEIGHT = {
    totalReturn : 2.0,
    annRet      : 2.0,
    mdd         : 2.0,
    pf          : 1.8,
    sr          : 1.6,
    so          : 1.4,
    mar         : 1.4,
    cal         : 1.0,
    hitRate     : 1.4,
    expectancy  : 1.2,
    payoff      : 1.0,
    annVol      : 1.2,
    dStd        : 1.0,
    costRatio   : 1.0,
    maeAvgAbs   : 1.3,
    maeWorst    : 0.8,
    recoveryDays: 1.0,
    monthHit    : 1.0
  };

  function renderKPI(k){
    var rows = [];
    function pushRow(name, valObj, key, ref){
      var raw   = valObj.raw;
      var band  = scoreMetric(key, raw);
      var w     = KPI_WEIGHT.hasOwnProperty(key) ? KPI_WEIGHT[key] : 0.5;
      rows.push({name:name, disp:valObj.disp, key:key, ref:ref, raw:raw, band:band, weight:w});
    }

    // 報酬
    pushRow('總報酬（Total Return）',{disp:pct(k.totalReturn),raw:k.totalReturn},'totalReturn','—');
    pushRow('CAGR（年化報酬）',{disp:pct(k.annRet),raw:k.annRet},'annRet','≥10%');
    pushRow('平均損益（Expectancy/Trade）',{disp:fmtInt(k.avgTrade),raw:k.avgTrade},'expectancy','—');
    pushRow('年化報酬（Arithmetic）',{disp:pct(k.annRet),raw:k.annRet},'annRet','—');
    pushRow('勝率（Hit Ratio）',{disp:pct(k.hitRate),raw:k.hitRate},'hitRate','≥50%');
    pushRow('最佳週損益',{disp:fmtInt(k.bestWeek),raw:k.bestWeek},'bestWeek','—');
    pushRow('最差週損益',{disp:fmtInt(k.worstWeek),raw:k.worstWeek},'worstWeek','—');
    pushRow('Payoff（AvgWin/AvgLoss）',{disp:(isFinite(k.payoff)?k.payoff.toFixed(2):'∞'),raw:k.payoff},'payoff','≥1.2');

    // 風險 + MAE + Recovery
    pushRow('最大回撤（MaxDD）',{disp:fmtInt(k.mdd),raw:Math.abs(k.mdd)/CFG.capital},'mdd','≤15%資本');
    pushRow('水下時間 MaxTU（天）',{disp:k.maxTU,raw:k.maxTU},'maxTU','愈低愈好');
    pushRow('水下時間 TotalTU（天）',{disp:k.totalTU,raw:k.totalTU},'totalTU','愈低愈好');
    pushRow('波動率（Volatility, ann.）',{disp:pct(k.annVol),raw:k.annVol},'annVol','≤15%');
    pushRow('下行波動（Downside, ann.）',{disp:pct(k.dStd),raw:k.dStd},'dStd','≤10%');
    pushRow('Ulcer Index',{disp:k.ui.toFixed(2),raw:k.ui},'ui','愈低愈好');
    pushRow('Martin Ratio',{disp:k.mart.toFixed(2),raw:k.mart},'mart','≥1.0');
    pushRow('Recovery Days（回到前高天數）',{disp:k.recoveryDays,raw:k.recoveryDays},'recoveryDays','≤60 天');
    pushRow('Average MAE%（平均浮虧）',{disp:(k.maeAvgAbs?k.maeAvgAbs.toFixed(2)+'%':'—'),raw:k.maeAvgAbs},'maeAvgAbs','≤5%');
    pushRow('Worst MAE%（單筆最大浮虧）',{disp:(k.maeWorst?k.maeWorst.toFixed(2)+'%':'—'),raw:Math.abs(k.maeWorst)},'maeWorst','≤15%');

    // 效率
    pushRow('Sharpe',{disp:k.sr.toFixed(2),raw:k.sr},'sr','≥1.5');
    pushRow('Sortino',{disp:k.so.toFixed(2),raw:k.so},'so','≥1.5');
    pushRow('Calmar',{disp:k.cal.toFixed(2),raw:k.cal},'cal','≥0.5');
    pushRow('MAR',{disp:k.mar.toFixed(2),raw:k.mar},'mar','≥0.3');
    pushRow('Profit Factor',{disp:(isFinite(k.pf)?k.pf.toFixed(2):'∞'),raw:k.pf},'pf','≥1.5');
    pushRow('Expectancy（每筆期望值）',{disp:fmtInt(k.expectancy),raw:k.expectancy},'expectancy','—');
    pushRow('Avg Win',{disp:fmtInt(k.avgWin),raw:k.avgWin},'avgWin','—');
    pushRow('Avg Loss',{disp:fmtInt(-k.avgLoss),raw:-k.avgLoss},'avgLoss','—');

    // 穩定度
    pushRow('Max Win Streak',{disp:k.maxWinStreak,raw:k.maxWinStreak},'maxWinStreak','愈高愈好');
    pushRow('Max Loss Streak',{disp:k.maxLossStreak,raw:k.maxLossStreak},'maxLossStreak','愈低愈好');
    pushRow('Skewness',{disp:k.skew.toFixed(2),raw:k.skew},'skew','—');
    pushRow('Kurtosis',{disp:k.kurt.toFixed(2),raw:k.kurt},'kurt','—');
    pushRow('Trading Days',{disp:k.days,raw:k.days},'days','—');
    pushRow('Weekly PnL Vol',{disp:fmtInt(k.volWeekly),raw:k.volWeekly},'volWeekly','愈低愈好');
    pushRow('Daily Std',{disp:pct(k.std),raw:k.std},'std','愈低愈好');
    pushRow('Month Hit Ratio（月度勝率）',{disp:pct(k.monthHit),raw:k.monthHit},'monthHit','≥60%');

    // 成本 / 活性
    pushRow('Gross Buy',{disp:fmtInt(k.grossBuy),raw:k.grossBuy},'grossBuy','—');
    pushRow('Gross Sell',{disp:fmtInt(k.grossSell),raw:k.grossSell},'grossSell','—');
    pushRow('Fee Sum',{disp:fmtInt(k.feeSum),raw:k.feeSum},'feeSum','—');
    pushRow('Tax Sum',{disp:fmtInt(k.taxSum),raw:k.taxSum},'taxSum','—');
    pushRow('Turnover ×',{disp:k.turnover.toFixed(2)+'×',raw:k.turnover},'turnover','—');
    pushRow('Cost Ratio',{disp:pct(k.costRatio),raw:k.costRatio},'costRatio','≤0.3%');
    pushRow('Total Exec Rows',{disp:k.totalExecs,raw:k.totalExecs},'totalExecs','—');
    pushRow('Unit Shares',{disp:k.unitShares,raw:k.unitShares},'unitShares','—');

    // 分布
    pushRow('#Trades (SELL)',{disp:k.tradeCount,raw:k.tradeCount},'tradeCount','—');
    pushRow('Wins / Zeros / Losses',{disp:k.posCount+' / '+k.zeroCount+' / '+k.negCount,raw:k.posCount},'posCount','—');
    pushRow('Win Ratio',{disp:pct(k.posRatio),raw:k.posRatio},'posRatio','≥50%');
    pushRow('Loss Ratio',{disp:pct(k.negRatio),raw:k.negRatio},'negRatio','愈低愈好');
    pushRow('Omega (0)',{disp:(isFinite(k.omega)?k.omega.toFixed(2):'∞'),raw:k.omega},'omega','≥1.2');
    pushRow('Trade PnL Std',{disp:fmtInt(k.pnlStd),raw:k.pnlStd},'pnlStd','愈低愈好');

    // 保留位
    pushRow('—',{disp:'—',raw:0},'na','—');
    pushRow('—',{disp:'—',raw:0},'na','—');

    var sumW=0,sumS=0;
    for(var i=0;i<rows.length;i++){
      var w=rows[i].weight;
      var band=rows[i].band;
      var sVal = (band===0?1.0:(band===1?0.6:0.2));
      sumW+=w;
      sumS+=w*sVal;
    }
    var score = sumW>0 ? (sumS/sumW*100) : 0;
    setText('#scoreLine','Score：'+score.toFixed(1)+' / 100');

    rows.sort(function(a,b){
      if(b.weight!==a.weight) return b.weight-a.weight;
      return b.band-a.band;
    });

    var table = $('#kpiAll');
    if(!table) return;
    var tb = table.querySelector('tbody');
    if(!tb){ tb=document.createElement('tbody'); table.appendChild(tb); }
    var html='';
    for(var j=0;j<rows.length;j++){
      var r=rows[j];
      var cls = r.band===2?'improve-row':(r.band===0?'ok-row':'');
      html+='<tr class="'+cls+'">'
          + '<td>'+r.name+'</td>'
          + '<td>'+r.disp+'</td>'
          + '<td>'+bandAdvice(r.band)+'</td>'
          + '<td>'+bandTxt(r.band)+'</td>'
          + '<td>'+r.ref+'</td>'
          + '</tr>';
    }
    tb.innerHTML=html;
  }

  // ===== 交易明細 =====
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

      priceDiffCell= isSell ? (((e.fee||0)+(e.tax||0))/(e.shares||1)).toFixed(2) : '—';

      pnlCell      = (isSell && e.pnlFull!=null)
        ? (e.pnlFull>0 ? '<span class="pnl-pos">'+fmtInt(e.pnlFull)+'</span>'
                       : '<span class="pnl-neg">'+fmtInt(e.pnlFull)+'</span>')
        : '—';
      retCell      = (isSell && e.retPctUnit!=null) ? (e.retPctUnit*100).toFixed(2)+'%' : '—';
      cumCell      = (isSell && e.cumPnlFull!=null)
        ? (e.cumPnlFull>0 ? '<span class="pnl-pos">'+fmtInt(e.cumPnlFull)+'</span>'
                          : '<span class="pnl-neg">'+fmtInt(e.cumPnlFull)+'</span>')
        : '—';

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
    var normLines = normalize(rawText);
    if(!normLines.length){
      alert('TXT 為空');
      return;
    }

    var header = normLines[0];
    applyHeaderParams(header);
    renderParams(header);
    refreshChips();

    var canon    = toCanon(normLines);
    var maeList  = extractMaeList(normLines);

    // TXT 有 lotShares 時，以之覆蓋 CFG.unit
    var autoUnit = null, i;
    for(i=0;i<canon.length;i++){
      if(canon[i].lotShares && canon[i].lotShares>0){
        autoUnit = canon[i].lotShares;
        break;
      }
    }
    if(autoUnit!=null){
      CFG.unit = autoUnit;
      refreshChips();
    }

    var bt = backtest(canon);

    renderTradeChart(bt, maeList);
    renderTrades(bt.trades);
    renderKPI(computeKPI(bt, maeList));
  }

})();
