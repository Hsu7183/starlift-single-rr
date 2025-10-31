// tw-1031.js — 台股 1031（讀「資料上傳區 /reports」）
// 只做多（買進/加碼/再加碼 -> 新買；賣出 -> 平賣）；只顯示：每週盈虧圖 + 交易明細；不含 KPI
(function(){
  const $ = s => document.querySelector(s);
  const statusEl = $('#autostatus');
  const setStatus = (m,bad=false)=>{ if(statusEl){ statusEl.textContent=m; statusEl.style.background=bad?'#fee2e2':'#eef4ff'; statusEl.style.color=bad?'#b91c1c':'#0d6efd'; } };
  const fmtInt = n => Math.round(n||0).toLocaleString();
  const tsPretty = ts14 => `${ts14.slice(0,4)}/${ts14.slice(4,6)}/${ts14.slice(6,8)} ${ts14.slice(8,10)}:${ts14.slice(10,12)}`;

  // ===== Supabase =====
  const SUPABASE_URL = window.SUPABASE_URL || "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_KEY = window.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ5aGJtbW5hY2V6emdrd2Zrb3pzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1OTE0NzksImV4cCI6MjA3NDE2NzQ3OX0.VCSye3-fKrQphejdJSWAM6iRzv_7gkl8MLe7NeVszR0";
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { global:{ fetch:(u,o={})=>fetch(u,{...o,cache:'no-store'}) } });
  const BUCKET = 'reports';
  const pubUrl = p => sb.storage.from(BUCKET).getPublicUrl(p).data.publicUrl;

  // ===== UI =====
  const sel=$('#fileSel'), btnLoad=$('#btnLoad'), btnRefresh=$('#btnRefresh'), currentFile=$('#currentFile'), periodText=$('#periodText');
  const q=new URLSearchParams(location.search); const OVERRIDE_FILE=q.get('file')||'';

  // ===== List =====
  async function listRecursive(prefix='',acc=[]){
    const p = prefix && !prefix.endsWith('/') ? prefix+'/' : prefix;
    const {data,error}=await sb.storage.from(BUCKET).list(p,{limit:1000,sortBy:{column:'name',order:'asc'}});
    if(error) throw new Error(error.message);
    for(const it of data||[]){
      if(!it.id && !it.metadata) await listRecursive(p+it.name,acc);
      else acc.push({fullPath:p+it.name,item:it});
    }
    return acc;
  }
  const scoreByNameDate=name=>{
    const m=(name||'').match(/\b(20\d{6})\b/g);
    return m ? Math.max(...m.map(x=>+x)) : 0;
  };
  async function refreshList(){
    setStatus('讀取上傳區清單…');
    sel.innerHTML='<option value="">（選擇檔案）</option>'; btnLoad.disabled=true;
    const all=await listRecursive('');
    const files=all.filter(x=>/\.txt$|\.csv$/i.test(x.fullPath)).map(x=>({
      path:x.fullPath,name:x.fullPath.split('/').pop(),size:x.item?.metadata?.size||0,updated:x.item?.updated_at||''
    }));
    const f1031=files.filter(f=>/1031/i.test(f.name));
    const list=(f1031.length?f1031:files).sort((a,b)=>{
      const sa=scoreByNameDate(a.name), sb=scoreByNameDate(b.name);
      if(sa!==sb) return sb-sa;
      const ta=a.updated?Date.parse(a.updated):0, tb=b.updated?Date.parse(b.updated):0;
      if(ta!==tb) return tb-ta;
      return (b.size||0)-(a.size||0);
    });
    for(const f of list){
      const opt=document.createElement('option');
      opt.value=f.path; opt.textContent=`${f.path} · ${(f.updated||'').replace('T',' ').slice(0,16)||'—'}`;
      sel.appendChild(opt);
    }
    btnLoad.disabled=!sel.value;
    setStatus('就緒');
  }
  sel.addEventListener('change',()=>btnLoad.disabled=!sel.value);
  btnRefresh.addEventListener('click',()=>refreshList());

  // ===== 下載 =====
  const fetchText = u => fetch(u,{cache:'no-store'}).then(r=>{ if(!r.ok) throw new Error(r.status+' '+r.statusText); return r.text(); });

  // ===== Parser：1031 CSV -> canonical（只做多） =====
  function toCanonFrom1031CSV(raw){
    // 1) 換行標準化；2) 移除 BOM/奇異控制碼；3) 刪除不可見空白；4) 只取前四欄
    const txt = raw.replace(/\ufeff/g,'')
                   .replace(/\r\n?/g,'\n')
                   .replace(/[\x00-\x09\x0B-\x1F\x7F]/g,'')
                   .replace(/[\u200B-\u200D]/g,'');
    const out=[];
    for (let line of txt.split('\n')) {
      if (!line) continue;
      line = line.trim();
      if (!line || line.startsWith('日期')) continue;

      // 有些行可能因為結尾多逗號或有中文逗號：先把全形逗號替換為半形，再 split
      line = line.replace(/，/g, ',');
      const parts = line.split(',');
      if (parts.length < 4) continue;

      const d8 = (parts[0]||'').trim();
      const t0 = (parts[1]||'').trim();
      const px0= (parts[2]||'').trim();
      const act0= (parts[3]||'').trim();

      if (!/^\d{8}$/.test(d8)) continue;
      let t = t0;
      if (/^\d{5}$/.test(t)) t = '0'+t;
      if (!/^\d{6}$/.test(t)) continue;

      // 價格可能是整數或小數，先轉數字再固定 6 位
      const price = Number(px0);
      if (!Number.isFinite(price)) continue;
      const p6 = price.toFixed(6);

      // 只做多的動作映射
      let mapped = '';
      if (act0.indexOf('賣出') >= 0) mapped = '平賣';
      else if (/(買進|加碼攤平|再加碼攤平)/.test(act0)) mapped = '新買';
      else continue;

      out.push(`${d8}${t}.000000 ${p6} ${mapped}`);
    }
    return { canon: out.join('\n'), ok: out.length };
  }

  // ===== 每週盈虧圖 =====
  let chWeekly=null;
  const weekStartDateUTC=ms=>{
    const d=new Date(ms), dow=(d.getUTCDay()+6)%7;
    const s=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()-dow));
    return s.toISOString().slice(0,10);
  };
  function buildWeeklyFromExecs(execs){
    const m={},order=[];
    for(const e of execs){
      if(e.side!=='SELL'||typeof e.pnlFull!=='number') continue;
      const wk=weekStartDateUTC(e.tsMs);
      if(!(wk in m)){ m[wk]=0; order.push(wk); }
      m[wk]+=e.pnlFull;
    }
    const weekly=order.map(k=>m[k]||0); let s=0; const cum=weekly.map(v=>s+=v);
    return {labels:order,weekly,cum};
  }
  function renderWeeklyChart(execs){
    const card=$('#weeklyCard'),ctx=$('#chWeekly');
    const W=buildWeeklyFromExecs(execs);
    if(!W.labels.length){ card.style.display='none'; return; }
    card.style.display='';
    if(chWeekly) chWeekly.destroy();
    chWeekly=new Chart(ctx,{data:{
      labels:W.labels,
      datasets:[
        {type:'bar',label:'每週獲利',data:W.weekly,borderWidth:1},
        {type:'line',label:'累積淨利',data:W.cum,borderWidth:2,tension:0.2,pointRadius:0}
      ]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:true}},scales:{x:{ticks:{maxTicksLimit:12}}}}
    });
  }

  // ===== 交易明細表 =====
  function renderTxTable(execs){
    const tb=$('#txBody'); tb.innerHTML='';
    if(!execs.length){ tb.innerHTML='<tr><td colspan="7" class="muted">（無資料）</td></tr>'; return; }
    for(const e of execs){
      const tr=document.createElement('tr'); tr.className=e.side==='SELL'?'sell-row':'buy-row';
      const fee=e.fee||0,tax=e.tax||0,amt=e.side==='SELL'?(e.sellAmount||0):(e.buyAmount||0);
      const tsShow=e.ts?tsPretty(e.ts):(e.tsMs?new Date(e.tsMs).toISOString().slice(0,16).replace('T',' '):'—');
      tr.innerHTML=`<td>${tsShow}</td><td>${e.side==='BUY'?'買進':(e.side==='SELL'?'賣出':e.side||'—')}</td>
      <td>${e.price!=null?e.price.toFixed(2):'—'}</td>
      <td class="right">${fmtInt(e.shares||0)}</td><td class="right">${fmtInt(fee)}</td>
      <td class="right">${fmtInt(tax)}</td><td class="right">${fmtInt(amt)}</td>`;
      tb.appendChild(tr);
    }
  }

  // ===== 主程式 =====
  async function loadAndRender(path){
    try{
      setStatus('下載/解析…');
      const url = /^https?:\/\//i.test(path) ? path : pubUrl(path);
      const raw = await fetchText(url);
      const conv = toCanonFrom1031CSV(raw);
      if(!conv.ok) throw new Error('TXT 內容無可解析的交易行（1031 CSV 轉換失敗）');

      const rows = window.ETF_ENGINE.parseCanon(conv.canon);
      if(!rows.length) throw new Error('轉換後資料為空');

      const start=rows[0].day, end=rows.at(-1).day;
      periodText.textContent = `${start} - ${end}`;
      currentFile.textContent = path;

      setStatus('回測/繪圖…');
      const CFG = window.ETF_ENGINE.defaultCFG ? window.ETF_ENGINE.defaultCFG() : {};
      const bt  = window.ETF_ENGINE.backtest(rows, CFG);

      renderWeeklyChart(bt.execs);
      renderTxTable(bt.execs);
      setStatus('完成');
    }catch(err){
      console.error(err);
      setStatus('錯誤：'+(err?.message||String(err)), true);
    }
  }

  // ===== 啟動 =====
  btnLoad.addEventListener('click',()=>{ if(sel.value) loadAndRender(sel.value); });
  btnRefresh.addEventListener('click',()=>refreshList());
  (async function boot(){
    await refreshList();
    if(OVERRIDE_FILE){ currentFile.textContent=OVERRIDE_FILE.split('/').pop()||OVERRIDE_FILE; loadAndRender(OVERRIDE_FILE); return; }
    if(sel.options.length>1){ sel.selectedIndex=1; loadAndRender(sel.value); }
    else setStatus('清單為空，請先上傳檔案。', true);
  })();
})();
