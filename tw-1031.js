// tw-1031.js — 1031策略頁
// 交易明細＝固定 1-1-2（1000/1000/2000）；最佳化交易明細＝本金100萬、資金不足縮量 1-1-2
(function(){
  const $ = s => document.querySelector(s);
  const status = $('#autostatus');
  const set = (m,bad=false)=>{ if(status){ status.textContent=m; status.style.color=bad?'#c62828':'#666'; } };
  const fmtInt = n => Math.round(n || 0).toLocaleString();
  const fmtPct = v => (v==null||!isFinite(v))?'—':(v*100).toFixed(2)+'%';
  const tsPretty = ts14 => `${ts14.slice(0,4)}/${ts14.slice(4,6)}/${ts14.slice(6,8)} ${ts14.slice(8,10)}:${ts14.slice(10,12)}`;

  // ===== 設定 =====
  const url = new URL(location.href);
  const CFG = {
    bucket: 'reports',
    // 你的檔名列於「1031 / 00909 / 20231212-20251023」→ 同時匹配 1031 與 00909
    want: /(1031|00909)/i,
    feeRate: +(url.searchParams.get('fee') || 0.001425),
    taxRate: +(url.searchParams.get('tax') || 0.001),
    minFee: +(url.searchParams.get('minfee') || 20),
    unitShares: +(url.searchParams.get('unit') || 1000),
    rf: 0.00,
    manifestPath: 'manifests/tw-1031.json'
  };
  const OPT   = { capital: 1_000_000, unitShares: CFG.unitShares, ratio: [1,1,2] };
  const FIXED = { lots: [1,1,2], unitShares: CFG.unitShares }; // 1000/1000/2000

  $('#feeRateChip').textContent = (CFG.feeRate*100).toFixed(4)+'%';
  $('#taxRateChip').textContent = (CFG.taxRate*100).toFixed(3)+'%';
  $('#minFeeChip').textContent  = String(CFG.minFee);
  $('#unitChip').textContent    = String(CFG.unitShares);
  $('#slipChip').textContent    = '0';
  $('#rfChip').textContent      = (CFG.rf*100).toFixed(2)+'%';

  // ===== Supabase =====
  const SUPABASE_URL = window.SUPABASE_URL || "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY || "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global:{ fetch:(u,o={})=>fetch(u,{...o,cache:'no-store'}) } });
  const pubUrl = p => { const {data} = sb.storage.from(CFG.bucket).getPublicUrl(p); return data?.publicUrl || '#'; };

  // ===== 遞迴列舉所有子資料夾（抓得到 1031/00909/20231212-20251023.txt） =====
  async function listAll(prefix=''){
    const p = (prefix && !prefix.endsWith('/')) ? (prefix + '/') : (prefix || '');
    const { data, error } = await sb.storage.from(CFG.bucket).list(p, { limit: 1000, sortBy:{ column:'name', order:'asc' } });
    if (error) throw new Error(error.message);
    const out = [];
    for (const it of (data||[])) {
      const isFile = !!(it.metadata && typeof it.metadata.size === 'number');
      if (isFile) {
        out.push({ name: it.name, fullPath: p + it.name, updatedAt: it.updated_at ? Date.parse(it.updated_at) : 0, size: it.metadata.size||0 });
      } else {
        // folder → 繼續往下
        const sub = await listAll(p + it.name);
        out.push(...sub);
      }
    }
    return out;
  }
  const lastDateScore = name => { const m = String(name).match(/\b(20\d{6})\b/g); return m && m.length ? Math.max(...m.map(s=>+s||0)) : 0; };

  // ===== 下載（多編碼） =====
  async function fetchText(u){
    const res = await fetch(u, { cache:'no-store' }); if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    const trials = ['utf-8','big5','utf-16le','utf-16be','windows-1252'];
    let best = {score:-1, txt:''};
    for (const enc of trials){
      try{
        let txt = new TextDecoder(enc).decode(buf).replace(/\ufeff/gi,'');
        const head=txt.slice(0,1500);
        const kw = /日期\s*,\s*時間\s*,\s*價格\s*,\s*動作/.test(head) ? 5 : 0;
        const lines=(txt.match(/^\s*\d{8}\s*,\s*\d{5,6}\s*,\s*\d+(?:\.\d+)?\s*,/gm)||[]).length;
        const score=kw*100+lines;
        if(score>best.score){ best={score,txt}; }
      }catch{}
    }
    return best.txt || new TextDecoder('utf-8').decode(buf);
  }

  // ===== CSV→canonical（只做多） =====
  function toCanonFrom1031CSV(raw){
    const toHalf = s => s.replace(/[０-９]/g, d=>String.fromCharCode(d.charCodeAt(0)-0xFEE0)).replace(/，/g,',');
    let txt = toHalf(raw).replace(/\r\n?/g,'\n').replace(/[\x00-\x08\x0B-\x1F\x7F]/g,'').replace(/[\u200B-\u200D]/g,'');
    const out=[];
    for(const line0 of txt.split('\n')){
      if(!line0) continue;
      const line=line0.trim();
      if(!line || /^日期\s*,\s*時間\s*,\s*價格\s*,\s*動作/i.test(line)) continue;
      const parts=line.split(','); if(parts.length<4) continue;

      const d8=(parts[0]||'').trim(); if(!/^\d{8}$/.test(d8)) continue;
      let t=(parts[1]||'').trim(); if(/^\d{5}$/.test(t)) t='0'+t; if(!/^\d{6}$/.test(t)) continue;
      const price=Number((parts[2]||'').trim()); if(!Number.isFinite(price)) continue;

      const act=(parts[3]||'').trim();
      let mapped='';
      if(act.includes('賣出')) mapped='平賣';
      else if(/買進|加碼攤平|再加碼攤平/.test(act)) mapped='新買';
      else continue;

      out.push(`${d8}${t}.000000 ${price.toFixed(6)} ${mapped}`);
    }
    return { canon: out.join('\n'), ok: out.length };
  }

  // ===== 回測 & 週圖 =====
  const backtest = (rows)=> window.ETF_ENGINE.backtest(rows, { feeRate:CFG.feeRate, taxRate:CFG.taxRate, minFee:CFG.minFee, unitShares:CFG.unitShares });
  let chWeekly=null;
  function weekStartDate(ms){ const d=new Date(ms), dow=(d.getUTCDay()+6)%7; const s=new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()-dow)); return s.toISOString().slice(0,10); }
  function buildWeeklyFromOpt(optExecs){
    const m=new Map(), order=[];
    for(const e of optExecs){
      if (e.side!=='SELL' || typeof e.pnlFull!=='number') continue;
      const wk = weekStartDate(e.tsMs);
      if (!m.has(wk)){ m.set(wk,0); order.push(wk); }
      m.set(wk, m.get(wk)+e.pnlFull);
    }
    const labels=order, weekly=labels.map(wk=>m.get(wk)||0);
    const cum=[]; let s=0; for(const v of weekly){ s+=v; cum.push(s); }
    return { labels, weekly, cum };
  }
  function renderWeeklyChartFromOpt(optExecs){
    const box=$('#weeklyCard'), ctx=$('#chWeekly'); if(!ctx) return;
    const W = buildWeeklyFromOpt(optExecs);
    if (!W.labels.length){ box.style.display='none'; return; }
    box.style.display='';
    const maxCum=Math.max(...W.cum,0);
    const floatBars=[]; let prev=0; for(const c of W.cum){ floatBars.push([prev,c]); prev=c; }
    if (chWeekly) chWeekly.destroy();
    chWeekly = new Chart(ctx, {
      data:{ labels:W.labels, datasets:[
        { type:'bar', label:'每週獲利（浮動長條）', data:floatBars, borderWidth:1, backgroundColor:'rgba(13,110,253,0.30)', borderColor:'#0d6efd' },
        { type:'line', label:'累積淨利', data:W.cum, borderWidth:2, borderColor:'#f43f5e', tension:0.2, pointRadius:0 }
      ]},
      options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:true}},
        scales:{ y:{ suggestedMin:0, suggestedMax:Math.max(1, maxCum*1.05) }, x:{ ticks:{ maxTicksLimit:12 } } } }
    });
  }

  // ===== 手續費/稅 =====
  function feesInt(price, shares, isSell){
    const gross = price * shares;
    const fee = Math.max(CFG.minFee, Math.ceil(gross * CFG.feeRate));
    const tax = isSell ? Math.ceil(gross * CFG.taxRate) : 0;
    return { gross, fee, tax };
  }

  // ===== 分段工具 =====
  function splitSegments(execs){ const segs=[], cur=[]; for(const e of execs){ cur.push(e); if(e.side==='SELL'){ segs.push(cur.splice(0)); } } if (cur.length) segs.push(cur); return segs; }
  function buyCostLots(price, lots){ const shares = lots * CFG.unitShares; const f = feesInt(price, shares, false); return { cost: f.gross + f.fee, shares, f }; }

  // ===== 建立兩組 execs =====
  function buildOptimizedExecs(execs){
    const segs = splitSegments(execs), out=[]; let cumPnlAll=0;
    for(const seg of segs){
      const buys = seg.filter(x=>x.side==='BUY');
      const sell = seg.find(x=>x.side==='SELL');
      if(!buys.length) continue;
      const p0 = buys[0].price;
      const one = buyCostLots(p0,1).cost;
      let maxLotsTotal = Math.floor(OPT.capital / one); if (maxLotsTotal<=0) continue;
      let q=Math.floor(maxLotsTotal/4); if(q<=0) q=1;
      const n=Math.min(3,buys.length);
      const plan=[q,q,2*q].slice(0,n);
      let remaining=OPT.capital, sharesHeld=0, cumCost=0;
      for(let i=0;i<n;i++){
        const b=buys[i];
        let lots=plan[i];
        const oneC = buyCostLots(b.price,1).cost;
        let affordable = Math.floor(remaining/oneC);
        if (affordable<=0) break;
        if (lots>affordable) lots=affordable;
        const bc = buyCostLots(b.price, lots);
        remaining -= bc.cost; cumCost += bc.cost; sharesHeld += bc.shares;
        const costAvgDisp = (bc.f.gross + bc.f.fee) / bc.shares;
        out.push({ side:'BUY', ts:b.ts, tsMs:b.tsMs, price:b.price, shares:bc.shares,
          buyAmount:bc.f.gross, sellAmount:0, fee:bc.f.fee, tax:0, cost:bc.cost,
          cumCost, costAvgDisp, pnlFull:null, retPctUnit:null, cumPnlFull:cumPnlAll });
      }
      if (sell && sharesHeld>0){
        const st = feesInt(sell.price, sharesHeld, true);
        const pnlFull = st.gross - (st.fee + st.tax) - cumCost; cumPnlAll += pnlFull;
        const sellCumCostDisp = cumCost + st.fee + st.tax;
        const sellCostAvgDisp = sellCumCostDisp / sharesHeld;
        const buyCostAvgBase  = cumCost / sharesHeld;
        const priceDiff = sellCostAvgDisp - buyCostAvgBase;
        out.push({ side:'SELL', ts:sell.ts, tsMs:sell.tsMs, price:sell.price, shares:sharesHeld,
          buyAmount:0, sellAmount:st.gross, fee:st.fee, tax:st.tax, cost:0,
          cumCost, cumCostDisp:sellCumCostDisp, costAvgDisp:sellCostAvgDisp, priceDiff,
          pnlFull, retPctUnit: sellCumCostDisp>0 ? (pnlFull / sellCumCostDisp) : null, cumPnlFull:cumPnlAll });
      }
    }
    out.sort((a,b)=>a.tsMs-b.tsMs); return out;
  }

  function buildFixed112Execs(execs){
    const segs = splitSegments(execs), out=[]; let cumPnlAll=0;
    for(const seg of segs){
      const buys = seg.filter(x=>x.side==='BUY');
      const sell = seg.find(x=>x.side==='SELL');
      if(!buys.length) continue;
      const n = Math.min(3, buys.length);
      const planLots = FIXED.lots.slice(0, n); // 1,1,2 lots
      let sharesHeld=0, cumCost=0;
      for(let i=0;i<n;i++){
        const b = buys[i], lots = planLots[i];
        const shares = lots * FIXED.unitShares;
        const f = feesInt(b.price, shares, false);
        const cost = f.gross + f.fee;
        sharesHeld += shares; cumCost += cost;
        const costAvgDisp = (f.gross + f.fee) / shares;
        out.push({ side:'BUY', ts:b.ts, tsMs:b.tsMs, price:b.price, shares,
          buyAmount:f.gross, sellAmount:0, fee:f.fee, tax:0, cost,
          cumCost, costAvgDisp, pnlFull:null, retPctUnit:null, cumPnlFull:cumPnlAll });
      }
      if(sell && sharesHeld>0){
        const st = feesInt(sell.price, sharesHeld, true);
        const pnlFull = st.gross - (st.fee + st.tax) - cumCost; cumPnlAll += pnlFull;
        const sellCumCostDisp = cumCost + st.fee + st.tax;
        const sellCostAvgDisp = sellCumCostDisp / sharesHeld;
        const buyCostAvgBase  = cumCost / sharesHeld;
        const priceDiff = sellCostAvgDisp - buyCostAvgBase;
        out.push({ side:'SELL', ts:sell.ts, tsMs:sell.tsMs, price:sell.price, shares:sharesHeld,
          buyAmount:0, sellAmount:st.gross, fee:st.fee, tax:st.tax, cost:0,
          cumCost, cumCostDisp:sellCumCostDisp, costAvgDisp:sellCostAvgDisp, priceDiff,
          pnlFull, retPctUnit: sellCumCostDisp>0 ? (pnlFull / sellCumCostDisp) : null, cumPnlFull:cumPnlAll });
      }
    }
    out.sort((a,b)=>a.tsMs-b.tsMs); return out;
  }

  // ===== 表格渲染（兩張表同欄位） =====
  function renderFullTable(execs, tableId){
    const thead = $(`#${tableId} thead`), tbody = $(`#${tableId} tbody`);
    if(!thead || !tbody) return;
    thead.innerHTML = `<tr>
      <th>日期</th><th>種類</th><th>成交價格</th><th>成交數量</th>
      <th>買進金額</th><th>賣出金額</th><th>手續費</th><th>交易稅</th>
      <th>成本</th><th>成本均價</th><th>累計成本</th><th>價格差</th><th>損益</th><th>報酬率</th><th>累計損益</th>
    </tr>`;
    tbody.innerHTML='';
    for(const e of execs){
      const isSell = e.side==='SELL';
      const costAvgDisp = e.costAvgDisp!=null ? Number(e.costAvgDisp).toFixed(2) : '—';
      const cumCostDisp = isSell ? (e.cumCostDisp ?? (e.cumCost + (e.fee||0) + (e.tax||0))) : (e.cumCost||0);
      const priceDiff   = isSell ? (e.priceDiff!=null ? e.priceDiff.toFixed(2) : '—') : '—';
      const retPctShow  = (isSell && e.retPctUnit!=null) ? fmtPct(e.retPctUnit) : '—';
      const pnlCell     = e.pnlFull==null ? '—' : (e.pnlFull>0 ? `<span class="pnl-pos">${fmtInt(e.pnlFull)}</span>` : `<span class="pnl-neg">${fmtInt(e.pnlFull)}</span>`);
      const cumPnlCell  = e.cumPnlFull==null ? '—' : (e.cumPnlFull>0 ? `<span class="pnl-pos">${fmtInt(e.cumPnlFull)}</span>` : `<span class="pnl-neg">${fmtInt(e.cumPnlFull)}</span>`);
      const tr=document.createElement('tr'); tr.className=isSell?'sell-row':'buy-row';
      tr.innerHTML =
        `<td>${tsPretty(e.ts)}</td>
         <td>${isSell?'賣出':'買進'}</td>
         <td>${Number(e.price).toFixed(2)}</td>
         <td>${fmtInt(e.shares||0)}</td>
         <td>${fmtInt(e.buyAmount||0)}</td>
         <td>${fmtInt(e.sellAmount||0)}</td>
         <td>${fmtInt(e.fee||0)}</td>
         <td>${fmtInt(e.tax||0)}</td>
         <td>${fmtInt(e.cost||0)}</td>
         <td>${costAvgDisp}</td>
         <td>${fmtInt(cumCostDisp||0)}</td>
         <td>${priceDiff}</td>
         <td>${pnlCell}</td>
         <td>${retPctShow}</td>
         <td>${cumPnlCell}</td>`;
      tbody.appendChild(tr);
    }
  }

  // ===== 基準（僅顯示名稱） =====
  async function readManifest(){ try{ const {data}=await sb.storage.from(CFG.bucket).download(CFG.manifestPath); if(!data) return null; return JSON.parse(await data.text()); }catch{ return null; } }

  // ===== 主流程 =====
  async function boot(){
    try{
      set('從 Supabase 讀取清單…');
      const paramFile=url.searchParams.get('file');
      let latest=null, list=[];
      if(paramFile){
        latest={ name:paramFile.split('/').pop()||'1031.txt', fullPath:paramFile, from:'url' };
      }else{
        const prefix = url.searchParams.get('prefix') || '';  // 可指定 ?prefix=1031
        list = await listAll(prefix); // << 遞迴列舉
        // 只要 .txt，且路徑/檔名含 1031 或 00909
        list = list.filter(f => /\.txt$/i.test(f.name) && (CFG.want.test(f.name) || CFG.want.test(f.fullPath)));
        // 依檔名中的 YYYYMMDD 加分，其次 updatedAt/size
        list.sort((a,b)=>{
          const sa=lastDateScore(a.name), sb=lastDateScore(b.name);
          if(sa!==sb) return sb-sa;
          if(a.updatedAt!==b.updatedAt) return b.updatedAt-a.updatedAt;
          return (b.size||0)-(a.size||0);
        });
        latest = list[0];
      }
      if(!latest){ set('找不到檔名含「1031/00909」的 TXT（可用 ?prefix=1031 或 ?file= 指定）。', true); return; }
      $('#latestName').textContent=latest.fullPath || latest.name;

      const manifest=await readManifest();
      $('#baseName').textContent = manifest?.baseline_path ? manifest.baseline_path.split('/').pop() : '（尚無）';

      // 下載
      set('下載最新檔…');
      const latestUrl = latest.from==='url'? latest.fullPath : pubUrl(latest.fullPath);
      const raw = await fetchText(latestUrl);

      // 解析
      set('解析與回測…');
      let rows = window.ETF_ENGINE.parseCanon(raw);
      if(!rows.length){
        const {canon, ok} = toCanonFrom1031CSV(raw);
        if(!ok){ set('TXT 內容無可解析的交易行（1031 CSV 轉換失敗）', true); return; }
        rows = window.ETF_ENGINE.parseCanon(canon);
      }
      if(!rows.length){ set('TXT 內無可解析的交易行。', true); return; }

      const start8=rows[0].day, end8=rows.at(-1).day;
      $('#periodText').textContent=`期間：${start8} 開始到 ${end8} 結束`;

      // 回測
      const bt = backtest(rows);

      // 兩組 execs
      const execsFixed = buildFixed112Execs(bt.execs);
      const execsOpt   = buildOptimizedExecs(bt.execs);

      // 畫圖 + 表格 + 目前持有
      renderWeeklyChartFromOpt(execsOpt);
      renderFullTable(execsFixed, 'tradeTable');
      renderFullTable(execsOpt,   'optTable');

      (function renderLastOpenBuyFromExecs(optExecs){
        const netShares = optExecs.reduce((acc,e)=> acc + (e.side==='BUY'? e.shares : -e.shares), 0);
        const bar = $('#lastBuyBar'); if(!bar) return;
        if (netShares<=0){ bar.style.display='none'; bar.innerHTML=''; return; }
        let i=optExecs.length-1; while(i>=0 && optExecs[i].side!=='SELL') i--;
        const openBuys = optExecs.slice(i+1).filter(e=>e.side==='BUY');
        if (!openBuys.length){ bar.style.display='none'; bar.innerHTML=''; return; }
        const rows = openBuys.map(b => `買進　<b>${tsPretty(b.ts)}</b>　成交價格 <b>${Number(b.price).toFixed(2)}</b>　成交數量 <b>${fmtInt(b.shares)}</b>　持有數量 <b>${fmtInt(netShares)}</b>`);
        bar.innerHTML = `目前持有：<br>${rows.join('<br>')}`; bar.style.display='';
      })(execsOpt);

      const btn=$('#btnSetBaseline'); if(btn) btn.disabled=true;
      set('完成。');
    }catch(err){
      console.error('[1031 ERROR]', err);
      set('初始化失敗：'+(err?.message||String(err)), true);
    }
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
