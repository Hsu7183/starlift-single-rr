// etf-00909.js — KPI(最佳化) 計算 + 判等（含你先前的明細/最佳化演算法）
// 版本：kpi-opt-v1
(function () {
  const $ = s => document.querySelector(s);
  const status = $('#autostatus');
  const set = (m, b = false) => { if (status) { status.textContent = m; status.style.color = b ? '#c62828' : '#666'; } };

  // ===== 基本設定 =====
  const CFG = {
    symbol:'00909', bucket:'reports', want:/00909/i,
    manifestPath:'manifests/etf-00909.json',
    feeRate:0.001425, taxRate:0.001, minFee:20,
    tickSize:0.01, slippageTick:0, unitShares:1000, rf:0.00, initialCapital:1_000_000
  };

  // 最佳化（固定 1-1-2；先算「第一筆價能承受的最大總張數」→分配→實價檢查剩餘資金）
  const OPT = { capital:1_000_000, unitShares:CFG.unitShares, ratio:[1,1,2] };

  // chips
  $('#feeRateChip').textContent=(CFG.feeRate*100).toFixed(4)+'%';
  $('#taxRateChip').textContent=(CFG.taxRate*100).toFixed(3)+'%';
  $('#minFeeChip').textContent=CFG.minFee.toString();
  $('#unitChip').textContent=CFG.unitShares.toString();
  $('#slipChip').textContent=CFG.slippageTick.toString();
  $('#rfChip').textContent=(CFG.rf*100).toFixed(2)+'%';

  // ===== Supabase =====
  const SUPABASE_URL="https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON_KEY="sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const sb=window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON_KEY,{ global:{ fetch:(u,o={})=>fetch(u,{...o,cache:'no-store'}) } });
  const pubUrl=p=>{ const {data}=sb.storage.from(CFG.bucket).getPublicUrl(p); return data?.publicUrl||'#'; };
  async function listOnce(prefix){ const p=(prefix && !prefix.endsWith('/'))?(prefix+'/'):(prefix||''); const {data,error}=await sb.storage.from(CFG.bucket).list(p,{limit:1000,sortBy:{column:'name',order:'asc'}}); if(error) throw new Error(error.message); return (data||[]).map(it=>({name:it.name, fullPath:p+it.name, updatedAt:it.updated_at?Date.parse(it.updated_at):0, size:it.metadata?.size||0})); }
  async function listCandidates(){ const u=new URL(location.href); const prefix=u.searchParams.get('prefix')||''; return listOnce(prefix); }
  const lastDateScore=name=>{ const m=String(name).match(/\b(20\d{6})\b/g); return m&&m.length? Math.max(...m.map(s=>+s||0)) : 0; };
  async function readManifest(){ try{ const {data}=await sb.storage.from(CFG.bucket).download(CFG.manifestPath); if(!data) return null; return JSON.parse(await data.text()); }catch{ return null; } }
  async function writeManifest(obj){ const blob=new Blob([JSON.stringify(obj,null,2)],{type:'application/json'}); await sb.storage.from(CFG.bucket).upload(CFG.manifestPath,blob,{upsert:true,cacheControl:'0',contentType:'application/json'}); }

  // 多編碼打分選優
  async function fetchText(url){
    const res=await fetch(url,{cache:'no-store'}); if(!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const buf=await res.arrayBuffer(); const trials=['big5','utf-8','utf-16le','utf-16be','windows-1252'];
    let best={score:-1,txt:''};
    for(const enc of trials){
      let txt=''; try{ txt=new TextDecoder(enc,{fatal:false}).decode(buf).replace(/\ufeff/gi,''); }catch{ continue; }
      const head=txt.slice(0,1000), bad=(head.match(/\uFFFD/g)||[]).length, kw=(/日期|時間|動作|買進|賣出|加碼/.test(head)?1:0);
      const lines=(txt.match(/^\d{8}[,\t]\d{5,6}[,\t]\d+(?:\.\d+)?[,\t].+$/gm)||[]).length;
      const score=kw*1000 + lines*10 - bad; if(score>best.score) best={score,txt};
    }
    return best.txt || new TextDecoder('utf-8').decode(buf);
  }

  // ===== round-trip（保留）=====
  function renderTradesTable(trades){
    const thead=$('#tradeTable thead'), tbody=$('#tradeTable tbody');
    thead.innerHTML=`<tr>
      <th>方向</th><th>進場時間</th><th>進場價</th>
      <th>出場時間</th><th>出場價</th><th>股數</th>
      <th>買方手續費</th><th>賣方手續費</th><th>賣方交易稅</th>
      <th>損益</th><th>持有天數</th></tr>`;
    tbody.innerHTML='';
    for(const t of trades){
      const tr=document.createElement('tr');
      tr.innerHTML=`<td>${t.side}</td><td>${t.inTs}</td><td>${t.inPx.toFixed(2)}</td>
      <td>${t.outTs}</td><td>${t.outPx.toFixed(2)}</td><td>${t.shares.toLocaleString()}</td>
      <td>${t.buyFee.toLocaleString()}</td><td>${t.sellFee.toLocaleString()}</td>
      <td>${t.sellTax.toLocaleString()}</td><td>${Math.round(t.pnl).toLocaleString()}</td>
      <td>${t.holdDays.toFixed(2)}</td>`; tbody.appendChild(tr);
    }
  }

  // ===== 格式化 =====
  const fmtPct=v=> (v==null||!isFinite(v))?'—':(v*100).toFixed(2)+'%';
  const pnlSpan=v=>{ const cls=v>0?'rate-strong':(v<0?'rate-improve':''); return `<span class="${cls}">${Math.round(v||0).toLocaleString()}</span>`; };
  const tsPretty=ts14=>`${ts14.slice(0,4)}/${ts14.slice(4,6)}/${ts14.slice(6,8)} ${ts14.slice(8,10)}:${ts14.slice(10,12)}`;

  // ===== 交易明細（原表；全費口徑版）=====
  function renderExecsTable(execs){
    const thead=$('#execTable thead'), tbody=$('#execTable tbody');
    thead.innerHTML=`<tr>
      <th>種類</th><th>日期</th><th>成交價格</th><th>成本均價</th><th>成交數量</th>
      <th>買進金額</th><th>賣出金額</th><th>手續費</th><th>交易稅</th>
      <th>成本</th><th>累計成本</th><th>損益</th><th>報酬率</th><th>累計損益</th>
    </tr>`;
    tbody.innerHTML='';
    for(const e of execs){
      const tr=document.createElement('tr'); tr.className=(e.side==='BUY'?'buy-row':'sell-row');
      tr.innerHTML=`<td>${e.side==='BUY'?'買進':'賣出'}</td>
      <td>${tsPretty(e.ts)}</td><td>${e.price.toFixed(2)}</td>
      <td>${e.avgCost!=null? e.avgCost.toFixed(2) : '—'}</td><td>${e.shares.toLocaleString()}</td>
      <td>${Math.round(e.buyAmount||0).toLocaleString()}</td>
      <td>${Math.round(e.sellAmount||0).toLocaleString()}</td>
      <td>${Math.round(e.fee||0).toLocaleString()}</td>
      <td>${Math.round(e.tax||0).toLocaleString()}</td>
      <td>${Math.round(e.cost||0).toLocaleString()}</td>
      <td>${Math.round(e.cumCost||0).toLocaleString()}</td>
      <td>${e.pnlFull==null?'—':pnlSpan(e.pnlFull)}</td>
      <td>${fmtPct(e.retPctUnit)}</td>
      <td>${e.cumPnlFull==null?'—':pnlSpan(e.cumPnlFull)}</td>`;
      tbody.appendChild(tr);
    }
  }

  // ===== 最佳化：拆段 / 費用 / 建表 =====
  function splitSegments(execs){ const segs=[]; let cur=[]; for(const e of execs){ cur.push(e); if(e.side==='SELL'){ segs.push(cur); cur=[]; } } if(cur.length) segs.push(cur); return segs; }
  function fees(price, shares, isSell){ const gross=price*shares; const fee=Math.max(CFG.minFee, gross*CFG.feeRate); const tax=isSell? gross*CFG.taxRate : 0; return { gross, fee, tax }; }
  function buyCostLots(price, lots){ const shares=lots*OPT.unitShares; const f=fees(price, shares, false); return { cost:f.gross+f.fee, shares, f }; }

  function buildOptimizedExecs(execs){
    const segs=splitSegments(execs), out=[]; let cumPnlAll=0;
    for(const seg of segs){
      const buys=seg.filter(x=>x.side==='BUY'); const sell=seg.find(x=>x.side==='SELL');
      if(!buys.length || !sell) continue;

      // 最大總張數：以第一筆買價估
      const p0=buys[0].price, one=buyCostLots(p0,1).cost;
      let maxLotsTotal=Math.floor(OPT.capital / one); if(maxLotsTotal<=0) continue;
      let q=Math.floor(maxLotsTotal/4); if(q<=0) q=1;
      const n=Math.min(3,buys.length), plan=[q,q,2*q].slice(0,n);

      // 逐筆進場（當時價檢查剩餘資金）
      let remaining=OPT.capital, sharesHeld=0, avgCost=0, cumCost=0, unitCount=plan.reduce((a,b)=>a+b,0);
      for(let i=0;i<n;i++){
        const b=buys[i];
        let lots=plan[i];
        const unitC=buyCostLots(b.price,1).cost;
        let affordable=Math.floor(remaining/unitC); if(affordable<=0) break;
        if(lots>affordable) lots=affordable;
        const bc=buyCostLots(b.price,lots);
        remaining-=bc.cost; cumCost+=bc.cost;
        const newAvg=(sharesHeld*avgCost + b.price*bc.shares) / (sharesHeld + bc.shares || 1);
        sharesHeld+=bc.shares; avgCost=newAvg;

        out.push({ side:'BUY', ts:b.ts, tsMs:b.tsMs, price:b.price, avgCost:newAvg, shares:bc.shares,
          buyAmount:bc.f.gross, sellAmount:0, fee:bc.f.fee, tax:0, cost:bc.cost, cumCost,
          pnlFull:null, retPctUnit:null, cumPnlFull:cumPnlAll });
      }

      if(sharesHeld>0){
        const s=sell; const st=fees(s.price, sharesHeld, true);
        const pnlFull= st.gross - cumCost - (st.fee + st.tax);
        const retPctUnit= (unitCount>0 && cumCost>0)? (pnlFull / (cumCost/unitCount)) : null;
        cumPnlAll+=pnlFull;

        out.push({ side:'SELL', ts:s.ts, tsMs:s.tsMs, price:s.price, avgCost, shares:sharesHeld,
          buyAmount:0, sellAmount:st.gross, fee:st.fee, tax:st.tax, cost:0, cumCost,
          pnlFull, retPctUnit, cumPnlFull:cumPnlAll });
      }
    }
    return out;
  }

  // ===== KPI：從最佳化明細計算 =====
  const BANDS = {
    // 優/普/劣門檻（可自行微調）
    CAGR:{strong:0.15, adequate:0.05},
    MaxDD:{strong:-0.10, adequate:-0.25},           // 取比例（-10%, -25%）
    Vol:{strong:0.20, adequate:0.35},
    Sharpe:{strong:1.0, adequate:0.5},
    Sortino:{strong:1.5, adequate:0.75},
    Calmar:{strong:1.0, adequate:0.3},
    PF:{strong:1.5, adequate:1.0},
    Hit:{strong:0.55, adequate:0.45},
    TU_days:{strong:45, adequate:120},               // 泳水時間（越短越好）
    Rec_days:{strong:45, adequate:90},               // 回本時間
    MCL:{strong:5, adequate:10},                     // 連虧次數（越小越好）
    Payoff:{strong:1.5, adequate:1.0}
  };
  function rateHigherBetter(v, band){ if(v>=band.strong) return ['Strong','rate-strong']; if(v>=band.adequate) return ['Adequate','rate-adequate']; return ['Improve','rate-improve']; }
  function rateLowerBetter(v, band){ if(v<=band.strong) return ['Strong','rate-strong']; if(v<=band.adequate) return ['Adequate','rate-adequate']; return ['Improve','rate-improve']; }

  function computeKPIFromOpt(optExecs){
    if(optExecs.length===0) return null;
    // 權益序列：本金 100萬，按執行事件變動
    let equity=OPT.capital;
    const timeline=[]; // {t, eq}
    const tradePnls=[];
    for(const e of optExecs){
      if(e.side==='BUY'){ equity -= e.cost||0; }
      else{ // SELL
        const settle = (e.sellAmount||0) - (e.fee||0) - (e.tax||0);
        equity += settle;
        if(typeof e.pnlFull==='number') tradePnls.push(e.pnlFull);
      }
      timeline.push({t:e.tsMs, eq:equity});
    }
    // 轉日末序列
    const byDay=new Map();
    for(const p of timeline){ const d=new Date(p.t).toISOString().slice(0,10); byDay.set(d,p.eq); }
    const days=[...byDay.keys()].sort();
    const eqs=days.map(d=>byDay.get(d));
    const rets=[];
    for(let i=1;i<eqs.length;i++){ const a=eqs[i-1], b=eqs[i]; if(a>0) rets.push(b/a-1); }
    // 期間
    const t0=new Date(days[0]).getTime(), t1=new Date(days.at(-1)).getTime();
    const years=Math.max(1/365,(t1-t0)/(365*24*60*60*1000));
    const totalRet=(eqs.at(-1)/OPT.capital)-1;
    const CAGR=Math.pow(1+totalRet,1/years)-1;
    const mean=rets.length? rets.reduce((a,b)=>a+b,0)/rets.length : 0;
    const sd = rets.length>1? Math.sqrt(rets.reduce((s,x)=>s+Math.pow(x-mean,2),0)/rets.length) : 0;
    const annRet = mean*252;
    const vol = sd*Math.sqrt(252);
    const downside = (()=>{ const neg=rets.filter(x=>x<0); if(neg.length===0) return 0; const m=neg.reduce((a,b)=>a+b,0)/neg.length; const s=Math.sqrt(neg.reduce((s,x)=>s+Math.pow(x-m,2),0)/neg.length); return s*Math.sqrt(252); })();

    const sharpe = vol>0? (annRet - CFG.rf)/vol : 0;
    const sortino = downside>0? (annRet - CFG.rf)/downside : 0;

    // MaxDD / TU / Recovery
    let peak=eqs[0], maxDD=0, curU=0, maxU=0, recDays=0, inDraw=false, troughIdx=0, peakIdx=0, recFound=false;
    for(let i=0;i<eqs.length;i++){
      const v=eqs[i];
      if(v>peak){ peak=v; if(inDraw){ inDraw=false; recDays=0; } }
      const dd=(v-peak)/peak; if(dd<maxDD){ maxDD=dd; inDraw=true; troughIdx=i; peakIdx = eqs.findIndex((x,idx)=> idx<=i && x===peak); }
      if(inDraw){ curU++; maxU=Math.max(maxU,curU); }
      else curU=0;
    }
    // Recovery days：從 trough 之後回到先前峰值以上所需天數
    if(peakIdx<troughIdx){
      const prePeak=eqs[peakIdx];
      for(let i=troughIdx;i<eqs.length;i++){ if(eqs[i]>=prePeak){ recDays = i - troughIdx; recFound=true; break; } }
      if(!recFound) recDays = eqs.length - 1 - troughIdx;
    }

    // 交易級別
    const wins=tradePnls.filter(x=>x>0), losses=tradePnls.filter(x=>x<0);
    const PF = (wins.reduce((a,b)=>a+b,0)) / (Math.abs(losses.reduce((a,b)=>a+b,0)) || 1);
    const hit = tradePnls.length? wins.length/tradePnls.length : 0;
    const expectancy = tradePnls.length? tradePnls.reduce((a,b)=>a+b,0)/tradePnls.length : 0;
    const payoff = (wins.length? wins.reduce((a,b)=>a+b,0)/wins.length : 0) / (Math.abs(losses.length? losses.reduce((a,b)=>a+b,0)/losses.length : 1));
    // 連續虧損
    let mcl=0, cur=0; for(const p of tradePnls){ if(p<0){ cur++; mcl=Math.max(mcl,cur);} else cur=0; }

    const calmar = maxDD<0? CAGR/Math.abs(maxDD):0;

    return {
      period:{start:days[0], end:days.at(-1), years},
      equity:{start:OPT.capital, end:eqs.at(-1), series:eqs, days},
      returns:{daily:rets, mean, annRet, vol, downside},
      pnl:{trades:tradePnls, wins, losses, total:tradePnls.reduce((a,b)=>a+b,0)},
      risk:{maxDD, TU_days:maxU, Rec_days:recDays},
      ratios:{CAGR, sharpe, sortino, PF, hit, expectancy, payoff, calmar, totalRet}
    };
  }

  // ===== KPI 判等 / 渲染 =====
  function judgeReturn(k){
    const out=[]; const r=k.ratios;
    const [c1,l1]=rateHigherBetter(r.totalRet, {strong:0.30, adequate:0.10});
    const [c2,l2]=rateHigherBetter(r.CAGR, BANDS.CAGR);
    const [c3,l3]=rateHigherBetter(r.expectancy>0?1:0, {strong:1, adequate:0}); // 只做正負判斷
    const [c4,l4]=rateHigherBetter(k.returns.annRet, {strong:0.20, adequate:0.05});
    const [c5,l5]=rateHigherBetter(r.hit, BANDS.Hit);
    out.push(['總報酬 (Total Return)',''+(r.totalRet*100).toFixed(2)+'%','回期末/期初報酬',c1,'—']);
    out.push(['CAGR 年化報酬',''+(r.CAGR*100).toFixed(2)+'%','長期年化',c2,'≥15% / 5%']);
    out.push(['平均每筆淨損益 (Expectancy)', Math.round(r.expectancy).toLocaleString(),'每筆平均淨損益',c3,'>0']);
    out.push(['年化報酬 (Arithmetic)',''+(k.returns.annRet*100).toFixed(2)+'%','日均×252',c4,'≥20% / 5%']);
    out.push(['勝率 (Hit Ratio)',''+(r.hit*100).toFixed(2)+'%','獲利筆數/總筆數',c5,'≥55% / 45%']);
    return out;
  }
  function judgeRisk(k){
    const [c1]=rateLowerBetter(k.risk.maxDD, BANDS.MaxDD);
    const [c2]=rateLowerBetter(k.risk.TU_days, BANDS.TU_days);
    const [c3]=rateLowerBetter(k.risk.Rec_days, BANDS.Rec_days);
    const [c4]=rateLowerBetter(k.returns.vol, BANDS.Vol);
    const [c5]=rateLowerBetter(k.returns.downside, {strong:0.15, adequate:0.30});
    const [c6]=rateHigherBetter(k.ratios.sharpe, BANDS.Sharpe);
    const [c7]=rateHigherBetter(k.ratios.sortino, BANDS.Sortino);
    const [c8]=rateHigherBetter(k.ratios.calmar, BANDS.Calmar);
    return [
      ['最大回撤 (MaxDD)', (k.risk.maxDD*100).toFixed(2)+'%','峰值到谷底最大跌幅 (以資金)', c1,'≤-10% / -25%'],
      ['水下時間 (TU)', k.risk.TU_days+' 天','在水下的最長天數', c2,'≤45 / ≤120'],
      ['回本時間 (Recovery)', k.risk.Rec_days+' 天','自MDD後回到新高天數', c3,'≤45 / ≤90'],
      ['波動率 (Volatility)', (k.returns.vol*100).toFixed(2)+'%','年化波動', c4,'≤20% / ≤35%'],
      ['下行波動 (Downside Dev)', (k.returns.downside*100).toFixed(2)+'%','只計下行波動(年化)', c5,'≤15% / ≤30%'],
      ['夏普 (Sharpe)', k.ratios.sharpe.toFixed(2),'風險調整報酬', c6,'≥1.0 / ≥0.5'],
      ['索提諾 (Sortino)', k.ratios.sortino.toFixed(2),'下行風險調整報酬', c7,'≥1.5 / ≥0.75'],
      ['Calmar', k.ratios.calmar.toFixed(2),'年化/CMD', c8,'≥1.0 / ≥0.3']
    ];
  }
  function judgeEff(k){
    const [c1]=rateHigherBetter(k.ratios.PF, BANDS.PF);
    const [c2]=rateHigherBetter(k.ratios.payoff, BANDS.Payoff);
    const avgHold='—'; // 若要可從原始 execs 計算持有時間
    return [
      ['Profit Factor', k.ratios.PF.toFixed(2),'總獲利/總虧損', c1,'≥1.5 / ≥1.0'],
      ['Payoff Ratio', k.ratios.payoff.toFixed(2),'平均獲利/平均虧損', c2,'≥1.5 / ≥1.0'],
      ['平均持有天數', avgHold,'需帶持有期資料', 'Adequate','—']
    ];
  }
  function judgeStability(k){
    const [c1]=rateLowerBetter(k.pnl.trades.length? (k.pnl.trades.filter(x=>x<0).length? k.pnl.trades.length : 0):0, {strong:0, adequate:0});
    const [c2]=rateLowerBetter(k.pnl.trades.length? k.pnl.trades.filter(x=>x<0).length:0, {strong:0, adequate:5});
    const [c3]=rateLowerBetter(k.pnl.trades.length? k.pnl.trades.filter(x=>x<0).length:0, BANDS.MCL);
    return [
      ['連續虧損次數 (Max Consecutive Losses)', k.risk.MCL||0, '連續虧損峰值', (k.risk.MCL||0)<=BANDS.MCL.strong?'Strong':((k.risk.MCL||0)<=BANDS.MCL.adequate?'Adequate':'Improve'),
       `≤${BANDS.MCL.strong} / ≤${BANDS.MCL.adequate}`]
    ];
  }

  function fillTable(tbodySel, rows){
    const tb=$(tbodySel); tb.innerHTML='';
    for(const r of rows){
      const tr=document.createElement('tr');
      tr.innerHTML=`<td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td class="${r[3]==='Strong'?'rate-strong':(r[3]==='Adequate'?'rate-adequate':'rate-improve')}">${r[3]}</td><td class="subtle">${r[4]}</td>`;
      tb.appendChild(tr);
    }
  }

  function renderKPI(k){
    // 補：MCL 計算
    let mcl=0, cur=0; for(const p of k.pnl.trades){ if(p<0){ cur++; mcl=Math.max(mcl,cur);} else cur=0; } k.risk.MCL=mcl;

    $('#kpiOptCard').style.display='';
    // 建議優化：先放三個常見
    const sugRows=[
      ['波動率 (Volatility)', (k.returns.vol*100).toFixed(2)+'%', k.returns.vol<=BANDS.Vol.strong?'—':'建議優化', (k.returns.vol<=BANDS.Vol.strong?'Strong':(k.returns.vol<=BANDS.Vol.adequate?'Adequate':'Improve')), '—'],
      ['PF (獲利因子)', k.ratios.PF.toFixed(2), k.ratios.PF>=BANDS.PF.strong?'—':'建議優化', (k.ratios.PF>=BANDS.PF.strong?'Strong':(k.ratios.PF>=BANDS.PF.adequate?'Adequate':'Improve')), '—'],
      ['最大連敗', k.risk.MCL, k.risk.MCL<=BANDS.MCL.strong?'—':'建議優化', (k.risk.MCL<=BANDS.MCL.strong?'Strong':(k.risk.MCL<=BANDS.MCL.adequate?'Adequate':'Improve')), '—']
    ];
    fillTable('#kpiOptSuggest tbody',sugRows);

    fillTable('#kpiOptReturn tbody', judgeReturn(k));
    fillTable('#kpiOptRisk tbody',   judgeRisk(k));
    fillTable('#kpiOptEff tbody',    judgeEff(k));
    fillTable('#kpiOptStab tbody',   judgeStability(k));
  }

  // ===== 主流程 =====
  async function boot(){
    try{
      const u=new URL(location.href); const paramFile=u.searchParams.get('file');

      // 最新 + 基準
      let latest=null, list=[];
      if(paramFile){ latest={ name:paramFile.split('/').pop()||'00909.txt', fullPath:paramFile, from:'url' }; }
      else{
        set('從 Supabase（reports）讀取清單…');
        list=(await listCandidates()).filter(f=>CFG.want.test(f.name)||CFG.want.test(f.fullPath));
        list.sort((a,b)=>{ const sa=lastDateScore(a.name), sb=lastDateScore(b.name);
          if(sa!==sb) return sb-sa; if(a.updatedAt!==b.updatedAt) return b.updatedAt-a.updatedAt; return (b.size||0)-(a.size||0); });
        latest=list[0];
      }
      if(!latest){ set('找不到檔名含「00909」的 TXT（可用 ?file= 指定）。',true); return; }
      $('#latestName').textContent=latest.name;

      let base=null; const manifest=await readManifest();
      if(manifest?.baseline_path){ base=list.find(x=>x.fullPath===manifest.baseline_path) || { name:manifest.baseline_path.split('/').pop(), fullPath:manifest.baseline_path }; }
      else{ base=list[1]||null; }
      $('#baseName').textContent=base? base.name : '（尚無）';

      // 下載/解析/合併
      const latestUrl= latest.from==='url'? latest.fullPath : pubUrl(latest.fullPath);
      const txtNew = await fetchText(latestUrl);
      const rowsNew = window.ETF_ENGINE.parseCanon(txtNew);
      if(rowsNew.length===0){ set('最新檔沒有可解析的交易行。',true); return; }

      let rowsMerged=rowsNew, start8='', end8='';
      if(base){
        const baseUrl= base.from==='url'? base.fullPath : pubUrl(base.fullPath);
        const rowsBase = window.ETF_ENGINE.parseCanon(await fetchText(baseUrl));
        const m=mergeRowsByBaseline(rowsBase, rowsNew);
        rowsMerged=m.merged; start8=m.start8; end8=m.end8;
      }else{ start8=rowsNew[0].day; end8=rowsNew.at(-1).day; }
      $('#periodText').textContent=`期間：${start8||'—'} 開始到 ${end8||'—'} 結束`;

      // 分析（原表）
      const bt = window.ETF_ENGINE.backtest(rowsMerged, CFG);
      renderTradesTable(bt.trades);
      renderExecsTable(bt.execs);

      // 最佳化明細
      const optExecs = buildOptimizedExecs(bt.execs);
      const thead=$('#optTable thead'); if(thead && thead.children.length===0){
        thead.innerHTML=`<tr>
          <th>種類</th><th>日期</th><th>成交價格</th><th>成本均價</th><th>成交數量</th>
          <th>買進金額</th><th>賣出金額</th><th>手續費</th><th>交易稅</th>
          <th>成本</th><th>累計成本</th><th>損益</th><th>報酬率</th><th>累計損益</th>
        </tr>`;
      }
      const tb=$('#optTable tbody'); tb.innerHTML='';
      for(const e of optExecs){
        const tr=document.createElement('tr'); tr.className=(e.side==='BUY'?'buy-row':'sell-row');
        tr.innerHTML=`<td>${e.side==='BUY'?'買進':'賣出'}</td>
        <td>${tsPretty(e.ts)}</td><td>${e.price.toFixed(2)}</td>
        <td>${e.avgCost!=null? e.avgCost.toFixed(2):'—'}</td><td>${e.shares.toLocaleString()}</td>
        <td>${Math.round(e.buyAmount||0).toLocaleString()}</td>
        <td>${Math.round(e.sellAmount||0).toLocaleString()}</td>
        <td>${Math.round(e.fee||0).toLocaleString()}</td>
        <td>${Math.round(e.tax||0).toLocaleString()}</td>
        <td>${Math.round(e.cost||0).toLocaleString()}</td>
        <td>${Math.round(e.cumCost||0).toLocaleString()}</td>
        <td>${e.pnlFull==null?'—':pnlSpan(e.pnlFull)}</td>
        <td>${(e.retPctUnit==null)?'—':fmtPct(e.retPctUnit)}</td>
        <td>${e.cumPnlFull==null?'—':pnlSpan(e.cumPnlFull)}</td>`;
        tb.appendChild(tr);
      }

      // KPI from optExecs
      const K = computeKPIFromOpt(optExecs);
      if(K){ renderKPI(K); }

      // 設基準按鈕
      const btn=$('#btnSetBaseline'); btn.disabled=false;
      btn.onclick=async()=>{ try{ await writeManifest({ baseline_path: latest.from==='url'? latest.fullPath : latest.fullPath, updated_at:new Date().toISOString() }); btn.textContent='已設為基準'; }catch(e){ set('寫入基準失敗：'+(e.message||e), true); } };

      set('完成。');
    }catch(err){
      set('初始化失敗：'+(err && err.message ? err.message : String(err)), true);
      console.error('[00909 ERROR]', err);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
