// 0807-single-cloud.js — 第5分頁：從 Supabase「資料上傳區」讀檔 → 丟給 #file，交由 shared.js + single.js 處理
(function () {
  'use strict';

  // ===== Supabase 設定（沿用你的第4分頁專案） =====
  const SUPABASE_URL  = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET        = "reports";

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    global:{ fetch:(u,o={})=>fetch(u,{...o,cache:'no-store'}) }
  });

  // ===== DOM =====
  const $ = s => document.querySelector(s);

  // 與 single.html 一致的本機匯入元件（交由原本流程處理）
  const fileInput = $('#file');
  const btnClip   = $('#btn-clip');

  // 第5分頁的雲端 UI
  const prefix   = $('#cloudPrefix');
  const btnList  = $('#btnCloudList');
  const pick     = $('#cloudSelect');
  const btnPrev  = $('#btnCloudPreview');
  const btnImp   = $('#btnCloudImport');
  const meta     = $('#cloudMeta');
  const prev     = $('#cloudPreview');
  const cacheTxt = $('#cloudTxt');

  // ===== 公用：剪貼簿 → File → 觸發 #file =====
  if (btnClip) {
    btnClip.addEventListener('click', async ()=>{
      try{
        const txt = await navigator.clipboard.readText();
        if(!txt) return alert('剪貼簿沒有文字');
        feedToFile(txt, 'clipboard.txt');
      }catch(e){
        alert('無法讀取剪貼簿內容，請改用「選擇檔案」。');
      }
    });
  }

  // ===== 雲端：列清單 =====
  if (btnList) {
    btnList.addEventListener('click', listCloud);
  }

  // ===== 雲端：預覽 =====
  if (btnPrev) {
    btnPrev.addEventListener('click', previewCloud);
  }

  // ===== 雲端：載入到分析（用原始位元組 → File → #file） =====
  if (btnImp) {
    btnImp.addEventListener('click', importCloudToAnalysis);
  }

  // ---------- 功能實作 ----------

  async function listCloud(){
    prev.textContent = '';
    meta.textContent = '';
    cacheTxt.value   = '';

    pick.innerHTML = '<option value="">載入中…</option>';

    const p     = (prefix?.value || '').trim();
    const fixed = p && !p.endsWith('/') ? p + '/' : p;

    const { data, error } = await sb.storage.from(BUCKET).list(fixed,{
      limit:1000,
      sortBy:{column:'name',order:'asc'}
    });

    if (error) {
      pick.innerHTML = `<option>讀取失敗：${error.message}</option>`;
      return;
    }
    if (!data || !data.length) {
      pick.innerHTML = '<option>（無檔案）</option>';
      return;
    }

    pick.innerHTML = '';
    data.forEach(it=>{
      // 跳過資料夾（id=null && !metadata）
      if (it.id === null && !it.metadata) return;

      const path   = (fixed || '') + it.name;
      const opt    = document.createElement('option');
      const sizeKB = it.metadata?.size ? (it.metadata.size/1024).toFixed(1) : '-';

      opt.value      = path;
      opt.textContent = `${path} (${sizeKB} KB)`;
      pick.appendChild(opt);
    });
  }

  async function previewCloud(){
    prev.textContent = '';
    meta.textContent = '';
    cacheTxt.value   = '';

    const path = pick.value;
    if (!path) return;

    const url = await getUrl(path);
    if (!url) {
      prev.textContent = '取得連結失敗';
      return;
    }

    const r = await fetch(url,{cache:'no-store'});
    if (!r.ok) {
      prev.textContent = `HTTP ${r.status}`;
      return;
    }

    const ab   = await r.arrayBuffer();
    const best = decodeBest(ab);

    cacheTxt.value = best.txt; // 僅顯示；實際載入用原始位元組
    meta.textContent = `來源：${path}（編碼：${best.enc}）`;

    const lines = best.txt.split(/\r?\n/);
    prev.textContent =
      lines.slice(0,500).join('\n') +
      (lines.length>500 ? `\n...（共 ${lines.length} 行）` : ``);
  }

  async function importCloudToAnalysis(){
    const path = pick.value;
    if (!path) return alert('請先選檔');

    const url = await getUrl(path);
    if (!url) return alert('取得連結失敗');

    const r = await fetch(url,{cache:'no-store'});
    if (!r.ok) return alert(`HTTP ${r.status}`);

    const ab = await r.arrayBuffer();
    const f  = new File(
      [new Uint8Array(ab)],
      path.split('/').pop() || 'cloud.txt',
      { type:'application/octet-stream' }
    );

    const dt = new DataTransfer();
    dt.items.add(f);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('change',{bubbles:true}));
  }

  // ---------- 輔助：File 丟給 #file ----------
  function feedToFile(text, name){
    const blob = new Blob([text],{type:'text/plain;charset=utf-8'});
    const f    = new File([blob], name || 'cloud.txt', {type:'text/plain'});
    const dt   = new DataTransfer();
    dt.items.add(f);
    fileInput.files = dt.files;
    fileInput.dispatchEvent(new Event('change',{bubbles:true}));
  }

  // ---------- 輔助：先簽名再 public（相容 Private/Public bucket） ----------
  async function getUrl(path){
    try{
      const { data } = await sb.storage.from(BUCKET).createSignedUrl(path, 3600);
      if (data?.signedUrl) return data.signedUrl;
    }catch(e){}
    const { data:pub } = sb.storage.from(BUCKET).getPublicUrl(path);
    return pub?.publicUrl || '';
  }

  // ---------- 輔助：ArrayBuffer → 自動偵測編碼（utf-8 / big5 / gb18030） ----------
  function decodeBest(ab){
    const encs = ['utf-8','big5','gb18030'];
    let best   = {txt:'',bad:1e9,enc:''};

    for (const e of encs){
      try{
        const t = new TextDecoder(e,{fatal:false}).decode(ab);
        const b = (t.match(/\uFFFD/g)||[]).length;
        if (b < best.bad) best = {txt:t,bad:b,enc:e};
      }catch{}
    }
    return best;
  }
})();
