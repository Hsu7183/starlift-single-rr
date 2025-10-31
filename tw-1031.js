// tw-1031.js — 台股 1031（KPI 全移除；交易明細固定 1/1/2；保留週次圖 + 最佳化表）
(function(){
  /* ============ 工具 ============ */
  const $ = s => document.querySelector(s);
  const status = $('#autostatus');
  const set = (m,bad=false)=>{ if(status){ status.textContent=m; status.style.color=bad?'#c62828':'#666'; } };
  const fmtInt = n => Math.round(n || 0).toLocaleString();
  const tsPretty = ts14 => `${ts14.slice(0,4)}/${ts14.slice(4,6)}/${ts14.slice(6,8)} ${ts14.slice(8,10)}:${ts14.slice(10,12)}`;

  /* ============ 參數 ============ */
  const url = new URL(location.href);
  const CFG = {
    bucket: 'reports',
    feeRate: +(url.searchParams.get('fee') || 0.001425),
    taxRate: +(url.searchParams.get('tax') || 0.001),
    minFee : +(url.searchParams.get('minfee') || 20),
    unitShares: +(url.searchParams.get('unit') || 1000),
    initialCapital: 1_000_000,
  };
  $('#feeRateChip').textContent = (CFG.feeRate*100).toFixed(4)+'%';
  $('#taxRateChip').textContent = (CFG.taxRate*100).toFixed(3)+'%';
  $('#minFeeChip').textContent = String(CFG.minFee);
  $('#unitChip').textContent = String(CFG.unitShares);
  $('#slipChip').textContent = '0';
  $('#rfChip').textContent = '0.00%';

  /* ============ Supabase ============ */
  const SUPABASE_URL  = window.SUPABASE_URL  || "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_KEY  = window.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ5aGJtbW5hY2V6emdrd2Zrb3pzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1OTE0NzksImV4cCI6MjA3NDE2NzQ3OX0.VCSye3-fKrQphejdJSWAM6iRzv_7gkl8MLe7NeVszR0";
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { global:{ fetch:(u,o={})=>fetch(u,{...o,cache:'no-store'}) } });
  const pubUrl = p => sb.storage.from(CFG.bucket).getPublicUrl(p).data.publicUrl;

  /* ============ 手續費 / 稅 ============ */
  function feesInt(price, shares, isSell){
    const gross = price * shares;
    const fee = Math.max(CFG.minFee, Math.ceil(gross * CFG.feeRate));
    const tax = isSell ? Math.ceil(gross * CFG.taxRate) : 0;
    return { gross, fee, tax };
  }

  /* ============ 多編碼下載 ============ */
  async function fetchText(u){
    const res=await fetch(u,{cache:'no-store'}); if(!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const buf=await res.arrayBuffer();
    const trials=['utf-8','big5','utf-16le','utf-16be','windows-1252'];
    for(const enc of trials){
      try{ return new TextDecoder(enc).decode(buf).replace(/\ufeff/g,''); }catch{}
    }
    return new TextDecoder('utf-8').decode(buf);
  }

  /* ============ CSV -> canonical（只做多）：逐字掃前 4 欄 ============ */
  function toCanonFrom1031CSV(raw){
    const toHalf = s => s.replace(/[０-９]/g, d=>String.fromCharCode(d.charCodeAt(0)-0xFEE0))
                         .replace(/，/g, ',')
                         .replace(/\t/g, ',');
    const txt = toHalf(raw)
      .replace(/\r\n?/g,'\n')
      .replace(/[\x00-\x08\x0B-\x1F\x7F]/g,'')
      .replace(/[\u200B-\u200D]/g,'');

    function first4(line){
      const arr=[]; let cur='', comma=0;
      for(let i=0;i<line.length;i++){
        const c=line[i];
        if(c===','){
          arr.push(cur.trim()); cur=''; comma++;
          if(comma===3){
            let j=i+1, tok='';
            while(j<line.length && line[j]!==','){ tok+=line[j]; j++; }
            arr.push(tok.trim());
            return arr;
          }
        }else{
          cur+=c;
        }
      }
      if(cur) arr.push(cur.trim());
      return arr;
    }

    const out=[]; let counted=0; const demo=[];
    for(const rawLine of txt.split('\n')){
      if(!rawLine) continue;
      const line=rawLine.trim();
      if(!line || /^日期\s*,\s*時間\s*,\s*價格\s*,\s*動作/i.test(line)) continue;

      const p = first4(line);
      if(p.length<4){ if(demo.length<10) demo.push(line); continue; }

      const d8=(p[0]||'').trim();
      let t=(p[1]||'').trim();
      const pxStr=(p[2]||'').trim();
      const act=(p[3]||'').trim();

      if(!/^\d{8}$/.test(d8)) { if(demo.length<10) demo.push(line); continue; }
      if(/^\d{5}$/.test(t)) t='0'+t;
      if(!/^\d{6}$/.test(t)) { if(demo.length<10) demo.push(line); continue; }
      const price=Number(pxStr); if(!Number.isFinite(price)) { if(demo.length<10) demo.push(line); continue; }

      let mapped='';
      if(act.indexOf('賣出')>=0) mapped='平賣';
      else if(/買進|加碼攤平|再加碼攤平/.test(act)) mapped='新買';
      else { if(demo.length<10) demo.push(line); continue; }

      out.push(`${d8}${t}.000000 ${price.toFixed(6)} ${mapped}`);
      counted++;
    }
    if(counted===0){ console.warn('[tw-1031] CSV 轉換失敗，樣本：\n' + demo.join('\n')); }
    return { canon: out.join('\n'), ok: counted };
  }

  /* ============ 回測 ============ */
  const backtest = rows => window.ETF_ENGINE.backtest(rows, { ...CFG });

  /* ============ 週次圖 ============ */
  let chWeekly=null;
  function weekStartDate(ms){
    const d=new Date(ms), dow=(d.getUTCDay()+6)%7;
    const s=new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()-dow));
    return s.toISOString().slice(0,10);
  }
  function buildWeeklyFromExecs(execs){
    const m=new Map(), order=[];
    for(const e of execs){
      if(e.side!=='SELL' || typeof e.pnlFull!=='number') continue;
      const wk=weekStartDate(e.tsMs);
      if(!m.has(wk)){ m.set(wk,0); order.push(wk); }
      m.set(wk, m.get(wk)+e.pnlFull);
    }
    const weekly=order.map(k=>m.get(k)||0); let s=0; const cum=weekly.map(v=>s+=v);
    return { labels:order, weekly, cum };
  }
  function renderWeeklyChart(execs){
    const card=$('#weeklyCard'), ctx=$('#chWeekly');
    const W=buildWeeklyFromExecs(execs);
    if(!W.labels.length){ card.style.display='none'; return; }
    card.style.display='';
    if(chWeekly) chWeekly.destroy();
    chWeekly=new Chart(ctx,{
      data:{ labels:W.labels, datasets:[
        { type:'bar',  label:'每週獲利', data:W.weekly, borderWidth:1 },
        { type:'line', label:'累積淨利', data:W.cum,    borderWidth:2, tension:0.2, pointRadius:0 }
      ]},
      options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:true}}, scales:{ x:{ticks:{maxTicksLimit:12}} } }
    });
  }

  /* ============ 交易明細（固定 1/1/2） ============ */
  function buildSimpleExecs(execs){
    const segs=[], cur=[]; for(const e of execs){ cur.push(e); if(e.side==='SELL'){ segs.push(cur.slice()); cur.length=0; } } if(cur.length) segs.push(cur.slice());
    const out=[];
    for(const seg of segs){
      const buys=seg.filter(x=>x.side==='BUY'); const sell=seg.find(x=>x.side==='SELL');
      if(!buys.length || !sell) continue;
      const plan=[1,1,2]; const n=Math.min(plan.length, buys.length); let sharesHeld=0;
      for(let i=0;i<n;i++){
        const b=buys[i], lots=plan[i], shares=lots*CFG.unitShares; const f=feesInt(b.price, shares, false);
        out.push({ side:'BUY', ts:b.ts, tsMs:b.tsMs, price:b.price, shares, buyAmount:f.gross, sellAmount:0, fee:f.fee, tax:0 });
        sharesHeld += shares;
      }
      if(sharesHeld>0){
        const s=sell; const f=feesInt(s.price, sharesHeld, true);
        out.push({ side:'SELL', ts:s.ts, tsMs:s.tsMs, price:s.price, shares:sharesHeld, buyAmount:0, sellAmount:f.gross, fee:f.fee, tax:f.tax });
      }
    }
    out.sort((a,b)=>a.tsMs-b.tsMs); return out;
  }
  function renderExecTable(rows){
    const card=$('#execCard'); const tb=$('#execTable tbody'); tb.innerHTML='';
    if(!rows.length){ card.style.display='none'; return; } card.style.display='';
    for(const e of rows){
      const tr=document.createElement('tr'); tr.className=e.side==='SELL'?'sell-row':'buy-row';
      const tsShow = tsPretty(e.ts); const amt = e.side==='SELL' ? e.sellAmount : e.buyAmount;
      tr.innerHTML =
        `<td>${tsShow}</td>
         <td>${e.side==='BUY'?'買進':'賣出'}</td>
         <td>${e.price.toFixed(2)}</td>
         <td class="right">${fmtInt(e.shares||0)}</td>
         <td class="right">${fmtInt(e.fee||0)}</td>
         <td class="right">${fmtInt(e.tax||0)}</td>
         <td class="right">${fmtInt(amt||0)}</td>`;
      tb.appendChild(tr);
    }
  }

  /* ============ 最佳化交易（本金100萬；1/1/2；資金不足縮量） ============ */
  function feesOpt(price, shares, isSell){ const g=price*shares; const fee=Math.max(CFG.minFee,Math.ceil(g*CFG.feeRate)); const tax=isSell?Math.ceil(g*CFG.taxRate):0; return {gross:g,fee,tax}; }
  function buyCostLots(price,lots){ const sh=lots*CFG.unitShares; const f=feesOpt(price,sh,false); return { cost:f.gross+f.fee, shares:sh, f }; }
  function splitSegments(execs){ const segs=[], cur=[]; for(const e of execs){ cur.push(e); if(e.side==='SELL'){ segs.push(cur.slice()); cur.length=0; } } if(cur.length) segs.push(cur.slice()); return segs; }
  function buildOptimizedExecs(execs){
    const segs=splitSegments(execs), out=[]; let cumPnlAll=0;
    for(const seg of segs){
      const buys=seg.filter(x=>x.side==='BUY'); const sell=seg.find(x=>x.side==='SELL');
      if(!buys.length || !sell) continue;
      const p0=buys[0].price; const one=buyCostLots(p0,1).cost;
      let maxLotsTotal=Math.floor(CFG.initialCapital/one); if(maxLotsTotal<=0) continue;
      let q=Math.floor(maxLotsTotal/4); if(q<=0) q=1;
      const n=Math.min(3,buys.length); const plan=[q,q,2*q].slice(0,n);
      let remaining=CFG.initialCapital, sharesHeld=0, cumCost=0;
      for(let i=0;i<n;i++){
        const b=buys[i]; let lots=plan[i];
        const oneC=buyCostLots(b.price,1).cost; let affordable=Math.floor(remaining/oneC);
        if(affordable<=0) break; if(lots>affordable) lots=affordable;
        const bc=buyCostLots(b.price,lots);
        remaining-=bc.cost; cumCost+=bc.cost; sharesHeld+=bc.shares;
        const costAvgDisp=(bc.f.gross+bc.f.fee)/bc.shares;
        out.push({ side:'BUY', ts:b.ts, tsMs:b.tsMs, price:b.price, shares:bc.shares,
          buyAmount:bc.f.gross, sellAmount:0, fee:bc.f.fee, tax:0, cost:bc.cost,
          cumCost, costAvgDisp, pnlFull:null, retPctUnit:null, cumPnlFull:cumPnlAll });
      }
      if(sharesHeld>0){
        const s=sell; const st=feesOpt(s.price,sharesHeld,true);
        const pnlFull= st.gross - st.fee - st.tax - cumCost; cumPnlAll+=pnlFull;
        const sellCumCostDisp=cumCost+st.fee+st.tax; const sellCostAvgDisp=sellCumCostDisp/sharesHeld;
        const buyCostAvgBase=cumCost/sharesHeld; const priceDiff=sellCostAvgDisp-buyCostAvgBase;
        out.push({ side:'SELL', ts:s.ts, tsMs:s.tsMs, price:s.price, shares:sharesHeld, buyAmount:0, sellAmount:st.gross,
          fee:st.fee, tax:st.tax, cost:0, cumCost, cumCostDisp:sellCumCostDisp, costAvgDisp:sellCostAvgDisp, priceDiff,
          pnlFull, retPctUnit: sellCumCostDisp>0 ? (pnlFull/sellCumCostDisp) : null, cumPnlFull:cumPnlAll });
      }
    }
    out.sort((a,b)=>a.tsMs-b.tsMs); return out;
  }
  function renderOptTable(rows){
    const thead=$('#optTable thead'), tbody=$('#optTable tbody');
    thead.innerHTML=`<tr>
      <th>日期</th><th>種類</th><th>成交價格</th><th>成交數量</th>
      <th>買進金額</th><th>賣出金額</th><th>手續費</th><th>交易稅</th>
      <th>成本</th><th>成本均價</th><th>累計成本</th><th>價格差</th><th>損益</th><th>報酬率</th><th>累計損益</th>
    </tr>`;
    tbody.innerHTML='';
    for(const e of rows){
      const isSell=e.side==='SELL';
      const costAvgDisp = e.costAvgDisp!=null ? Number(e.costAvgDisp).toFixed(2) : '—';
      const cumCostDisp = isSell ? (e.cumCostDisp ?? (e.cumCost + (e.fee||0) + (e.tax||0))) : (e.cumCost||0);
      const priceDiff = isSell ? (e.priceDiff!=null ? e.priceDiff.toFixed(2) : '—') : '—';
      const retPctShow = (isSell && e.retPctUnit!=null) ? ((e.retPctUnit*100).toFixed(2)+'%') : '—';
      const pnlCell = e.pnlFull==null ? '—' : (e.pnlFull>0 ? `<span class="pnl-pos">${fmtInt(e.pnlFull)}</span>` : `<span class="pnl-neg">${fmtInt(e.pnlFull)}</span>`);
      const cumPnlCell = e.cumPnlFull==null ? '—' : (e.cumPnlFull>0 ? `<span class="pnl-pos">${fmtInt(e.cumPnlFull)}</span>` : `<span class="pnl-neg">${fmtInt(e.cumPnlFull)}</span>`);
      const tr=document.createElement('tr'); tr.className=isSell?'sell-row':'buy-row';
      tr.innerHTML =
        `<td>${tsPretty(e.ts)}</td><td>${isSell?'賣出':'買進'}</td><td>${e.price.toFixed(2)}</td>
         <td>${fmtInt(e.shares||0)}</td><td>${fmtInt(e.buyAmount||0)}</td><td>${fmtInt(e.sellAmount||0)}</td>
         <td>${fmtInt(e.fee||0)}</td><td>${fmtInt(e.tax||0)}</td><td>${fmtInt(e.cost||0)}</td>
         <td>${costAvgDisp}</td><td>${fmtInt(cumCostDisp||0)}</td><td>${priceDiff}</td>
         <td>${pnlCell}</td><td>${retPctShow}</td><td>${cumPnlCell}</td>`;
      tbody.appendChild(tr);
    }
  }

  /* ============ 啟動 ============ */
  async function boot(){
    try{
      set('從 Supabase 讀取清單…');
      const { data } = await sb.storage.from(CFG.bucket).list('', { limit:1000, sortBy:{column:'name',order:'asc'} });
      const list=(data||[])
        .map(it=>({ name:it.name, fullPath:it.name, updatedAt:it.updated_at?Date.parse(it.updated_at):0, size:it.metadata?.size||0 }))
        .filter(f=>/\.txt$|\.csv$/i.test(f.name) && /1031/i.test(f.name))
        .sort((a,b)=>b.updatedAt-a.updatedAt || (b.size||0)-(a.size||0));
      const latest=list[0];
      if(!latest){ set('找不到檔名含「1031」的 TXT。', true); return; }
      $('#latestName').textContent = latest.name;
      $('#baseName').textContent   = '（不使用）';

      set('下載/解析…');
      const raw = await fetchText(pubUrl(latest.fullPath));

      // 先試 canonical；若 0 行再用 CSV 轉
      let rows = window.ETF_ENGINE.parseCanon(raw);
      if(!rows.length){
        const {canon, ok} = toCanonFrom1031CSV(raw);
        if(!ok){ set('TXT 內容無可解析的交易行（CSV 轉換失敗）', true); return; }
        rows = window.ETF_ENGINE.parseCanon(canon);
      }
      if(!rows.length){ set('TXT 內無可解析的交易行。', true); return; }

      const start8=rows[0].day, end8=rows.at(-1).day;
      $('#periodText').textContent = `期間：${start8} 開始到 ${end8} 結束`;

      const bt = backtest(rows);

      // 週次圖
      renderWeeklyChart(bt.execs);

      // 交易明細：固定 1/1/2
      const simpleExecs = buildSimpleExecs(bt.execs);
      renderExecTable(simpleExecs);

      // 最佳化交易明細（資金 100 萬、1/1/2）
      const optExecs = buildOptimizedExecs(bt.execs);
      renderOptTable(optExecs);

      set('完成。');
    }catch(err){
      console.error('[1031 ERROR]', err);
      set('初始化失敗：'+(err?.message||String(err)), true);
    }
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
