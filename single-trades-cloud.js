// single-trades-cloud.js
// 從 Supabase / reports 讀檔 → 塞進 #fileInput，並設定 single-trades.js 的 gFile
(function () {
  'use strict';

  const SUPABASE_URL  = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET        = "reports";

  const $ = (s) => document.querySelector(s);

  const fileInput   = $('#fileInput');
  const cloudSelect = $('#cloudSelect');
  const runBtn      = $('#runBtn');

  if (!fileInput || !cloudSelect) return;
  if (!window.supabase) {
    console.warn('Supabase script not loaded');
    return;
  }

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    global:{ fetch:(u,o={})=>fetch(u,{...o,cache:'no-store'}) }
  });

  // ==== 1) 頁面載入時自動載入雲端檔案清單 ====
  (async function loadCloudList(){
    try {
      cloudSelect.innerHTML = '<option value="">（雲端載入中…）</option>';

      // 這裡先列出 reports bucket 根目錄所有檔
      const { data, error } = await sb.storage.from(BUCKET).list('', {
        limit: 1000,
        sortBy: { column:'name', order:'asc' }
      });

      if (error) {
        console.error(error);
        cloudSelect.innerHTML = '<option value="">（雲端讀取失敗）</option>';
        return;
      }
      if (!data || !data.length) {
        cloudSelect.innerHTML = '<option value="">（雲端無檔案）</option>';
        return;
      }

      cloudSelect.innerHTML = '<option value="">（選擇雲端檔案）</option>';
      data.forEach(it => {
        // 跳過資料夾（id=null && !metadata）
        if (it.id === null && !it.metadata) return;
        const path = it.name;
        const opt  = document.createElement('option');
        const sizeKB = it.metadata?.size ? (it.metadata.size / 1024).toFixed(1) : '-';
        opt.value = path;
        opt.textContent = `${path} (${sizeKB} KB)`;
        cloudSelect.appendChild(opt);
      });
    } catch (e) {
      console.error(e);
      cloudSelect.innerHTML = '<option value="">（雲端讀取錯誤）</option>';
    }
  })();

  // ==== 2) 選擇雲端檔案 → 下載 → 塞進 #fileInput & 設定 gFile ====
  cloudSelect.addEventListener('change', async () => {
    const path = cloudSelect.value;
    if (!path) return;

    try {
      const url = await getUrl(path);
      if (!url) {
        alert('取得雲端連結失敗');
        return;
      }

      const r = await fetch(url, { cache:'no-store' });
      if (!r.ok) {
        alert(`下載失敗（HTTP ${r.status}）`);
        return;
      }

      const ab = await r.arrayBuffer();
      const fileName = path.split('/').pop() || 'cloud.txt';
      const f  = new File(
        [new Uint8Array(ab)],
        fileName,
        { type:'application/octet-stream' }
      );

      // 1) 塞進 #fileInput，讓瀏覽器顯示檔名
      const dt = new DataTransfer();
      dt.items.add(f);
      fileInput.files = dt.files;

      // 2) 通知 single-trades.js：「這是目前要分析的檔案」
      if (window.__singleTrades_setFile) {
        window.__singleTrades_setFile(f);
      }

      // 3) 若 single-trades.js 有綁 change 也讓它吃到
      fileInput.dispatchEvent(new Event('change', { bubbles:true }));

      // ✅ 接下來照你的流程：手動按「計算」
      if (runBtn) {
        // 如果未來想自動計算，只要把下一行註解打開即可：
        // runBtn.click();
      }
    } catch (e) {
      console.error(e);
      alert('載入雲端檔案時發生錯誤：' + e.message);
    }
  });

  // ==== 取得檔案 URL：先簽名，失敗改用 publicUrl ====
  async function getUrl(path) {
    try {
      const { data } = await sb.storage.from(BUCKET).createSignedUrl(path, 3600);
      if (data?.signedUrl) return data.signedUrl;
    } catch (e) {
      console.warn('createSignedUrl 失敗，改用 publicUrl', e);
    }
    const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(path);
    return pub?.publicUrl || '';
  }
})();
