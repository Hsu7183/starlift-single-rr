// 股票｜雲端單檔分析（49 KPI 版）
// - 支援 canonical 與 1031-CSV
// - 股票口徑：手續費整數進位 + 最低手續費；賣出含交易稅；unit=每張股數；slip=每股滑價；rf=年化無風險率
// - 產出：週次盈虧圖（浮動長條 + 累積線）＋ 49 KPI（六大分組）＋ 交易明細
(function(){
  'use strict';

  // ===== URL 參數 =====
  const url = new URL(location.href);
  const CFG = {
    feeRate:  +(url.searchParams.get('fee')  ?? 0.001425),
    minFee:   +(url.searchParams.get('min')  ?? 20),
    taxRate:  +(url.searchParams.get('tax')  ?? 0.003),
    unit:     +(url.searchParams.get('unit') ?? 1000),
    slip:     +(url.searchParams.get('slip') ?? 0),     // 每股
    capital:  +(url.searchParams.get('cap')  ?? 1_000_000),
    rf:       +(url.searchParams.get('rf')   ?? 0.00),  // 年化
  };
  const $ = s=>document.querySelector(s);
  $('#p-fee').textContent  = CFG.feeRate;
  $('#p-min').textContent  = CFG.minFee;
  $('#p-tax').textContent  = CFG.taxRate;
  $('#p-unit').textContent = CFG.unit;
  $('#p-slip').textContent = CFG.slip;
  $('#p-rf').textContent   = CFG.rf;

  // ===== Supabase =====
  const SUPABASE_URL  = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET        = "reports";
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    global:{ fetch:(u,o={})=>fetch(u,{...o,cache:'no-store'}) }
  });

  // ===== UI 綁定 =====
  const fileInput = $('#file');
  const btnClip   = $('#btn-clip');
  const prefix    = $('#cloudPrefix');
  const btnList   = $('#btnCloudList');
  const pick      = $('#cloudSelect');
  const btnPrev   = $('#btnCloudPreview');
  const btnImp    = $('#btnCloudImport');
  const meta      = $('#cloudMeta');
  const prev      = $('#cloudPreview');
  const cacheTxt  = $('#cloudTxt');

  btnClip.addEventListener('click', async ()=>{
    try{
      const txt = await navigator.clipboard.readText();
      if(!txt) return alert('剪貼簿沒有文字');
      runAll(txt);
    }catch{ alert('無法讀取剪貼簿內容'); }
  });
  fileInput.addEventListener('change', async ()=>{
    const f = fileInput.files?.[0]; if(!f) return;
    const buf = await f.arrayBuffer();
    const txt = decodeBest(buf).txt;
    runAll(txt);
  });
  btnList.addEventListener('click', listCloud);
  btnPrev.addEventListener('click', previewCloud);
  btnImp.addEventListener('click', importCloud);

  async function listCloud(){
    prev.textContent=''; meta.textContent=''; cacheTxt.value='';
    pick.innerHTML = '<option value="">載入中…</option>';
    const p=(prefix.value||'').trim(); const fixed = p && !p.endsWith('/') ? p+'/' : p;
    const { data, error } = await sb.storage.from(BUCKET).list(fixed,{limit:1000,sortBy:{column:'name',order:'asc'}});
    if(error){ pick.innerHTML = `<option>讀取失敗：${error.message}</option>`; return; }
    if(!data?.length){ pick.innerHTML = '<option>（無檔案）</option>'; return; }
    pick.innerHTML = '';
    for(const it of data){
      if(it.id===null && !it.metadata) continue;
      const path=(fixed||'')+it.name;
      const opt=document.createElement('option');
      opt.value=path; opt.textContent=`${path} (${(it.metadata?.size/1024).toFixed(1)} KB)`;
      pick.appendChild(opt);
    }
  }
  async function getUrl(path){
    try{ const { data } = await sb.storage.from(BUCKET).createSignedUrl(path, 3600);
         if(data?.signedUrl) return data.signedUrl; }catch{}
    const { data:pub } = sb.storage.from(BUCKET).getPublicUrl(path);
    return pub?.publicUrl || '';
  }
  function decodeBest(ab){
    const encs=['utf-8','big5','gb18030']; let best={txt:'',bad:1e9,enc:''};
    for(const e of encs){
      try{ const t=new TextDecoder(e,{fatal:false}).decode(ab);
           const b=(t.match(/\uFFFD/g)||[]).length;
           if(b<best.bad) best={txt:t,bad:b,enc:e}; }catch{}
    } return best;
  }
  async function previewCloud(){
    prev.textContent=''; meta.textContent=''; cacheTxt.value='';
    const path=pick.value; if(!path) return;
    const url=await getUrl(path); if(!url){ prev.textContent='取得連結失敗'; return; }
    const r=await fetch(url,{cache:'no-store'}); if(!r.ok){ prev.textContent=`HTTP ${r.status}`; return; }
    const ab=await r.arrayBuffer(); const best=decodeBest(ab);
    cacheTxt.value=best.txt; meta.textContent=`來源：${path}（編碼：${best.enc}）`;
    const lines=best.txt.split(/\r?\n/);
    prev.textContent = lines.slice(0,500).join('\n') + (lines.length>500?`\n...（共 ${lines.length} 行）`:``);
  }
  async function importCloud(){
    const path=pick.value; if(!path) return alert('請先選檔');
    const url=await getUrl(path); if(!url) return alert('取得連結失敗');
    const r=await fetch(url,{cache:'no-store'}); if(!r.ok) return alert(`HTTP ${r.status}`);
    const ab=await r.arrayBuffer(); const best=decodeBest(ab);
    runAll(best.txt);
  }

  // ===== 解析：canonical + 1031-CSV =====
  const CANON_RE=/^(\d{14})\.0{6}\s+(\d+\.\d{6})\s+(新買|平賣|新賣|平買|強制平倉)\s*$/;
  const CSV_RE=/^(\d{8}),(\d{5,6}),(\d+(?:\.\d+)?),([^,]+),/;
  const mapAct=(s)=>{
    if(/^賣出$/i.test(s)) return '平賣';
    if(/^(買進|加碼|再加碼|加碼攤平)$/i.test(s)) return '新買';
    if(/^強平$/i.test(s)) return '強制平倉';
    return s.trim();
  };
  const pad6=t=>String(t||'').padStart(6,'0').slice(0,6);

  function normalize(txt){
    return (txt||'')
      .replace(/\ufeff/gi,'').replace(/\u200b|\u200c|\u200d/gi,'')
      .replace(/[\x00-\x09\x0B-\x1F\x7F]/g,'')
      .replace(/\r\n?/g,'\n').split('\n').map(s=>s.replace(/\s+/g,' ').trim()).filter(Boolean);
  }
  function toCanon(lines){
    const out=[];
    for(const l of lines){
      let m=l.match(CANON_RE);
      if(m){ out.push({ts:m[1], px:+m[2], act:m[3]}); continue; }
      m=l.match(CSV_RE);
      if(m){ const d8=m[1], t6=pad6(m[2]), px=+m[3], act=mapAct(m[4]);
             if(Number.isFinite(px)) out.push({ts:d8+t6, px, act}); }
    }
    out.sort((a,b)=>a.ts.localeCompare(b.ts));
    return out;
  }

  // ===== 回測（股票版） =====
  function ceilInt(n){ return Math.ceil(n); }
  function fee(amount){ return Math.max(CFG.minFee, ceilInt(amount * CFG.feeRate)); }
  function tax(amount){ return ceilInt(amount * CFG.taxRate); }
  const d8 = ts => ts.slice(0,8);

  // 以「全部賣出時入帳」建立 PnL 時間序列 + 交易明細
  function backtest(rows){
    let shares=0, cash=CFG.capital, cumCost=0, pnlCum=0;
    const trades=[], weeks=new Map(), dayPnL=new Map();
    for(const r of rows){
      if(r.act==='新買'){
        const px=r.px+CFG.slip, amt=px*CFG.unit, f=fee(amt);
        if(cash >= amt+f){
          cash -= (amt+f);
          shares += CFG.unit;
          cumCost += (amt+f);
          trades.push({ts:r.ts, kind:'BUY', px, shares:CFG.unit, fee:f, tax:0, cash, pnl:null, pnlCum, d8:d8(r.ts)});
        }
      }else if(r.act==='平賣' && shares>0){
        const px=r.px-CFG.slip, amt=px*shares, f=fee(amt), t=tax(amt);
        cash += (amt - f - t);
        const avgCostPerShare = cumCost / shares;
        const pnl = (amt - f - t) - avgCostPerShare * shares;
        pnlCum += pnl;
        const day=d8(r.ts);
        dayPnL.set(day,(dayPnL.get(day)||0)+pnl);
        const wk = weekKey(day); weeks.set(wk,(weeks.get(wk)||0)+pnl);
        trades.push({ts:r.ts, kind:'SELL', px, shares, fee:f, tax:t, cash, pnl, pnlCum, d8:day});
        // 歸零
        shares=0; cumCost=0;
      }
    }
    return { trades, weeks, dayPnL, endingCash:cash, openShares:shares, pnlCum };
  }

  function weekKey(d){ // ISO-like (近似)
    const dt=new Date(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T00:00:00`);
    const y=dt.getFullYear(); const oneJan=new Date(y,0,1);
    const week=Math.ceil((((dt - oneJan)/86400000)+oneJan.getDay()+1)/7);
    return `${y}-W${String(week).padStart(2,'0')}`;
  }

  // ===== 49 KPI =====
  function seriesFromDayPnL(dayPnL){
    const days=[...dayPnL.keys()].sort();
    const pnl=days.map(d=>dayPnL.get(d)||0);
    const eq=[]; let acc=0; for(const v of pnl){ acc+=v; eq.push(acc); }
    return {days, pnl, eq};
  }
  function statsBasic(arr){
    const n=arr.length; if(!n) return {n,mean:0,std:0,min:0,max:0,skew:0,kurt:0};
    const mean = arr.reduce((a,b)=>a+b,0)/n;
    const v = arr.reduce((a,b)=>a+(b-mean)**2,0)/n;
    const std = Math.sqrt(v);
    const min = Math.min(...arr), max = Math.max(...arr);
    // Fisher-Pearson skew/kurt (excess)
    const m3 = arr.reduce((a,b)=>a+(b-mean)**3,0)/n;
    const m4 = arr.reduce((a,b)=>a+(b-mean)**4,0)/n;
    const skew = std>0 ? m3/Math.pow(std,3) : 0;
    const kurt = std>0 ? m4/Math.pow(std,4) - 3 : 0;
    return {n,mean,std,min,max,skew,kurt};
  }
  function maxDrawdown(eq){
    let peak=eq[0]||0, mdd=0, troughIdx=0, peakIdx=0;
    for(let i=0;i<eq.length;i++){
      if(eq[i]>peak){ peak=eq[i]; peakIdx=i; }
      const dd=eq[i]-peak; if(dd<mdd){ mdd=dd; troughIdx=i; }
    }
    return { mdd, peakIdx, troughIdx };
  }
  function timeUnderwater(eq){
    let peak=eq[0]||0, cur=0, maxTU=0, totalTU=0;
    for(const v of eq){
      if(v>=peak){ peak=v; if(cur>0){ totalTU+=cur; cur=0; } }
      else{ cur++; maxTU=Math.max(maxTU,cur); }
    }
    if(cur>0) totalTU+=cur;
    return { maxTU, totalTU };
  }
  function ulcerIndex(eq){
    let peak=eq[0]||0, sum=0; for(const v of eq){ peak=Math.max(peak,v); const d=(v-peak); sum += (d*d); }
    return Math.sqrt(sum/Math.max(1,eq.length));
  }
  function martin(eq){ const ui=ulcerIndex(eq); return ui>0 ? (eq.at(-1)||0)/ui : 0; }
  function downsideStd(returns){ const neg=returns.map(r=>Math.min(0,r)); const mean=neg.reduce((a,b)=>a+b,0)/returns.length; const varD=returns.reduce((a,r)=>a+(Math.min(0,r)-mean)**2,0)/returns.length; return Math.sqrt(varD); }
  function sharpe(annRet, annVol, rf){ return annVol>0 ? (annRet-rf)/annVol : 0; }
  function sortino(annRet, annDown, rf){ return annDown>0 ? (annRet-rf)/annDown : 0; }
  function calmar(annRet, mdd){ return mdd<0 ? (annRet/Math.abs(mdd)) : 0; }
  function omega(returns, thresh=0){ // discrete omega ratio
    let pos=0,neg=0; for(const r of returns){ if(r>thresh) pos+=r-thresh; else neg+=thresh-r; } return neg>0? pos/neg : Infinity;
  }
  function streaks(arr){ // arr: trade pnl
    let win=0,loss=0,maxW=0,maxL=0;
    for(const x of arr){ if(x>0){ win++; loss=0; maxW=Math.max(maxW,win);} else if(x<0){ loss++; win=0; maxL=Math.max(maxL,loss);} else { win=0; loss=0; } }
    return {maxWinStreak:maxW, maxLossStreak:maxL};
  }

  function computeKPI(bt){
    const sells = bt.trades.filter(x=>x.kind==='SELL');
    const tradePnl = sells.map(x=>x.pnl||0);
    const {days,pnl:eqIncr,eq} = seriesFromDayPnL(bt.dayPnL);

    // 年化：以天序列（交易日）近似 -> 年化係數 252
    const annualFactor = 252;
    const total = eq.at(-1)||0;
    const totalReturn = CFG.capital ? total/CFG.capital : 0;

    // 日報酬：以「當天入帳Pnl / capital」做序列
    const dailyRet = eqIncr.map(v=> v/CFG.capital);
    const statR = statsBasic(dailyRet);
    const annRet = statR.mean * annualFactor;
    const annVol = statR.std  * Math.sqrt(annualFactor);

    const dStd = downsideStd(dailyRet) * Math.sqrt(annualFactor);
    const {mdd} = maxDrawdown(eq);
    const ui = ulcerIndex(eq);
    const mar = annRet / Math.max(1, Math.abs(mdd));
    const sr = sharpe(annRet, annVol, CFG.rf);
    const so = sortino(annRet, dStd, CFG.rf);
    const cal = calmar(annRet, mdd);
    const mart = martin(eq);
    const omg = omega(dailyRet, 0);

    const nTrades = sells.length;
    const hits = sells.filter(s=>s.pnl>0).length;
    const hitRate = nTrades? hits/nTrades : 0;
    const grossWin = sells.filter(s=>s.pnl>0).reduce((a,b)=>a+b.pnl,0);
    const grossLoss= sells.filter(s=>s.pnl<0).reduce((a,b)=>a+b.pnl,0);
    const pf = grossLoss<0 ? (grossWin/Math.abs(grossLoss)) : (grossWin>0?Infinity:0);
    const avgWin = hits? grossWin/hits : 0;
    const avgLoss= (nTrades-hits)? Math.abs(grossLoss)/(nTrades-hits) : 0;
    const payoff = avgLoss>0 ? avgWin/avgLoss : Infinity;
    const expectancy = nTrades? (grossWin+grossLoss)/nTrades : 0;

    const volWeekly = (()=>{ // 週次損益 vol
      const arr=[...bt.weeks.values()]; const st=statsBasic(arr); return st.std;
    })();
    const bestWeek = Math.max(0,...bt.weeks.values());
    const worstWeek= Math.min(0,...bt.weeks.values());

    const {maxTU,totalTU} = timeUnderwater(eq);
    const {maxWinStreak,maxLossStreak} = streaks(tradePnl);

    // 活動 / 成本
    const grossBuy = bt.trades.filter(t=>t.kind==='BUY').reduce((a,b)=>a+b.px*b.shares,0);
    const grossSell= bt.trades.filter(t=>t.kind==='SELL').reduce((a,b)=>a+b.px*b.shares,0);
    const feeSum   = bt.trades.reduce((a,b)=>a+(b.fee||0),0);
    const taxSum   = bt.trades.reduce((a,b)=>a+(b.tax||0),0);
    const turnover = CFG.capital? (grossBuy+grossSell)/CFG.capital : 0;
    const costRatio= (grossBuy+grossSell)>0? (feeSum+taxSum)/(grossBuy+grossSell) : 0;
    const avgTrade = nTrades? tradePnl.reduce((a,b)=>a+b,0)/nTrades : 0;
    const medTrade = (()=>{ const s=[...tradePnl].sort((a,b)=>a-b); if(!s.length) return 0; const m=Math.floor(s.length/2); return s.length%2? s[m] : (s[m-1]+s[m])/2; })();

    // 49 指標（六組）
    return {
      // Return (8)
      total, totalReturn, annRet, // 1~3
      bestWeek, worstWeek,        // 4~5
      avgTrade, medTrade,         // 6~7
      payoff,                     // 8

      // Risk (9)
      mdd, annVol, dStd, ui, mart, volWeekly, // 9~14
      statR.min, statR.max,                    // 15~16（單日最差/最好報酬）
      statR.std,                               // 17（每日波動再列顯）

      // Efficiency (9)
      sr, so, cal, mar, pf, expectancy,        // 18~23
      hitRate, avgWin, avgLoss,                // 24~26

      // Stability (7)
      maxTU, totalTU, maxWinStreak, maxLossStreak, // 27~30
      statR.skew, statR.kurt, days.length,         // 31~33（交易日數）

      // Cost / Activity (8)
      grossBuy, grossSell, feeSum, taxSum, turnover, costRatio, // 34~39
      bt.trades.length, CFG.unit,                                 // 40~41

      // Distribution (8)
      // 以 trade pnl 分布計：>0、=0、<0 的比例與數量 + Omega
      tradeCount:nTrades,
      posCount: tradePnl.filter(x=>x>0).length,
      zeroCount: tradePnl.filter(x=>x===0).length,
      negCount: tradePnl.filter(x=>x<0).length,
      posRatio: nTrades? tradePnl.filter(x=>x>0).length/nTrades:0,
      negRatio: nTrades? tradePnl.filter(x=>x<0).length/nTrades:0,
      omega:omg,
      pnlStd: statsBasic(tradePnl).std,
    };
  }

  // ===== Render：圖、KPI、表 =====
  let chart;
  function renderChart(weeks){
    const labels=[...weeks.keys()];
    const bars=labels.map(k=>weeks.get(k)||0);
    const cum=[]; let s=0; for(const v of bars){ s+=v; cum.push(s); }
    if(chart) chart.destroy();
    const ctx=$('#chart').getContext('2d');
    chart = new Chart(ctx,{
      type:'bar',
      data:{ labels, datasets:[
        { type:'bar',  label:'每週損益', data:bars },
        { type:'line', label:'累積損益', data:cum, yAxisID:'y1' },
      ]},
      options:{
        responsive:true,
        scales:{ y:{ beginAtZero:true }, y1:{ beginAtZero:true, position:'right' } }
      }
    });
  }
  const fmtInt = n => Math.round(n || 0).toLocaleString();
  const pct = v => (v==null||!isFinite(v))?'—':(v*100).toFixed(2)+'%';
  function tableKV(rows){
    const th = `<thead><tr><th>指標</th><th>值</th></tr></thead>`;
    const tb = `<tbody>${rows.map(([k,v])=>`<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</tbody>`;
    return `<table>${th}${tb}</table>`;
  }
  function renderKPI(k){
    // Return (8)
    $('#kpiReturn').innerHTML = tableKV([
      ['Total PnL(元)', fmtInt(k.total)],
      ['Total Return', pct(k.totalReturn)],
      ['Annualized Return', pct(k.annRet)],
      ['Best Week PnL', fmtInt(k.bestWeek)],
      ['Worst Week PnL', fmtInt(k.worstWeek)],
      ['Avg Trade PnL', fmtInt(k.avgTrade)],
      ['Median Trade PnL', fmtInt(k.medTrade)],
      ['Payoff (AvgWin/AvgLoss)', (Number.isFinite(k.payoff)?k.payoff.toFixed(2):'∞')],
    ]);

    // Risk (9)
    $('#kpiRisk').innerHTML = tableKV([
      ['Max Drawdown', fmtInt(k.mdd)],
      ['Volatility (ann.)', pct(k.annVol)],
      ['Downside Vol (ann.)', pct(k.dStd)],
      ['Ulcer Index', k.ui.toFixed(2)],
      ['Martin Ratio', k.mart.toFixed(2)],
      ['Weekly PnL Vol', fmtInt(k.volWeekly)],
      ['Worst Daily Ret', pct(k.statR_min || k.min)], // 向下相容
      ['Best Daily Ret', pct(k.statR_max || k.max)],
      ['Daily Std (alt.)', pct(k.statR_std || k.std)],
    ]
    .map((row,i)=>{
      // 將已抽離的值補回（兼容）
      if(row[0]==='Worst Daily Ret') row[1]=pct(k.min);
      if(row[0]==='Best Daily Ret')  row[1]=pct(k.max);
      if(row[0]==='Daily Std (alt.)')row[1]=pct(k.std);
      return row;
    }));

    // Efficiency (9)
    $('#kpiEff').innerHTML = tableKV([
      ['Sharpe', k.sr.toFixed(2)],
      ['Sortino', k.so.toFixed(2)],
      ['Calmar', k.cal.toFixed(2)],
      ['MAR', k.mar.toFixed(2)],
      ['Profit Factor', (Number.isFinite(k.pf)?k.pf.toFixed(2):'∞')],
      ['Expectancy (per trade)', fmtInt(k.expectancy)],
      ['Hit Rate', pct(k.hitRate)],
      ['Avg Win', fmtInt(k.avgWin)],
      ['Avg Loss', fmtInt(-k.avgLoss)],
    ]);

    // Stability (7)
    $('#kpiStab').innerHTML = tableKV([
      ['Max Time Underwater (days)', k.maxTU],
      ['Total Time Underwater (days)', k.totalTU],
      ['Max Win Streak', k.maxWinStreak],
      ['Max Loss Streak', k.maxLossStreak],
      ['Skewness (daily ret)', k.skew?.toFixed?.(2) ?? '—'],
      ['Kurtosis (daily ret)', k.kurt?.toFixed?.(2) ?? '—'],
      ['Trading Days', k.days || k.tradingDays || '—'],
    ].map((r,i)=>{
      if(r[0].includes('Skewness')) r[1]=(k.statR_skew||k.skew||0).toFixed(2);
      if(r[0].includes('Kurtosis')) r[1]=(k.statR_kurt||k.kurt||0).toFixed(2);
      if(r[0]==='Trading Days') r[1]=(k.days||'—');
      return r;
    }));

    // Cost / Activity (8)
    $('#kpiCost').innerHTML = tableKV([
      ['Gross Buy', fmtInt(k.grossBuy)],
      ['Gross Sell', fmtInt(k.grossSell)],
      ['Fee Sum', fmtInt(k.feeSum)],
      ['Tax Sum', fmtInt(k.taxSum)],
      ['Turnover / Capital', (k.turnover).toFixed(2)+'×'],
      ['Cost Ratio (Fee+Tax / Turnover)', pct(k.costRatio)],
      ['Total Exec Rows', k.totalExecs || k.tradeRows || '—'],
      ['Unit Shares', k.unitShares || k.unit || CFG.unit],
    ].map((r,i)=>{
      if(r[0]==='Total Exec Rows') r[1]=(k.totalExecs||k.tradeRows||'—');
      if(r[0]==='Unit Shares') r[1]=(CFG.unit);
      return r;
    }));

    // Distribution (8)
    $('#kpiDist').innerHTML = tableKV([
      ['#Trades (SELL)', k.tradeCount],
      ['Wins / Zeros / Losses', `${k.posCount} / ${k.zeroCount} / ${k.negCount}`],
      ['Win Ratio', pct(k.posRatio)],
      ['Loss Ratio', pct(k.negRatio)],
      ['Omega (0)', (Number.isFinite(k.omega)?k.omega.toFixed(2):'∞')],
      ['Trade PnL Std', fmtInt(k.pnlStd)],
      ['—', '—'],
      ['—', '—'],
    ]);
  }

  function renderTrades(t){
    const th = $('#tradeTable thead'), tb=$('#tradeTable tbody');
    th.innerHTML = `<tr><th>時間</th><th>種類</th><th>價格</th><th>股數</th><th>手續費</th><th>交易稅</th><th>現金餘額</th><th>單筆損益</th><th>累積損益</th></tr>`;
    tb.innerHTML = t.map(r=>`<tr>
      <td>${r.ts}</td><td>${r.kind}</td><td>${r.px.toFixed(3)}</td>
      <td>${r.shares}</td><td>${r.fee||0}</td><td>${r.tax||0}</td>
      <td>${Math.round(r.cash)}</td><td>${r.pnl!=null?(r.pnl>0?`<span class="pnl-pos">${fmtInt(r.pnl)}</span>`:`<span class="pnl-neg">${fmtInt(r.pnl)}</span>`):''}</td>
      <td>${r.pnlCum!=null?(r.pnlCum>0?`<span class="pnl-pos">${fmtInt(r.pnlCum)}</span>`:`<span class="pnl-neg">${fmtInt(r.pnlCum)}</span>`):''}</td></tr>`).join('');
  }

  // ===== 主流程 =====
  function runAll(rawText){
    const canon = toCanon(normalize(rawText));
    const bt = backtest(canon);
    renderChart(bt.weeks);
    renderTrades(bt.trades);
    const k = computeKPI(bt);
    // 把 computeKPI 內部使用到的統計(為了表格相容)掛上
    k.statR_min = k.min; k.statR_max = k.max; k.statR_std=k.std; k.statR_skew=k.skew; k.statR_kurt=k.kurt;
    renderKPI(k);
  }
})();
