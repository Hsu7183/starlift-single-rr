// tw-1031.js — 台股 1031 版本（只顯示：每週盈虧圖 + 交易明細）
// 依賴：Chart.js、@supabase/supabase-js、shared.js、etf-engine.js
(function(){
  const $ = s => document.querySelector(s);
  const status = $('#autostatus');
  const set = (m,bad=false)=>{ if(status){ status.textContent=m; status.style.color = bad ? '#c62828' : '#222'; } };
  const fmtInt = n => Math.round(n || 0).toLocaleString();
  const tsPretty = ts14 => `${ts14.slice(0,4)}/${ts14.slice(4,6)}/${ts14.slice(6,8)} ${ts14.slice(8,10)}:${ts14.slice(10,12)}`;

  // ====== Supabase 參數 ======
  const SUPABASE_URL = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET = "reports";
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global:{ fetch:(u,o={})=>fetch(u,{...o,cache:'no-store'}) }
  });
  const pubUrl = p => sb.storage.from(BUCKET).getPublicUrl(p).data.publicUrl;

  // ====== 讀取邏輯 ======
  const q = new URLSearchParams(location.search);
  const OVERRIDE_FILE = q.get('file') || ''; // 支援 ?file=reports/path/to/file.txt

  async function listAllFiles(prefix=''){
    const all=[];
    async function listDeep(dir){
      const pp = (dir && !dir.endsWith('/')) ? dir + '/' : (dir || '');
      const { data } = await sb.storage.from(BUCKET).list(pp, { limit:1000, sortBy:{column:'name',order:'asc'} });
      for(const it of (data||[])){
        if(it.id===null){ await listDeep(pp+it.name); }
        else all.push({...it, fullPath: pp+it.name});
      }
    }
    await listDeep(prefix);
    return all;
  }

  function scoreByDateInName(name){
    // 以檔名中最大 YYYYMMDD 當排序權重
    const m=(name||'').match(/\b(20\d{6})\b/g);
    return m ? Math.max(...m.map(s=>+s)) : 0;
  }

  async function latestFile1031(){
    const all = await listAllFiles('');
    const cands = all.filter(x=>/1031/i.test(x.name));
    if(!cands.length) return null;
    cands.sort((a,b)=>{
      const sa=scoreByDateInName(a.name), sb=scoreByDateInName(b.name);
      if(sa!==sb) return sb-sa;
      const ta=a.updated_at?Date.parse(a.updated_at):0, tb=b.updated_at?Date.parse(b.updated_at):0;
      if(ta!==tb) return tb-ta;
      return (b.metadata?.size||0)-(a.metadata?.size||0);
    });
    return cands[0];
  }

  async function fetchText(u){
    const res = await fetch(u, {cache:'no-store'});
    if(!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  }

  // ====== 每週盈虧圖 ======
  let chWeekly = null;

  function weekStartDateUTC(ms){
    // 以 UTC 周一為起點
    const d=new Date(ms), dow=(d.getUTCDay()+6)%7;
    const s=new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()-dow));
    return s.toISOString().slice(0,10);
  }

  function buildWeeklyFromExecs(execs){
    // 只在 SELL 那筆累計 pnlFull
    const m=new Map(), order=[];
    for(const e of execs){
      if(e.side!=='SELL' || typeof e.pnlFull!=='number') continue;
      const wk = weekStartDateUTC(e.tsMs);
      if(!m.has(wk)){ m.set(wk,0); order.push(wk); }
      m.set(wk, m.get(wk)+e.pnlFull);
    }
    const labels=order;
    const weekly=labels.map(wk=>m.get(wk)||0);
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
          { type:'bar',  label:'每週獲利', data:W.weekly, borderWidth:1 },
          { type:'line', label:'累積淨利', data:W.cum,    borderWidth:2, tension:0.2, pointRadius:0 }
        ]
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ display:true } },
        scales:{ x:{ ticks:{ maxTicksLimit:12 } } }
      }
    });
  }

  // ====== 交易明細表（原始 execs） ======
  function renderTxTable(execs){
    const tb = $('#txTable tbody'); tb.innerHTML='';
    for(const e of execs){
      const tr=document.createElement('tr');
      tr.className = (e.side==='SELL'?'sell-row':'buy-row');
      const fee = e.fee!=null ? e.fee : 0;
      const tax = e.tax!=null ? e.tax : 0;
      // 顯示金額：SELL 顯示賣出金額、BUY 顯示買進金額
      const amt = e.side==='SELL' ? (e.sellAmount??0) : (e.buyAmount??0);
      // 顯示時間：若有 ts（YYYYMMDDhhmmss），用 tsPretty；否則以 tsMs 推一個可讀字串
      const tsShow = e.ts ? tsPretty(e.ts) :
                     (e.tsMs ? new Date(e.tsMs).toISOString().slice(0,16).replace('T',' ') : '—');
      tr.innerHTML = `
        <td>${tsShow}</td>
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

  // ====== 主流程 ======
  (async function boot(){
    try{
      set('初始化…');

      // 讀檔：優先 ?file= 覆蓋，否則自動找含 1031 的最新檔
      let fullPath = '';
      if(OVERRIDE_FILE){
        fullPath = OVERRIDE_FILE;
        $('#latestName').textContent = fullPath.split('/').pop() || fullPath;
      }else{
        set('尋找 1031 最新檔…');
        const f = await latestFile1031();
        if(!f) throw new Error('找不到檔名含「1031」的檔案（reports/）');
        fullPath = f.fullPath;
        $('#latestName').textContent = fullPath;
      }

      set('下載/解析…');
      const url = /^https?:\/\//i.test(fullPath) ? fullPath : pubUrl(fullPath);
      const txt = await fetchText(url);

      // 解析成 rows（依你的引擎口徑）
      // window.ETF_ENGINE.parseCanon 支援標準：YYYYMMDDhhmmss.000000 <price(6d)> <動作>
      const rows = window.ETF_ENGINE.parseCanon(txt);
      if(!rows.length) throw new Error('TXT 內容無交易行可解析');

      // 期間
      const start = rows[0].day, end = rows.at(-1).day;
      $('#periodText').textContent = `${start} - ${end}`;

      // 回測（用引擎預設 CFG，沿用你現有口徑）
      set('回測/繪圖…');
      const CFG = window.ETF_ENGINE.defaultCFG ? window.ETF_ENGINE.defaultCFG() : {};
      const bt  = window.ETF_ENGINE.backtest(rows, CFG);

      // 繪圖 + 明細
      renderWeeklyChart(bt.execs);
      renderTxTable(bt.execs);

      set('完成');
    }catch(err){
      console.error(err);
      set('錯誤：' + (err?.message || String(err)), true);
    }
  })();
})();
