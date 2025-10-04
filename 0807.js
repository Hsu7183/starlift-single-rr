// 0807.js - 自動尋找 0807 檔案並注入到 single.js 的 #file 流程
(function () {
  const $ = s => document.querySelector(s);
  const status = $('#autostatus');

  // 依序嘗試的來源：
  // 1) URL ?file= 完整網址或相對路徑
  // 2) 上傳清單（localStorage 的可能 key；等你需要可改成你 upload.json 的 API）
  // 3) 預設候選路徑（照你的部署調整）
  const UPLOAD_KEYS = ['starlift_uploads', 'uploadsIndex', 'fileList'];
  const CANDIDATE_PATHS = [
    'uploads/0807.txt',
    'uploads/0807_latest.txt',
    'uploads/strategy_0807.txt'
  ];
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

  function pickFromLocalUploads(){
    for (const k of UPLOAD_KEYS){
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      try{
        const obj = JSON.parse(raw);
        const files = Array.isArray(obj) ? obj : (Array.isArray(obj.files) ? obj.files : []);
        if (!files.length) continue;
        const norm = files.map(f => ({
          name: f.name || f.filename || '',
          url:  f.url  || f.href     || f.path || '',
          ts:   f.ts   || f.time     || f.mtime || 0
        })).filter(x => x.url);

        const prefer = norm.filter(x => WANT.test(x.name)).sort((a,b)=>(b.ts||0)-(a.ts||0))[0];
        if (prefer) return prefer;
        return norm.sort((a,b)=>(b.ts||0)-(a.ts||0))[0];
      }catch(e){}
    }
    return null;
  }

  // 把文字包成 File，指派給 #file 並觸發 change，讓 single.js 接手
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

      // 2) 上傳清單
      set('嘗試從「資料上傳區」清單挑選 0807 檔案…');
      const picked = pickFromLocalUploads();
      if (picked){
        set(`載入上傳清單檔案：${picked.name}`);
        const txt = await fetchText(picked.url);
        await injectToSingle(picked.name, txt);
        set('已載入並開始分析（上傳清單）');
        return;
      }

      // 3) 預設候選路徑
      for (const path of CANDIDATE_PATHS){
        try{
          set(`嘗試預設路徑：${path}`);
          const txt = await fetchText(path);
          await injectToSingle(path.split('/').pop(), txt);
          set('已載入並開始分析（預設路徑）');
          return;
        }catch(e){ /* 繼續嘗試下一個 */ }
      }

      set('找不到可用的 0807 檔案。請回「資料上傳區」確認或改用單檔分析傳統頁。', true);
      // 顯示隱藏的手動控制讓你也能選檔
      document.querySelectorAll('.hide-on-0807').forEach(el=>el.style.display='');
    }catch(err){
      set('初始化失敗：' + (err.message || err), true);
      document.querySelectorAll('.hide-on-0807').forEach(el=>el.style.display='');
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
