// tw-1031.js — 台股 1031 策略頁（改自 00909 頁範本）
(function(){
  const $ = s => document.querySelector(s);
  const status = $('#autostatus');
  const set = (m,bad=false)=>{ if(status){ status.textContent=m; status.className = bad?'chip bad':'chip ok'; } };

  // ====== Supabase ======
  const SUPABASE_URL = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET = "reports";
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global:{ fetch:(u,o={})=>fetch(u,{...o,cache:'no-store'}) } });
  const pubUrl = (path) => sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

  // ====== Helpers ======
  const q = new URLSearchParams(location.search);
  const OVERRIDE_FILE = q.get('file') || '';
  const MANIFEST_NAME = '1031';

  const CANON_RE=/^(\d{14})\.0{6}\s+(\d+\.\d{6})\s+(新買|平賣|新賣|平買|強制平倉|強平)\s*$/;
  const EXTRACT_RE=/.*?(\d{14})(?:\.0{1,6})?\s+(\d+(?:\.\d{1,6})?)\s*(新買|平賣|新賣|平買|強制平倉|強平)\s*$/;

  function normalizeText(raw){
    let s=raw.replace(/\ufeff/gi,'').replace(/\u200b|\u200c|\u200d/gi,''); s=s.replace(/[\x00-\x09\x0B-\x1F\x7F]/g,'').replace(/\r\n?/g,'\n').replace(/\u3000/g,' ');
    return s.split('\n').map(l=>l.replace(/\s+/g,' ').trim()).filter(Boolean).join('\n');
  }
  function canonicalize(txt){
    const out=[], lines=txt.split('\n'); let ok=0;
    for(const l of lines){ const m=l.match(EXTRACT_RE); if(m){ const ts=m[1], px=Number(m[2]); const p6=Number.isFinite(px)?px.toFixed(6):m[2]; let act=m[3]; if(act==='強平') act='強制平倉'; out.push(`${ts}.000000 ${p6} ${act}`); ok++; } }
    return { canon: out.join('\n'), ok };
  }
  async function fetchSmart(url){
    const res=await fetch(url,{cache:'no-store'}); if(!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const buf=await res.arrayBuffer();
    for(const enc of ['utf-8','big5','utf-16le','utf-16be']){ try{ const td=new TextDecoder(enc); const norm=normalizeText(td.decode(buf)); const {canon,ok}=canonicalize(norm); if(ok>0) return {canon,ok}; }catch{} }
    const td=new TextDecoder('utf-8'); const norm=normalizeText(td.decode(buf)); const {canon,ok}=canonicalize(norm); return {canon,ok};
  }
  function parseCanon(text){
    const rows=[]; if(!text) return rows; for(const line of text.split('\n')){ const m=line.match(CANON_RE); if(m) rows.push({ts:m[1], line}); }
    rows.sort((a,b)=>a.ts.localeCompare(b.ts)); return rows;
  }
  function mergeByBaseline(baseText, latestText){
    const A=parseCanon(baseText), B=parseCanon(latestText);
    const baseMax=A.length?A[A.length-1].ts:'';
    const added=baseMax?B.filter(x=>x.ts>baseMax).map(x=>x.line):B.map(x=>x.line);
    const mergedLines=[...A.map(x=>x.line), ...added];
    return mergedLines.join('\n');
  }

  async function readManifest(){
    try{
      const { data } = await sb.storage.from(BUCKET).download(`manifests/${MANIFEST_NAME}.json`);
      if(!data) return null;
      return JSON.parse(await data.text());
    }catch{ return null; }
  }
  async function latest1031(){
    const all=[];
    async function listDeep(prefix, depth){
      const p = (prefix && !prefix.endsWith('/')) ? prefix + '/' : (prefix || '');
      const { data } = await sb.storage.from(BUCKET).list(p, { limit:1000, sortBy:{column:'name',order:'asc'} });
      for(const it of (data||[])){
        if(it.id===null) await listDeep(p+it.name, depth+1);
        else all.push({...it, fullPath: p+it.name});
      }
    }
    await listDeep('',0);
    const files = all.filter(x=>/1031/i.test(x.name));
    if(!files.length) return null;
    const scoreInName = n => { const m=(n||'').match(/\b(20\d{6})\b/g); return m?Math.max(...m.map(s=>+s)):0; };
    files.sort((a,b)=>{
      const sa=scoreInName(a.name), sb=scoreInName(b.name);
      if(sa!==sb) return sb-sa;
      const ta=a.updated_at?Date.parse(a.updated_at):0, tb=b.updated_at?Date.parse(b.updated_at):0;
      if(ta!==tb) return tb-ta;
      return (b.metadata?.size||0)-(a.metadata?.size||0);
    });
    return files[0];
  }

  // ====== Chart ======
  let chWeekly=null;
  function drawWeekly(days, vals){
    const ctx = document.getElementById('chWeekly');
    if(chWeekly) chWeekly.destroy();
    const cum = []; let acc=0; for(const v of vals){ acc+=v; cum.push(acc); }
    chWeekly = new Chart(ctx, {
      type:'line',
      data:{ labels:days, datasets:[{ label:'週盈虧', data:vals }, { label:'累積', data:cum }] },
      options:{ responsive:true, maintainAspectRatio:false, plugins:{ legend:{ display:true } }, scales:{ x:{ display:false } } }
    });
  }

  // ====== Renderers ======
  function fmtPct(x){ return (x*100).toFixed(2)+'%'; }
  function fmtMoney(x){ return (Math.round(x)).toLocaleString(); }

  function renderKPI(k){
    $('#k_total').textContent = fmtPct(k.totalReturn);
    $('#k_cagr').textContent  = fmtPct(k.cagr);
    $('#k_mdd').textContent   = fmtPct(k.maxDD);
    $('#k_pf').textContent    = (k.pf||0).toFixed(2);
    $('#k_hit').textContent   = fmtPct(k.hit);
  }
  function renderTable(rows){
    const tb = $('#optTable tbody'); tb.innerHTML='';
    for(const r of rows){
      const tr=document.createElement('tr');
      const cells=[r.date, r.type, r.price, r.qty, r.buyAmt, r.sellAmt, r.fee, r.tax, r.cost, r.avgCost, r.cumCost, r.diff, r.pnl, r.ret, r.cumPnl];
      cells.forEach((c,i)=>{ const td=document.createElement('td'); td.textContent=(i>=2?Number(c).toLocaleString():c); if([2,3,4,5,6,7,8,9,10,11,12,14].includes(i)) td.className='right'; tr.appendChild(td); });
      tb.appendChild(tr);
    }
  }

  // ====== Main ======
  (async function main(){
    try{
      set('讀取設定…');
      const manifest = await readManifest();

      let latestPath = OVERRIDE_FILE;
      if(!latestPath){
        set('尋找 1031 最新檔…');
        const f = await latest1031();
        if(!f) throw new Error('找不到含 1031 的檔案');
        latestPath = f.fullPath;
        $('#latestChip').textContent = '最新檔：' + latestPath;
      }else{
        $('#latestChip').textContent = '指定檔：' + latestPath;
      }

      let mergedText='';
      if(manifest?.baseline_path){
        $('#baseChip').textContent = '基準：' + manifest.baseline_path;
        const baseTxt = (await fetchSmart(pubUrl(manifest.baseline_path))).canon;
        const latTxt  = (await fetchSmart(pubUrl(latestPath))).canon;
        mergedText = mergeByBaseline(baseTxt, latTxt);
      }else{
        $('#baseChip').textContent = '基準：—';
        mergedText = (await fetchSmart(pubUrl(latestPath))).canon;
      }

      set('解析/回測…');
      const rows = window.ETF_ENGINE.parseCanon(mergedText);
      const CFG  = window.ETF_ENGINE.defaultCFG();
      const R    = window.ETF_ENGINE.backtest(rows, CFG);

      // 週盈虧
      const week = window.ETF_CHART.weeklySeriesFromTrades(R.trades);
      drawWeekly(week.labels, week.pnl);

      // KPI
      renderKPI({
        totalReturn: R.kpi.totalReturn,
        cagr: R.kpi.cagr,
        maxDD: R.kpi.maxDD,
        pf: R.kpi.pf,
        hit: R.kpi.hitRate
      });

      // 交易表
      renderTable(window.ETF_ENGINE.toExecTable(R.execs));

      set('完成');
    }catch(e){
      console.error(e);
      set('錯誤：'+e.message, true);
    }
  })();

  // 設此為基準（寫 manifest 需你提供 server 端；此處僅示意）
  $('#btnSetBase').addEventListener('click', ()=>alert('此按鈕僅示意：若要寫入 manifests/1031.json，需在後端（或本地工具）處理。'));
})();
