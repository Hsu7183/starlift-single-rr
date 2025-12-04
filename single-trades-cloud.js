// single-trades-cloud.js
// 從 Supabase / reports 讀檔 → 丟給 #fileInput，並自動按「計算」
(function () {
  'use strict';

  const SUPABASE_URL  = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET        = "reports";

  const $ = (s) => document.querySelector(s);

  const fileInput = $('#fileInput');
  const btnList   = $('#btnCloudList');
  const pick      = $('#cloudSelect');
  const meta      = $('#cloudMeta');
  const runBtn    = $('#runBtn');

  if (!fileInput || !btnList || !pick || !meta) return;
  if (!window.supabase) {
    meta.textContent = 'Supabase 尚未載入。';
    return;
  }

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    global:{ fetch:(u,o={})=>fetch(u,{...o,cache:'no-store'}) }
  });

  // 1) 載入清單（目前預設列出 reports bucket 下所有檔案，你之後要加前綴再說）
  btnList.addEventListener('click', async () => {
    try {
      meta.textContent = '';
      pick.innerHTML = '<option value="">載入中…</option>';

      const { data, error } = await sb.storage.from(BUCKET).list('', {
        limit: 1000,
        sortBy: { column:'name', order:'asc' }
      });

      if (error) {
        console.error(error);
        pick.innerHTML = '<option value="">讀取失敗</option>';
        meta.textContent = '讀取失敗：' + error.message;
        return;
      }
      if (!data || !data.length) {
        pick.innerHTML = '<option value="">（無檔案）</option>';
        meta.textContent = '找不到任何檔案。';
        return;
      }

      pick.innerHTML = '';
      data.forEach(it => {
        // 跳過資料夾
        if (it.id === null && !it.metadata) return;
        const path = it.name;
        const opt  = document.createElement('option');
        const sizeKB = it.metadata?.size ? (it.metadata.size/1024).toFixed(1) : '-';
        opt.value = path;
        opt.textContent = `${path} (${sizeKB} KB)`;
        pick.appendChild(opt);
      });

      meta.textContent = '清單載入完成，請從下拉選擇檔案。';
    } catch (e) {
      console.error(e);
      pick.innerHTML = '<option value="">讀取失敗</option>';
      meta.textContent = '發生錯誤：' + e.message;
    }
  });

  // 2) 選擇雲端檔案 → 下載 → 塞進 #fileInput → 自動按「計算」
  pick.addEventListener('change', async () => {
    const path = pick.value;
    if (!path) {
      meta.textContent = '請先選擇檔案。';
      return;
    }

    try {
      meta.textContent = `下載中：${path} …`;

      const url = await getUrl(path);
      if (!url) {
        meta.textContent = '取得雲端連結失敗。';
        return;
      }

      const r = await fetch(url, { cache:'no-store' });
      if (!r.ok) {
        meta.textContent = `下載失敗（HTTP ${r.status}）`;
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

      // 觸發 single-trades.js 的 change 邏輯
      fileInput.dispatchEvent(new Event('change', { bubbles:true }));

      meta.textContent = `已載入：${path} → 上方 TXT 檔已帶入，已自動執行「計算」。`;

      // 自動幫你按一次計算，把圖表跑出來
      if (runBtn) {
        runBtn.click();
      }
    } catch (e) {
      console.error(e);
      meta.textContent = '載入檔案時發生錯誤：' + e.message;
    }
  });

  // 取得檔案 URL：先試簽名，失敗再用 publicUrl
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
