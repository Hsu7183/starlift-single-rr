// single-trades-cloud.js
// 從 Supabase / reports 讀檔 → 塞進 #fileInput，交給 single-trades.js 分析
(function () {
  'use strict';

  const SUPABASE_URL  = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET        = "reports";

  const $ = (s) => document.querySelector(s);

  const fileInput = $('#fileInput');
  const cloudSelect = $('#cloudSelect');
  const runBtn    = $('#runBtn');

  if (!fileInput || !cloudSelect) return;
  if (!window.supabase) {
    console.warn('Supabase script not loaded');
    return;
  }

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    global:{ fetch:(u,o={})=>fetch(u,{...o,cache:'no-store'}) }
  });

  // ==== 1) 頁面載入後自動載入雲端檔案清單 ====
  (async function loadCloudList(){
    try {
      cloudSelect.innerHTML = '<option value="">（雲端載入中…）</option>';

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
        const sizeKB = it.metadata?.size ? (it.metadata.size/1024).toFixed(1) : '-';
        opt.value = path;
        opt.textContent = `${path} (${sizeKB} KB)`;
        cloudSelect.appendChild(opt);
      });
    } catch (e) {
      console.error(e);
      cloudSelect.innerHTML = '<option value="">（雲端讀取錯誤）</option>';
    }
  })();

  // ==== 2) 選擇雲端檔案時 → 下載 → 塞進 #fileInput ====
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
      const f  = new File(
        [new Uint8Array(ab)],
        path.split('/').pop() || 'cloud.txt',
        { type:'application/octet-stream' }
      );

      const dt = new DataTransfer();
      dt.items.add(f);
      fileInput.files = dt.files;

      // 讓 single-trades.js 的 change 監聽器吃到這個 File
      fileInput.dispatchEvent(new Event('change', { bubbles:true }));

      // 這裡不自動按「計算」，照你的流程：選好雲端檔 → 手動按計算
      if (runBtn) {
        // 你如果想自動計算，把下面這行取消註解即可：
        // runBtn.click();
      }
    } catch (e) {
      console.error(e);
      alert('載入雲端檔案時發生錯誤：' + e.message);
    }
  });

  // ==== 取得檔案 URL：先簽名，再退回 publicUrl ====
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
