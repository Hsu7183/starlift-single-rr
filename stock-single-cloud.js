// 股票雲端單檔分析（KPI49 + 帳戶資金/風險時間線）
// 讀取 1031 指標 TXT（含日線 "日線" + MAE%）
// 1. 解析交易（買進/賣出）+ 日線收盤價
// 2. 以本金 100 萬模擬每日資金 & 持股變化，週結算：
//    - cash: 現金餘額
//    - cost: 當週末持股成本總額
//    - value: 當週末持股市值
//    - equity = cash + value
//    - unreal = value - cost (未實現損益)
//    - realized: 累積已實現損益
// 3. 圖表（每週一點，全部金額單位 NT$）：
//    - 灰線：本金(固定 100 萬)
//    - 黃線：現金
//    - 藍線：持股成本
//    - 紅線：帳戶總值（cash+value）
//    - 柱狀圖：未實現損益（>0 紅，<0 綠）
//    - 橘線：已實現損益（可視化整體賺賠）
// 4. 下半部保留：Score + KPI 一覽（依重要性排序），交易明細。

(function(){
  'use strict';

  // ===== 工具函數 =====
  var $ = function(s){ return document.querySelector(s); };
  var fmtInt = function(n){ return Math.round(n||0).toLocaleString(); };
  var pct = function(v){ return (v==null||!isFinite(v)) ? '—' : (v*100).toFixed(2)+'%'; };
  var setText = function(sel,t){ var el=$(sel); if(el) el.textContent=t; };
  var clamp = function(v,lo,hi){ return Math.max(lo,Math.min(hi,v)); };

  // ===== URL 參數 / 全域設定 =====
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

  // ===== Supabase（雲端選檔） =====
  var SUPABASE_URL  = "https://byhbmmnacezzgkwfkozs.supabase.co";
  var SUPABASE_ANON = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  var BUCKET        = "reports";
  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    global:{ fetch:function(u,o){ o=o||{}; o.cache='no-store'; return fetch(u,o); } }
  });

  var currentRaw = null;
  var chWeekly = null;

  var fileInput=$('#file'), btnClip=$('#btn-clip'), prefix=$('#cloudPrefix');
  var btnList=$('#btnCloudList'), pick=$('#cloudSelect'), btnPrev=$('#btnCloudPreview'), btnImp=$('#btnCloudImport');
  var meta=$('#cloudMeta'), prev=$('#cloudPreview');

  if(btnClip){
    btnClip.addEventListener('click', function(){
      navigator.clipboard.readText().then(function(txt){
        if(!txt){ alert('剪貼簿沒有文字'); return; }
        currentRun(txt);
      }).catch(function(){ alert('無法讀取剪貼簿內容'); });
    });
  }
  if(fileInput){
    fileInput.addEventListener('change', function(){
      var f=fileInput.files&&fileInput.files[0]; if(!f) return;
      f.arrayBuffer().then(function(buf){
        var best=decodeBest(buf);
        currentRun(best.txt);
      });
    });
  }
  if(btnList) btnList.addEventListener('click', listCloud);
  if(btnPrev) btnPrev.addEventListener('click', previewCloud);
  if(btnImp)  btnImp.addEventListener('click', importCloud);

  function currentRun(txt){
    currentRaw = txt;
    runAll(txt);
  }

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
      return r.text();
    }).then(function(text){
      if(text==null) return;
      var lines=text.split(/\r?\n/);
      meta.textContent='來源：'+path;
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
      return r.text();
    }).then(function(text){
      if(text==null) return;
      currentRun(text);
    });
  }

  // ===== 解析 & 模擬相關 =====

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

  function fee(amount){ return Math.max(CFG.minFee, Math.ceil(amount*CFG.feeRate)); }
  function tax(amount){ return Math.max(0, Math.ceil(amount*CFG.taxRate)); }

  // 解析日線收盤價：20240308,90500,27.570000,賣出,... / 20240308,90500,xx,日線,...
  function extractDailyCloses(lines){
    var map = new Map();
    for(var i=0;i<lines.length;i++){
      var l = lines[i];
      var m = l.match(/^(\d{8})\s*,\s*(\d{5,6})\s*,\s*([\d.]+)\s*,\s*([^,]+)\s*,/);
      if(!m) continue;
      var date = m[0].split(',')[0]; // or m[1]
      var time = m[2];
      var price= parseFloat(m[3]);
      var act  = m[4].trim();
      if(act === '日線' && isFinite(price)){
        map.set(m[1], price); // m[1] 是日期 8 碼
      }
    }
    return map;
  }

  // 解析 MAE% 列表（每筆賣出行上的 MAE%）
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

  // 解析交易行（忽略日線行），回傳 rows = [{ts, px, act, units, lotShares}]
  function toCanon(lines){
    var out = [];
    for(var i=0;i<lines.length;i++){
      var l = lines[i];
      if(!l) continue;

      // canonical 行
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
      if(actRaw === '日線') continue; // 忽略日線行

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

  // 日級模擬：回傳 stateByDay: Map<YYYYMMDD, {cash,cost,value,equity,unreal,realized}>
  function buildDailyState(rows, dailyCloseMap){
    var tradesByDay = new Map();
    for(var i=0;i<rows.length;i++){
      var r = rows[i];
      var d = r.ts.slice(0,8);
      var arr = tradesByDay.get(d) || [];
      arr.push(r);
      tradesByDay.set(d, arr);
    }
    tradesByDay.forEach(function(arr){
      arr.sort(function(a,b){ return a.ts.localeCompare(b.ts); });
    });

    var dates = Array.from(dailyCloseMap.keys()).sort();
    var stateByDay = new Map();

    var cash = CFG.capital;
    var openShares = 0;
    var openCost   = 0;
    var realized   = 0;
    var lastClose  = null;

    for(var i=0;i<dates.length;i++){
      var day = dates[i];
      var trades = tradesByDay.get(day) || [];
      trades.sort(function(a,b){ return a.ts.localeCompare(b.ts); });

      // 先處理當天所有交易，更新 cash / openShares / openCost / realized
      for(var j=0;j<trades.length;j++){
        var t = trades[j];
        var shares = (t.lotShares || CFG.unit) * (t.units || 1);
        if(t.act === '新買'){
          var amt = t.px * shares;
          var f = fee(amt);
          cash -= (amt + f);
          openCost += (amt + f);
          openShares += shares;
        }else if(t.act === '平賣'){
          // 這個策略每次賣出都是全出場
          var sellAmt = t.px * openShares;
          var ff = fee(sellAmt);
          var tt = tax(sellAmt);
          var pnl = sellAmt - ff - tt - openCost;
          cash += (sellAmt - ff - tt);
          realized += pnl;
          openShares = 0;
          openCost = 0;
        }
      }

      var closePx = dailyCloseMap.get(day);
      if(!isFinite(closePx)){
        if(lastClose==null) continue;
        closePx = lastClose;
      }
      var value = openShares * closePx;
      var equity = cash + value;
      var unreal = value - openCost;

      stateByDay.set(day, {
        cash: cash,
        cost: openCost,
        value: value,
        equity: equity,
        unreal: unreal,
        realized: realized
      });

      lastClose = closePx;
    }

    return stateByDay;
  }

  function weekKey(day){
    var dt=new Date(day.slice(0,4)+'-'+day.slice(4,6)+'-'+day.slice(6,8)+'T00:00:00');
    var y=dt.getFullYear(), oneJan=new Date(y,0,1);
    var week=Math.ceil((((dt-oneJan)/86400000)+oneJan.getDay()+1)/7);
    return y+'-W'+(week<10?('0'+week):week);
  }

  // 由日級狀態取每週最後一天的狀態
  function buildWeeklySeries(stateByDay){
    var dates = Array.from(stateByDay.keys());
    if(!dates.length) return [];
    dates.sort();

    var weekly = [];
    var curWeek = null;
    var lastDate = null;

    for(var i=0;i<dates.length;i++){
      var d = dates[i];
      var wk = weekKey(d);
      if(curWeek === null){
        curWeek = wk;
      }
      if(wk !== curWeek){
        // 收斂上一週最後一天
        if(lastDate){
          weekly.push({ date:lastDate, week:curWeek, state: stateByDay.get(lastDate) });
        }
        curWeek = wk;
      }
      lastDate = d;
    }
    if(lastDate){
      weekly.push({ date:lastDate, week:weekKey(lastDate), state: stateByDay.get(lastDate) });
    }
    return weekly;
  }

  // ===== 帳戶資金 + 浮虧/浮盈圖（每週一點，全用金額） =====
  function renderWeeklyAccountChart(weekly){
    var ctx = $('#chWeekly');
    if(!ctx) return;
    if(chWeekly){ chWeekly.destroy(); chWeekly=null; }

    if(!weekly.length){
      chWeekly = new Chart(ctx,{type:'line',data:{labels:[],datasets:[]},options:{}});
      return;
    }

    var labels=[], principal=[], cashArr=[], costArr=[], equityArr=[], unrealPos=[], unrealNeg=[], realizedArr=[];
    for(var i=0;i<weekly.length;i++){
      var w = weekly[i];
      var d = w.date;
      var st = w.state;
      var label = d.slice(0,4)+'/'+d.slice(4,6)+'/'+d.slice(6,8);
      labels.push(label);
      principal.push(CFG.capital);
      cashArr.push(st.cash);
      costArr.push(st.cost);
      equityArr.push(st.equity);
      realizedArr.push(st.realized);
      var u = st.unreal || 0;
      if(u >= 0){
        unrealPos.push(u);
        unrealNeg.push(null);
      }else{
        unrealPos.push(null);
        unrealNeg.push(u);
      }
    }

    chWeekly = new Chart(ctx,{
      data:{
        labels:labels,
        datasets:[
          {
            type:'line',
            label:'本金 (NT$)',
            data:principal,
            borderColor:'#9ca3af',
            borderWidth:1,
            borderDash:[4,4],
            pointRadius:0,
            yAxisID:'y'
          },
          {
            type:'line',
            label:'現金 (NT$)',
            data:cashArr,
            borderColor:'#fbbf24',
            backgroundColor:'#facc15',
            borderWidth:2,
            pointRadius:0,
            yAxisID:'y'
          },
          {
            type:'line',
            label:'持股成本 (NT$)',
            data:costArr,
            borderColor:'#3b82f6',
            backgroundColor:'#3b82f6',
            borderWidth:2,
            pointRadius:0,
            yAxisID:'y'
          },
          {
            type:'line',
            label:'帳戶總值 (NT$)',
            data:equityArr,
            borderColor:'#ef4444',
            backgroundColor:'#ef4444',
            borderWidth:2,
            pointRadius:0,
            yAxisID:'y'
          },
          {
            type:'bar',
            label:'未實現盈虧 (NT$)',
            data:unrealPos,
            yAxisID:'y',
            backgroundColor:'rgba(220,38,38,0.45)'
          },
          {
            type:'bar',
            label:'未實現虧損 (NT$)',
            data:unrealNeg,
            yAxisID:'y',
            backgroundColor:'rgba(22,163,74,0.45)'
          },
          {
            type:'line',
            label:'已實現損益 (NT$)',
            data:realizedArr,
            yAxisID:'y',
            borderColor:'#f97316',
            borderWidth:2,
            pointRadius:0
          }
        ]
      },
      options:{
        responsive:true,
        maintainAspectRatio:false,
        plugins:{
          legend:{display:true},
          tooltip:{
            callbacks:{
              label:function(ctx){
                var v = ctx.parsed.y;
                return ctx.dataset.label+'：'+fmtInt(v||0)+' 元';
              }
            }
          }
        },
        scales:{
          y:{
            position:'left',
            title:{display:true,text:'金額 (NT$)'},
            ticks:{callback:function(v){ return fmtInt(v); }}
          },
          x:{
            ticks:{maxTicksLimit:20}
          }
        }
      }
    });
  }

  // ===== KPI 計算（與前版相同，使用 dayPnL + maeList） =====
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
  function downsideStd(rets){
    var n=rets.length,i,neg=new Array(n);
    for(i=0;i<n;i++) neg[i]=Math.min(0,rets[i]);
    var mean=0; for(i=0;i<n;i++) mean+=neg[i]; mean/=n;
    var varD=0;
    for(i=0;i<n;i++) varD+=Math.pow(Math.min(0,rets[i])-mean,2);
    varD/=n; return Math.sqrt(varD);
  }
  function sharpe(annRet, annVol, rf){ return annVol>0 ? (annRet-rf)/annVol : 0; }
  function calmar(annRet, mdd){ return mdd<0 ? (annRet/Math.abs(mdd)) : 0; }

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
    var so=sortino(annRent=annRet, annDown=dStd, rf=CFG.rf); // we don't actually use so in score,保留可擴充
    var mar=annRet/Math.max(1,Math.abs(mdd));
    var mart= (ui>0 ? (eq[eq.length-1]/ui) : 0);

    var grossWin=sells.filter(function(s){return (s.pnlFull||0)>0;}).reduce(function(a,b){return a+(b.pnlFull||0);},0);
    var grossLoss=sells.filter(function(s){return (s.pnlFull||0)<0;}).reduce(function(a,b){return a+(b.pnlFull||0);},0);
    var pf=grossLoss<0? (grossWin/Math.abs(grossLoss)) : (grossWin>0?Infinity:0);

    var nTrades=sells.length;
    var hits=sells.filter(function(s){return (s.pnlFull||0)>0;}).length;
    var hitRate=nTrades? hits/nTrades : 0;

    var avgWin=hits? grossWin/hits : 0;
    var avgLoss=(nTrades-hits)? Math.abs(grossLoss)/(nTrades-hits) : 0;
    var payoff=avgLoss>0? avgWin/avgLoss : Infinity;
    var expectancy=nTrades? (grossWin+grossLoss)/nTrades : 0;

    var TU=timeUnderwater(eq), ST = streaks(tradePnl);

    var grossBuy=bt.trades.filter(function(t){return t.kind==='BUY';}).reduce(function(a,b){return a+b.price*b.shares;},0);
    var grossSell=bt.trades.filter(function(t){return t.kind==='SELL';}).reduce(function(a,b){return a+b.price*b.shares;},0);
    var feeSum=bt.trades.reduce(function(a,b){return a+(b.fee||0);},0);
    var taxSum=bt.trades.reduce(function(a,b){return a+(b.tax||0);},0);
    var turnover=CFG.capital? (grossBuy+grossSell)/CFG.capital : 0;
    var costRatio=(grossBuy+grossSell)>0? (feeSum+taxSum)/(grossBuy+grossSell) : 0;

    var M = (function(){
      var arr = [];
      var map = new Map();
      bt.dayPnL.forEach(function(v,day){
        var mKey = day.slice(0,6);
        map.set(mKey,(map.get(mKey)||0)+v);
      });
      var ks = Array.from(map.keys());
      for(var i=0;i<ks.length;i++){ arr.push(map.get(ks[i])||0); }
      return statsBasic(arr);
    })();

    var maeAvgAbs=0, maeWorst=0;
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

    var daysCount = days.length;

    return {
      total:total,totalReturn:totalReturn,annRet:annRet,bestWeek:bestWeekFromWeekly(bt.weeks),worstWeek:worstWeekFromWeekly(bt.weeks),
      avgTrade:avgTradeFromTrades(sells),medTrade:medTradeFromTrades(tradePnl),
      mdd:mdd,annVol:annVol,dStd:dStd,ui:ui,mart:mart,volWeekly:M.std,min:R.min,max:R.max,std:R.std,
      sr:sr,so:0,cal:calmar(annRet,mdd),mar:mar,pf:pf,expectancy:expectancy,hitRate:hitRate,avgWin:avgWin,avgLoss:avgLoss,
      maxTU:TU.maxTU,totalTU:TU.totalTU,maxWinStreak:ST.maxWinStreak,maxLossStreak:ST.maxLossStreak,skew:R.skew,kurt:R.kurt,days:daysCount,
      grossBuy:grossBuy,grossSell:grossSell,feeSum:feeSum,taxSum:taxSum,turnover:turnover,costRatio:costRatio,totalExecs:bt.trades.length,unitShares:CFG.unit,
      tradeCount:sells.length,
      posCount:tradePnl.filter(function(x){return x>0;}).length,
      zeroCount:tradePnl.filter(function(x){return x===0;}).length,
      negCount:tradePnl.filter(function(x){return x<0;}).length,
      posRatio:sells.length? tradePnl.filter(function(x){return x>0;}).length/sells.length : 0,
      negRatio:sells.length? tradePnl.filter(function(x){return x<0;}).length/sells.length : 0,
      omega:omega(dailyRet||[],0),
      pnlStd:statsBasic(tradePnl).std,
      monthHit:(function(){
        var m=0,tot=0;
        var mm = new Map();
        bt.dayPnL.forEach(function(v,day){
          var mk = day.slice(0,6);
          mm.set(mk,(mm.get(mk)||0)+v);
        });
        var ks = Array.from(mm.keys());
        ks.forEach(function(k){
          tot++;
          if(mm.get(k)>0) m++;
        });
        return tot? m/tot : 0;
      })(),
      maeAvgAbs:maeAvgAbs,
      maeWorst:maeWorst,
      recoveryDays:recoveryDays(eq)
    };
  }

  function bestWeekFromWeekly(weeks){
    var vals = Array.from(weeks.values());
    if(!vals.length) return 0;
    return Math.max.apply(null,vals);
  }
  function worstWeekFromWeekly(weeks){
    var vals = Array.from(weeks.values());
    if(!vals.length) return 0;
    return Math.min.apply(null,vals);
  }
  function avgTradeFromTrades(sells){
    if(!sells.length) return 0;
    var s=0; for(var i=0;i<sells.length;i++) s += sells[i].pnlFull||0;
    return s / sells.length;
  }
  function medTradeFromTrades(arr){
    if(!arr.length) return 0;
    var a = arr.slice().sort(function(a,b){return a-b;});
    var m = Math.floor(a.length/2);
    return a.length%2 ? a[m] : (a[m-1]+a[m])/2;
  }

  // ===== KPI 表格（單表 + Score） =====
  function bandTxt(score){
    return score===0 ? 'Strong（強）'
         : score===1 ? 'Adequate（可接受）'
         : 'Improve（需優化）';
  }
  function bandAdvice(score){ return score===2 ? '建議優化' : '維持監控'; }

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
    // 原始 Worst MAE%（依 % 顯示，方便對照）
    pushRow('Worst MAE%（單筆最大浮虧）',{disp:(k.maeWorst?k.maeWorst.toFixed(2)+'%':'—'),raw:Math.abs(k.maeWorst)},'maeWorst','≤15%');

    // 效率
    pushRow('Sharpe',{disp:k.sr.toFixed(2),raw:k.sr},'sr','≥1.5');
    pushRow('Sortino',{disp:k.so.toFixed(2),raw:k.so},'so','≥1.5');
    pushRow('Calmar',{disp:k.cal? k.cal.toFixed(2):'0.00',raw:k.cal||0},'cal','≥0.5');
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

    // ===== 排序 & 渲染 =====
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

  // ===== 交易明細（沿用你原本的格式） =====
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
    var lines = normalize(rawText);
    if(!lines.length){ alert('TXT 為空'); return; }

    var header = lines[0];
    applyHeaderParams(header);
    renderParams(header);
    refreshChips();

    // 解析交易 & 日線 & MAE
    var rows = toCanon(lines);
    var dailyCloses = extractDailyCloses(lines);
    var maeList = extractMAEInfoFromLines(lines);

    // 交易回測（給 KPI / 交易明細）
    var bt = backtest(rows);

    // 日級資金/持股模擬 → 週級帳戶狀態
    var stateByDay = buildDailyState(rows, dailyCloses);
    var weekly = buildWeeklySeries(stateByDay);

    // 畫帳戶資金/風險圖
    renderWeeklyAccountChart(weekly);

    // 渲染交易明細 & KPI
    renderTrades(bt.trades);
    var k = computeKPI(bt, maeList);
    renderKPI(k);
  }

  // 只要 MAE% 列表即可
  function extractMAEInfoFromLines(lines){
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

})();
