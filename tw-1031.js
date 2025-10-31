// tw-1031.js — 台股 1031（直接讀「資料上傳區 /reports」）
// 顯示：每週盈虧圖 + 交易明細；不含 KPI
(function(){
  const $ = s => document.querySelector(s);
  const status = $('#autostatus');
  const set = (m,bad=false)=>{ if(status){ status.textContent=m; status.style.background = bad ? '#fee2e2' : '#eef4ff'; status.style.color = bad ? '#b91c1c' : '#0d6efd'; } };
  const fmtInt = n => Math.round(n || 0).toLocaleString();
  const tsPretty = ts14 => `${ts14.slice(0,4)}/${ts14.slice(4,6)}/${ts14.slice(6,8)} ${ts14.slice(8,10)}:${ts14.slice(10,12)}`;

  // ===== Supabase（優先用上傳頁掛的全域變數） =====
  const SUPABASE_URL  = window.SUPABASE_URL  || "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_KEY  = window.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ5aGJtbW5hY2V6emdrd2Zrb3pzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1OTE0NzksImV4cCI6MjA3NDE2NzQ3OX0.VCSye3-fKrQphejdJSWAM6iRzv_7gkl8MLe7NeVszR0";
  const BUCKET = "reports";
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    global:{ fetch:(u,o={})=>fetch(u,{...o,cache:'no-store'}) }
  });
  (function markProj(){ try{ const prj=(new URL(SUPABASE_URL).hostname||'').split('.')[0]; $('#projBadge')?.textContent=`Bucket: ${BUCKET}（Public）｜Project: ${prj}`; }catch{} })();
  const pubUrl = p => sb.storage.from(BUCKET).getPublicUrl(p).data.publicUrl;

  // ===== DOM =====
  const sel = $('#fileSel');
  const btnLoad = $('#btnLoad');
  const btnRefresh = $('#btnRefresh');
  const currentFile = $('#currentFile');
  const periodText = $('#periodText');
  const q = new URLSearchParams(location.search);
  const OVERRIDE_FILE = q.get('file') || '';

  // ===== 清單（遞迴掃描 + 排序；只列 .txt/.csv；優先 1031） =====
  async function listRecursive(path="", acc=[]){
    const p = (path && !path.endsWith('/')) ? path+'/' : (path||'');
    const { data, error } = await sb.storage.from(BUCKET).list(p, { limit: 1000, sortBy:{column:'name',order:'asc'} });
    if(error) throw new Error(error.message||'list error');
    for(const it of (data||[])){
      if(!it.id && !it.metadata){ await listRecursive(p + it.name, acc); }
      else acc.push({ fullPath: p + it.name, item: it });
    }
    return acc;
  }
  function scoreByNameDate(name){
    const m=(name||'').match(/\b(20\d{6})\b/g);
    return m ? Math.max(...m.map(s=>+s)) : 0;
  }
  async function refreshList(){
    set('讀取上傳區清單…');
    sel.innerHTML = '<option value="">（選擇檔案）</option>'; btnLoad.disabled = true;
    const all = await listRecursive("");
    const files = all
      .filter(x => /\.txt$|\.csv$/i.test(x.fullPath))
      .map(x => ({ path:x.fullPath, name:x.fullPath.split('/').pop(), size:x.item?.metadata?.size||0, updated:x.item?.updated_at||'' }));
    const f1031 = files.filter(f=>/1031/i.test(f.name));
    const list = (f1031.length ? f1031 : files).sort((a,b)=>{
      const sa=scoreByNameDate(a.name), sb=scoreByNameDate(b.name);
      if(sa!==sb) return sb-sa;
      const ta=a.updated?Date.parse(a.updated):0, tb=b.updated?Date.parse(b.updated):0;
      if(ta!==tb) return tb-ta;
      return (b.size||0)-(a.size||0);
    });
    for(const f of list){
      const opt = document.createElement('option');
      opt.value = f.path;
      opt.textContent = `${f.path}  ${f.updated?('· '+f.updated.replace('T',' ').slice(0,16)):'· —'}`;
      sel.appendChild(opt);
    }
    btnLoad.disabled = !sel.value;
    set('就緒');
  }
  sel?.addEventListener('change', ()=>{ btnLoad.disabled = !sel.value; });

  // ===== 下載 =====
  async function fetchText(u){
    const res = await fetch(u, {cache:'no-store'});
    if(!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  }

  // ===== 1031 專屬：CSV → canonical 轉換 =====
  // 支援行首格式：YYYYMMDD,hhmmss,price,action,...
  // 映射：買進/加碼攤平/再加碼攤平 -> 新買；賣出 -> 平賣
  function toCanonFrom1031CSV(raw){
    // 清理 BOM / 零寬 / 控制字元
    let txt = raw.replace(/\ufeff/gi,'').replace(/[\u200B-\u200D]/g,'')
                 .replace(/[\x00-\x09\x0B-\x1F\x7F]/g,'').replace(/\r\n?/g,'\n');
    const out=[]; let ok=0;
    const mapAction = a=>{
      if(/賣出/.test(a)) return '平賣';
      if(/買進|加碼攤平|再加碼攤平/.test(a)) return '新買';
      return ''; // unsupported
    };
    for(const line of txt.split('\n')){
      if(!line.trim()) continue;
      // 跳過表頭（含「日期,時間,價格,動作」）
      if(/^日期\s*,\s*時間\s*,\s*價格\s*,\s*動作/i.test(line)) continue;

      const m = line.match(/^\s*(\d{8})\s*,\s*(\d{5,6})\s*,\s*(\d+(?:\.\d+)?)\s*,\s*([^,]+)\s*/);
      if(!m) continue;

      const d8 = m[1];
      let t = m[2]; if(t.length===5) t = '0' + t; // 90500 -> 090500
      const px = Number(m[3]); const p6 = Number.isFinite(px) ? px.toFixed(6) : m[3];
      const act = mapAction(m[4].trim());
      if(!act) continue;

      out.push(`${d8}${t}.000000 ${p6} ${act}`); ok++;
    }
    return { canon: out.join('\n'), ok };
  }

  // ===== 每週盈虧圖 =====
  let chWeekly = null;
  function weekStartDateUTC(ms){
    const d=new Date(ms), dow=(d.getUTCDay()+6)%7;
    const s=new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()-dow));
    return s.toISOString().slice(0,10);
  }
  function buildWeeklyFromExecs(execs){
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
      options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{ display:true } }, scales:{ x:{ ticks:{ maxTicksLimit:12 } } } }
    });
  }

  // ===== 交易明細表 =====
  function renderTxTable(execs){
    const tb = $('#txBody'); tb.innerHTML='';
    for(const e of execs){
      const tr=document.createElement('tr');
      tr.className = (e.side==='SELL'?'sell-row':'buy-row');
      const fee = e.fee!=null ? e.fee : 0;
      const tax = e.tax!=null ? e.tax : 0;
      const amt = e.side==='SELL' ? (e.sellAmount??0) : (e.buyAmount??0);
      const tsShow = e.ts ? tsPretty(e.ts) :
                     (e.tsMs ? new Date(e.tsMs).toISOString().slice(0,16).replace('T',' ') : '—');
      tr.innerHTML = `
        <td>${tsShow}</td>
        <td>${e.side==='BUY'?'買進':(e.side==='SELL'?'賣出':(e.side||'—'))}</td>
        <td>${e.price!=null ? Number(e.price).toFixed(2) : '—'}</td>
        <td class="right">${fmtInt(e.shares||0)}</td>
        <td class="right">${fmtInt(fee)}</td>
        <td class="right">${fmtInt(tax)}</td>
        <td class="right">${fmtInt(amt)}</td>
      `;
      tb.appendChild(tr);
    }
    if(!execs.length){ tb.innerHTML = '<tr><td colspan="7" class="muted">（無資料）</td></tr>'; }
  }

  // ===== 載入並渲染 =====
  async function loadAndRender(fullPath){
    try{
      set('下載/解析…');
      const url = /^https?:\/\//i.test(fullPath) ? fullPath : pubUrl(fullPath);
      const raw = await fetchText(url);

      // 專屬轉換：CSV -> canonical
      const { canon, ok } = toCanonFrom1031CSV(raw);
      if(ok === 0) throw new Error('TXT 內容無可解析的交易行（1031 CSV 轉換失敗）');

      // 交給引擎 parse/backtest
      const rows = window.ETF_ENGINE.parseCanon(canon);
      if(!rows.length) throw new Error('轉換後資料為空');

      const start = rows[0].day, end = rows.at(-1).day;
      periodText.textContent = `${start} - ${end}`;
      currentFile.textContent = fullPath;

      set('回測/繪圖…');
      const CFG = window.ETF_ENGINE.defaultCFG ? window.ETF_ENGINE.defaultCFG() : {};
      const bt  = window.ETF_ENGINE.backtest(rows, CFG);

      renderWeeklyChart(bt.execs);
      renderTxTable(bt.execs);

      set('完成');
    }catch(err){
      console.error(err);
      set('錯誤：' + (err?.message || String(err)), true);
    }
  }

  // ===== 事件 =====
  btnLoad?.addEventListener('click', ()=>{ const path = sel.value; if(path) loadAndRender(path); });
  btnRefresh?.addEventListener('click', ()=>refreshList());

  // ===== 開機流程 =====
  (async function boot(){
    try{
      await refreshList();
      if(OVERRIDE_FILE){
        currentFile.textContent = OVERRIDE_FILE.split('/').pop() || OVERRIDE_FILE;
        await loadAndRender(OVERRIDE_FILE);
        return;
      }
      if(sel && sel.options.length>1){
        sel.selectedIndex = 1;
        await loadAndRender(sel.value);
      }else{
        set('清單為空，請先到「資料上傳區」上傳檔案。', true);
      }
    }catch(err){
      console.error(err);
      set('初始化失敗：' + (err?.message || String(err)), true);
    }
  })();
})();
