(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);

  const status   = $('#autostatus');
  const elLatest = $('#latestName');
  const elBase   = $('#baseName');
  const btnBase  = $('#btnSetBaseline');

  const rangeRow     = $('#rangeRow');
  const tradesBody   = $('#tradesBody');
  const equityCanvas = $('#equityChart');
  const dailyCanvas  = $('#weeklyPnlChart');

  const slipInput = $('#slipInput');
  const runBtn    = $('#runBtn');

  if (status) status.style.whiteSpace = 'pre-wrap';
  const setStatus = (msg, bad=false) => { if(status){ status.textContent=msg; status.style.color=bad?'#c62828':'#666'; } };

  // ---- slip=2 ----
  function forceSlip2(){
    if(!slipInput) return;
    slipInput.value='2';
    slipInput.dispatchEvent(new Event('input',{bubbles:true}));
    slipInput.dispatchEvent(new Event('change',{bubbles:true}));
  }
  function safeClickRun(times=4){
    if(!runBtn) return;
    const delays=[0,80,250,600];
    for(let i=0;i<Math.min(times,delays.length);i++){
      setTimeout(()=>{ forceSlip2(); runBtn.click(); }, delays[i]);
    }
  }
  document.addEventListener('DOMContentLoaded', ()=>forceSlip2());

  // ---- Supabase + merge (same as your 0807.js) ----
  const SUPABASE_URL  = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET        = "reports";
  const WANT          = /0807/i;
  const MANIFEST_PATH = "manifests/0807.json";

  const sb = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON, {
    global: { fetch: (u, o = {}) => fetch(u, { ...o, cache: 'no-store' }) }
  });

  const CANON_RE   = /^(\d{14})\.0{6}\s+(\d+\.\d{6})\s+(新買|平賣|新賣|平買|強制平倉)\s*$/;
  const EXTRACT_RE = /.*?(\d{14})(?:\.0{1,6})?\s+(\d+(?:\.\d{1,6})?)\s*(新買|平賣|新賣|平買|強制平倉)\s*$/;

  const pubUrl = (path)=> sb.storage.from(BUCKET).getPublicUrl(path)?.data?.publicUrl || '#';

  async function listOnce(prefix){
    const p = (prefix && !prefix.endsWith('/')) ? (prefix + '/') : (prefix || '');
    const { data, error } = await sb.storage.from(BUCKET).list(p,{limit:1000,sortBy:{column:'name',order:'asc'}});
    if(error) throw new Error(error.message);
    return (data||[])
      .filter(it => !(it.id === null && !it.metadata))
      .map(it => ({ name:it.name, fullPath:p+it.name, updatedAt: it.updated_at?Date.parse(it.updated_at):0, size: it.metadata?.size||0 }));
  }
  async function listCandidates(){
    const u=new URL(location.href);
    const prefix=u.searchParams.get('prefix')||'';
    return listOnce(prefix);
  }
  function lastDateScore(name){
    const m=String(name).match(/\b(20\d{6})\b/g);
    if(!m||!m.length) return 0;
    return Math.max(...m.map(s=>+s||0));
  }

  async function readManifest(){
    try{
      const {data,error}=await sb.storage.from(BUCKET).download(MANIFEST_PATH);
      if(error||!data) return null;
      return JSON.parse(await data.text());
    }catch{ return null; }
  }
  async function writeManifest(obj){
    const blob=new Blob([JSON.stringify(obj,null,2)],{type:'application/json'});
    const {error}=await sb.storage.from(BUCKET).upload(MANIFEST_PATH, blob, {upsert:true,cacheControl:'0',contentType:'application/json'});
    if(error) throw new Error(error.message);
  }

  function normalizeText(raw){
    let s = raw
      .replace(/\ufeff/gi,'')
      .replace(/\u200b|\u200c|\u200d/gi,'')
      .replace(/[\x00-\x09\x0B-\x1F\x7F]/g,'');
    s = s.replace(/\r\n?/g,'\n').replace(/\u3000/g,' ');
    return s.split('\n').map(l=>l.replace(/\s+/g,' ').trim()).filter(Boolean).join('\n');
  }
  function canonicalize(txt){
    const out=[]; let ok=0;
    for(const l of (txt||'').split('\n')){
      const m=l.match(EXTRACT_RE);
      if(m){
        const ts=m[1];
        const pxN=Number(m[2]);
        const px6=Number.isFinite(pxN)?pxN.toFixed(6):m[2];
        const act=m[3];
        out.push(`${ts}.000000 ${px6} ${act}`);
        ok++;
      }
    }
    return {canon:out.join('\n'), ok};
  }
  async function fetchSmart(url){
    const res=await fetch(url,{cache:'no-store'});
    if(!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buf=await res.arrayBuffer();
    for(const enc of ['utf-8','big5','utf-16le','utf-16be']){
      try{
        const td=new TextDecoder(enc,{fatal:false});
        const norm=normalizeText(td.decode(buf));
        const {canon,ok}=canonicalize(norm);
        if(ok>0) return {enc,canon,ok};
      }catch{}
    }
    const td=new TextDecoder('utf-8');
    const norm=normalizeText(td.decode(buf));
    const {canon,ok}=canonicalize(norm);
    return {enc:'utf-8',canon,ok};
  }

  function parseCanon(text){
    const rows=[];
    for(const line of (text||'').split('\n')){
      const m=line.match(CANON_RE);
      if(m) rows.push({ts:m[1], line});
    }
    rows.sort((a,b)=>a.ts.localeCompare(b.ts));
    return rows;
  }
  function mergeByBaseline(baseText, latestText){
    const A=parseCanon(baseText);
    const B=parseCanon(latestText);
    const baseMax=A.length?A[A.length-1].ts:'';
    const added=baseMax?B.filter(x=>x.ts>baseMax).map(x=>x.line):B.map(x=>x.line);
    return [...A.map(x=>x.line), ...added].join('\n');
  }
  function addFakeInpos(text){
    const out=[];
    const lines=(text||'').split('\n').map(s=>s.trim()).filter(Boolean);
    for(const line of lines){
      const m=line.match(CANON_RE);
      if(!m) continue;
      const ts=m[1], act=m[3];
      if(act==='新買' || act==='新賣'){
        const dir=(act==='新買')?1:-1;
        out.push(line);
        out.push(`${ts}.000000 0 0 ${dir} 0 INPOS`);
      } else out.push(line);
    }
    return out.join('\n');
  }

  async function feedToSingleTrades(filename, mergedText){
    const fileInput=$('#fileInput');
    const fname=filename||'0807.txt';
    const file=new File([mergedText], fname, {type:'text/plain'});
    forceSlip2();
    if(window.__singleTrades_setFile) window.__singleTrades_setFile(file);
    if(fileInput){
      const dt=new DataTransfer();
      dt.items.add(file);
      fileInput.files=dt.files;
      fileInput.dispatchEvent(new Event('change',{bubbles:true}));
    }
    safeClickRun(4);
  }

  // ---- date helpers ----
  const pad2 = (n)=>String(n).padStart(2,'0');
  const ymdToDate = (ymd)=>{
    if(!ymd||ymd.length!==8) return null;
    const y=+ymd.slice(0,4), m=+ymd.slice(4,6), d=+ymd.slice(6,8);
    return new Date(y,m-1,d);
  };
  const dateToYmd = (d)=>`${d.getFullYear()}${pad2(d.getMonth()+1)}${pad2(d.getDate())}`;
  const mondayOfWeek = (d)=>{
    const x=new Date(d.getFullYear(),d.getMonth(),d.getDate());
    const day=x.getDay();
    const delta=(day===0)?-6:(1-day);
    x.setDate(x.getDate()+delta);
    return x;
  };

  function parseYmdFromText(text){
    const s=String(text||'').trim();
    let m=s.match(/\b(20\d{12})\b/);
    if(m) return m[1].slice(0,8);
    m=s.match(/\b(20\d{6})\b/);
    if(m) return m[1];
    m=s.match(/\b(20\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/);
    if(m) return `${m[1]}${pad2(m[2])}${pad2(m[3])}`;
    return '';
  }

  function parseNum(text){
    const s=String(text||'').trim();
    if(!s||s==='—'||s==='-') return NaN;
    const v=Number(s.replace(/,/g,''));
    return Number.isFinite(v)?v:NaN;
  }
  const formatNum = (n)=>{
    if(!Number.isFinite(n)) return '—';
    const sign=n<0?'-':'';
    const x=Math.abs(Math.round(n));
    return sign + x.toLocaleString('en-US');
  };

  function getChart(canvas){
    if(!canvas||!window.Chart) return null;
    try { return window.Chart.getChart(canvas) || null; } catch { return null; }
  }

  // ---- Snapshot originals for ALL restore ----
  const SNAP = {
    ready:false,
    endYmd:null,
    tradesHTML:null,
    eq:{labels:null, data:null},
    dy:{labels:null, data:null},
    kpiHTML:null
  };

  function snapshotOnce(){
    if(SNAP.ready) return true;
    const eq=getChart(equityCanvas);
    const dy=getChart(dailyCanvas);
    if(!eq||!dy||!tradesBody) return false;
    if(!eq.data?.labels?.length || !eq.data?.datasets?.length) return false;
    if(!dy.data?.labels?.length || !dy.data?.datasets?.length) return false;

    SNAP.eq.labels = eq.data.labels.slice();
    SNAP.eq.data = eq.data.datasets.map(ds=>Array.isArray(ds.data)?ds.data.slice():[]);
    SNAP.dy.labels = dy.data.labels.slice();
    SNAP.dy.data = dy.data.datasets.map(ds=>Array.isArray(ds.data)?ds.data.slice():[]);
    SNAP.tradesHTML = tradesBody.innerHTML;

    // endYmd = max trading day from trades table (truth)
    const trs = Array.from(tradesBody.querySelectorAll('tr'));
    const yset = new Set();
    for(const tr of trs){
      const ymd = parseYmdFromText(tr.textContent);
      if(ymd) yset.add(ymd);
    }
    const list = Array.from(yset).sort();
    if(!list.length) return false;
    SNAP.endYmd = list[list.length-1];

    // KPI HTML (freeze) so non-ALL won't mutate it
    const kpiBad = document.querySelector('#kpiBadBody')?.closest('table');
    const kpiAll = document.querySelector('#kpiBody')?.closest('table');
    const kpiWrap = kpiAll?.closest('.kpi-wrapper')?.parentElement || document.body;
    SNAP.kpiHTML = kpiWrap.innerHTML;

    SNAP.ready = true;
    return true;
  }

  // ---- Range rules (end anchored) ----
  function rangeStartYmd(endYmd, code){
    if(code==='ALL') return '';
    const endDate=ymdToDate(endYmd);
    if(!endDate) return '';
    if(code==='1W') return dateToYmd(mondayOfWeek(endDate));
    if(code==='2W'){
      const m=mondayOfWeek(endDate);
      m.setDate(m.getDate()-7);
      return dateToYmd(m);
    }
    const daysMap={ '1M':30,'2M':60,'3M':91,'6M':182,'1Y':365 };
    const n=daysMap[code]||0;
    if(!n) return '';
    const s=new Date(endDate.getFullYear(),endDate.getMonth(),endDate.getDate());
    s.setDate(s.getDate()-n);
    return dateToYmd(s);
  }

  function setActiveRangeBtn(code){
    if(!rangeRow) return;
    const btns=Array.from(rangeRow.querySelectorAll('.range-btn'));
    btns.forEach(b=>b.classList.toggle('active', (b.dataset.range===code)));
  }

  // ---- Build daily series from trades table (truth) ----
  function buildDailySeriesFromTrades(startYmd, endYmd){
    const table = tradesBody?.closest('table');
    if(!table) return null;

    const ths = Array.from(table.querySelectorAll('thead th')).map(th=>(th.textContent||'').trim());
    const idxDateTime = ths.findIndex(t=>t.includes('日期時間'));
    const idxType     = ths.findIndex(t=>t.includes('類別'));
    const idxTheo     = ths.findIndex(t=>t.includes('理論淨損益'));
    const idxReal     = ths.findIndex(t=>t.includes('實際淨損益'));

    const rows = Array.from(tradesBody.querySelectorAll('tr'));
    const dayMap = new Map(); // ymd -> {theo, real, longTheo, longReal, shortTheo, shortReal}

    for(const tr of rows){
      const tds = Array.from(tr.querySelectorAll('td'));
      if(!tds.length) continue;

      const dtText = (idxDateTime>=0 && tds[idxDateTime]) ? tds[idxDateTime].textContent : tr.textContent;
      const ymd = parseYmdFromText(dtText);
      if(!ymd) continue;
      if(ymd < startYmd || ymd > endYmd) continue;

      const typ = (idxType>=0 && tds[idxType]) ? (tds[idxType].textContent||'').trim() : '';
      const theo = (idxTheo>=0 && tds[idxTheo]) ? parseNum(tds[idxTheo].textContent) : NaN;
      const real = (idxReal>=0 && tds[idxReal]) ? parseNum(tds[idxReal].textContent) : NaN;

      if(!dayMap.has(ymd)){
        dayMap.set(ymd,{ theo:0, real:0, longTheo:0, longReal:0, shortTheo:0, shortReal:0 });
      }
      const agg = dayMap.get(ymd);

      if(Number.isFinite(theo)) agg.theo += theo;
      if(Number.isFinite(real)) agg.real += real;

      // 以類別判斷多/空：你的表格是「平賣/平買/新買/新賣」
      // 平賣→多頭了結；平買→空頭了結。其餘不計入損益（多半是 —）
      if(typ.includes('平賣')){
        if(Number.isFinite(theo)) agg.longTheo += theo;
        if(Number.isFinite(real)) agg.longReal += real;
      } else if(typ.includes('平買')){
        if(Number.isFinite(theo)) agg.shortTheo += theo;
        if(Number.isFinite(real)) agg.shortReal += real;
      }
    }

    const days = Array.from(dayMap.keys()).sort();
    // daily series
    const dailyTheo = [];
    const dailyReal = [];

    const dailyLongTheo = [];
    const dailyLongReal = [];
    const dailyShortTheo = [];
    const dailyShortReal = [];

    // cumulative from 0
    let cumTheo=0, cumReal=0, cumLongTheo=0, cumLongReal=0, cumShortTheo=0, cumShortReal=0;

    const cumTheoArr=[], cumRealArr=[];
    const cumLongTheoArr=[], cumLongRealArr=[], cumShortTheoArr=[], cumShortRealArr=[];

    for(const d of days){
      const a = dayMap.get(d);

      dailyTheo.push(a.theo);
      dailyReal.push(a.real);

      dailyLongTheo.push(a.longTheo);
      dailyLongReal.push(a.longReal);
      dailyShortTheo.push(a.shortTheo);
      dailyShortReal.push(a.shortReal);

      cumTheo += a.theo;
      cumReal += a.real;
      cumLongTheo += a.longTheo;
      cumLongReal += a.longReal;
      cumShortTheo += a.shortTheo;
      cumShortReal += a.shortReal;

      cumTheoArr.push(cumTheo);
      cumRealArr.push(cumReal);
      cumLongTheoArr.push(cumLongTheo);
      cumLongRealArr.push(cumLongReal);
      cumShortTheoArr.push(cumShortTheo);
      cumShortRealArr.push(cumShortReal);
    }

    return {
      days,
      dailyTheo, dailyReal,
      dailyLongTheo, dailyLongReal,
      dailyShortTheo, dailyShortReal,
      cumTheoArr, cumRealArr,
      cumLongTheoArr, cumLongRealArr,
      cumShortTheoArr, cumShortRealArr
    };
  }

  // ---- Apply range (non-ALL: rebuild charts from daily series) ----
  function applyRange(code){
    if(!snapshotOnce()){
      setStatus('區間切換：資料尚未就緒，正在重試…');
      setTimeout(()=>applyRange(code), 200);
      return;
    }

    const eq=getChart(equityCanvas);
    const dy=getChart(dailyCanvas);
    if(!eq||!dy) return;

    // restore ALL baseline first
    eq.data.labels = SNAP.eq.labels.slice();
    eq.data.datasets.forEach((ds,k)=> ds.data = (SNAP.eq.data[k]||[]).slice());
    eq.update('none');

    dy.data.labels = SNAP.dy.labels.slice();
    dy.data.datasets.forEach((ds,k)=> ds.data = (SNAP.dy.data[k]||[]).slice());
    dy.update('none');

    tradesBody.innerHTML = SNAP.tradesHTML;

    // restore KPI for ALL mode always
    const kpiAll = document.querySelector('#kpiBody')?.closest('.kpi-wrapper')?.parentElement;
    if(kpiAll && SNAP.kpiHTML) kpiAll.innerHTML = SNAP.kpiHTML;

    const endYmd = SNAP.endYmd;
    const startYmd = rangeStartYmd(endYmd, code);

    if(code==='ALL' || !startYmd){
      setActiveRangeBtn('ALL');
      setStatus(`全區間：${parseYmdFromText(SNAP.tradesHTML)||''} ~ ${endYmd}（僅全區間計算 KPI）`);
      return;
    }

    // Non-ALL: do NOT touch KPI at all (keep ALL KPI as-is)
    // Only rebuild charts + filter trades
    const trs = Array.from(tradesBody.querySelectorAll('tr'));
    const kept = trs.filter(tr=>{
      const ymd = parseYmdFromText(tr.textContent);
      if(!ymd) return true;
      return (ymd>=startYmd && ymd<=endYmd);
    });
    tradesBody.innerHTML = kept.map(tr=>tr.outerHTML).join('');

    // Build daily series from filtered trades (truth)
    const series = buildDailySeriesFromTrades(startYmd, endYmd);
    if(!series || !series.days.length){
      setStatus(`區間內無可用交易損益資料：${startYmd}~${endYmd}`, true);
      setActiveRangeBtn(code);
      return;
    }

    // Rebuild equity chart with daily labels (YYYY/MM/DD) and rebase all relevant lines to 0
    const dayLabels = series.days.map(ymd => `${ymd.slice(0,4)}/${ymd.slice(4,6)}/${ymd.slice(6,8)}`);

    // Map datasets by label keywords; keep styling but overwrite data
    eq.data.labels = dayLabels;

    eq.data.datasets.forEach(ds=>{
      const lab = String(ds.label||'');
      // total (含滑價 / 理論)
      if(lab.includes('含滑價') && lab.includes('總損益')) ds.data = series.cumRealArr.slice();
      else if(lab.includes('理論') && lab.includes('總損益')) ds.data = series.cumTheoArr.slice();
      // long/short (含滑價 / 理論)
      else if(lab.includes('多頭') && lab.includes('含滑價')) ds.data = series.cumLongRealArr.slice();
      else if(lab.includes('多頭') && lab.includes('理論')) ds.data = series.cumLongTheoArr.slice();
      else if(lab.includes('空頭') && lab.includes('含滑價')) ds.data = series.cumShortRealArr.slice();
      else if(lab.includes('空頭') && lab.includes('理論')) ds.data = series.cumShortTheoArr.slice();
      // period high/low markers: keep as-is, but if lengths mismatch, clear to avoid misplot
      else if(lab.includes('期間最高') || lab.includes('期間最低')) {
        // 不改（讓它保留全區間也行），但長度不一致時清空避免誤畫
        if(Array.isArray(ds.data) && ds.data.length !== dayLabels.length) ds.data = [];
      }
      // unknown: if length mismatch, clear
      else {
        if(Array.isArray(ds.data) && ds.data.length !== dayLabels.length) ds.data = [];
      }
    });

    // Rebase: cum arrays already start from 0 by construction (series cumulative from 0)
    eq.update('none');

    // Rebuild daily pnl chart: keep bar meaning daily pnl (theo/real)
    dy.data.labels = dayLabels;
    dy.data.datasets.forEach(ds=>{
      const lab = String(ds.label||'');
      // 你圖例目前是「每週獲利(>0) / 每週虧損(<0)」，但實際是日
      // 我們保持同語意：正值/負值分開兩個 dataset
      if(lab.includes('獲利')) {
        ds.data = series.dailyReal.map(v => v > 0 ? v : 0);
      } else if(lab.includes('虧損')) {
        ds.data = series.dailyReal.map(v => v < 0 ? v : 0);
      } else {
        // fallback：維持長度一致
        ds.data = new Array(dayLabels.length).fill(0);
      }
    });
    dy.update('none');

    // Trades cumulative: 你已指定非全區間不需要 KPI，但明細可以維持原本累計不動或重算。
    // 依你前面要求「明細累計歸0」：這裡只在非全區間重算累積欄位。
    // （若你現在不需要可把下一行註解）
    (function resetCumInTrades(){
      const table = tradesBody?.closest('table');
      if(!table) return;
      const ths = Array.from(table.querySelectorAll('thead th')).map(th=>(th.textContent||'').trim());
      const idxTheo     = ths.findIndex(t => t.includes('理論淨損益'));
      const idxCumTheo  = ths.findIndex(t => t.includes('累積理論淨損益'));
      const idxReal     = ths.findIndex(t => t.includes('實際淨損益'));
      const idxCumReal  = ths.findIndex(t => t.includes('累積實際淨損益'));
      if(idxTheo<0||idxCumTheo<0||idxReal<0||idxCumReal<0) return;

      let cumTheo=0, cumReal=0;
      const rows = Array.from(tradesBody.querySelectorAll('tr'));
      for(const tr of rows){
        const tds = Array.from(tr.querySelectorAll('td'));
        const theo = parseNum(tds[idxTheo]?.textContent);
        const real = parseNum(tds[idxReal]?.textContent);
        if(Number.isFinite(theo)) cumTheo += theo;
        if(Number.isFinite(real)) cumReal += real;
        if(tds[idxCumTheo]) tds[idxCumTheo].textContent = formatNum(cumTheo);
        if(tds[idxCumReal]) tds[idxCumReal].textContent = formatNum(cumReal);
      }
      tradesBody.innerHTML = rows.map(tr=>tr.outerHTML).join('');
    })();

    setActiveRangeBtn(code);
    setStatus(`區間：${code}（${startYmd} ~ ${endYmd}）｜區間僅顯示圖表/日損益/明細`);
  }

  function hookRangeButtons(){
    if(!rangeRow) return;
    rangeRow.addEventListener('click', (e)=>{
      const btn = e.target.closest('.range-btn');
      if(!btn) return;
      applyRange(btn.dataset.range || 'ALL');
    });
  }

  function waitAndInit(){
    let tries=0;
    const timer=setInterval(()=>{
      tries++;
      if(snapshotOnce()){
        clearInterval(timer);
        hookRangeButtons();
        // ALL: KPI 由 single-trades.js 保持原樣；我們不去補色以免你想完全維持原輸出
        applyRange('ALL');
      }
      if(tries>360) clearInterval(timer);
    }, 140);
  }

  // -----------------------------
  // Boot: merge + feed to single-trades.js
  // -----------------------------
  async function boot(){
    try{
      if(!sb){
        setStatus('Supabase SDK 未載入或初始化失敗。', true);
        return;
      }

      forceSlip2();

      const url=new URL(location.href);
      const paramFile=url.searchParams.get('file');

      let latest=null;
      let list=[];

      if(paramFile){
        latest={ name:paramFile.split('/').pop()||'0807.txt', fullPath:paramFile, from:'url' };
      } else {
        setStatus('從 Supabase（reports）讀取清單…');
        list=(await listCandidates()).filter(f=>WANT.test(f.name)||WANT.test(f.fullPath));
        if(!list.length){
          setStatus('找不到檔名含「0807」的 TXT（可用 ?file= 指定）。', true);
          return;
        }
        list.sort((a,b)=>{
          const sa=lastDateScore(a.name), sb2=lastDateScore(b.name);
          if(sa!==sb2) return sb2-sa;
          if(a.updatedAt!==b.updatedAt) return b.updatedAt-a.updatedAt;
          return (b.size||0)-(a.size||0);
        });
        latest=list[0];
      }

      if(!latest){
        setStatus('找不到可分析的 0807 檔案。', true);
        return;
      }
      if(elLatest) elLatest.textContent=latest.name;

      // baseline
      let base=null;
      if(!paramFile){
        const manifest=await readManifest();
        if(manifest?.baseline_path){
          base = list.find(x=>x.fullPath===manifest.baseline_path) ||
                 { name: manifest.baseline_path.split('/').pop()||manifest.baseline_path, fullPath: manifest.baseline_path };
        } else {
          base = list[1] || null;
        }
      }
      if(elBase) elBase.textContent=base?base.name:'（尚無）';

      // download latest
      setStatus('下載最新 0807 檔案並解碼中…');
      const latestUrl = latest.from==='url' ? latest.fullPath : pubUrl(latest.fullPath);
      const rNew = await fetchSmart(latestUrl);
      if(rNew.ok===0){
        setStatus(`最新檔沒有合法交易行（解碼=${rNew.enc}）。`, true);
        return;
      }

      let mergedText = rNew.canon;

      if(base){
        setStatus('下載基準檔並進行合併…');
        const baseUrl = base.from==='url' ? base.fullPath : pubUrl(base.fullPath);
        const rBase = await fetchSmart(baseUrl);
        mergedText = mergeByBaseline(rBase.canon, rNew.canon);
      }

      // baseline button
      if(btnBase){
        btnBase.disabled=false;
        btnBase.onclick = async ()=>{
          try{
            await writeManifest({ baseline_path: latest.fullPath, updated_at: new Date().toISOString() });
            btnBase.textContent='已設為基準';
          }catch(e){
            setStatus('寫入基準失敗：'+(e.message||e), true);
          }
        };
      }

      // feed single-trades.js (ALL computes KPI)
      const mergedWithInpos = addFakeInpos(mergedText);
      const finalText = '0807 MERGED\n' + mergedWithInpos;

      setStatus('已載入（合併後）資料，開始分析…');
      await feedToSingleTrades(latest.name, finalText);
      setStatus('分析完成（全區間含 KPI；區間只顯示圖表/日損益/明細）。');

      waitAndInit();
    }catch(err){
      console.error(err);
      setStatus('初始化失敗：'+(err.message||err), true);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
