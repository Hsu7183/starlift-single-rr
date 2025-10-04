// 0807.js - 自動從 Supabase reports bucket 抓「最新的 0807 檔案」→ 注入 single.js 的 #file 流程
(function () {
  const $ = s => document.querySelector(s);
  const status = $('#autostatus');

  // 與 upload.html 相同的公開設定
  const SUPABASE_URL = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET = "reports";
  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { fetch: (url, opts={}) => fetch(url, { ...opts, cache:'no-store' }) }
  });

  const WANT = /0807/i;

  function set(msg, err=false){
    if (!status) return;
    status.textContent = msg;
    status.style.color = err ? '#c62828' : '#666';
  }

  async function fetchText(url){
    const res = await fetch(url, { cache:'no-store' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.text();
  }

  // 從檔名抓出 8 碼日期（回傳最「晚」的一個，當排序權重）
  function extractLastDateScore(name){
    const m = String(name).match(/\b(20\d{6})\b/g); // ex: 20250924
    if (!m || !m.length) return 0;
    return Math.max(...m.map(s => Number(s)||0));
  }

  // 列出某一層的檔案（不含資料夾）
  async function listOnce(prefix){
    const p = (prefix && !prefix.endsWith('/')) ? (prefix + '/') : (prefix || '');
    const { data, error } = await sb.storage.from(BUCKET).list(p, { limit:1000, sortBy:{ column:'name', order:'asc' }});
    if (error) throw new Error(error.message);
    const files = [];
    for (const it of (data||[])) {
      // Supabase：資料夾 id 為 null；檔案有 metadata/size
      const isDir = (it.id === null && !it.metadata);
      if (isDir) continue;
      files.push({
        name: it.name,
        fullPath: p + it.name,
        updatedAt: it.updated_at ? Date.parse(it.updated_at) : 0,
        size: it.metadata?.size || 0
      });
    }
    return files;
  }

  // 依照 URL 參數 ?prefix= 只看該資料夾；否則只看根目錄（你日後想改成遞迴，可再擴充）
  async function listCandidates(){
    const url = new URL(location.href);
    const prefix = url.searchParams.get('prefix') || '';
    return await listOnce(prefix);
  }

  // 取得檔案的可公開讀取網址（非強制下載）
  function publicUrlOf(path){
    const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
    return data?.publicUrl || '#';
  }

  // 把文字包成 File → 指派給 #file → 觸發 change，交給 single.js
  async function injectToSingle(filename, txt){
    const input = $('#file');
    if (!input){
      set('找不到 #file 輸入框（single.js 尚未載入？）', true);
      return;
    }
    const file = new File([txt], filename || '0807.txt', { type:'text/plain' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles:true }));
  }

  async function boot(){
    try{
      // 1) URL 參數 ?file=
      const u = new URL(location.href);
      const p = u.searchParams.get('file');
      if (p){
        set(`從 URL 指定檔載入：${p}`);
        const txt = await fetchText(p);
        await injectToSingle(p.split('/').pop() || '0807.txt', txt);
        set('已載入並開始分析（URL）');
        return;
      }

      // 2) 從 Supabase 清單中找「檔名含 0807」→ 以(結束日/更新時間/大小)排序擇優
      set('從 Supabase（reports）讀取清單…');
      const files = await listCandidates();
      const targets = files.filter(f => WANT.test(f.name) || WANT.test(f.fullPath));
      if (targets.length) {
        targets.sort((a,b)=>{
          const sa = extractLastDateScore(a.name), sb = extractLastDateScore(b.name);
          if (sa !== sb) return sb - sa;                    // 先比檔名中的日期（如結束日）
          if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt; // 再比更新時間
          return (b.size||0) - (a.size||0);                 // 最後比檔案大小
        });
        const best = targets[0];
        const url = publicUrlOf(best.fullPath);
        set(`載入：${best.fullPath}`);
        const txt = await fetchText(url);
        await injectToSingle(best.name, txt);
        set('已載入並開始分析（Supabase）');
        return;
      }

      // 3) 找不到 0807 → 提示
      set('找不到檔名含「0807」的 TXT。請至「資料上傳區」上傳，或以 ?file= 直接指定。', true);
      // 顯示隱藏的手動控制（讓你仍可選檔）
      document.querySelectorAll('.hide-on-0807').forEach(el=>el.style.display='');
    }catch(err){
      set('初始化失敗：' + (err.message || err), true);
      document.querySelectorAll('.hide-on-0807').forEach(el=>el.style.display='');
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
