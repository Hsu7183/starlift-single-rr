// single-trades-cloud.js
// 從 Supabase「資料上傳區」（reports bucket）讀檔 → 丟給 #fileInput，交由 single-trades.js 處理
(function () {
  'use strict';

  // ===== Supabase 設定（沿用第4、5分頁） =====
  const SUPABASE_URL  = "https://byhbmmnacezzgkwfkozs.supabase.co";
  const SUPABASE_ANON = "sb_publishable_xVe8fGbqQ0XGwi4DsmjPMg_Y2RBOD3t";
  const BUCKET        = "reports";

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
    global:{ fetch:(u,o={})=>fetch(u,{...o,cache:'no-store'}) }
  });

  const $ = (s) => document.querySelector(s);

  const fileInput = $('#fileInput');

  const prefix   = $('#cloudPrefix');
  const btnList  = $('#btnCloudList');
  const pick     = $('#cloudSelect');
  const btnPrev  = $('#btnCloudPreview');
  const btnImp   = $('#btnCloudImport');
  const meta     = $('#cloudMeta');
  const prev     = $('#cloudPreview');
  const cacheTxt = $('#cloudTxt');

  if (!fileInput || !prefix || !btnList || !pick || !btnPrev || !btnImp) {
    // DOM 未找到就直接跳出（避免其他頁誤載）
    return;
  }

  // === 載入清單 ===
  btnList.addEventListener('click', async () => {
    prev.textContent = '';
    meta.textContent = '';
    cacheTxt.value   = '';
    pick.innerHTML   = '<option value="">載入中…</option>';

    const p      = (prefix.value || '').trim();
    const fixed  = p && !p.endsWith('/') ? p + '/' : p;

    const { data, error } = await sb.storage.from(BUCKET).list(fixed, {
      limit: 1000,
      sortBy: { column: 'name', order: 'asc' }
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
    data.forEach(it => {
      // 跳過資料夾（id=null && !metadata）
      if (it.id === null && !it.metadata) return;
      const path = (fixed || '') + it.name;
      const opt  = document.createElement('option');
      const sizeKB = it.metadata?.size ? (it.metadata.size / 1024).toFixed(1) : '-';
      opt.value = path;
      opt.textContent = `${path} (${sizeKB} KB)`;
      pick.appendChild(opt);
    });
  });

  // === 預覽 ===
  btnPrev.addEventListener('click', async () => {
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

    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) {
      prev.textContent = `HTTP ${r.status}`;
      return;
    }

    const ab   = await r.arrayBuffer();
    const best = decodeBest(ab);
    cacheTxt.value = best.txt; // 只是讓你複製查驗，不給主流程用

    meta.textContent = `來源：${path}（編碼：${best.enc}）`;
    const lines = best.txt.split(/\r?\n/);
    prev.textContent =
      lines.slice(0, 500).join('\n') +
      (lines.length > 500 ? `\n...（共 ${lines.length} 行）` : '');
  });

  // === 載入到分析：轉 File → 丟給 #fileInput ===
  btnImp.addEventListener('click', async () => {
    const path = pick.value;
    if (!path) {
      alert('請先選擇檔案');
      return;
    }

    const url = await getUrl(path);
    if (!url) {
      alert('取得連結失敗');
      return;
    }

    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) {
      alert(`下載失敗（HTTP ${r.status}）`);
      return;
    }

    const ab = await r.arrayBuffer();
    const f  = new File([new Uint8Array(ab)],
      path.split('/').pop() || 'cloud.txt',
      { type: 'application/octet-stream' });

    const dt = new DataTransfer();
    dt.items.add(f);
    fileInput.files = dt.files;

    // 交給 single-trades.js 的 #fileInput change 邏輯處理
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    alert('檔案已載入，下方按「計算」即可分析。');
  });

  // ---------- 輔助：先簽名再 public（相容 Private/Public bucket） ----------
  async function getUrl(path) {
    try {
      const { data } = await sb.storage.from(BUCKET).createSignedUrl(path, 3600);
      if (data?.signedUrl) return data.signedUrl;
    } catch (e) {}
    const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(path);
    return pub?.publicUrl || '';
  }

  // ---------- 輔助：ArrayBuffer → 自動偵測編碼（utf-8 / big5 / gb18030） ----------
  function decodeBest(ab) {
    const encs = ['utf-8', 'big5', 'gb18030'];
    let best   = { txt: '', bad: 1e9, enc: '' };
    for (const e of encs) {
      try {
        const t   = new TextDecoder(e, { fatal: false }).decode(ab);
        const bad = (t.match(/\uFFFD/g) || []).length;
        if (bad < best.bad) best = { txt: t, bad, enc: e };
      } catch {}
    }
    return best;
  }
})();
