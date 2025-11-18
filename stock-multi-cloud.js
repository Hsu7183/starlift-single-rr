// 股票｜雲端多檔分析（直接吃指標 TXT 的「稅後損益 / 累積損益」）
// - 解析每個 TXT 檔：只看有「稅後損益=」「累積損益=」的行（賣出行）
// - Summary:
//   * 筆數：賣出筆數
//   * 勝率：稅後損益 > 0 的比例
//   * 累積淨損益：最後一筆累積損益
//   * 最大回撤：依累積損益路徑計算
//   * PF：Σ正向稅後損益 / |Σ負向稅後損益|
//   * Sharpe / Sortino / MAR / 年化報酬 / 波動：用每日稅後損益 / capital 估算
//   * 交易頻率：賣出筆數 / （首筆到末筆的月數）

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
    taxRate: +(url.searchParams.get('tax') || 0.003),
    unit   : +(url.searchParams.get('unit')|| 1000),
    slip   : +(url.searchParams.get('slip')|| 0),
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

  // 週 key
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
    var peak=eq[0]||0, mdd=0, i, dd;
    for(i=0;i<eq.length;i++){
      if(eq[i]>peak) peak=eq[i];
      dd=eq[i]-peak;
      if(dd<mdd) mdd=dd;
    }
    return {mdd:mdd};
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

  // ===== 解析一個 TXT：只抓有「稅後損益=」「累積損益=」的行 =====
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
      if(!pnlMatch) continue;   // 沒稅後損益就不是賣出行

      var cumMatch = CUM_RE.exec(l);

      var pnl = parseInt(pnlMatch[1],10);
      var cum = cumMatch ? parseInt(cumMatch[1],10) : (lastCum + pnl);
      lastCum = cum;

      var ts = date + time;
      trades.push({ ts:ts, date:date, pnl:pnl, cum:cum });

      // 日別損益
      dayPnL.set(date, (dayPnL.get(date)||0) + pnl);
      // 週別損益
      var wKey = weekKey(date);
      weeks.set(wKey, (weeks.get(wKey)||0) + pnl);
    }

    return { trades:trades, dayPnL:dayPnL, weeks:weeks };
  }

  // ===== 用 TXT 的損益計算 KPI =====
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

    var tradesPerMonth = 0;
    if(nTrades>1){
      var firstTs = trades[0].ts;
      var lastTs  = trades[nTrades-1].ts;
      var msDiff = tsToDate(lastTs) - tsToDate(firstTs);
      var months = msDiff / (1000*60*60*24*30.4);
      if(months <= 0) months = 1/30.4;
      tradesPerMonth = nTrades/months;
    }

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
      tradesPerMonth: tradesPerMonth,
      maxDDAbs: Math.abs(mddTrades||0)
    };
  }

  // ===== 多檔狀態 =====
  var rows = [];
  var currentIdx = -1;
  var chart = null;
  var allSources = [];

  // ===== 圖表（週損益＋累積） =====
  function drawChartFor(rec){
    var ctx = $('#chart');
    if(!ctx || !rec) return;
    if(chart){ chart.destroy(); chart=null; }

    var weeks = rec.weeks;
    var labels = Array.from(weeks.keys());
    var weekly = labels.map(function(k){ return weeks.get(k)||0; });

    var cum=[], s=0, floatBars=[], p=0;
    for(var i=0;i<weekly.length;i++){
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
      '｜Total(累積損益)=' + fmtInt(rec.total) +
      '，MaxDD=' + fmtInt(rec.maxDDAbs) +
      '，PF=' + fmt2(rec.pf);
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

    var trs = tb.querySelectorAll('tr');
    for(i=0;i<trs.length;i++){
      (function(idx){
        trs[idx].onclick = function(){
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
    for(var i=0;i<ths.length;i++){
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
            for(var j=0;j<rows.length;j++){
              if(rows[j].__id === curId){ newIdx=j; break; }
            }
            currentIdx = newIdx;
          }
          renderTable();
        };
      })(ths[i]);
    }
  }

  // ===== 稅率方案（只影響 chip & 年化計算用的稅率） =====
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

  // ===== 主流程：多檔 TXT → rows =====
  function handleTexts(nameTextPairs){
    allSources = nameTextPairs.slice();
    rows = [];
    currentIdx = -1;

    for(var i=0;i<nameTextPairs.length;i++){
      var src = nameTextPairs[i];
      var parsed = parseFile(src.text);
      if(!parsed.trades.length) continue;

      autoPickSchemeByContent(src.name, src.text);

      var kpi = computeKPI(parsed.dayPnL, parsed.trades);

      rows.push({
        __id: Math.random().toString(36).slice(2),
        name: src.name,
        shortName: shortName(src.name),
        weeks: parsed.weeks,
        tradeCount: parsed.trades.length,
        hitRate:    kpi.hitRate,
        total:      kpi.total,
        maxDDAbs:   kpi.maxDDAbs,
        pf:         isFinite(kpi.pf)?kpi.pf:0,
        sr:         kpi.sr,
        so:         kpi.so,
        mar:        kpi.mar,
        tradesPerMonth: kpi.tradesPerMonth,
        annRet:     kpi.annRet,
        annVol:     kpi.annVol
      });
    }

    if(rows.length){
      selectRow(0);
    }else{
      renderTable();
      if(chart){ chart.destroy(); chart=null; }
      $('#chartCaption').textContent = '尚未載入檔案或找不到「稅後損益=」資料行。';
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
