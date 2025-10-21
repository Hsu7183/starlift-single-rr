// etf-00909.js — 00909專責：置頂KPI + 自動挑問題指標(無上限) + 基準型KPI + 月勝率
// 版本：kpi-opt-v4
(function () {
  const $ = s => document.querySelector(s);
  const status = $('#autostatus');
  const set = (m, b = false) => { if (status) { status.textContent = m; status.style.color = b ? '#c62828' : '#666'; } };

  // ===== 固定設定（00909專責）=====
  const CFG = {
    symbol:'00909', bucket:'reports', want:/00909/i,
    manifestPath:'manifests/etf-00909.json',
    feeRate:0.001425, taxRate:0.001, minFee:20,
    tickSize:0.01, slippageTick:0, unitShares:1000, rf:0.00, initialCapital:1_000_000
  };
  const OPT = { capital:1_000_000, unitShares:CFG.unitShares, ratio:[1,1,2] };

  // 顯示 chips
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
      const head=txt.slice(0,1200), bad=(head.match(/\uFFFD/g)||[]).length, kw=(/日期|時間|動作|買進|賣出|加碼/.test(head)?1:0);
      const lines=(txt.match(/^\d{8}[,\t]\d{5,6}[,\t]\d+(?:\.\d+)?[,\t].+$/gm)||[]).length;
      const score=kw*1000 + lines*10 - bad; if(score>best.score) best={score,txt};
    }
    return best.txt || new TextDecoder('utf-8').decode(buf);
  }

  // ===== 格式化/評語（含中譯）=====
  const fmtPct=v=> (v==null||!isFinite(v))?'—':(v*100).toFixed(2)+'%';
  const pnlSpan=v=>{ const cls=v>0?'pnl-pos':(v<0?'pnl-neg':''); return `<span class="${cls}">${Math.round(v||0).toLocaleString()}</span>`; };
  const rateLabel=(label)=> label==='Strong' ? 'Strong (強)' : (label==='Adequate' ? 'Adequate (可)' : 'Improve (弱)');
  const rateHtml=(label)=>`<span class="${label==='Strong'?'rate-strong':(label==='Adequate'?'rate-adequate':'rate-improve')}">${rateLabel(label)}</span>`;
  const tsPretty=ts14=>`${ts14.slice(0,4)}/${ts14.slice(4,6)}/${ts14.slice(6,8)} ${ts14.slice(8,10)}:${ts14.slice(10,12)}`;

  // ===== 交易明細表 =====
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

  // ===== 段落/費用 =====
  function splitSegments(execs){ const segs=[]; let cur=[]; for(const e of execs){ cur.push(e); if(e.side==='SELL'){ segs.push(cur); cur=[]; } } if(cur.length) segs.push(cur); return segs; }
  function fees(price, shares, isSell){ const gross=price*shares; const fee=Math.max(CFG.minFee, gross*CFG.feeRate); const tax=isSell? gross*CFG.taxRate : 0; return { gross, fee, tax }; }
  function buyCostLots(price, lots){ const shares=lots*OPT.unitShares; const f=fees(price, shares, false); return { cost:f.gross+f.fee, shares, f }; }

  // ===== 最佳化（本金100萬；1/1/2）=====
  function buildOptimizedExecs(execs){
    const segs=splitSegments(execs), out=[]; let cumPnlAll=0;
    for(const seg of segs){
      const buys=seg.filter(x=>x.side==='BUY'); const sell=seg.find(x=>x.side==='SELL');
      if(!buys.length || !sell) continue;

      const p0=buys[0].price, one=buyCostLots(p0,1).cost;
      let maxLotsTotal=Math.floor(OPT.capital / one); if(maxLotsTotal<=0) continue;
      let q=Math.floor(maxLotsTotal/4); if(q<=0) q=1;
      const n=Math.min(3,buys.length), plan=[q,q,2*q].slice(0,n);

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

  // ===== 評級門檻 =====
  const BANDS = {
    CAGR:{strong:0.15, adequate:0.05},
    MaxDD:{strong:-0.10, adequate:-0.25},
    Vol:{strong:0.20, adequate:0.35},
    Sharpe:{strong:1.0, adequate:0.5},
    Sortino:{strong:1.5, adequate:0.75},
    Calmar:{strong:1.0, adequate:0.3},
    PF:{strong:1.5, adequate:1.0},
    Hit:{strong:0.55, adequate:0.45},
    TU_days:{strong:45, adequate:120},
    Rec_days:{strong:45, adequate:90},
    MCL:{strong:5, adequate:10},
    Payoff:{strong:1.5, adequate:1.0},
    CostRatio:{strong:0.001, adequate:0.003},
    Turnover:{strong:1.0, adequate:2.0},
    RtVol:{strong:1.0, adequate:0.5},
    MAR:{strong:1.0, adequate:0.3},
    Omega:{strong:1.5, adequate:1.0},
    VaR95:{strong:-0.02, adequate:-0.04},
    CVaR95:{strong:-0.03, adequate:-0.06},
    UI:{strong:0.05, adequate:0.12},
    Martin:{strong:0.8, adequate:0.3},
    GPR:{strong:1.5, adequate:1.0},
    Tail:{strong:1.5, adequate:1.0},
  };
  const rateHigher=(v,b)=> v>=b.strong ? 'Strong' : (v>=b.adequate ? 'Adequate' : 'Improve');
  const rateLower=(v,b)=> v<=b.strong ? 'Strong' : (v<=b.adequate ? 'Adequate' : 'Improve');

  // ===== KPI（含回撤序列、月勝率）=====
  function computeKPIFromOpt(optExecs){
    if(optExecs.length===0) return null;

    let equity=OPT.capital;
    const timeline=[], tradePnls=[], tradeFees=[], tradeTaxes=[], holdDaysArr=[];
    let grossBuy=0, grossSell=0, segStartMs=null;

    for(const e of optExecs){
      if(e.side==='BUY'){
        equity -= (e.cost||0);
        grossBuy += (e.buyAmount||0);
        if(segStartMs==null) segStartMs = e.tsMs;
      }else{
        const settle=(e.sellAmount||0) - (e.fee||0) - (e.tax||0);
        equity += settle;
        if(typeof e.pnlFull==='number') tradePnls.push(e.pnlFull);
        tradeFees.push(e.fee||0); tradeTaxes.push(e.tax||0);
        grossSell += (e.sellAmount||0);
        if(segStartMs!=null){ holdDaysArr.push((e.tsMs - segStartMs)/(24*60*60*1000)); segStartMs=null; }
      }
      timeline.push({t:e.tsMs, eq:equity});
    }

    // 日末權益與報酬
    const byDay=new Map();
    for(const p of timeline){ const d=new Date(p.t).toISOString().slice(0,10); byDay.set(d,p.eq); }
    const days=[...byDay.keys()].sort(); const eqs=days.map(d=>byDay.get(d));
    const rets=[]; for(let i=1;i<eqs.length;i++){ const a=eqs[i-1], b=eqs[i]; if(a>0) rets.push(b/a-1); }

    // 期間與CAGR
    const t0=new Date(days[0]).getTime(), t1=new Date(days.at(-1)).getTime();
    const years=Math.max(1/365,(t1-t0)/(365*24*60*60*1000));
    const totalRet=(eqs.at(-1)/OPT.capital)-1;
    const CAGR=Math.pow(1+totalRet,1/years)-1;

    // 年化報酬與波動、下行
    const mean=rets.length? rets.reduce((a,b)=>a+b,0)/rets.length : 0;
    const sd=rets.length>1? Math.sqrt(rets.reduce((s,x)=>s+Math.pow(x-mean,2),0)/rets.length) : 0;
    const annRet=mean*252, vol=sd*Math.sqrt(252);
    const neg=rets.filter(x=>x<0); const mNeg=neg.length? neg.reduce((a,b)=>a+b,0)/neg.length : 0;
    const sdNeg=neg.length>1? Math.sqrt(neg.reduce((s,x)=>s+Math.pow(x-mNeg,2),0)/neg.length) : 0;
    const downside=sdNeg*Math.sqrt(252);
    const sharpe=vol>0? (annRet-CFG.rf)/vol : 0;
    const sortino=downside>0? (annRet-CFG.rf)/downside : 0;

    // 回撤序列與衍生
    let peak=eqs[0], maxDD=0, curU=0, maxU=0, recDays=0, inDraw=false, troughIdx=0, peakIdx=0, recFound=false;
    const ddSeries=[];
    for(let i=0;i<eqs.length;i++){
      const v=eqs[i]; if(v>peak){ peak=v; if(inDraw){ inDraw=false; } }
      const dd=(v-peak)/peak; ddSeries.push(dd);
      if(dd<maxDD){ maxDD=dd; inDraw=true; troughIdx=i; peakIdx = eqs.findIndex((x,idx)=> idx<=i && x===peak); }
      if(inDraw){ curU++; maxU=Math.max(maxU,curU); } else curU=0;
    }
    if(peakIdx<troughIdx){
      const prePeak=eqs[peakIdx];
      for(let i=troughIdx;i<eqs.length;i++){ if(eqs[i]>=prePeak){ recDays=i-troughIdx; recFound=true; break; } }
      if(!recFound) recDays=eqs.length-1-troughIdx;
    }
    const UI = Math.sqrt(ddSeries.filter(x=>x<0).reduce((s,x)=>s+Math.pow(x,2),0)/Math.max(1,ddSeries.filter(x=>x<0).length));

    // 交易層級
    const wins=tradePnls.filter(x=>x>0), losses=tradePnls.filter(x=>x<0);
    const PF=(wins.reduce((a,b)=>a+b,0))/(Math.abs(losses.reduce((a,b)=>a+b,0))||1);
    const hit=tradePnls.length? wins.length/tradePnls.length : 0;
    const expectancy=tradePnls.length? tradePnls.reduce((a,b)=>a+b,0)/tradePnls.length : 0;
    const payoff=(wins.length? wins.reduce((a,b)=>a+b,0)/wins.length : 0) / (Math.abs(losses.length? losses.reduce((a,b)=>a+b,0)/losses.length : 1));
    let mcl=0, cur=0; for(const p of tradePnls){ if(p<0){ cur++; mcl=Math.max(mcl,cur);} else cur=0; }
    const avgHoldDays = holdDaysArr.length? holdDaysArr.reduce((a,b)=>a+b,0)/holdDaysArr.length : 0;

    // 偏態/峰度、VaR/CVaR、Omega、Tail/Gain-to-Pain、Martin
    const skew = (()=>{
      if(rets.length<3 || sd===0) return 0;
      const n=rets.length; return (n/((n-1)*(n-2))) * rets.reduce((s,x)=>s+Math.pow((x-mean)/sd,3),0);
    })();
    const kurt = (()=>{
      if(rets.length<4 || sd===0) return 0;
      const n=rets.length;
      const m4 = rets.reduce((s,x)=>s+Math.pow((x-mean),4),0)/n;
      const g2 = m4/Math.pow(sd,4) - 3;
      return g2+3;
    })();
    const sorted=[...rets].sort((a,b)=>a-b);
    const idx=Math.max(0, Math.floor(0.05*(sorted.length-1)));
    const VaR95 = sorted[idx] || 0;
    const tail=sorted.slice(0,idx+1); const CVaR95 = tail.length? tail.reduce((a,b)=>a+b,0)/tail.length : 0;
    const pos=rets.filter(x=>x>0), neg2=rets.filter(x=>x<0);
    const TailRatio = (pos.length? pos[Math.floor(0.95*(pos.length-1))] : 0) / Math.abs(neg2.length? neg2[Math.floor(0.05*(neg2.length-1))] : 1);
    const posSum = pos.reduce((a,b)=>a+b,0), negAbs = Math.abs(neg2.reduce((a,b)=>a+b,0));
    const GainPain = negAbs>0? posSum/negAbs : 9.99;
    const Omega = neg2.length===0 ? 9.99 : (pos.length/neg2.length);
    const Martin = UI>0 ? annRet/UI : 0;

    // 成本/成交額
    const totalFees=tradeFees.reduce((a,b)=>a+b,0);
    const totalTaxes=tradeTaxes.reduce((a,b)=>a+b,0);
    const totalCost=totalFees+totalTaxes;
    const turnover=(grossBuy+grossSell)/OPT.capital;
    const avgTradeValue = (()=>{ const n = (wins.length+losses.length)||1; return (grossBuy+grossSell)/n;})();
    const costRatio = (grossBuy+grossSell)>0 ? totalCost/(grossBuy+grossSell) : 0;

    // 綜合比
    const calmar = maxDD<0? CAGR/Math.abs(maxDD) : 0;
    const rtVol = vol>0? annRet/vol : 0;

    // 月勝率（Consistency）
    const byMonth=new Map();
    for(let i=1;i<days.length;i++){
      const ym = days[i].slice(0,7); // YYYY-MM
      const r = (eqs[i]/eqs[i-1]-1);
      byMonth.set(ym, (byMonth.get(ym)||0) + r);
    }
    const months=[...byMonth.keys()];
    const winsM = months.filter(m=> byMonth.get(m) > 0).length;
    const consistency = months.length ? winsM / months.length : null;

    return {
      period:{start:days[0], end:days.at(-1), years},
      equity:{start:OPT.capital, end:eqs.at(-1), series:eqs, days, ddSeries},
      returns:{daily:rets, mean, annRet, vol, downside, skew, kurt, VaR95, CVaR95, Omega, TailRatio, GainPain},
      pnl:{trades:tradePnls, wins, losses, total:tradePnls.reduce((a,b)=>a+b,0), maxWin:Math.max(...tradePnls,0), maxLoss:Math.min(...tradePnls,0), avgHoldDays},
      risk:{maxDD, TU_days:maxU, Rec_days:recDays, MCL:mcl, UI, Martin},
      ratios:{CAGR, sharpe, sortino, PF, hit, expectancy, payoff, calmar, totalRet, rtVol},
      cost:{totalFees,totalTaxes,totalCost,grossBuy,grossSell,turnover,avgTradeValue,costRatio},
      monthly:{months, wins: winsM, consistency}
    };
  }

  // ===== 基準讀取與基準型KPI =====
  async function loadBenchmark(days){
    const u=new URL(location.href);
    const tag = (u.searchParams.get('benchmark')||'').toUpperCase();
    const benchFile = u.searchParams.get('benchfile'); // Supabase path, e.g., benchmarks/0050.csv
    const benchUrl  = u.searchParams.get('benchurl');  // full URL

    let path=null, url=null;
    if(benchUrl){ url=benchUrl; }
    else if(benchFile){ path=benchFile; }
    else if(tag==='0050'){ path='benchmarks/0050_daily.csv'; }
    else if(tag==='TWII'){ path='benchmarks/TWII_daily.csv'; }

    if(!path && !url) return null;

    try{
      const text = url ? await fetchText(url) : await fetchText(pubUrl(path));
      // 允許兩種格式：
      // 1) date,close
      // 2) date,ret   （ret 為當日報酬，例如 0.0032）
      const lines = text.replace(/\r\n?/g,'\n').split('\n').map(s=>s.trim()).filter(Boolean);
      const head = lines[0].toLowerCase();
      const data=[];
      if(head.includes('ret')){ // date,ret
        for(let i=1;i<lines.length;i++){
          const [d, r] = lines[i].split(/[, \t]+/);
          if(d && !isNaN(+r)) data.push({d, r:+r});
        }
      }else{ // date,close
        let prev=null;
        for(let i=1;i<lines.length;i++){
          const [d, c] = lines[i].split(/[, \t]+/);
          const px = +c;
          if(d && px>0){
            if(prev!=null){ data.push({d, r: px/prev - 1}); }
            prev = px;
          }
        }
      }
      // 對齊策略日列表
      const map=new Map(data.map(x=>[x.d.slice(0,10), x.r]));
      const br = [];
      for(const day of days){
        const k = day; // YYYY-MM-DD
        if(map.has(k)) br.push(map.get(k));
      }
      if(br.length<5) return null;
      return br;
    }catch(e){
      console.warn('Benchmark load failed:', e);
      return null;
    }
  }

  function regressXY(x, y){ // 簡單OLS，回傳 {alpha,beta,r2}
    const n=x.length; if(n<2) return {alpha:0,beta:0,r2:0};
    const mx = x.reduce((a,b)=>a+b,0)/n, my=y.reduce((a,b)=>a+b,0)/n;
    let sxx=0, syy=0, sxy=0;
    for(let i=0;i<n;i++){ const dx=x[i]-mx, dy=y[i]-my; sxx+=dx*dx; syy+=dy*dy; sxy+=dx*dy; }
    const beta = sxx>0 ? sxy/sxx : 0;
    const alpha = my - beta*mx;
    const r2 = (sxx>0 && syy>0) ? (sxy*sxy)/(sxx*syy) : 0;
    return {alpha,beta,r2};
  }

  function benchKPIs(stratRets, benchRets, rf=0){
    const n=Math.min(stratRets.length, benchRets.length);
    const s=stratRets.slice(-n), b=benchRets.slice(-n);
    if(n<5) return null;

    const active = s.map((v,i)=> v - b[i]);
    const meanA = active.reduce((a,c)=>a+c,0)/n;
    const sdA = Math.sqrt(active.reduce((a,c)=>a+(c-meanA)*(c-meanA),0)/Math.max(1,n));
    const TE = sdA*Math.sqrt(252);
    const annExcess = meanA*252;
    const IR = TE>0 ? annExcess/TE : 0;

    const {alpha, beta, r2} = regressXY(b, s); // 以日報酬回歸
    const annAlpha = alpha*252;
    const treynor = beta!==0 ? ((s.reduce((a,c)=>a+c,0)/n)*252 - rf)/beta : 0;

    // 捕捉率
    const upIdx = b.map((v,i)=>[v,i]).filter(p=>p[0]>0).map(p=>p[1]);
    const dnIdx = b.map((v,i)=>[v,i]).filter(p=>p[0]<0).map(p=>p[1]);
    const upCap = upIdx.length ? (avg(upIdx.map(i=>s[i])) / Math.max(1e-9, avg(upIdx.map(i=>b[i])))) : null;
    const dnCap = dnIdx.length ? (avg(dnIdx.map(i=>s[i])) / Math.max(1e-9, avg(dnIdx.map(i=>b[i])))) : null;

    function avg(a){ return a.length? a.reduce((x,y)=>x+y,0)/a.length : 0; }

    return {IR, TE, beta, r2, alphaDaily:alpha, alphaAnn:annAlpha, upCap, dnCap, treynor};
  }

  // ===== 渲染 =====
  function fillRows(tbodySel, rows){
    const tb=$(tbodySel); tb.innerHTML='';
    for(const r of rows){
      const tr=document.createElement('tr');
      tr.innerHTML=`<td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3] ? rateHtml(r[3]) : (r[3]===null?'—':'—')}</td><td class="subtle">${r[4]||'—'}</td>`;
      tb.appendChild(tr);
    }
  }
  function gatherRatings(rows){
    const all=[]; for(const r of rows){ if(r[3]) all.push({name:r[0], value:r[1], desc:r[2], rating:r[3], band:r[4]}); }
    return all;
  }
  function pickSuggestions(groups){
    const bag=[]; groups.forEach(g=>bag.push(...gatherRatings(g)));
    const bad=bag.filter(x=>x.rating!=='Strong');
    bad.sort((a,b)=>{
      const ord=v=> v==='Improve'?0:(v==='Adequate'?1:2);
      return ord(a.rating)-ord(b.rating);
    });
    // 改為「無上限」：把所有非 Strong 都列出
    return bad.map(x=>[x.name,x.value,'—',x.rating,x.band]);
  }

  function renderKPI(K, bench){
    $('#kpiOptCard').style.display='';

    // 一、報酬
    const ret=[
      ['總報酬 (Total Return)', (K.ratios.totalRet*100).toFixed(2)+'%', '期末/期初 - 1', (K.ratios.totalRet>0?'Strong':'Improve'), '≥0%'],
      ['CAGR 年化', (K.ratios.CAGR*100).toFixed(2)+'%', '長期年化', rateHigher(K.ratios.CAGR, BANDS.CAGR), '≥15% / ≥5%'],
      ['Arithmetic 年化', (K.returns.annRet*100).toFixed(2)+'%', '日均×252', rateHigher(K.returns.annRet,{strong:0.20,adequate:0.05}), '≥20% / ≥5%'],
      ['平均每筆淨損益', Math.round(K.ratios.expectancy).toLocaleString(), '交易損益均值', rateHigher(K.ratios.expectancy>0?1:0,{strong:1,adequate:0}), '> 0'],
      ['勝率 (Hit Ratio)', (K.ratios.hit*100).toFixed(2)+'%', '獲利筆數/總筆數', rateHigher(K.ratios.hit,BANDS.Hit), '≥55% / ≥45%'],
      ['累積淨利 (NTD)', Math.round(K.pnl.total).toLocaleString(), '所有賣出筆加總', rateHigher(K.pnl.total>0?1:0,{strong:1,adequate:0}), '> 0'],
      ['單筆最大獲利/虧損', `${Math.round(K.pnl.maxWin).toLocaleString()} / ${Math.round(K.pnl.maxLoss).toLocaleString()}`, '極值', 'Adequate','—'],
      ['平均持有天數', K.pnl.avgHoldDays.toFixed(2), '每段多單的平均天數', 'Adequate', '—'],
    ];
    fillRows('#kpiOptReturn tbody', ret);

    // 二、風險
    const risk=[
      ['最大回撤 (MaxDD)', (K.risk.maxDD*100).toFixed(2)+'%', '峰值到谷底', rateLower(K.risk.maxDD,BANDS.MaxDD), '≥-10% / ≥-25%'],
      ['水下時間 (TU)', K.risk.TU_days+' 天', '在水下的最長天數', rateLower(K.risk.TU_days,BANDS.TU_days), '≤45 / ≤120'],
      ['回本時間 (Recovery)', K.risk.Rec_days+' 天', '回到新高所需天數', rateLower(K.risk.Rec_days,BANDS.Rec_days), '≤45 / ≤90'],
      ['波動率 (Volatility)', (K.returns.vol*100).toFixed(2)+'%', '年化標準差', rateLower(K.returns.vol,BANDS.Vol), '≤20% / ≤35%'],
      ['下行波動 (Downside Dev)', (K.returns.downside*100).toFixed(2)+'%', '只計下行波動年化', rateLower(K.returns.downside,{strong:0.15,adequate:0.30}), '≤15% / ≤30%'],
      ['Ulcer Index (UI)', (K.risk.UI*100).toFixed(2)+'%', '回撤平方均根', rateLower(K.risk.UI,BANDS.UI), '≤5% / ≤12%'],
      ['Martin Ratio', K.risk.Martin.toFixed(2), '年化報酬/UI', rateHigher(K.risk.Martin,BANDS.Martin), '≥0.8 / ≥0.3'],
      ['VaR 95% (1日)', (K.returns.VaR95*100).toFixed(2)+'%', '95%信賴的一日風險', rateHigher(K.returns.VaR95,BANDS.VaR95), '>-2% / >-4%'],
      ['CVaR 95% (1日)', (K.returns.CVaR95*100).toFixed(2)+'%', '超過VaR的平均虧損', rateHigher(K.returns.CVaR95,BANDS.CVaR95), '>-3% / >-6%']
    ];
    fillRows('#kpiOptRisk tbody', risk);

    // 三、效率
    const eff=[
      ['Sharpe', K.ratios.sharpe.toFixed(2), '風險調整報酬', rateHigher(K.ratios.sharpe,BANDS.Sharpe), '≥1.0 / ≥0.5'],
      ['Sortino', K.ratios.sortino.toFixed(2), '下行風險調整報酬', rateHigher(K.ratios.sortino,BANDS.Sortino), '≥1.5 / ≥0.75'],
      ['Calmar', K.ratios.calmar.toFixed(2), 'CAGR / |MaxDD|', rateHigher(K.ratios.calmar,BANDS.Calmar), '≥1.0 / ≥0.3'],
      ['Reward/Vol', K.ratios.rtVol.toFixed(2), '年化報酬/波動', rateHigher(K.ratios.rtVol,BANDS.RtVol), '≥1.0 / ≥0.5'],
      ['Profit Factor (PF)', K.ratios.PF.toFixed(2), '總獲利/總虧損', rateHigher(K.ratios.PF,BANDS.PF), '≥1.5 / ≥1.0'],
      ['Payoff Ratio', K.ratios.payoff.toFixed(2), '均獲利/均虧損', rateHigher(K.ratios.payoff,BANDS.Payoff), '≥1.5 / ≥1.0'],
      ['Gain-to-Pain', K.returns.GainPain.toFixed(2), '正報酬總和/負報酬總和絕對值', rateHigher(K.returns.GainPain,BANDS.GPR), '≥1.5 / ≥1.0'],
      ['Tail Ratio', K.returns.TailRatio.toFixed(2), '右尾(95%)/左尾(5%)', rateHigher(K.returns.TailRatio,BANDS.Tail), '≥1.5 / ≥1.0'],
      ['連續虧損峰值 (MCL)', K.risk.MCL, '最大連虧次數', rateLower(K.risk.MCL,BANDS.MCL), `≤${BANDS.MCL.strong} / ≤${BANDS.MCL.adequate}`]
    ];
    fillRows('#kpiOptEff tbody', eff);

    // 四、穩定
    const stab=[
      ['偏態 (Skewness)', K.returns.skew.toFixed(2), '報酬分配偏度(>0偏右尾)', (K.returns.skew>=0?'Strong':'Improve'), '> 0'],
      ['峰度 (Kurtosis)', K.returns.kurt.toFixed(2), '分配峰度(≈3常態；>10尾風險高)', (K.returns.kurt<=10?'Adequate':'Improve'), '≤10'],
      ['Consistency (月勝率)', K.monthly.consistency==null?'—':fmtPct(K.monthly.consistency), '月度正報酬比例', (K.monthly.consistency==null?'Adequate':(K.monthly.consistency>=0.7?'Strong':(K.monthly.consistency>=0.5?'Adequate':'Improve'))), '≥70%']
    ];
    fillRows('#kpiOptStab tbody', stab);

    // 五、成本
    const cost=[
      ['總費用(手續費+稅)', Math.round(K.cost.totalCost).toLocaleString(), '所有賣出筆累計', (K.cost.totalCost<=0?'Improve':'Adequate'),'—'],
      ['費用比 (Cost Ratio)', (K.cost.costRatio*100).toFixed(2)+'%', '(費用/成交額)', rateLower(K.cost.costRatio,BANDS.CostRatio), '<0.10% / <0.30%'],
      ['成交額週轉率 (Turnover)', K.cost.turnover.toFixed(2)+'x', '成交額/本金', rateLower(K.cost.turnover,BANDS.Turnover), '1~2x'],
      ['筆均成交額 (Avg Trade Value)', Math.round(K.cost.avgTradeValue).toLocaleString(), '成交額/筆數', (K.cost.avgTradeValue>=100000?'Strong':(K.cost.avgTradeValue>=30000?'Adequate':'Improve')), '≥100k / ≥30k'],
      ['買入總額 / 賣出總額', `${Math.round(K.cost.grossBuy).toLocaleString()} / ${Math.round(K.cost.grossSell).toLocaleString()}`, '流動性利用', 'Adequate','—'],
      ['Omega(0%)', K.returns.Omega.toFixed(2), 'P(R>0)/P(R<0)', rateHigher(K.returns.Omega,BANDS.Omega), '≥1.5 / ≥1.0'],
      ['MAR (CAGR/MaxDD)', (K.ratios.calmar).toFixed(2), '等同 Calmar（無年內重置）', rateHigher(K.ratios.calmar,BANDS.MAR), '≥1.0 / ≥0.3']
    ];
    fillRows('#kpiOptCost tbody', cost);

    // 六、基準型 KPI
    const benchBody = $('#kpiOptBench tbody');
    benchBody.innerHTML = '';
    if(bench && bench.ok){
      const rows = [
        ['Alpha (年化 Jensen)', (bench.alphaAnn*100).toFixed(2)+'%', '回歸截距 × 252', '—'],
        ['Beta', bench.beta.toFixed(3), '對市場敏感度', '—'],
        ['Information Ratio (IR)', bench.IR.toFixed(2), '年化超額 / 追蹤誤差', '—'],
        ['Tracking Error (TE)', (bench.TE*100).toFixed(2)+'%', '超額報酬標準差年化', '—'],
        ['R²', bench.r2.toFixed(3), '回歸擬合度', '—'],
        ['Upside Capture', bench.upCap==null?'—':bench.upCap.toFixed(2), '基準上漲日策略平均 / 基準平均', '—'],
        ['Downside Capture', bench.dnCap==null?'—':bench.dnCap.toFixed(2), '基準下跌日策略平均 / 基準平均', '—'],
        ['Treynor Ratio', bench.treynor.toFixed(2), '(年化超額)/Beta', '—'],
      ];
      for(const r of rows){
        const tr=document.createElement('tr');
        tr.innerHTML=`<td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>—</td>`;
        benchBody.appendChild(tr);
      }
    }else{
      const tr=document.createElement('tr');
      tr.innerHTML=`<td colspan="4">— 尚未連結基準（用 <code>?benchmark=0050</code>、<code>?benchmark=TWII</code>、<code>?benchfile=</code> 或 <code>?benchurl=</code> 指定）</td>`;
      benchBody.appendChild(tr);
    }

    // 建議優化指標（無上限）
    const sugg = pickSuggestions([ret,risk,eff,stab,cost]);
    fillRows('#kpiOptSuggest tbody', sugg);
  }

  // ===== 合併基準區段 =====
  function mergeRowsByBaseline(baseRows, newRows){
    const endBase = baseRows.length ? baseRows[baseRows.length-1].ts : null;
    const merged = [...baseRows];
    let start8='', end8='';
    for(const r of newRows){
      if(!endBase || r.ts > endBase){ merged.push(r); if(!start8) start8=r.day; end8=r.day; }
    }
    return { merged, start8, end8 };
  }

  // ===== 最佳化表 =====
  function renderOptTable(rows){
    const thead=$('#optTable thead'), tbody=$('#optTable tbody');
    thead.innerHTML=`<tr>
      <th>種類</th><th>日期</th><th>成交價格</th><th>成本均價</th><th>成交數量</th>
      <th>買進金額</th><th>賣出金額</th><th>手續費</th><th>交易稅</th>
      <th>成本</th><th>累計成本</th><th>損益</th><th>報酬率</th><th>累計損益</th>
    </tr>`;
    tbody.innerHTML='';
    for(const e of rows){
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
      tbody.appendChild(tr);
    }
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

      // 回測主流程
      const bt = window.ETF_ENGINE.backtest(rowsMerged, CFG);

      // 原始逐筆明細
      renderExecsTable(bt.execs);

      // 最佳化
      const optExecs = buildOptimizedExecs(bt.execs);
      renderOptTable(optExecs);

      // KPI from 最佳化
      const K = computeKPIFromOpt(optExecs);

      // 讀取基準並計算基準型KPI
      let bench=null;
      if(K){
        const benchRets = await loadBenchmark(K.equity.days);
        if(benchRets){ bench = benchKPIs(K.returns.daily, benchRets, CFG.rf); bench.ok=true; }
      }

      if(K){ renderKPI(K, bench); }

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
