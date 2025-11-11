// 股票｜雲端單檔分析（KPI49，tw-1031 版型）
(function(){
  'use strict';

  // ===== 參數（URL 可覆寫） =====
  const url = new URL(location.href);
  const CFG = {
    feeRate:  +(url.searchParams.get('fee')  ?? 0.001425),
    minFee:   +(url.searchParams.get('min')  ?? 20),
    taxRate:  +(url.searchParams.get('tax')  ?? 0.003),
    unit:     +(url.searchParams.get('unit') ?? 1000),
    slip:     +(url.searchParams.get('slip') ?? 0),     // 每股滑價，買加賣各一次
    capital:  +(url.searchParams.get('cap')  ?? 1_000_000),
    rf:       +(url.searchParams.get('rf')   ?? 0.00),
  };
  const $ = s=>document.querySelector(s);
  const fmtInt=n=>Math.round(n||0).toLocaleString();
  const pct=v=>(v==null||!isFinite(v))?'—':(v*100).toFixed(2)+'%';

  // chips
  $('#feeRateChip').textContent = (CFG.feeRate*100).toFixed(4)+'%';
  $('#taxRateChip').textContent = (CFG.taxRate*100).toFixed(3)+'%';
  $('#minFeeChip').textContent  = String(CFG.minFee);
  $('#unitChip').textContent    = String(CFG.unit);
  $('#slipChip').textContent    = String(CFG.slip);
  $('#rfChip').textContent      = (CFG.rf*100).toFixed(2)+'%';

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
    prev.textContent=''; meta.textContent='';
    pick.innerHTML = '<option value="">載入中…</option>';
    const p=(prefix.value||'').trim(); const fixed = p && !p.endsWith('/') ? p+'/' : p;
    const { data, error } = await sb.storage.from(BUCKET).list(fixed,{limit:1000,sortBy:{column:'name',order:'asc'}});
    if(error){ pick.innerHTML = `<option>讀取失敗：${error.message}</option>`; return; }
    if(!data?.length){ pick.innerHTML = '<option>（無檔案）</option>'; return; }
    pick.innerHTML = '';
    for(const it of data){
      if(it.id===null && !it.metadata) continue; // 資料夾
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
    prev.textContent=''; meta.textContent='';
    const path=pick.value; if(!path) return;
    const url=await getUrl(path); if(!url){ prev.textContent='取得連結失敗'; return; }
    const r=await fetch(url,{cache:'no-store'}); if(!r.ok){ prev.textContent=`HTTP ${r.status}`; return; }
    const ab=await r.arrayBuffer(); const best=decodeBest(ab);
    meta.textContent=`來源：${path}（編碼：${best.enc}）`;
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
  const mapAct=s=>{
    if(/^賣出$/i.test(s)) return '平賣';
    if(/^(買進|加碼|再加碼|加碼攤平)$/i.test(s)) return '新買';
    if(/^強平$/i.test(s)) return '強制平倉';
    return s.trim();
  };
  const pad6=t=>String(t||'').padStart(6,'0').slice(0,6);
  function normalize(txt){
    return (txt||'')
      .replace(/\ufeff/gi,'').replace(/[\u200B-\u200D\uFEFF]/g,'')
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
  const d8 = ts => ts.slice(0,8);
  function ceilInt(n){ return Math.ceil(n); }
  function fee(amount){ return Math.max(CFG.minFee, ceilInt(amount * CFG.feeRate)); }
  function tax(amount){ return ceilInt(amount * CFG.taxRate); }

  function weekKey(d){ // 近似 ISO 週
    const dt=new Date(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T00:00:00`);
    const y=dt.getFullYear(); const oneJan=new Date(y,0,1);
    const week=Math.ceil((((dt - oneJan)/86400000)+oneJan.getDay()+1)/7);
    return `${y}-W${String(week).padStart(2,'0')}`;
  }

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
        shares=0; cumCost=0;
      }
    }
    return { trades, weeks, dayPnL, endingCash:cash, openShares:shares, pnlCum };
  }

  // ===== KPI（49） =====
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
    const m3 = arr.reduce((a,b)=>a+(b-mean)**3,0)/n;
    const m4 = arr.reduce((a,b)=>a+(b-mean)**4,0)/n;
    const skew = std>0 ? m3/Math.pow(std,3) : 0;
    const kurt = std>0 ? m4/Math.pow(std,4) - 3 : 0;
    return {n,mean,std,min,max,skew,kurt};
  }
  function maxDrawdown(eq){
    let peak=eq[0]||0, mdd=0;
    for(let i=0;i<eq.length;i++){
      if(eq[i]>peak) peak=eq[i];
      const dd=eq[i]-peak; if(dd<mdd) mdd=dd;
    }
    return { mdd };
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
    let peak=eq[0]||0, sum=0; for(const v of eq){ peak=Math.max(peak,v); const d=(v-peak); sum += d*d; }
    return Math.sqrt(sum/Math.max(1,eq.length));
  }
  function martin(eq){ const ui=ulcerIndex(eq); return ui>0 ? (eq.at(-1)||0)/ui : 0; }
  function downsideStd(rets){ const neg=rets.map(r=>Math.min(0,r)); const mean=neg.reduce((a,b)=>a+b,0)/rets.length; const varD=rets.reduce((a,r)=>a+(Math.min(0,r)-mean)**2,0)/rets.length; return Math.sqrt(varD); }
  function sharpe(annRet, annVol, rf){ return annVol>0 ? (annRet-rf)/annVol : 0; }
  function sortino(annRet, annDown, rf){ return annDown>0 ? (annRet-rf)/annDown : 0; }
  function calmar(annRet, mdd){ return mdd<0 ? (annRet/Math.abs(mdd)) : 0; }
  function omega(rets, thr=0){ let pos=0,neg=0; for(const r of rets){ if(r>thr) pos+=r-thr; else neg+=thr-r; } return neg>0? pos/neg : Infinity; }
  function streaks(arr){ let win=0,loss=0,maxW=0,maxL=0; for(const x of arr){ if(x>0){ win++; loss=0; maxW=Math.max(maxW,win);} else if(x<0){ loss++; win=0; maxL=Math.max(maxL,loss);} else { win=0; loss=0; } } return {maxWinStreak:maxW, maxLossStreak:maxL}; }

  function computeKPI(bt){
    const sells = bt.trades.filter(x=>x.kind==='SELL');
    const tradePnl = sells.map(x=>x.pnl||0);
    const {days,pnl:eqIncr,eq} = seriesFromDayPnL(bt.dayPnL);

    // 年化：以交易日近似 252
    const annualFactor = 252;
    const total = eq.at(-1)||0;
    const totalReturn = CFG.capital ? total/CFG.capital : 0;

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

    const volWeekly = (()=>{ const arr=[...bt.weeks.values()]; return statsBasic(arr).std; })();
    const bestWeek = Math.max(0,...bt.weeks.values());
    const worstWeek= Math.min(0,...bt.weeks.values());

    const {maxTU,totalTU} = timeUnderwater(eq);
    const {maxWinStreak,maxLossStreak} = streaks(tradePnl);

    const grossBuy = bt.trades.filter(t=>t.kind==='BUY').reduce((a,b)=>a+b.px*b.shares,0);
    const grossSell= bt.trades.filter(t=>t.kind==='SELL').reduce((a,b)=>a+b.px*b.shares,0);
    const feeSum   = bt.trades.reduce((a,b)=>a+(b.fee||0),0);
    const taxSum   = bt.trades.reduce((a,b)=>a+(b.tax||0),0);
    const turnover = CFG.capital? (grossBuy+grossSell)/CFG.capital : 0;
    const costRatio= (grossBuy+grossSell)>0? (feeSum+taxSum)/(grossBuy+grossSell) : 0;
    const avgTrade = nTrades? tradePnl.reduce((a,b)=>a+b,0)/nTrades : 0;
    const medTrade = (()=>{ const s=[...tradePnl].sort((a,b)=>a-b); if(!s.length) return 0; const m=Math.floor(s.length/2); return s.length%2? s[m] : (s[m-1]+s[m])/2; })();

    return {
      // Return (8)
      total, totalReturn, annRet, bestWeek, worstWeek, avgTrade, medTrade, payoff,
      // Risk (9)
      mdd, annVol, dStd, ui, mart, volWeekly, min:statR.min, max:statR.max, std:statR.std,
      // Efficiency (9)
      sr, so, cal, mar, pf, expectancy, hitRate, avgWin, avgLoss,
      // Stability (7)
      maxTU, totalTU, maxWinStreak, maxLossStreak, skew:statR.skew, kurt:statR.kurt, days:days.length,
      // Cost/Activity (8)
      grossBuy, grossSell, feeSum, taxSum, turnover, costRatio, totalExecs:bt.trades.length, unitShares:CFG.unit,
      // Distribution (8)
      tradeCount:nTrades, posCount: tradePnl.filter(x=>x>0).length, zeroCount: tradePnl.filter(x=>x===0).length, negCount: tradePnl.filter(x=>x<0).length,
      posRatio: nTrades? tradePnl.filter(x=>x>0).length/nTrades:0, negRatio: nTrades? tradePnl.filter(x=>x<0).length/nTrades:0,
      omega:omg, pnlStd: statsBasic(tradePnl).std,
    };
  }

  // ===== Render：週次圖（浮動長條 + 折線） =====
  let chWeekly=null;
  function renderWeeklyChart(weeks){
    const labels=[...weeks.keys()];
    const weekly=labels.map(k=>weeks.get(k)||0);
    const cum=[]; let s=0; for(const v of weekly){ s+=v; cum.push(s); }
    const floatBars=[]; let p=0; for(const c of cum){ floatBars.push([p,c]); p=c; }

    const ctx=$('#chWeekly');
    if(chWeekly) chWeekly.destroy();
    chWeekly = new Chart(ctx, {
      data:{ labels, datasets:[
        { type:'bar', label:'每週獲利（浮動長條）', data:floatBars, borderWidth:1, backgroundColor:'rgba(13,110,253,0.30)', borderColor:'#0d6efd' },
        { type:'line', label:'累積淨利', data:cum, borderWidth:2, borderColor:'#f43f5e', tension:0.2, pointRadius:0 }
      ]},
      options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:true}},
        scales:{ y:{ suggestedMin:Math.min(0,Math.min(...cum)*1.1), suggestedMax:Math.max(1,Math.max(...cum)*1.05) },
                 x:{ ticks:{ maxTicksLimit:12 } } }
    });
  }

  // ===== Render：49 KPI（六卡） =====
  const put = (id, rows) => {
    $(id).innerHTML = rows.map(([k,v])=>`<div class="k"><b>${k}</b></div><div class="v">${v}</div>`).join('');
  };
  function renderKPI(k){
    put('#kpiReturn', [
      ['Total PnL(元)', fmtInt(k.total)],
      ['Total Return', pct(k.totalReturn)],
      ['Annualized Return', pct(k.annRet)],
      ['Best Week PnL', fmtInt(k.bestWeek)],
      ['Worst Week PnL', fmtInt(k.worstWeek)],
      ['Avg Trade PnL', fmtInt(k.avgTrade)],
      ['Median Trade PnL', fmtInt(k.medTrade)],
      ['Payoff (AvgWin/AvgLoss)', Number.isFinite(k.payoff)?k.payoff.toFixed(2):'∞'],
    ]);
    put('#kpiRisk', [
      ['Max Drawdown', fmtInt(k.mdd)],
      ['Volatility (ann.)', pct(k.annVol)],
      ['Downside Vol (ann.)', pct(k.dStd)],
      ['Ulcer Index', k.ui.toFixed(2)],
      ['Martin Ratio', k.mart.toFixed(2)],
      ['Weekly PnL Vol', fmtInt(k.volWeekly)],
      ['Worst Daily Ret', pct(k.min)],
      ['Best Daily Ret', pct(k.max)],
      ['Daily Std (alt.)', pct(k.std)],
    ]);
    put('#kpiEff', [
      ['Sharpe', k.sr.toFixed(2)],
      ['Sortino', k.so.toFixed(2)],
      ['Calmar', k.cal.toFixed(2)],
      ['MAR', k.mar.toFixed(2)],
      ['Profit Factor', Number.isFinite(k.pf)?k.pf.toFixed(2):'∞'],
      ['Expectancy (per trade)', fmtInt(k.expectancy)],
      ['Hit Rate', pct(k.hitRate)],
      ['Avg Win', fmtInt(k.avgWin)],
      ['Avg Loss', fmtInt(-k.avgLoss)],
    ]);
    put('#kpiStab', [
      ['Max Time Underwater (days)', k.maxTU],
      ['Total Time Underwater (days)', k.totalTU],
      ['Max Win Streak', k.maxWinStreak],
      ['Max Loss Streak', k.maxLossStreak],
      ['Skewness (daily ret)', k.skew.toFixed(2)],
      ['Kurtosis (daily ret)', k.kurt.toFixed(2)],
      ['Trading Days', k.days],
    ]);
    put('#kpiCost', [
      ['Gross Buy', fmtInt(k.grossBuy)],
      ['Gross Sell', fmtInt(k.grossSell)],
      ['Fee Sum', fmtInt(k.feeSum)],
      ['Tax Sum', fmtInt(k.taxSum)],
      ['Turnover / Capital', k.turnover.toFixed(2)+'×'],
      ['Cost Ratio (Fee+Tax / Turnover)', pct(k.costRatio)],
      ['Total Exec Rows', k.totalExecs],
      ['Unit Shares', k.unitShares],
    ]);
    put('#kpiDist', [
      ['#Trades (SELL)', k.tradeCount],
      ['Wins / Zeros / Losses', `${k.posCount} / ${k.zeroCount} / ${k.negCount}`],
      ['Win Ratio', pct(k.posRatio)],
      ['Loss Ratio', pct(k.negRatio)],
      ['Omega (0)', Number.isFinite(k.omega)?k.omega.toFixed(2):'∞'],
      ['Trade PnL Std', fmtInt(k.pnlStd)],
      ['—','—'], ['—','—'], // 保留欄位到 8 項
    ]);
  }

  // ===== Render：交易明細 =====
  function renderTrades(t){
    const th = $('#tradeTable thead'), tb=$('#tradeTable tbody');
    th.innerHTML = `<tr>
      <th>時間</th><th>種類</th><th>價格</th><th>股數</th>
      <th>手續費</th><th>交易稅</th><th>現金餘額</th><th>單筆損益</th><th>累積損益</th>
    </tr>`;
    tb.innerHTML = t.map(r=>`<tr class="${r.kind==='SELL'?'sell-row':'buy-row'}">
      <td>${r.ts}</td><td>${r.kind}</td><td>${r.px.toFixed(3)}</td>
      <td>${r.shares}</td><td>${r.fee||0}</td><td>${r.tax||0}</td>
      <td>${fmtInt(r.cash)}</td>
      <td>${r.pnl==null?'—':(r.pnl>0?`<span class="pnl-pos">${fmtInt(r.pnl)}</span>`:`<span class="pnl-neg">${fmtInt(r.pnl)}</span>`)}</td>
      <td>${r.pnlCum==null?'—':(r.pnlCum>0?`<span class="pnl-pos">${fmtInt(r.pnlCum)}</span>`:`<span class="pnl-neg">${fmtInt(r.pnlCum)}</span>`)}</td>
    </tr>`).join('');
  }

  // ===== 主流程 =====
  function runAll(rawText){
    const canon = toCanon(normalize(rawText));
    const bt = backtest(canon);
    renderWeeklyChart(bt.weeks);
    renderTrades(bt.trades);
    renderKPI(computeKPI(bt));
  }
})();
