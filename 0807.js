// 0807.js — 0807專用自動分析 + 差異比對 + 基準（manifest）記錄
(function () {
  const $ = s => document.querySelector(s);
  const status = $('#autostatus'), diffStatus = $('#diffStatus');
  const elLatest = $('#latestName'), elBase = $('#baseName');
  const btnCopy = $('#btnCopyNew'), btnBase = $('#btnSetBaseline');
  const appendBox = $('#appendBox');
  const changeWrap = $('#changeTableWrap'), changeTbody = $('#changeTable');

  // Supabase（與 upload.html 相同）
  const SUPABASE_URL = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET = "reports";
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { fetch: (u,o={}) => fetch(u,{...o, cache:'no-store'}) }
  });

  const WANT = /0807/i;
  const MANIFEST_PATH = "manifests/0807.json"; // 記錄基準檔資訊（跨裝置一致）
  const TRADE_RE = /^\d{14}\.000000\s+\d+\.\d{6}\s+(新買|平賣|新賣|平買|強制平倉)\s*$/;

  function set(msg, bad=false){ if(status){ status.textContent = msg; status.style.color = bad?'#c62828':'#666'; } }
  function setDiff(msg, bad=false){ if(diffStatus){ diffStatus.textContent = msg; diffStatus.style.color = bad?'#c62828':'#666'; } }
  function pubUrl(path){ const { data } = sb.storage.from(BUCKET).getPublicUrl(path); return data?.publicUrl || '#'; }

  async function listOnce(prefix){
    const p = (prefix && !prefix.endsWith('/')) ? (prefix + '/') : (prefix || '');
    const { data, error } = await sb.storage.from(BUCKET).list(p, { limit:1000, sortBy:{ column:'name', order:'asc' }});
    if(error) throw new Error(error.message);
    return (data||[]).filter(it => !(it.id===null && !it.metadata))
      .map(it => ({ name:it.name, fullPath:p+it.name, updatedAt: it.updated_at? Date.parse(it.updated_at):0, size: it.metadata?.size||0 }));
  }
  async function listCandidates(){
    const u = new URL(location.href);
    const prefix = u.searchParams.get('prefix') || '';
    return listOnce(prefix);
  }
  function lastDateScore(name){ const m=String(name).match(/\b(20\d{6})\b/g); return m && m.length ? Math.max(...m.map(s=>+s||0)) : 0; }

  // —— 解碼 & 正規化 & 驗證 ——
  function normalizeTxt(raw){
    let s = raw.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').replace(/\u3000/g,' ');
    const lines = s.split('\n').map(l=>l.trim()).filter(Boolean).map(l=>l.replace(/\s+/g,' '));
    return lines.join('\n');
  }
  function countTradeLines(txt){
    const lines = txt.split('\n'); let ok=0,bad=0,samples=[];
    for(const l of lines){ if(TRADE_RE.test(l)) ok++; else if(/^\d{14}\.000000/.test(l)){ bad++; if(samples.length<3) samples.push(l); } }
    return {ok,bad,samples};
  }
  async function fetchSmart(url){
    const res = await fetch(url,{cache:'no-store'}); if(!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    const encs = ['utf-8','big5','utf-16le','utf-16be'];
    let best={enc:'utf-8',text:'',ok:-1,samples:[]};
    for(const enc of encs){
      try{ const td=new TextDecoder(enc,{fatal:false}); const txt=normalizeTxt(td.decode(buf)); const r=countTradeLines(txt);
        if(r.ok>best.ok) best={enc,text:txt,ok:r.ok,samples:r.samples}; if(r.ok>0) return best;
      }catch(e){}
    }
    return best;
  }

  // —— SHA-256（用於 manifest 比對） ——
  async function sha256(text){
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(hash)).map(b=>b.toString(16).padStart(2,'0')).join('');
  }

  // —— 讀/寫 基準 manifest ——
  async function readManifest(){
    try{
      // 以 publicUrl 讀
      const u = pubUrl(MANIFEST_PATH);
      const res = await fetch(u, { cache:'no-store' });
      if(!res.ok) return null;
      return await res.json();
    }catch{ return null; }
  }
  async function writeManifest(obj){
    const blob = new Blob([JSON.stringify(obj,null,2)], {type:'application/json'});
    const { error } = await sb.storage.from(BUCKET).upload(MANIFEST_PATH, blob, { upsert:true, cacheControl:'0', contentType:'application/json' });
    if(error) throw new Error(error.message);
  }

  // —— 差異計算（簡化：常見情境＝追加；若非純追加，列出首段差異） ——
  function computeDelta(baseText, newText){
    const A = baseText.split('\n'), B = newText.split('\n');
    const min = Math.min(A.length,B.length);
    let i=0; while(i<min && A[i]===B[i]) i++;
    // 是否 base 為 new 的前綴（常見：追加）
    const isPrefix = (i===A.length && B.length>=A.length && A.every((v,idx)=>v===B[idx]));
    const appended = isPrefix ? B.slice(A.length) : [];
    const changed = [];
    if(!isPrefix){
      for(let j=i;j<min;j++){ if(A[j]!==B[j]) changed.push({idx:j+1, old:A[j], neu:B[j]}); if(changed.length>=200) break; }
      // 如果 new 比 base 還長，額外把尾端當成新增
      if(B.length>min) appended.push(...B.slice(min));
    }
    return { isPrefix, prefixLen:i, appended, changed };
  }

  // —— 把我們已解碼的文字餵給 single.js（避免它再猜編碼） ——
  async function feedToSingle(filename, decodedText){
    const input = $('#file'); if(!input){ set('找不到 #file（single.js 尚未載入？）', true); return; }
    if(window.SHARED && typeof window.SHARED.readAsTextAuto==='function'){
      const orig = window.SHARED.readAsTextAuto;
      window.SHARED.readAsTextAuto = async function(){ window.SHARED.readAsTextAuto = orig; return decodedText; };
    }
    const file = new File([decodedText], filename || '0807.txt', {type:'text/plain'});
    const dt = new DataTransfer(); dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles:true }));
  }

  async function boot(){
    try{
      const url = new URL(location.href);
      const paramFile = url.searchParams.get('file');

      // 先決定「最新檔」與「基準檔」
      let latest=null, base=null, list=[];
      if(paramFile){
        latest = { name:paramFile.split('/').pop()||'0807.txt', fullPath:paramFile, from:'url' };
      }else{
        set('從 Supabase（reports）讀取清單…');
        list = (await listCandidates()).filter(f => WANT.test(f.name)||WANT.test(f.fullPath));
        list.sort((a,b)=>{
          const sa=lastDateScore(a.name), sb=lastDateScore(b.name);
          if(sa!==sb) return sb-sa;
          if(a.updatedAt!==b.updatedAt) return b.updatedAt-a.updatedAt;
          return (b.size||0)-(a.size||0);
        });
        latest = list[0];
      }
      if(!latest){ set('找不到檔名含「0807」的 TXT（可用 ?file= 指定）。', true); return; }
      elLatest.textContent = latest.name;

      // 基準：先看 manifest，沒有則用「次新」
      const manifest = await readManifest();
      if(manifest?.baseline_path){
        base = list.find(x => x.fullPath===manifest.baseline_path) || { name: manifest.baseline_path.split('/').pop(), fullPath: manifest.baseline_path };
      }else{
        base = list[1] || null; // 沒有就表示首次
      }
      elBase.textContent = base ? base.name : '（尚無）';

      // 抓文字（智慧解碼）
      const latestUrl = latest.from==='url' ? latest.fullPath : pubUrl(latest.fullPath);
      const { enc:encNew, text:newText, ok:okNew, samples:sampNew } = await fetchSmart(latestUrl);
      if(okNew===0){ set(`最新檔沒有任何合法交易行（解碼=${encNew}）：\n${sampNew.join('\n')}`, true); return; }

      let baseText='', baseHash=null;
      if(base){
        const baseUrl = base.from==='url' ? base.fullPath : pubUrl(base.fullPath);
        const r = await fetchSmart(baseUrl);
        if(r.ok===0){ set(`基準檔解析不到交易（解碼=${r.enc}）：\n${r.samples.join('\n')}`, true); /* 仍繼續用最新檔跑分析 */ }
        baseText = r.text;
        baseHash = await sha256(baseText);
      }

      // 差異比對
      if(baseText){
        const d = computeDelta(baseText, newText);
        if(d.isPrefix && d.appended.length>0){
          setDiff(`✅ 僅追加 ${d.appended.length} 行。`); 
          appendBox.style.display='block'; appendBox.textContent = d.appended.join('\n');
          btnCopy.disabled = false;
          btnCopy.onclick = async ()=>{ await navigator.clipboard.writeText(d.appended.join('\n')); btnCopy.textContent='已複製'; setTimeout(()=>btnCopy.textContent='複製新增交易',1200); };
        }else if(d.isPrefix && d.appended.length===0){
          setDiff('ℹ️ 內容與基準相同。');
        }else{
          setDiff(`⚠️ 非純追加：從第 ${d.prefixLen+1} 行開始出現差異；列出前 ${d.changed.length} 處差異供檢視。`, true);
          changeWrap.style.display='block'; changeTbody.innerHTML='';
          for(const row of d.changed){
            const tr=document.createElement('tr');
            tr.innerHTML = `<td class="mono">${row.idx}</td><td class="mono">${row.old||''}</td><td class="mono">${row.neu||''}</td>`;
            changeTbody.appendChild(tr);
          }
          if(d.appended.length){ appendBox.style.display='block'; appendBox.textContent=d.appended.join('\n'); btnCopy.disabled=false; btnCopy.onclick=async()=>{ await navigator.clipboard.writeText(d.appended.join('\n')); btnCopy.textContent='已複製'; setTimeout(()=>btnCopy.textContent='複製新增交易',1200);} }
        }
      }else{
        setDiff('首次建立：目前沒有基準檔。');
        appendBox.style.display='block'; appendBox.textContent=newText; // 讓你一眼看到全部
        btnCopy.disabled = false;
        btnCopy.onclick = async ()=>{ await navigator.clipboard.writeText(newText); btnCopy.textContent='已複製'; setTimeout(()=>btnCopy.textContent='複製新增交易',1200); };
      }

      // 設為基準
      btnBase.disabled = false;
      btnBase.onclick = async ()=>{
        try{
          const h = await sha256(newText);
          const payload = { baseline_path: latest.from==='url' ? latest.fullPath : latest.fullPath, baseline_hash: h, updated_at: new Date().toISOString() };
          await writeManifest(payload);
          btnBase.textContent='已設為基準';
          setDiff('✅ 已將最新檔標記為基準（寫入 manifests/0807.json）');
        }catch(err){ setDiff('寫入基準失敗：'+(err.message||err), true); }
      };

      // 將最新檔送交 single.js 分析
      set(`已載入最新檔（解碼=${encNew}，有效行=${okNew}），開始分析…`);
      await feedToSingle(latest.name, newText);
    }catch(err){
      set('初始化失敗：'+(err.message||err), true);
    }
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
