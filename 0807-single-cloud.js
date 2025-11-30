// 0807-single-cloud.js —— 0807 雲端單檔分析（本機 + 雲端 → single.js）
//
// 0807 TXT 格式：
//   line1: BeginTime=84800 EndTime=131000 ForceExitTime=131200 ...（參數，跳過）
//   line2+: 20231201093900 17366 新買
//
// 本檔負責：
//   - 從本機選檔 / 剪貼簿 / Supabase 取得 TXT
//   - "很鬆" 地抓出「時間 / 價格 / 動作」三欄
//   - 轉成 canonical：YYYYMMDDhhmmss.000000 價格(6位) 動作
//   - patch window.SHARED.readAsTextAuto，把 canonical 丟給 single.js 分析

(function () {
  'use strict';
  console.log('0807-single-cloud JS loaded');

  const $ = s => document.querySelector(s);
  const statusEl = $('#autostatus');

  function setStatus(msg, bad){
    if(!statusEl) return;
    statusEl.textContent = msg;
    statusEl.style.color = bad ? '#c62828' : '#666';
  }

  // ===== Supabase 設定 =====
  const SUPABASE_URL  = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET        = "reports";

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    global:{ fetch:(u,o={})=>fetch(u,{...o,cache:'no-store'}) }
  });

  // ===== 清理文字 =====
  function normalizeText(raw){
    let s = raw.replace(/\ufeff/gi,'').replace(/\u200b|\u200c|\u200d/gi,'');
    s = s.replace(/[\x00-\x09\x0B-\x1F\x7F]/g,'');    // 控制碼
    s = s.replace(/\r\n?/g,'\n').replace(/\u3000/g,' ');
    const lines = s.split('\n').map(l=>l.trim()).filter(Boolean);
    return lines.join('\n');
  }

  // ===== 0807 TXT → canonical（只看「時間 價格 動作」三欄） =====
  function canonicalizeFrom0807(raw){
    const norm = normalizeText(raw);
    const out = [];
    let ok = 0, bad = 0;

    const lines = norm.split('\n');
    for(let idx=0; idx<lines.length; idx++){
      const line = lines[idx];

      // 第一行參數：含 BeginTime 與 EndTime → 直接跳過
      if(idx === 0 && line.indexOf('BeginTime=') >= 0 && line.indexOf('EndTime=') >= 0){
        continue;
      }

      // 先用空白拆欄位
      const parts = line.split(/\s+/).filter(Boolean);
      if(parts.length < 3){
        bad++; continue;
      }

      const ts   = parts[0];            // 20231201093900
      const pStr = parts[1];            // 17366
      const act  = parts.slice(2).join(' ').trim();  // 後面全部當動作

      // 時間一定是 14 位數字
      if(!/^\d{14}$/.test(ts)){
        bad++; continue;
      }

      // 價格是數字
      if(!/^\d+(\.\d+)?$/.test(pStr)){
        bad++; continue;
      }

      const px  = Number(pStr);
      const px6 = Number.isFinite(px) ? px.toFixed(6) : pStr;

      out.push(`${ts}.000000 ${px6} ${act}`);
      ok++;
    }

    return { canon: out.join('\n'), ok, bad };
  }

  async function fetchTextSmart(url){
    const r = await fetch(url,{cache:'no-store'});
    if(!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    const buf = await r.arrayBuffer();

    for(const enc of ['utf-8','big5','utf-16le','utf-16be']){
      try{
        const td = new TextDecoder(enc,{fatal:false});
        const { canon, ok } = canonicalizeFrom0807(td.decode(buf));
        if(ok>0) return { canon, ok, enc };
      }catch(e){}
    }
    const td = new TextDecoder('utf-8');
    const { canon, ok } = canonicalizeFrom0807(td.decode(buf));
    return { canon, ok, enc:'utf-8' };
  }

  // ===== 將 canonical 丟給 single.js =====
  function patchSharedReaders(canonicalText){
    if(!window.SHARED) return;

    if(typeof window.SHARED.readAsTextAuto === 'function'){
      const orig = window.SHARED.readAsTextAuto;
      window.SHARED.readAsTextAuto = async function(){
        window.SHARED.readAsTextAuto = orig;  // 用一次就還原
        return canonicalText;
      };
    }

    if(typeof window.SHARED.paramsLabel === 'function'){
      const origPL = window.SHARED.paramsLabel;
      window.SHARED.paramsLabel = function(arg){
        try{
          return origPL(arg);
        }catch{
          const arr = Array.isArray(arg?.raw) ? arg.raw : (Array.isArray(arg)?arg:[]);
          return (arr.slice(0,2).join(' ｜ ')) || '—';
        }
      };
    }
  }

  async function feedToSingle(filename, canonicalText){
    const input = $('#file');   // single.js 用的隱藏 file input
    if(!input){
      setStatus('找不到 #file，single.js 可能尚未載入。', true);
      return;
    }
    patchSharedReaders(canonicalText);

    const file = new File([canonicalText], filename || '0807.txt', { type:'text/plain' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change',{ bubbles:true }));
  }

  // ===== 共用：由 raw text 直接跑分析（本機 / 剪貼簿） =====
  function runFromRawText(raw, filename, sourceLabel){
    const { canon, ok, bad } = canonicalizeFrom0807(raw);
    console.log('[0807] source=', sourceLabel, 'ok=', ok, 'bad=', bad);
    if(!ok){
      setStatus(`來源「${sourceLabel}」沒有合法交易行（bad=${bad}）。`, true);
      alert(`來源「${sourceLabel}」沒有合法交易行，請確認 TXT 格式。`);
      return;
    }
    setStatus(`來源「${sourceLabel}」，已轉換 ${ok} 行交易，送交單檔分析引擎…`, false);
    feedToSingle(filename || '0807.txt', canon);
  }

  // ==================== 本機檔案 ====================
  const fileLocal = $('#fileLocal');
  if(fileLocal){
    fileLocal.addEventListener('change', e=>{
      const f = e.target.files && e.target.files[0];
      if(!f) return;
      const fr = new FileReader();
      fr.onload = ev => {
        const txt = ev.target.result;
        runFromRawText(txt, f.name, '本機檔案');
      };
      fr.readAsText(f, 'utf-8');
    });
  }

  // ==================== 剪貼簿（本機） ====================
  const btnLocalClip = $('#btnLocalClip');
  if(btnLocalClip){
    btnLocalClip.addEventListener('click', async ()=>{
      try{
        const txt = await navigator.clipboard.readText();
        if(!txt) return alert('剪貼簿沒有文字');
        runFromRawText(txt, 'clipboard.txt', '剪貼簿文字');
      }catch(e){
        alert('無法讀取剪貼簿內容，請改用「選擇檔案」。');
      }
    });
  }

  // ==================== Supabase：列清單 / 預覽 / 匯入 ====================
  const prefix  = $('#cloudPrefix');
  const btnList = $('#btnCloudList');
  const pick    = $('#cloudSelect');
  const btnPrev = $('#btnCloudPreview');
  const btnImp  = $('#btnCloudImport');
  const meta    = $('#cloudMeta');
  const prev    = $('#cloudPreview');

  if(btnList) btnList.addEventListener('click', listCloud);
  if(btnPrev) btnPrev.addEventListener('click', previewCloud);
  if(btnImp)  btnImp.addEventListener('click', importCloudToAnalysis);

  async function listCloud(){
    if(!pick) return;
    prev.textContent=''; meta.textContent='';
    pick.innerHTML = '<option value="">載入中…</option>';
    setStatus('從 Supabase 讀取清單中…', false);

    const p = (prefix?.value || '').trim();
    const fixed = p && !p.endsWith('/') ? p + '/' : p;

    const { data, error } = await sb.storage.from(BUCKET).list(fixed,{
      limit:1000,
      sortBy:{ column:'name', order:'asc' }
    });

    if(error){
      pick.innerHTML = `<option value="">讀取失敗：${error.message}</option>`;
      setStatus('讀取清單失敗：' + error.message, true);
      return;
    }
    if(!data || !data.length){
      pick.innerHTML = '<option value="">（無檔案）</option>';
      setStatus('指定路徑下沒有檔案。', true);
      return;
    }

    pick.innerHTML = '';
    data.forEach(it=>{
      if(it.id===null && !it.metadata) return; // 資料夾略過
      const path = (fixed||'') + it.name;
      const sizeKB = it.metadata?.size ? (it.metadata.size/1024).toFixed(1) : '-';
      const opt = document.createElement('option');
      opt.value = path;
      opt.textContent = `${path} (${sizeKB} KB)`;
      pick.appendChild(opt);
    });

    setStatus(`清單載入完成，共 ${pick.options.length} 個檔案。`, false);
  }

  async function getUrl(path){
    try{
      const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
      return data?.publicUrl || '';
    }catch(e){
      return '';
    }
  }

  async function previewCloud(){
    prev.textContent=''; meta.textContent='';
    const path = pick?.value;
    if(!path) return;
    const url = await getUrl(path);
    if(!url){ prev.textContent='取得連結失敗'; setStatus('取得檔案連結失敗。', true); return; }

    setStatus('下載並預覽中…', false);
    try{
      const r = await fetch(url,{cache:'no-store'});
      if(!r.ok){ prev.textContent=`HTTP ${r.status}`; setStatus(`HTTP ${r.status}`, true); return; }
      const txt = await r.text();
      const norm = normalizeText(txt);
      meta.textContent = `來源：${path}`;
      const lines = norm.split(/\r?\n/);
      prev.textContent = lines.slice(0,300).join('\n') +
        (lines.length>300 ? `\n...（共 ${lines.length} 行）` : ``);
      setStatus('預覽完成。', false);
    }catch(e){
      prev.textContent = '預覽失敗：' + (e.message||e);
      setStatus('預覽失敗：' + (e.message||e), true);
    }
  }

  async function importCloudToAnalysis(){
    const path = pick?.value;
    if(!path) return alert('請先選擇一個檔案');
    const url = await getUrl(path);
    if(!url) return alert('取得檔案連結失敗');

    setStatus('下載並轉換為 canonical 格式…', false);
    try{
      const { canon, ok, enc } = await fetchTextSmart(url);
      if(!ok){
        setStatus(`沒有合法交易行（編碼=${enc}）。`, true);
        return;
      }
      setStatus(`已轉換 ${ok} 行交易（編碼=${enc}），送交單檔分析引擎…`, false);
      feedToSingle(path.split('/').pop() || '0807.txt', canon);
    }catch(e){
      console.error(e);
      setStatus('下載或轉換失敗：' + (e.message||e), true);
    }
  }

})();
