// 0807.js — 以「基準最後日」為錨的新增合併；時間戳對齊摘要；不顯示變更明細表
(function () {
  const $ = s => document.querySelector(s);
  const status = $('#autostatus'); if (status) status.style.whiteSpace = 'pre-wrap';
  const diffStatus = $('#diffStatus');
  const elLatest = $('#latestName'), elBase = $('#baseName');
  const btnCopy = $('#btnCopyNew'), btnBase = $('#btnSetBaseline');
  const appendBox = $('#appendBox');

  // Supabase（與 upload.html 相同）
  const SUPABASE_URL = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET = "reports";
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { fetch: (u,o={}) => fetch(u,{...o, cache:'no-store'}) }
  });

  const WANT = /0807/i;
  const MANIFEST_PATH = "manifests/0807.json"; // 記錄基準檔資訊
  const CANON_RE   = /^(\d{14})\.0{6}\s+(\d+\.\d{6})\s+(新買|平賣|新賣|平買|強制平倉)\s*$/;
  const EXTRACT_RE = /.*?(\d{14})(?:\.0{1,6})?\s+(\d+(?:\.\d{1,6})?)\s*(新買|平賣|新賣|平買|強制平倉)\s*$/;

  function set(msg, bad=false){ if(status){ status.textContent=msg; status.style.color=bad?'#c62828':'#666'; } }
  function setDiff(msg, bad=false){ if(diffStatus){ diffStatus.textContent=msg; diffStatus.style.color=bad?'#c62828':'#666'; } }
  function pubUrl(path){ const { data } = sb.storage.from(BUCKET).getPublicUrl(path); return data?.publicUrl || '#'; }

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

  // === 解碼 / 正規化 / 重建為 canonical ===
  function normalizeText(raw){
    let s = raw.replace(/\ufeff/gi,'').replace(/\u200b|\u200c|\u200d/gi,'');
    s = s.replace(/[\x00-\x09\x0B-\x1F\x7F]/g,''); // 控制碼
    s = s.replace(/\r\n?/g,'\n').replace(/\u3000/g,' ');
    const lines = s.split('\n').map(l=>l.replace(/\s+/g,' ').trim()).filter(Boolean);
    return lines.join('\n');
  }
  function canonicalize(txt){
    const out=[], lines = txt.split('\n'); let ok=0,bad=0,samples=[];
    for(const l of lines){
      const m = l.match(EXTRACT_RE);
      if(m){
        const ts = m[1], px = Number(m[2]); const p6 = Number.isFinite(px) ? px.toFixed(6) : m[2];
        const act= m[3];
        out.push(`${ts}.000000 ${p6} ${act}`); ok++;
      }else{
        if (/(\d{14})/.test(l) && samples.length<3) samples.push(l); bad++;
      }
    }
    return { canon: out.join('\n'), ok, bad, samples };
  }
  async function fetchSmart(url){
    const res = await fetch(url,{cache:'no-store'}); if(!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    for (const enc of ['utf-8','big5','utf-16le','utf-16be']){
      try{
        const td=new TextDecoder(enc,{fatal:false});
        const norm = normalizeText(td.decode(buf));
        const { canon, ok, samples } = canonicalize(norm);
        if (ok>0) return { enc, canon, ok, samples };
      }catch(e){}
    }
    // 都沒命中就回 UTF-8 的結果供診斷
    const td=new TextDecoder('utf-8'); const norm=normalizeText(td.decode(buf));
    const { canon, ok, samples } = canonicalize(norm);
    return { enc:'utf-8', canon, ok, samples };
  }

  // === 將文字交給 single.js（避免重複猜編碼、避免 params.map 錯誤） ===
  function patchSharedReaders(decodedText){
    if (window.SHARED) {
      if (typeof window.SHARED.readAsTextAuto === 'function') {
        const orig = window.SHARED.readAsTextAuto;
        window.SHARED.readAsTextAuto = async function(){
          window.SHARED.readAsTextAuto = orig;
          return decodedText;
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

  // === manifest：download（不存在即視為無基準） ===
  async function readManifest(){
    const { data } = await sb.storage.from(BUCKET).download(MANIFEST_PATH);
    if (!data) return null;
    try { return JSON.parse(await data.text()); } catch { return null; }
  }
  async function writeManifest(obj){
    const blob = new Blob([JSON.stringify(obj,null,2)], { type:'application/json' });
    const { error } = await sb.storage.from(BUCKET).upload(MANIFEST_PATH, blob, { upsert:true, cacheControl:'0', contentType:'application/json' });
    if (error) throw new Error(error.message);
  }

  // === 以「基準最後日」為錨：只列出 ts > baseMax 的新增；區間內變更僅摘要 ===
  function parseCanon(text){
    const rows=[]; if(!text) return rows;
    for(const line of text.split('\n')){
      const m = line.match(CANON_RE);
      if (m) rows.push({ ts:m[1], line });
    }
    rows.sort((a,b)=> a.ts.localeCompare(b.ts));
    return rows;
  }
  function anchoredSummary(baseText, newText){
    const A = parseCanon(baseText);
    const B = parseCanon(newText);
    const baseMin = A.length? A[0].ts : '';
    const baseMax = A.length? A[A.length-1].ts : '';

    const mapA = new Map(A.map(x=>[x.ts,x.line]));
    const mapB = new Map(B.map(x=>[x.ts,x.line]));

    // 區間內（≤ baseMax）的變更/刪除只計數
    let changed=0, removed=0;
    for (const [ts, lineA] of mapA){
      if (baseMax && ts > baseMax) continue;
      const lineB = mapB.get(ts);
      if (lineB && lineB !== lineA) changed++;
      if (!lineB) removed++;
    }

    // 新增：只取 > baseMax 的最新檔行
    const addedLines = B.filter(r => !baseMax || r.ts > baseMax).map(r => r.line);

    return { baseMin, baseMax, addedLines, changed, removed };
  }

  async function boot(){
    try{
      const url = new URL(location.href);
      const paramFile = url.searchParams.get('file');

      // 1) 決定最新檔
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
      elLatest && (elLatest.textContent = latest.name);

      // 2) 取得基準：manifest 指定；否則用次新
      let base=null;
      const manifest = await readManifest();
      if (manifest?.baseline_path){
        base = list.find(x => x.fullPath===manifest.baseline_path) || { name: manifest.baseline_path.split('/').pop(), fullPath: manifest.baseline_path };
      } else {
        base = list[1] || null;
      }
      elBase && (elBase.textContent = base ? base.name : '（尚無）');

      // 3) 抓文字（智慧解碼 + 正規化/重建）
      const latestUrl = latest.from==='url' ? latest.fullPath : pubUrl(latest.fullPath);
      const rNew = await fetchSmart(latestUrl);
      if (rNew.ok === 0){ set(`最新檔沒有合法交易行（解碼=${rNew.enc}）。`, true); return; }

      let baseText='';
      if (base){
        const baseUrl = base.from==='url' ? base.fullPath : pubUrl(base.fullPath);
        const rBase = await fetchSmart(baseUrl);
        if (rBase.ok === 0){ set(`基準檔解析不到交易（解碼=${rBase.enc}）。先以最新檔跑分析。`, true); }
        baseText = rBase.canon || '';
      }

      // 4) 生成 anchored 摘要：僅顯示新增列表，不顯示變更表
      if (baseText){
        const d = anchoredSummary(baseText, rNew.canon);

        // 摘要文字
        const from = d.baseMin ? `${d.baseMin}` : '—';
        const to   = d.baseMax ? `${d.baseMax}` : '—';
        const addN = d.addedLines.length;
        const msg  = `以基準區間（${from} ～ ${to}）為錨；新增：${addN}，變更：${d.changed}，刪除：${d.removed}。`;
        setDiff(msg, (d.changed>0 || d.removed>0));

        // 新增清單
        if (addN>0){
          appendBox.style.display='block';
          appendBox.textContent = d.addedLines.join('\n'); // 一行一筆
          btnCopy.disabled=false;
          btnCopy.onclick = async()=>{
            await navigator.clipboard.writeText(d.addedLines.join('\n'));
            btnCopy.textContent='已複製'; setTimeout(()=>btnCopy.textContent='複製新增交易',1200);
          };
        } else {
          appendBox.style.display='none';
          btnCopy.disabled=true;
        }
      } else {
        setDiff('首次建立：目前沒有基準檔（全部視為新增）。');
        appendBox.style.display='block';
        appendBox.textContent = rNew.canon;
        btnCopy.disabled=false;
        btnCopy.onclick = async()=>{
          await navigator.clipboard.writeText(rNew.canon);
          btnCopy.textContent='已複製'; setTimeout(()=>btnCopy.textContent='複製新增交易',1200);
        };
      }

      // 5) 設最新檔為基準
      btnBase.disabled=false;
      btnBase.onclick = async ()=>{
        try{
          const payload = { baseline_path: latest.from==='url' ? latest.fullPath : latest.fullPath, updated_at: new Date().toISOString() };
          await writeManifest(payload);
          btnBase.textContent='已設為基準';
          setDiff('✅ 已將最新檔標記為基準（manifests/0807.json）');
        }catch(e){ setDiff('寫入基準失敗：'+(e.message||e), true); }
      };

      // 6) 交給 single.js 繪圖（用我們已重建好的 canonical 內容）
      set(`已載入最新檔（解碼=${rNew.enc}，有效行=${rNew.ok}），開始分析…`);
      await feedToSingle(latest.name, rNew.canon);
    }catch(err){
      set('初始化失敗：' + (err.message || err), true);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
