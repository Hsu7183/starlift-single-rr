// 0807.js — 以「基準最後日」為錨合併：分析資料＝基準全段 + 最新檔的新增；摘要只顯示期間
(function () {
  const $ = s => document.querySelector(s);
  const status = $('#autostatus'); if (status) status.style.whiteSpace = 'pre-wrap';
  const elLatest = $('#latestName'), elBase = $('#baseName');
  const elPeriod = $('#periodText');
  const btnBase = $('#btnSetBaseline');

  // Supabase（與 upload.html 相同）
  const SUPABASE_URL = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET = "reports";
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { fetch: (u,o={}) => fetch(u,{...o, cache:'no-store'}) }
  });

  const WANT = /0807/i;
  const MANIFEST_PATH = "manifests/0807.json";

  const CANON_RE   = /^(\d{14})\.0{6}\s+(\d+\.\d{6})\s+(新買|平賣|新賣|平買|強制平倉)\s*$/;
  const EXTRACT_RE = /.*?(\d{14})(?:\.0{1,6})?\s+(\d+(?:\.\d{1,6})?)\s*(新買|平賣|新賣|平買|強制平倉)\s*$/;

  function set(msg, bad=false){ if(status){ status.textContent=msg; status.style.color = bad?'#c62828':'#666'; } }

  function pubUrl(path){
    const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
    return data?.publicUrl || '#';
  }
  async function listOnce(prefix){
    const p = (prefix && !prefix.endsWith('/')) ? (prefix + '/') : (prefix || '');
    const { data, error } = await sb.storage.from(BUCKET).list(p, { limit:1000, sortBy:{ column:'name', order:'asc' }});
    if(error) throw new Error(error.message);
    return (data||[]).filter(it => !(it.id===null && !it.metadata))
      .map(it => ({ name:it.name, fullPath:p+it.name, updatedAt: it.updated_at? Date.parse(it.updated_at):0, size: it.metadata?.size||0 }));
  }
  async function listCandidates(){
    const u = new URL(location.href); const prefix = u.searchParams.get('prefix') || '';
    return listOnce(prefix);
  }
  function lastDateScore(name){ const m=String(name).match(/\b(20\d{6})\b/g); return m && m.length ? Math.max(...m.map(s=>+s||0)) : 0; }

  // 文字 → 正規化 → canonical 行
  function normalizeText(raw){
    let s = raw.replace(/\ufeff/gi,'').replace(/\u200b|\u200c|\u200d/gi,'');
    s = s.replace(/[\x00-\x09\x0B-\x1F\x7F]/g,'');   // 控制碼
    s = s.replace(/\r\n?/g,'\n').replace(/\u3000/g,' ');
    const lines = s.split('\n').map(l=>l.replace(/\s+/g,' ').trim()).filter(Boolean);
    return lines.join('\n');
  }
  function canonicalize(txt){
    const out=[], lines = txt.split('\n'); let ok=0,bad=0;
    for(const l of lines){
      const m = l.match(EXTRACT_RE);
      if(m){
        const ts = m[1], px = Number(m[2]); const p6 = Number.isFinite(px) ? px.toFixed(6) : m[2];
        const act= m[3];
        out.push(`${ts}.000000 ${p6} ${act}`); ok++;
      }else{ bad++; }
    }
    return { canon: out.join('\n'), ok, bad };
  }
  async function fetchSmart(url){
    const res = await fetch(url,{cache:'no-store'}); if(!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    for (const enc of ['utf-8','big5','utf-16le','utf-16be']){
      try{
        const td=new TextDecoder(enc,{fatal:false});
        const norm = normalizeText(td.decode(buf));
        const { canon, ok } = canonicalize(norm);
        if (ok>0) return { enc, canon, ok };
      }catch(e){}
    }
    const td=new TextDecoder('utf-8'); const norm=normalizeText(td.decode(buf));
    const { canon, ok } = canonicalize(norm);
    return { enc:'utf-8', canon, ok };
  }

  function parseCanon(text){
    const rows=[]; if(!text) return rows;
    for(const line of text.split('\n')){
      const m = line.match(CANON_RE);
      if (m) rows.push({ ts:m[1], line });
    }
    rows.sort((a,b)=> a.ts.localeCompare(b.ts));
    return rows;
  }

  // 合併：combined = base 全部 + (latest 中 ts > baseMax 的行)
  function mergeByBaseline(baseText, latestText){
    const A = parseCanon(baseText);
    const B = parseCanon(latestText);
    const baseMin = A.length ? A[0].ts.slice(0,8) : (B.length? B[0].ts.slice(0,8) : '');
    const baseMax = A.length ? A[A.length-1].ts : '';
    const added   = baseMax ? B.filter(x => x.ts > baseMax).map(x => x.line) : B.map(x => x.line);
    const mergedLines = [...A.map(x => x.line), ...added];
    const endDay = mergedLines.length ? mergedLines[mergedLines.length-1].match(CANON_RE)[1].slice(0,8) : baseMin;
    return { combined: mergedLines.join('\n'), start8: baseMin, end8: endDay };
  }

  // 把我們已解碼好的內容交給 single.js（避免它再猜編碼 & params.map 錯誤）
  function patchSharedReaders(decodedText){
    if (window.SHARED) {
      if (typeof window.SHARED.readAsTextAuto === 'function') {
        const orig = window.SHARED.readAsTextAuto;
        window.SHARED.readAsTextAuto = async function(){
          window.SHARED.readAsTextAuto = orig; return decodedText;
        };
      }
      if (typeof window.SHARED.paramsLabel === 'function') {
        const origPL = window.SHARED.paramsLabel;
        window.SHARED.paramsLabel = function(arg){
          let arr = Array.isArray(arg) ? arg : (arg && Array.isArray(arg.raw) ? arg.raw : []);
          try { return origPL(arr); } catch { return (arr.slice(0,2).join(" ｜ ")) || "—"; }
        };
      }
    }
  }
  async function feedToSingle(filename, decodedText){
    const input = $('#file'); if(!input){ set('找不到 #file（single.js 未載入）', true); return; }
    patchSharedReaders(decodedText);
    const file = new File([decodedText], filename || '0807.txt', { type:'text/plain' });
    const dt = new DataTransfer(); dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles:true }));
  }

  // manifest：download（不存在即視為無基準）
  async function readManifest(){
    const { data } = await sb.storage.from(BUCKET).download(MANIFEST_PATH);
    if (!data) return null;
    try{ return JSON.parse(await data.text()); }catch{ return null; }
  }
  async function writeManifest(obj){
    const blob = new Blob([JSON.stringify(obj,null,2)], { type:'application/json' });
    const { error } = await sb.storage.from(BUCKET).upload(MANIFEST_PATH, blob, { upsert:true, cacheControl:'0', contentType:'application/json' });
    if (error) throw new Error(error.message);
  }

  async function boot(){
    try{
      const url = new URL(location.href);
      const paramFile = url.searchParams.get('file');

      // 1) 最新檔
      let latest=null, list=[];
      if (paramFile){
        latest = { name:paramFile.split('/').pop()||'0807.txt', fullPath:paramFile, from:'url' };
      } else {
        set('從 Supabase（reports）讀取清單…');
        list = (await listCandidates()).filter(f => WANT.test(f.name) || WANT.test(f.fullPath));
        list.sort((a,b)=>{
          const sa=lastDateScore(a.name), sb=lastDateScore(b.name);
          if (sa!==sb) return sb-sa;
          if (a.updatedAt!==b.updatedAt) return b.updatedAt-a.updatedAt;
          return (b.size||0)-(a.size||0);
        });
        latest = list[0];
      }
      if(!latest){ set('找不到檔名含「0807」的 TXT（可用 ?file= 指定）。', true); return; }
      elLatest.textContent = latest.name;

      // 2) 基準（manifest，否則用次新）
      let base=null;
      const manifest = await readManifest();
      if (manifest?.baseline_path){
        base = list.find(x => x.fullPath===manifest.baseline_path) || { name: manifest.baseline_path.split('/').pop(), fullPath: manifest.baseline_path };
      } else {
        base = list[1] || null;
      }
      elBase.textContent = base ? base.name : '（尚無）';

      // 3) 下載 + 解碼
      const latestUrl = latest.from==='url' ? latest.fullPath : pubUrl(latest.fullPath);
      const rNew = await fetchSmart(latestUrl);
      if (rNew.ok === 0){ set(`最新檔沒有合法交易行（解碼=${rNew.enc}）。`, true); return; }

      let mergedText = rNew.canon, start8 = '', end8 = '';
      if (base){
        const baseUrl = base.from==='url' ? base.fullPath : pubUrl(base.fullPath);
        const rBase = await fetchSmart(baseUrl);
        // 合併：基準全段 + 基準之後的新增
        const m = mergeByBaseline(rBase.canon, rNew.canon);
        mergedText = m.combined; start8 = m.start8; end8 = m.end8;
      } else {
        // 沒有基準 → 直接以最新檔期間為主
        const rows = parseCanon(rNew.canon);
        start8 = rows.length ? rows[0].ts.slice(0,8) : '';
        end8   = rows.length ? rows[rows.length-1].ts.slice(0,8) : '';
      }

      // 4) 顯示期間（只顯示「YYYYMMDD 開始到 YYYYMMDD 結束」）
      elPeriod.textContent = `期間：${start8 || '—'} 開始到 ${end8 || '—'} 結束`;

      // 5) 設最新為基準（按鈕）
      btnBase.disabled=false;
      btnBase.onclick = async ()=>{
        try{
          const payload = { baseline_path: latest.from==='url' ? latest.fullPath : latest.fullPath, updated_at: new Date().toISOString() };
          await writeManifest(payload);
          btnBase.textContent='已設為基準';
          elPeriod.textContent = `期間：${start8 || '—'} 開始到 ${end8 || '—'} 結束`;
        }catch(e){ set('寫入基準失敗：'+(e.message||e), true); }
      };

      // 6) 交給 single.js（用合併後的內容）
      set(`已載入（合併後）資料，開始分析…`);
      await feedToSingle(latest.name, mergedText);
    }catch(err){
      set('初始化失敗：' + (err.message || err), true);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
