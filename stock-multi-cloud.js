// 股票｜雲端多檔分析（KPI49 簡表）
//
// 核心原則：
// 1) 解析 / 費稅 / 回測 / KPI 計算邏輯，完全沿用 stock-single-cloud.js。
// 2) 每單位固定 1 張 = 1000 股，不再被 lotShares 或 URL ?unit= 覆蓋。
// 3) 支援 canonical & 1031-CSV（買進 / 加碼攤平 / 再加碼攤平 / 賣出）。
// 4) 一次讀多個 TXT，輸出：多檔 KPI 簡表 + 單檔每日累積損益曲線。

(function(){
  'use strict';

  // ===== DOM & 小工具 =====
  function $(s){ return document.querySelector(s); }
  function fmtInt(n){ return Math.round(n||0).toLocaleString('zh-TW'); }
  function pct(v){ return (v==null||!isFinite(v)) ? '0.00%' : (v*100).toFixed(2)+'%'; }
  function setText(sel,t){ var el=$(sel); if(el) el.textContent=t; }
  function clamp(v,lo,hi){ return Math.max(lo,Math.min(hi,v)); }
  function nowStr(){
    var d=new Date(); var p=x=>(x<10?'0':'')+x;
    return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());
  }
  function tsToDate(ts){
    var s=String(ts||''); var y=s.slice(0,4), m=s.slice(4,6), d=s.slice(6,8);
    return (y&&m&&d)? (y+'/'+m+'/'+d) : s;
  }

  function safeHead(text){
    if(!text) return '';
    var lines=text.split(/\r?\n/);
    return (lines[0]||'').trim();
  }
  function slimNums(s){
    if(!s) return '';
    var t=s
      .replace(/(-?\d+\.\d*?[1-9])0+\b/g,'$1')
      .replace(/(-?\d+)\.0+\b/g,'$1');
    return t.replace(/\s{2,}/g,' ');
  }
  function shortName(name){
    var base=name.split(/[\\/]/).pop().replace(/\.[^.]+$/,'');
    var m=base.match(/(\d{8})_(\d{6})/);
    if(!m) return base;
    var mmdd=m[1].slice(4,8);
    return mmdd+'_'+m[2];
  }

  // ===== CFG & URL =====
  var url=new URL(location.href);
  var CFG={
    feeRate: +(url.searchParams.get('fee') || 0.001425),
    minFee : +(url.searchParams.get('min') || 20),
    taxRate: +(url.searchParams.get('tax') || 0.003), // 預設個股 0.3%
    unit   : 1000,                                     // ★ 固定 1 張 = 1000 股
    slip   : +(url.searchParams.get('slip')|| 0),
    capital: +(url.searchParams.get('cap') || 1000000),
    rf     : +(url.searchParams.get('rf')  || 0.00)
  };

  var taxScheme=$('#taxScheme');
  var taxCustom=$('#taxCustom');
  var userForcedScheme=false;

  function refreshChips(){
    setText('#feeRateChip',(CFG.feeRate*100).toFixed(4)+'%');
    setText('#taxRateChip',(CFG.taxRate*100).toFixed(3)+'%');
    setText('#minFeeChip',String(CFG.minFee));
    setText('#unitChip',String(CFG.unit));
    setText('#slipChip',String(CFG.slip));
    setText('#rfChip',(CFG.rf*100).toFixed(2)+'%');
  }
  refreshChips();

  // ===== Supabase =====
  var SUPABASE_URL  = "https://byhbmmnacezzgkwfkozs.supabase.co";
  var SUPABASE_ANON = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  var BUCKET        = "reports";
  var sb = window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON,{
    global:{fetch:function(u,o){o=o||{};o.cache='no-store';return fetch(u,o);}}
  });

  // ===== 狀態 =====
  var rows=[];          // 多檔彙總
  var currentIdx=-1;
  var chMulti=null;

  // ===== 稅率方案事件 =====
  if(taxScheme){
    taxScheme.addEventListener('change',function(){
      userForcedScheme=true;
      if(taxScheme.value==='ETF'){
        CFG.taxRate=0.001; taxCustom.disabled=true;
      }else if(taxScheme.value==='STOCK'){
        CFG.taxRate=0.003; taxCustom.disabled=true;
      }else{
        taxCustom.disabled=false;
        var v=parseFloat(taxCustom.value);
        if(isFinite(v)) CFG.taxRate=clamp(v,0,1);
      }
      refreshChips();
    });
  }
  if(taxCustom){
    taxCustom.addEventListener('input',function(){
      if(taxScheme.value!=='CUSTOM') return;
      var v=parseFloat(taxCustom.value);
      if(isFinite(v)){ CFG.taxRate=clamp(v,0,1); refreshChips(); }
    });
  }

  // ===== Supabase 雲端選檔 =====
  var prefix=$('#cloudPrefix'), btnList=$('#btnCloudList'), pick=$('#cloudSelect'),
      btnPrev=$('#btnCloudPreview'), btnImp=$('#btnCloudImport'),
      meta=$('#cloudMeta'), prev=$('#cloudPreview');

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
  function getUrl(path){
    return sb.storage.from(BUCKET).createSignedUrl(path,3600).then(function(r){
      if(r && r.data && r.data.signedUrl) return r.data.signedUrl;
      var pub=sb.storage.from(BUCKET).getPublicUrl(path);
      return pub && pub.data ? pub.data.publicUrl : '';
    });
  }

  function listCloud(){
    prev.textContent=''; meta.textContent='';
    pick.innerHTML='<option value="">載入中…</option>';
    var p=(prefix.value||'').trim();
    var fixed=p && p.charAt(p.length-1)!=='/' ? (p+'/'):p;
    sb.storage.from(BUCKET).list(fixed,{limit:1000,sortBy:{column:'name',order:'asc'}})
      .then(function(r){
        if(r.error){pick.innerHTML='<option>讀取失敗：'+r.error.message+'</option>';return;}
        var data=r.data||[],i,it,path,opt,kb;
        if(!data.length){pick.innerHTML='<option>（無檔案）</option>';return;}
        pick.innerHTML='';
        for(i=0;i<data.length;i++){
          it=data[i];
          if(it.id===null && !it.metadata) continue;
          path=(fixed||'')+it.name;
          opt=document.createElement('option');
          kb=it.metadata&&it.metadata.size?(it.metadata.size/1024).toFixed(1):'-';
          opt.value=path;
          opt.textContent=path+' ('+kb+' KB)';
          pick.appendChild(opt);
        }
      });
  }
  function previewCloud(){
    prev.textContent=''; meta.textContent='';
    var opts=pick && pick.selectedOptions ? pick.selectedOptions : null;
    if(!opts || !opts.length) return;
    var path=opts[0].value; if(!path) return;
    getUrl(path).then(function(u){
      if(!u){prev.textContent='取得連結失敗';return null;}
      return fetch(u,{cache:'no-store'});
    }).then(function(r){
      if(!r){return null;} if(!r.ok){prev.textContent='HTTP '+r.status;return null;}
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
    var opts=pick && pick.selectedOptions ? pick.selectedOptions : null;
    if(!opts || !opts.length){alert('請先選擇一個以上檔案');return;}
    var pairs=[], pending=opts.length;
    for(var i=0;i<opts.length;i++){
      (function(opt){
        var path=opt.value;
        getUrl(path).then(function(u){
          if(!u){console.error('取得連結失敗',path); if(--pending===0) handlePairs(pairs); return null;}
          return fetch(u,{cache:'no-store'});
        }).then(function(r){
          if(!r){if(--pending===0) handlePairs(pairs); return null;}
          if(!r.ok){console.error('HTTP',r.status,path); if(--pending===0) handlePairs(pairs); return null;}
          return r.arrayBuffer();
        }).then(function(ab){
          if(!ab){if(--pending===0) handlePairs(pairs); return;}
          var best=decodeBest(ab);
          pairs.push({name:path,text:best.txt});
          if(--pending===0) handlePairs(pairs);
        });
      })(opts[i]);
    }
  }
  if(btnList) btnList.addEventListener('click',listCloud);
  if(btnPrev) btnPrev.addEventListener('click',previewCloud);
  if(btnImp)  btnImp.addEventListener('click',importCloud);

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
  function pad6(t){
    t=String(t||''); if(t.length===5) t='0'+t; return t.slice(0,6);
  }
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
    var out=[], i,l,m,d8,t6,px,act,row,um;
    for(i=0;i<lines.length;i++){
      l=lines[i];

      m=l.match(CANON_RE);
      if(m){
        row={ts:m[1],px:+m[2],act:m[3]};
      }else{
        m=l.match(CSV_RE);
        if(!m) continue;
        d8=m[1]; t6=pad6(m[2]); px=+m[3]; act=mapAct(m[4]);
        if(!isFinite(px)||!/^\d{6}$/.test(t6)) continue;
        row={ts:d8+t6,px:px,act:act};
      }

      // unitsThis / 本次單位
      um=l.match(/unitsThis\s*=\s*(\d+)/);
      if(!um) um=l.match(/本次單位\s*=\s*(\d+)/);
      row.units = um ? Math.max(1,parseInt(um[1],10)) : 1;

      out.push(row);
    }
    out.sort(function(a,b){return a.ts.localeCompare(b.ts);});
    return out;
  }

  // ===== 手續費 / 稅（沿用單檔版） =====
  function fee(amount){ return Math.max(CFG.minFee,Math.ceil(amount*CFG.feeRate)); }
  function tax(amount){ return Math.max(0,Math.ceil(amount*CFG.taxRate)); }

  // ===== 自動偵測稅率方案 =====
  function autoPickSchemeByContent(name,txt){
    if(userForcedScheme) return;
    var s=(name||'')+' '+(txt||'');
    var isETF   = /(?:^|[^0-9])(?:00909|00910|0050)(?:[^0-9]|$)/.test(s);
    var isStock = /(?:^|[^0-9])(?:2603)(?:[^0-9]|$)|長榮/.test(s);
    if(isETF && !isStock){
      taxScheme.value='ETF';  CFG.taxRate=0.001; if(taxCustom) taxCustom.disabled=true;
    }else if(isStock && !isETF){
      taxScheme.value='STOCK';CFG.taxRate=0.003; if(taxCustom) taxCustom.disabled=true;
    }else{
      if(CFG.taxRate===0.001){taxScheme.value='ETF';  if(taxCustom) taxCustom.disabled=true;}
      else if(CFG.taxRate===0.003){taxScheme.value='STOCK';if(taxCustom) taxCustom.disabled=true;}
      else{
        taxScheme.value='CUSTOM';
        if(taxCustom){taxCustom.disabled=false; taxCustom.value=CFG.taxRate.toFixed(4);}
      }
    }
    refreshChips();
  }

  // ===== 回測（完全沿用單檔版邏輯，只保留 BUY/SELL） =====
  function backtest(rowsCanon){
    var shares=0, cash=CFG.capital, cumCost=0, pnlCum=0;
    var trades=[], dayPnL=new Map();

    for(var i=0;i<rowsCanon.length;i++){
      var r=rowsCanon[i];

      if(r.act==='新買'){
        var lotUnits  = r.units || 1;
        var sharesInc = CFG.unit * lotUnits;

        var px  = r.px + CFG.slip;
        var amt = px * sharesInc;
        var f   = fee(amt);
        var cost= amt + f;

        if(cash >= cost){
          cash    -= cost;
          shares  += sharesInc;
          cumCost += cost;

          trades.push({
            ts:r.ts, kind:'BUY', price:px, shares:sharesInc,
            buyAmount:amt, sellAmount:0, fee:f, tax:0,
            cost:cost, cumCost:cumCost,
            pnlFull:null, cumPnlFull:pnlCum
          });
        }

      }else if(r.act==='平賣' && shares>0){
        var spx = r.px - CFG.slip;
        var sam = spx * shares;
        var ff  = fee(sam);
        var tt  = tax(sam);
        cash   += (sam - ff - tt);

        var pnlFull = (sam - ff - tt) - cumCost;
        pnlCum += pnlFull;

        var day = r.ts.slice(0,8);
        dayPnL.set(day,(dayPnL.get(day)||0)+pnlFull);

        trades.push({
          ts:r.ts, kind:'SELL', price:spx, shares:shares,
          buyAmount:0, sellAmount:sam, fee:ff, tax:tt,
          cost:0, cumCost:cumCost,
          pnlFull:pnlFull, cumPnlFull:pnlCum
        });

        shares=0; cumCost=0;
      }
    }

    return { trades:trades, dayPnL:dayPnL, pnlCum:pnlCum, endingCash:cash, openShares:shares };
  }

  // ===== KPI 計算（抽出單檔版核心） =====
  function seriesFromDayPnL(dayPnL){
    var days=Array.from(dayPnL.keys()).sort();
    var pnl =days.map(function(d){return dayPnL.get(d)||0;});
    var eq=[], acc=0;
    for(var i=0;i<pnl.length;i++){acc+=pnl[i];eq.push(acc);}
    return {days:days,pnl:pnl,eq:eq};
  }
  function statsBasic(arr){
    var n=arr.length; if(!n) return {n:n,mean:0,std:0,min:0,max:0};
    var i,mean=0; for(i=0;i<n;i++) mean+=arr[i]; mean/=n;
    var v=0; for(i=0;i<n;i++) v+=(arr[i]-mean)*(arr[i]-mean); v/=n;
    var std=Math.sqrt(v);
    var min=Math.min.apply(null,arr), max=Math.max.apply(null,arr);
    return {n:n,mean:mean,std:std,min:min,max:max};
  }
  function maxDrawdown(eq){
    var peak=eq[0]||0, mdd=0,i,dd;
    for(i=0;i<eq.length;i++){
      if(eq[i]>peak) peak=eq[i];
      dd=eq[i]-peak;
      if(dd<mdd) mdd=dd;
    }
    return {mdd:mdd};
  }
  function downsideStd(rets){
    var n=rets.length,i,neg=new Array(n);
    for(i=0;i<n;i++) neg[i]=Math.min(0,rets[i]);
    var mean=0; for(i=0;i<n;i++) mean+=neg[i]; mean/=n;
    var varD=0;
    for(i=0;i<n;i++) varD+=Math.pow(Math.min(0,rets[i])-mean,2);
    varD/=n;
    return Math.sqrt(varD);
  }
  function sharpe(annRet,annVol,rf){return annVol>0?(annRet-rf)/annVol:0;}
  function sortino(annRet,annDown,rf){return annDown>0?(annRet-rf)/annDown:0;}

  function computeKPI(bt){
    var sells=bt.trades.filter(function(x){return x.kind==='SELL';});
    var tradePnl=sells.map(function(x){return x.pnlFull||0;});

    var S=seriesFromDayPnL(bt.dayPnL);
    var days=S.days, eqIncr=S.pnl, eq=S.eq;
    var annualFactor=252;
    var total=eq.length?eq[eq.length-1]:0;

    var dailyRet=eqIncr.map(function(v){return v/CFG.capital;});
    var R=statsBasic(dailyRet);
    var annRet=R.mean*annualFactor;
    var annVol=R.std*Math.sqrt(annualFactor);
    var dStd=downsideStd(dailyRet)*Math.sqrt(annualFactor);
    var mdd=maxDrawdown(eq).mdd;

    var sr=sharpe(annRet,annVol,CFG.rf);
    var so=sortino(annRet,dStd,CFG.rf);

    var hits=sells.filter(function(s){return (s.pnlFull||0)>0;}).length;
    var nTrades=sells.length;
    var grossWin=sells.filter(function(s){return (s.pnlFull||0)>0;})
                      .reduce(function(a,b){return a+(b.pnlFull||0);},0);
    var grossLoss=sells.filter(function(s){return (s.pnlFull||0)<0;})
                       .reduce(function(a,b){return a+(b.pnlFull||0);},0);
    var pf=grossLoss<0?(grossWin/Math.abs(grossLoss)):(grossWin>0?Infinity:0);
    var hitRate=nTrades?hits/nTrades:0;

    var tradesPerMonth=0;
    if(nTrades>0){
      var firstTs=sells[0].ts, lastTs=sells[nTrades-1].ts;
      var fY=+firstTs.slice(0,4), fM=+firstTs.slice(4,6)-1, fD=+firstTs.slice(6,8);
      var lY=+lastTs.slice(0,4),  lM=+lastTs.slice(4,6)-1,  lD=+lastTs.slice(6,8);
      var firstDate=new Date(fY,fM,fD), lastDate=new Date(lY,lM,lD);
      var ms=lastDate-firstDate;
      var months=ms>0?(ms/1000/60/60/24/30.4):0;
      tradesPerMonth=months>0?(nTrades/months):nTrades;
    }

    return {
      annRet:annRet,
      annVol:annVol,
      mdd:mdd,
      sr:sr,
      so:so,
      pf:pf,
      hitRate:hitRate,
      tradesPerMonth:tradesPerMonth,
      eqDays:days,
      eqSeries:eq,
      tradeCount:nTrades
    };
  }

  // ===== 圖表 =====
  function roundRect(ctx,x,y,w,h,r){
    var rr=Math.min(r,w/2,h/2);
    ctx.beginPath();
    ctx.moveTo(x+rr,y);
    ctx.arcTo(x+w,y,x+w,y+h,rr);
    ctx.arcTo(x+w,y+h,x,y+h,rr);
    ctx.arcTo(x,y+h,x,y,rr);
    ctx.arcTo(x,y,x+w,y,rr);
    ctx.closePath();
  }
  function drawChartFor(rec){
    if(!rec) return;
    if(chMulti) chMulti.destroy();

    var labels=rec.eqDays.map(function(_,i){return i;});
    var eq=rec.eqSeries||[];
    if(!eq.length){
      $('#chartCaption').textContent='尚無每日損益資料（可能尚未有 SELL 筆數）。';
      return;
    }

    var idxLast=Math.max(0,eq.length-1), idxMax=0, idxMin=0;
    for(var i=0;i<eq.length;i++){
      if(eq[i]>eq[idxMax]) idxMax=i;
      if(eq[i]<eq[idxMin]) idxMin=i;
    }
    var maxText=fmtInt(eq[idxMax])+' ('+tsToDate(rec.eqDays[idxMax])+')';
    var minText=fmtInt(eq[idxMin])+' ('+tsToDate(rec.eqDays[idxMin])+')';
    var lastText=fmtInt(eq[idxLast]);

    var points=[
      {i:idxMax,val:eq[idxMax],color:'#ef4444',text:maxText},
      {i:idxMin,val:eq[idxMin],color:'#10b981',text:minText},
      {i:idxLast,val:eq[idxLast],color:'#111',text:lastText}
    ];

    var anno={
      id:'anno',
      afterDatasetsDraw:function(c){
        var ctx=c.ctx, x=c.scales.x, y=c.scales.y;
        ctx.save(); ctx.font='12px ui-sans-serif,system-ui'; ctx.textBaseline='middle';
        points.forEach(function(p){
          if(!isFinite(p.val)) return;
          var px=x.getPixelForValue(p.i), py=y.getPixelForValue(p.val);
          ctx.beginPath(); ctx.arc(px,py,5,0,Math.PI*2); ctx.fillStyle=p.color; ctx.fill();
          var pad=6,h=20,w=ctx.measureText(p.text).width+pad*2, bx=px+10, by=py-h/2;
          ctx.fillStyle='rgba(255,255,255,.96)';
          roundRect(ctx,bx,by,w,h,6); ctx.fill();
          ctx.strokeStyle='#111'; ctx.stroke();
          ctx.fillStyle='#111'; ctx.fillText(p.text,bx+pad,by+h/2);
        });
        ctx.restore();
      }
    };

    chMulti=new Chart($('#chMulti'),{
      type:'line',
      data:{labels:labels,datasets:[{
        data:eq,stepped:true,borderColor:'#0d6efd',borderWidth:3,pointRadius:0
      }]},
      options:{
        responsive:true,maintainAspectRatio:false,
        layout:{padding:{right:80}},
        plugins:{legend:{display:false}},
        scales:{
          y:{
            suggestedMin:Math.min(0,Math.min.apply(null,eq.concat([0]))*1.1),
            suggestedMax:Math.max(1,Math.max.apply(null,eq.concat([0]))*1.05)
          },
          x:{ticks:{maxTicksLimit:14}}
        }
      },
      plugins:[anno]
    });

    $('#chartCaption').textContent='目前：'+rec.shortName+'（Max/Min/Last 皆為含滑價與費稅後累積損益）';
  }

  // ===== 表格 =====
  function clsPnL(v){ return v>0?'p-red':(v<0?'p-green':''); }
  function renderTable(){
    var tb=$('#sumTable tbody'); if(!tb) return;
    tb.innerHTML='';
    rows.forEach(function(r,idx){
      var tr=document.createElement('tr');
      if(idx===currentIdx) tr.classList.add('active-row');
      tr.innerHTML=
        '<td>'+r.shortName+'</td>'+
        '<td class="param-cell" title="'+(r.paramsFull||'')+'">'+(r.params||'')+'</td>'+
        '<td class="num">'+r.count+'</td>'+
        '<td class="num">'+pct(r.winRate)+'</td>'+
        '<td class="num '+clsPnL(r.totalPnL)+'">'+fmtInt(r.totalPnL)+'</td>'+
        '<td class="num">-'+fmtInt(r.maxDD)+'</td>'+
        '<td class="num">'+r.PF.toFixed(2)+'</td>'+
        '<td class="num">'+r.sharpe.toFixed(2)+'</td>'+
        '<td class="num">'+r.sortino.toFixed(2)+'</td>'+
        '<td class="num">'+r.MAR.toFixed(2)+'</td>'+
        '<td class="num">'+r.tradesPerMonth.toFixed(2)+'</td>'+
        '<td class="num">'+pct(r.annRet)+'</td>'+
        '<td class="num">'+pct(r.annVol)+'</td>';
      tr.addEventListener('click',function(){
        currentIdx=idx;
        renderTable();
        drawChartFor(rows[idx]);
      });
      tb.appendChild(tr);
    });
    $('#fileCount').textContent=String(rows.length);
  }
  function bindSort(){
    var ths=$('#sumTable thead').querySelectorAll('th');
    ths.forEach(function(th){
      th.onclick=function(){
        var k=th.getAttribute('data-k'); if(!k) return;
        var asc = th.getAttribute('data-asc')!=='1';
        rows.sort(function(a,b){
          if(k==='shortName' || k==='params'){
            var sa=String(a[k]||''), sb=String(b[k]||'');
            return asc ? sa.localeCompare(sb) : sb.localeCompare(sa);
          }
          var x=+a[k] || 0, y=+b[k] || 0;
          return asc ? (x-y):(y-x);
        });
        th.setAttribute('data-asc',asc?'1':'0');
        renderTable();
        if(currentIdx>=0 && currentIdx<rows.length) drawChartFor(rows[currentIdx]);
      };
    });
  }

  // ===== 主流程：多檔處理 =====
  function handlePairs(pairs){
    if(!pairs || !pairs.length) return;
    autoPickSchemeByContent(pairs[0].name,pairs[0].text);

    var newRows=[];
    pairs.forEach(function(p){
      var norm = normalize(p.text);
      var canon= toCanon(norm);

      var bt = backtest(canon);
      var k  = computeKPI(bt);

      var header=slimNums(safeHead(p.text));
      var headerShow=header.length>120 ? header.slice(0,120)+'…' : header;

      newRows.push({
        name:p.name,
        shortName:shortName(p.name),
        params:headerShow,
        paramsFull:header,
        count:k.tradeCount,
        winRate:k.hitRate,
        totalPnL:bt.pnlCum,
        maxDD:Math.abs(k.mdd),
        PF:isFinite(k.pf)?k.pf:0,
        sharpe:isFinite(k.sr)?k.sr:0,
        sortino:isFinite(k.so)?k.so:0,
        MAR:(k.mdd<0? k.annRet/Math.abs(k.mdd) : 0),
        tradesPerMonth:k.tradesPerMonth,
        annRet:k.annRet,
        annVol:k.annVol,
        eqDays:k.eqDays,
        eqSeries:k.eqSeries
      });
    });

    rows=newRows;
    bindSort();
    renderTable();
    $('#importAt').textContent=nowStr();
    if(rows.length>0){
      currentIdx=0;
      drawChartFor(rows[0]);
    }
  }

  // ===== 剪貼簿 / 本機 =====
  var btnClip=$('#btn-clip'), filesInput=$('#files');

  if(btnClip){
    btnClip.addEventListener('click',function(){
      navigator.clipboard.readText().then(function(txt){
        if(!txt){alert('剪貼簿沒有文字');return;}
        var parts=txt.split(/\n-{5,}\n/);
        var pairs=[];
        parts.forEach(function(t,i){
          t=t.trim(); if(t) pairs.push({name:'CLIP_'+(i+1)+'.txt',text:t});
        });
        if(!pairs.length){alert('剪貼簿沒有可用 TXT 內容');return;}
        handlePairs(pairs);
      }).catch(function(){
        alert('無法讀取剪貼簿內容，請改用「選擇檔案」。');
      });
    });
  }

  if(filesInput){
    filesInput.addEventListener('change',function(e){
      var flist=e.target.files||[]; if(!flist.length) return;
      var pairs=[], pending=flist.length;
      Array.prototype.forEach.call(flist,function(f){
        f.arrayBuffer().then(function(buf){
          var best=decodeBest(buf);
          pairs.push({name:f.name,text:best.txt});
          if(--pending===0) handlePairs(pairs);
        });
      });
    });
  }

  // init
  bindSort();
})();
