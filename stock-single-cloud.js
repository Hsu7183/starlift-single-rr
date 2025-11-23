// 股票雲端單檔分析（簡化版）
// - 讀 1031 TXT（含日線 closeD、買進/賣出、MAE%）
// - 本金 CFG.capital（預設=100萬）
// - 模擬日級資金：cash / cost / value / equity / unreal / realized
// - 以週為單位畫：本金、現金、持股成本、總值 + 未實現盈虧柱狀 + 已實現損益線
// - 下方：簡化版 KPI + Score + 交易明細

(function(){
  'use strict';

  // ===== 小工具 =====
  var $ = function(s){ return document.querySelector(s); };
  var fmtInt = function(n){ return Math.round(n||0).toLocaleString('zh-TW'); };
  var pct = function(v){ return (v==null||!isFinite(v)) ? '—' : (v*100).toFixed(2)+'%'; };
  var setText = function(sel,t){ var el=$(sel); if(el) el.textContent=t; };

  function normalize(txt){
    return (txt||'')
      .replace(/\ufeff/gi,'')
      .replace(/[\u200B-\u200D\uFEFF]/g,'')
      .replace(/[\x00-\x09\x0B-\x1F\x7F]/g,'')
      .replace(/\r\n?/g,'\n')
      .split('\n')
      .map(function(s){ return s.trim(); })
      .filter(function(x){ return !!x; });
  }

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

  function fee(amount){ return Math.max(CFG.minFee, Math.ceil(amount*CFG.feeRate)); }
  function tax(amount){ return Math.max(0, Math.ceil(amount*CFG.taxRate)); }

  // ===== Supabase（雲端選檔） =====
  var SUPABASE_URL  = "https://byhbmmnacezzgkwfkozs.supabase.co";
  var SUPABASE_ANON = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  var BUCKET        = "reports";
  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    global:{ fetch:function(u,o){ o=o||{}; o.cache='no-store'; return fetch(u,o); } }
  });

  var chWeekly = null;

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
      f.arrayBuffer().then(function(buf){
        var best=decodeBest(buf);
        runAll(best.txt);
      });
    });
  }
  if(btnList) btnList.addEventListener('click', listCloud);
  if(btnPrev) btnPrev.addEventListener('click', previewCloud);
  if(btnImp)  btnImp.addEventListener('click', importCloud);

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
      runAll(text);
    });
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
    if(!headerLine){ box.textContent=''; return; }
    var params = [];
    var re = /_(\w+)=([^,]+)/g, m;
    while((m = re.exec(headerLine)) !== null){
      params.push(m[1] + '=' + m[2]);
    }
    box.innerHTML = params.join(' ｜ ');
  }

  // ===== Regex =====
  var ROW_HEAD_RE = /^\s*(\d{8})\s*,\s*(\d{5,6})\s*,\s*([\d.]+)\s*,\s*([^,]+)\s*,/;
  var MAE_RE      = /MAE%\s*=\s*(-?\d+(?:\.\d+)?)/;

  function mapAct(s){
    s = String(s||'').trim();
    if(/^(平賣|賣出)$/i.test(s)) return '平賣';
    if(/^(強制平倉|強平)$/i.test(s)) return '強制平倉';
    if(/^(新買|買進|首買|加碼|再加碼|加碼攤平|再加碼攤平|加碼\s*攤平|再加碼\s*攤平)$/i.test(s)) return '新買';
    if(/^日線$/i.test(s))        return '日線';
    return s;
  }
  function pad6(t){ t=String(t||''); if(t.length===5) t='0'+t; return t.slice(0,6); }

  // ===== 解析交易行 =====
  function parseTrades(lines){
    var rows = [];
    for(var i=0;i<lines.length;i++){
      var l = lines[i];
      var m = ROW_HEAD_RE.exec(l);
      if(!m) continue;
      var date = m[1];
      var time = pad6(m[2]);
      var px   = parseFloat(m[3]);
      var actRaw = m[4].trim();
      var act = mapAct(actRaw);
      if(act === '日線') continue;
      if(!isFinite(px)) continue;

      var row = { ts: date+time, px:px, act:act };

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

      rows.push(row);
    }
    rows.sort(function(a,b){ return a.ts.localeCompare(b.ts); });
    return rows;
  }

  // ===== 日線收盤價 =====
  function extractDailyCloses(lines){
    var map = new Map();
    for(var i=0;i<lines.length;i++){
      var l = lines[i];
      var m = ROW_HEAD_RE.exec(l);
      if(!m) continue;
      var date = m[1];
      var px   = parseFloat(m[3]);
      var actRaw = m[4].trim();
      if(mapAct(actRaw)==='日線' && isFinite(px)){
        map.set(date, px);
      }
    }
    return map;
  }

  // ===== MAE% 列表 =====
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

  // ===== 回測交易（給 KPI & 明細用） =====
  function backtest(tradeRows){
    var shares=0, cash=CFG.capital, cumCost=0, pnlCum=0;
    var trades=[], weeks=new Map(), dayPnL=new Map();

    for(var i=0;i<tradeRows.length;i++){
      var r=tradeRows[i];
      var day = r.ts.slice(0,8);

      if(r.act==='新買'){
        var lotUnits  = r.units || 1;
        var unitSize  = r.lotShares || CFG.unit;
        var addShares = unitSize * lotUnits;
        var px  = r.px;
        var amt = px * addShares;
        var f   = fee(amt);
        var cost= amt + f;

        if(cash >= cost){
          cash    -= cost;
          shares  += addShares;
          cumCost += cost;
          var costAvgDisp = cumCost / shares;

          trades.push({
            ts:r.ts, kind:'BUY', price:px, shares:addShares,
            buyAmount:amt, sellAmount:0, fee:f, tax:0,
            cost:cost, costAvgDisp:costAvgDisp, cumCost:cumCost,
            cumCostDisp:null, priceDiff:null, pnlFull:null, retPctUnit:null, cumPnlFull:pnlCum
          });
        }
      }else if(r.act==='平賣' && shares>0){
        var spx = r.px;
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
          pnlFull:pnlFull, retPctUnit: sellCumCostDisp>0? (pnlFull/sellCumCostDisp):null,
          cumPnlFull:pnlCum
        });

        shares=0;
        cumCost=0;
      }
    }

    return {
      trades:trades,
      weeks:weeks,
      dayPnL:dayPnL,
      endingCash:cash,
      openShares:shares,
      pnlCum:pnlCum
    };
  }

  // ===== 日級資金狀態 =====
  function buildDailyState(trades, dailyCloses){
    var byDay = new Map();
    for(var i=0;i<trades.length;i++){
      var t=trades[i];
      var d=t.ts.slice(0,8);
      var arr=byDay.get(d)||[];
      arr.push(t);
      byDay.set(d,arr);
    }
    byDay.forEach(function(arr){
      arr.sort(function(a,b){ return a.ts.localeCompare(b.ts); });
    });

    var dates = Array.from(dailyCloses.keys()).sort();
    var stateByDay = new Map();

    var cash = CFG.capital;
    var shares = 0;
    var cost = 0;
    var realized = 0;
    var lastClose=null;

    for(var i=0;i<dates.length;i++){
      var d = dates[i];
      var close = dailyCloses.get(d);
      if(!isFinite(close)){
        if(lastClose==null) continue;
        close = lastClose;
      }

      var tlist = byDay.get(d)||[];
      for(var j=0;j<tlist.length;j++){
        var t = tlist[j];
        if(t.kind==='BUY'){
          var amt = t.price * t.shares;
          var f   = fee(amt);
          cash -= (amt+f);
          cost += (amt+f);
          shares += t.shares;
        }else if(t.kind==='SELL'){
          var sam = t.price * t.shares;
          var ff  = fee(sam);
          var tt  = tax(sam);
          var pnl = sam - ff - tt - cost;
          cash += (sam - ff - tt);
          realized += pnl;
          shares = 0;
          cost   = 0;
        }
      }

      var value  = shares * close;
      var equity = cash + value;
      var unreal = value - cost;

      stateByDay.set(d,{
        cash:cash,
        cost:cost,
        value:value,
        equity:equity,
        unreal:unreal,
        realized:realized
      });

      lastClose=close;
    }

    return stateByDay;
  }

  function weekKey(day){
    var dt=new Date(day.slice(0,4)+'-'+day.slice(4,6)+'-'+day.slice(6,8)+'T00:00:00');
    var y=dt.getFullYear(), oneJan=new Date(y,0,1);
    var week=Math.ceil((((dt-oneJan)/86400000)+oneJan.getDay()+1)/7);
    return y+'-W'+(week<10?('0'+week):week);
  }

  function buildWeeklySeries(stateByDay){
    var dates = Array.from(stateByDay.keys());
    dates.sort();
    var res = [];
    var curWeek=null, lastDate=null;

    for(var i=0;i<dates.length;i++){
      var d = dates[i];
      var wk = weekKey(d);
      if(curWeek===null) curWeek=wk;
      if(wk!==curWeek){
        if(lastDate){
          res.push({date:lastDate,week:curWeek,state:stateByDay.get(lastDate)});
        }
        curWeek = wk;
      }
      lastDate = d;
    }
    if(lastDate){
      res.push({date:lastDate,week:weekKey(lastDate),state:stateByDay.get(lastDate)});
    }
    return res;
  }

  // ===== 帳戶資金 / 風險週線圖 =====
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
      var st= w.state;
      labels.push(d.slice(0,4)+'/'+d.slice(4,6)+'/'+d.slice(6,8));
      principal.push(CFG.capital);
      cashArr.push(st.cash);
      costArr.push(st.cost);
      equityArr.push(st.equity);
      realizedArr.push(st.realized);
      var u = st.unreal||0;
      if(u>=0){
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
            borderColor:'#facc15',
            borderWidth:2,
            pointRadius:0,
            yAxisID:'y'
          },
          {
            type:'line',
            label:'持股成本 (NT$)',
            data:costArr,
            borderColor:'#3b82f6',
            borderWidth:2,
            pointRadius:0,
            yAxisID:'y'
          },
          {
            type:'line',
            label:'帳戶總值 (NT$)',
            data:equityArr,
            borderColor:'#ef4444',
            borderWidth:2,
            pointRadius:0,
            yAxisID:'y'
          },
          {
            type:'bar',
            label:'未實現盈餘 (NT$)',
            data:unrealPos,
            backgroundColor:'rgba(248,113,113,0.45)',
            yAxisID:'y'
          },
          {
            type:'bar',
            label:'未實現虧損 (NT$)',
            data:unrealNeg,
            backgroundColor:'rgba(34,197,94,0.45)',
            yAxisID:'y'
          },
          {
            type:'line',
            label:'累積已實現損益 (NT$)',
            data:realizedArr,
            borderColor:'#f97316',
            borderWidth:2,
            pointRadius:0,
            yAxisID:'y'
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
            title:{display:true,text:'金額 (NT$)'},
            ticks:{callback:function(v){ return fmtInt(v); }}
          },
          x:{ticks:{maxTicksLimit:20}}
        }
      }
    });
  }

  // ===== 簡化 KPI（先確認圖有跑：TotalReturn / AnnRet / MaxDD / Vol / Hit / PF / AvgTrade / MAE） =====
  function seriesFromDayPnL(dayPnL){
    var days = Array.from(dayPnL.keys()).sort();
    var pnl  = days.map(function(d){ return dayPnL.get(d)||0; });
    var eq=[], acc=0;
    for(var i=0;i<pnl.length;i++){ acc+=pnl[i]; eq.push(acc); }
    return {days:days, pnl:pnl, eq:eq};
  }
  function statsBasic(arr){
    var n=arr.length; if(!n) return {n:n,mean:0,std:0,min:0,max:0};
    var i, mean=0; for(i=0;i<n;i++) mean+=arr[i]; mean/=n;
    var v=0; for(i=0;i<n;i++) v+=(arr[i]-mean)*(arr[i]-mean); v/=n;
    var std=Math.sqrt(v), min=Math.min.apply(null,arr), max=Math.max.apply(null,arr);
    return {n:n,mean:mean,std:std,min:min,max:max,stdDev:std};
  }
  function maxDrawdown(eq){
    var peak=eq[0]||0, mdd=0, i, dd;
    for(i=0;i<eq.length;i++){ if(eq[i]>peak) peak=eq[i]; dd=eq[i]-peak; if(dd<mdd) mdd=dd; }
    return { mdd:mdd };
  }

  function computeKPI(bt, maeList){
    var sells=bt.trades.filter(function(x){return x.kind==='SELL';});
    var tradePnl=sells.map(function(x){return x.pnlFull||0;});

    var S  = seriesFromDayPnL(bt.dayPnL);
    var eq = S.eq;
    var pnlDay = S.pnl;

    var total = eq.length? eq[eq.length-1] : 0;
    var totalReturn = CFG.capital? total/CFG.capital : 0;

    var dailyRet = pnlDay.map(function(v){ return CFG.capital? v/CFG.capital : 0; });
    var statRet  = statsBasic(dailyRet);
    var annRet   = statRet.mean * 252;
    var annVol   = statRet.stdDev * Math.sqrt(252);

    var mddObj = maxDrawdown(eq);
    var mdd    = mddObj.mdd;

    var nTrades=sells.length;
    var hits   =sells.filter(function(s){return (s.pnlFull||0)>0;}).length;
    var hitRate=nTrades? hits/nTrades : 0;

    var grossWin=sells.filter(function(s){return (s.pnlFull||0)>0;}).reduce(function(a,b){return a+(b.pnlFull||0);},0);
    var grossLoss=sells.filter(function(s){return (s.pnlFull||0)<0;}).reduce(function(a,b){return a+(b.pnlFull||0);},0);
    var pf=grossLoss<0? (grossWin/Math.abs(grossLoss)) : (grossWin>0?Infinity:0);

    var avgTrade = nTrades? tradePnl.reduce(function(a,b){return a+b;},0)/nTrades : 0;

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

    return {
      total:total,
      totalReturn:totalReturn,
      annRet:annRet,
      mdd:mdd,
      annVol:annVol,
      hitRate:hitRate,
      pf:pf,
      avgTrade:avgTrade,
      maeAvgAbs:maeAvgAbs,
      maeWorst:maeWorst,
      tradeCount:nTrades
    };
  }

  function bandTxt(score){
    return score===0 ? 'Strong（強）'
         : score===1 ? 'Adequate（可接受）'
         : 'Improve（需優化）';
  }
  function bandAdvice(score){ return score===2 ? '建議優化' : '維持監控'; }

  function scoreMetric(key, raw){
    if(key==='annVol' || key==='mdd'){
      return raw<=0.15 ? 0 : (raw<=0.25 ? 1 : 2);
    }
    if(key==='pf' || key==='annRet' || key==='totalReturn'){
      return raw>=0.10 ? 0 : (raw>=0.05 ? 1 : 2);
    }
    if(key==='hitRate'){
      return raw>=0.55 ? 0 : (raw>=0.45 ? 1 : 2);
    }
    if(key==='maeAvgAbs'){
      return raw<=5 ? 0 : (raw<=10 ? 1 : 2);
    }
    return 1;
  }

  function renderKPI(k){
    var rows = [];

    function push(name, disp, key, raw, ref){
      var sc = scoreMetric(key,raw);
      var cls = sc===2?'improve-row':(sc===0?'ok-row':'');
      rows.push({name:name,disp:disp,key:key,raw:raw,ref:ref,score:sc,cls:cls});
    }

    push('總報酬（Total Return）', pct(k.totalReturn), 'totalReturn', k.totalReturn, '—');
    push('年化報酬（Ann. Return）', pct(k.annRet), 'annRet', k.annRet, '≥10%');
    push('最大回撤（MaxDD，本金）', pct(Math.abs(k.mdd)/CFG.capital), 'mdd', Math.abs(k.mdd)/CFG.capital, '≤15%');
    push('年化波動（Ann. Vol）', pct(k.annVol), 'annVol', k.annVol, '≤15%');
    push('勝率（Hit Rate）', pct(k.hitRate), 'hitRate', k.hitRate, '≥50%');
    push('獲利因子（PF）', isFinite(k.pf)?k.pf.toFixed(2):'∞', 'pf', k.pf, '≥1.5');
    push('平均每筆損益（Avg Trade）', fmtInt(k.avgTrade), 'avgTrade', k.avgTrade, '—');
    push('Average MAE%（平均浮虧）', k.maeAvgAbs.toFixed(2)+'%', 'maeAvgAbs', k.maeAvgAbs, '≤5%');
    push('Worst MAE%（單筆最大浮虧）', k.maeWorst.toFixed(2)+'%', 'maeWorst', Math.abs(k.maeWorst), '≤15%');
    push('#Trades (SELL)', String(k.tradeCount), 'tradeCount', k.tradeCount, '—');

    // Score：上面幾個指標平均打分
    var sumScore=0;
    for(var i=0;i<rows.length;i++){
      sumScore += (2-rows[i].score); // 0→2,1→1,2→0
    }
    var score = (sumScore/(rows.length*2))*100;
    setText('#scoreLine','Score：'+score.toFixed(1)+' / 100');

    var table = $('#kpiAll');
    if(!table) return;
    var tb = table.querySelector('tbody');
    if(!tb){ tb=document.createElement('tbody'); table.appendChild(tb); }

    var html='';
    for(var j=0;j<rows.length;j++){
      var r=rows[j];
      html+='<tr class="'+r.cls+'">'
          + '<td>'+r.name+'</td>'
          + '<td>'+r.disp+'</td>'
          + '<td>'+bandAdvice(r.score)+'</td>'
          + '<td>'+bandTxt(r.score)+'</td>'
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

    var html='', i, e, isSell, pnlCell, cumCell, retCell,
        priceDiffCell, costAvgCell, cumCostCell, costCell,
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

    var trades      = parseTrades(lines);
    var dailyClose  = extractDailyCloses(lines);
    var maeList     = extractMaeList(lines);
    var bt          = backtest(trades);

    var dailyState  = buildDailyState(bt.trades, dailyClose);
    var weekly      = buildWeeklySeries(dailyState);

    renderWeeklyAccountChart(weekly);
    renderTrades(bt.trades);
    renderKPI(computeKPI(bt, maeList));
  }

})();
