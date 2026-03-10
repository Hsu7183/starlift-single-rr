// single-trades-cloud.js
// 從 Supabase / reports 讀檔 → 塞進 #fileInput，並設定 single-trades.js 的 gFile
// 修正版：雲端失敗只降級，不中斷本機 TXT 分析

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

  function setCloudText(text) {
    cloudSelect.innerHTML = '';
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = text;
    cloudSelect.appendChild(opt);
  }

  function resetCloudDefault() {
    setCloudText('（雲端未載入）');
  }

  resetCloudDefault();

  if (!window.supabase) {
    console.warn('[single-trades-cloud] Supabase script not loaded');
    return;
  }

  let sb = null;
  try {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
      global: {
        fetch: (u, o = {}) => fetch(u, { ...o, cache: 'no-store' })
      }
    });
  } catch (e) {
    console.warn('[single-trades-cloud] createClient failed:', e);
    resetCloudDefault();
    return;
  }

  function isFolderItem(it) {
    // Supabase list 回傳資料夾通常無 metadata / id
    return !!it && (it.id === null && !it.metadata);
  }

  function isFileItem(it) {
    return !!it && !isFolderItem(it) && !!it.name;
  }

  async function listRootFilesSafe() {
    // 某些 storage 設定下 list('') 會 400，所以這裡做完整容錯
    const attempts = [
      async () => sb.storage.from(BUCKET).list('', {
        limit: 1000,
        offset: 0,
        sortBy: { column: 'name', order: 'asc' }
      }),
      async () => sb.storage.from(BUCKET).list('', {
        limit: 1000,
        offset: 0
      })
    ];

    for (let i = 0; i < attempts.length; i++) {
      try {
        const { data, error } = await attempts[i]();
        if (error) {
          console.warn(`[single-trades-cloud] list attempt ${i + 1} failed:`, error);
          continue;
        }
        return Array.isArray(data) ? data : [];
      } catch (e) {
        console.warn(`[single-trades-cloud] list attempt ${i + 1} exception:`, e);
      }
    }

    return null; // 明確表示雲端清單失敗
  }

  async function loadCloudList() {
    try {
      setCloudText('（雲端載入中…）');

      const data = await listRootFilesSafe();

      if (data === null) {
        console.warn('[single-trades-cloud] cloud list unavailable');
        setCloudText('（雲端讀取失敗）');
        return;
      }

      const files = data.filter(isFileItem);

      if (!files.length) {
        setCloudText('（雲端無檔案）');
        return;
      }

      cloudSelect.innerHTML = '';
      const head = document.createElement('option');
      head.value = '';
      head.textContent = '（選擇雲端檔案）';
      cloudSelect.appendChild(head);

      files.forEach(it => {
        const path = it.name;
        const opt  = document.createElement('option');
        const sizeKB = it.metadata && it.metadata.size
          ? (it.metadata.size / 1024).toFixed(1)
          : '-';

        opt.value = path;
        opt.textContent = `${path} (${sizeKB} KB)`;
        cloudSelect.appendChild(opt);
      });
    } catch (e) {
      console.warn('[single-trades-cloud] loadCloudList fatal:', e);
      setCloudText('（雲端讀取錯誤）');
    }
  }

  // 背景載入，不讓失敗中斷頁面
  loadCloudList().catch(err => {
    console.warn('[single-trades-cloud] background load failed:', err);
    setCloudText('（雲端讀取錯誤）');
  });

  async function getUrl(path) {
    if (!path) return '';

    // 1) 先試 signed URL
    try {
      const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, 3600);
      if (!error && data && data.signedUrl) return data.signedUrl;
      if (error) {
        console.warn('[single-trades-cloud] createSignedUrl failed:', error);
      }
    } catch (e) {
      console.warn('[single-trades-cloud] createSignedUrl exception:', e);
    }

    // 2) 再退回 public URL
    try {
      const { data } = sb.storage.from(BUCKET).getPublicUrl(path);
      if (data && data.publicUrl) return data.publicUrl;
    } catch (e) {
      console.warn('[single-trades-cloud] getPublicUrl exception:', e);
    }

    return '';
  }

  cloudSelect.addEventListener('change', async () => {
    const path = cloudSelect.value;
    if (!path) return;

    try {
      cloudSelect.disabled = true;

      const url = await getUrl(path);
      if (!url) {
        alert('取得雲端連結失敗');
        return;
      }

      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) {
        alert(`下載失敗（HTTP ${r.status}）`);
        return;
      }

      const ab = await r.arrayBuffer();
      const fileName = path.split('/').pop() || 'cloud.txt';

      const f = new File(
        [new Uint8Array(ab)],
        fileName,
        { type: 'application/octet-stream' }
      );

      // 1) 塞進 #fileInput，讓瀏覽器顯示檔名
      const dt = new DataTransfer();
      dt.items.add(f);
      fileInput.files = dt.files;

      // 2) 通知 single-trades.js：目前分析檔案改成這個
      if (window.__singleTrades_setFile) {
        window.__singleTrades_setFile(f);
      }

      // 3) 若 single-trades.js 有綁 change，也讓它同步收到
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));

      // 保留手動按「計算」流程
      if (runBtn) {
        // 若未來要改成選完自動算，可打開：
        // runBtn.click();
      }
    } catch (e) {
      console.error('[single-trades-cloud] download failed:', e);
      alert('載入雲端檔案時發生錯誤：' + (e && e.message ? e.message : e));
    } finally {
      cloudSelect.disabled = false;
    }
  });

})();
