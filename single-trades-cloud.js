// single-trades-cloud.js
// 從 Supabase / reports 讀檔 → 丟給 #fileInput，交由 single-trades.js 分析
(function () {
  'use strict';

  const SUPABASE_URL  = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET        = "reports";

  const $ = (s) => document.querySelector(s);

  const fileInput = $('#fileInput');
  const prefix    = $('#cloudPrefix');
  const btnList   = $('#btnCloudList');
  const pick      = $('#cloudSelect');
  const meta      = $('#cloudMeta');

  // 如果 DOM 元件沒找到就不做事（避免其他頁誤載）
  if (!fileInput || !prefix || !btnList || !pick || !meta) {
    return;
  }

  // 等 Supabase script 載好再建立 client
  function getClient() {
    if (!window.supabase) {
      throw new Error('Supabase 尚未載入');
    }
    return window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
      global:{ fetch:(u,o={})=>fetch(u,{...o,cache:'no-store'}) }
    });
  }

  let sb = null;
  try { sb = getClient(); }
  catch (e) {
    console.error(e);
    meta.textContent = 'Supabase 初始化失敗：' + e.message;
    return;
  }

  // 載入清單
  btnList.addEventListener('click', async () => {
    try {
      meta.textContent = '';
      pick.innerHTML = '<option value="">載入中…</option>';

      const p      = (prefix.value || '').trim();
      const fixed  = p && !p.endsWith('/') ? p + '/' : p;

      const { data, error } = await sb.storage.from(BUCKET).list(fixed, {
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
        meta.textContent = '找不到符合前綴的檔案。';
        return;
      }

      pick.innerHTML = '';
      data.forEach(it => {
        // 跳過資料夾（id=null && !metadata）
        if (it.id === null && !it.metadata) return;
        const path = (fixed || '') + it.name;
        const opt  = document.createElement('option');
        const sizeKB = it.metadata?.size ? (it.metadata.size/1024).toFixed(1) : '-';
        opt.value = path;
        opt.textContent = `${path} (${sizeKB} KB)`;
        pick.appendChild(opt);
      });

      meta.textContent = '清單載入完成，請從右側選擇檔案。';
    } catch (e) {
      console.error(e);
      pick.innerHTML = '<option value="">讀取失敗</option>';
      meta.textContent = '發生錯誤：' + e.message;
    }
  });

  // 選擇雲端檔案 → 下載 → 塞進 #fileInput
  pick.addEventListener('change', async () => {
    const path = pick.value;
    if (!path) {
      meta.textContent = '請先選擇檔案。';
      return;
    }

    try {
      meta.textContent = `下載中：${path} …`;

      const url = await getUrl(sb, path);
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
      fileInput.dispatchEvent(new Event('change', { bubbles:true }));

      meta.textContent = `已載入：${path} → 上方 TXT 檔已帶入，按「計算」即可分析。`;
    } catch (e) {
      console.error(e);
      meta.textContent = '載入檔案時發生錯誤：' + e.message;
    }
  });

  // 先簽名再 public（兼容 private/public bucket）
  async function getUrl(client, path) {
    try {
      const { data } = await client.storage.from(BUCKET).createSignedUrl(path, 3600);
      if (data?.signedUrl) return data.signedUrl;
    } catch (e) {
      console.warn('createSignedUrl 失敗，改用 publicUrl', e);
    }
    const { data: pub } = client.storage.from(BUCKET).getPublicUrl(path);
    return pub?.publicUrl || '';
  }
})();
