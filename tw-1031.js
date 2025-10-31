// tw-1031.js — 只做圖表 + 交易明細（無 KPI）
(function(){
  const $ = s => document.querySelector(s);
  const status = $('#autostatus');
  const set = (m,bad=false)=>{ if(status){ status.textContent=m; status.style.color = bad? '#c62828' : '#222'; } };
  const fmtInt = n => Math.round(n || 0).toLocaleString();
  const tsPretty = ts14 => `${ts14.slice(0,4)}/${ts14.slice(4,6)}/${ts14.slice(6,8)} ${ts14.slice(8,10)}:${ts14.slice(10,12)}`;

  // Supabase
  const SUPABASE_URL = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET = "reports";
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global:{ fetch:(u,o={})=>fetch(u,{...o,cache:'no-store'}) } });
  const pubUrl = p => sb.storage.from(BUCKET).getPublicUrl(p).data.publicUrl;

  // 取得最新 1031 檔
  async function latest1031(){
    const all=[];
    async function listDeep(prefix){
      const pp = (prefix && !prefix.endsWith('/')) ? prefix + '/' : (prefix || '');
      const { data } = await sb.storage.from(BUCKET).list(pp, { limit:1000, sortBy:{column:'name',order:'asc'} });
      for(const it of (data||[])){
        if(it.id===null) await listDeep(pp+it.name);
        else all.push({...it, fullPath: pp+it.name});
      }
    }
    await listDeep('');
    const files = all.filter(x=>/1031/i.test(x.name));
    if(!files.length) return null;
    const score = n => { const m=(n||'').match(/\b(20\d{6})\b/g); return m?Math.max(...m.map(s=>+s)):0; };
    files.sort((a,b)=>{
      const sa=score(a.name), sb=score(b.name);
      if(sa!==sb) return sb-sa;
      const ta=a.updated_at?Date.parse(a.updated_at):0, tb=b.updated_at?Date.parse(b.updated_at):0;
      if(ta!==tb) return tb-ta;
      return (b.metadata?.size||0)-(a.metadata?.size||0);
    });
    return files[0];
  }

  // 週次圖
  let chWeekly = null;
  function weekStartDate(ms){
    const d=new Date(ms), dow=(d.getUTCDay()+6)%7;
    const s=new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()-dow));
    return s.toISOString().slice(0,10);
  }
  function buildWeeklyFromExecs(execs){
    const m=new Map(), order=[];
    for(const e of execs){
      // 只在賣出那筆記錄 PnL（引擎應提供 pnlFull）；若沒有就跳過
      if(e.side!=='SELL' || typeof e.pnlFull!=='number') continue;
      const wk = weekStartDate(e.tsMs);
      if(!m.has(wk)){ m.set(wk,0); order.push(wk); }
      m.set(wk, m.get(wk)+e.pnlFull);
    }
    const labels=order, weekly=labels.map(wk=>m.get(wk)||0);
    const cum=[]; let s=0; for(const v of weekly){ s+=v; cum.push(s); }
    return { labels, weekly, cum };
  }
  function renderWeeklyChart(execs){
    const card=$('#weeklyCard'), ctx=$('#chWeekly');
    const W = buildWeeklyFromExecs(execs);
    if(!W.labels.length){ card.style.display='none'; return; }
    card.style.display='';
    if(chWeekly) chWeekly.destroy();
    chWeekly = new Chart(ctx, {
      data:{
        labels:W.labels,
        datasets:[
          { type:'bar', label:'每週獲利', data:W.weekly, borderWidth:1 },
          { type:'line', label:'累積淨利', data:W.cum, borderWidth:2, tension:0.2, pointRadius:0 }
        ]
      },
      options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:true}}, scales:{ x:{ticks:{maxTicksLimit:12}} } }
    });
  }

  // 交易明細表（原始 execs）
  function renderTxTable(execs){
    const tb = $('#txTable tbody'); tb.innerHTML='';
    for(const e of execs){
      const tr=document.createElement('tr');
      tr.className = (e.side==='SELL'?'sell-row':'buy-row');
      const fee = e.fee!=null ? e.fee : 0;
      const tax = e.tax!=null ? e.tax : 0;
      const amt = e.side==='SELL' ? (e.sellAmount??0) : (e.buyAmount??0);
      tr.innerHTML = `
        <td>${e.ts ? tsPretty(e.ts) : new Date(e.tsMs).toISOString().slice(0,16).replace('T',' ')}</td>
        <td>${e.side==='BUY'?'買進':(e.side==='SELL'?'賣出':(e.side||'—'))}</td>
        <td>${e.price!=null ? Number(e.price).toFixed(2) : '—'}</td>
        <td>${fmtInt(e.shares||0)}</td>
        <td>${fmtInt(fee)}</td>
        <td>${fmtInt(tax)}</td>
        <td>${fmtInt(amt)}</td>
      `;
      tb.appendChild(tr);
    }
  }

  // 主流程
  (async function boot(){
    try{
      set('尋找 1031 最新檔…');
      const f = await latest1031();
      if(!f){ set('找不到檔名含「1031」的檔案（reports/）', true); return; }
      $('#latestName').textContent = f.fullPath;

      set('下載/解析…');
      const url = pubUrl(f.fullPath);
      const txt = await fetch(url, {cache:'no-store'}).then(r=>r.text());
      const rows = window.ETF_ENGINE.parseCanon(txt);
      if(!rows.length){ set('TXT 內容無交易行可解析', true); return; }

      const start = rows[0].day, end = rows.at(-1).day;
      $('#periodText').textContent = `${start} - ${end}`;

      set('回測/繪圖…');
      const bt = window.ETF_ENGINE.backtest(rows, window.ETF_ENGINE.defaultCFG());
      renderWeeklyChart(bt.execs);
      renderTxTable(bt.execs);

      set('完成');
    }catch(err){
      console.error(err);
      set('錯誤：'+(err?.message||String(err)), true);
    }
  })();
})();
