/* compare-xq.js
 * XQ 回測匯出（xlsx/csv） → TXT（只輸出交易列）
 * + 可選擇載入策略 TXT 對帳（忽略參數列、INPOS、非交易動作）
 */
(function () {
  'use strict';

  const ACTIONS = new Set(['新買', '平賣', '新賣', '平買', '強制平倉']);

  const els = {
    xqFile: document.getElementById('xqFile'),
    tsMode: document.getElementById('tsMode'),
    pxMode: document.getElementById('pxMode'),
    outName: document.getElementById('outName'),
    btnConvert: document.getElementById('btnConvert'),
    dlCanon: document.getElementById('dlCanon'),
    xqStatus: document.getElementById('xqStatus'),
    canonPreview: document.getElementById('canonPreview'),

    canonFile: document.getElementById('canonFile'),
    btnCompare: document.getElementById('btnCompare'),
    cmpStatus: document.getElementById('cmpStatus'),
    cmpResult: document.getElementById('cmpResult'),

    tblBody: document.getElementById('tblBody'),
  };

  let xqEvents = [];        // {ts, px, act, src}
  let xqOutText = '';
  let userCanonEvents = []; // {ts, px, act, src}

  function pad2(n) { return String(n).padStart(2, '0'); }

  function fmtTs14(dt) {
    const y = dt.getFullYear();
    const mo = dt.getMonth() + 1;
    const d = dt.getDate();
    const h = dt.getHours();
    const mi = dt.getMinutes();
    const ss = dt.getSeconds();
    return `${y}${pad2(mo)}${pad2(d)}${pad2(h)}${pad2(mi)}${pad2(ss)}`;
  }

  function fmtTsCanon(dt) {
    return `${fmtTs14(dt)}.000000`;
  }

  function parseXqDatetime(v) {
    if (!v) return null;
    if (v instanceof Date && !isNaN(v.getTime())) return v;

    const s = String(v).trim();
    // 常見：YYYY/MM/DD HH:MM 或 YYYY/MM/DD HH:MM:SS
    const m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
      const y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], ss = m[6] ? +m[6] : 0;
      return new Date(y, mo - 1, d, h, mi, ss);
    }

    const d2 = new Date(s);
    if (!isNaN(d2.getTime())) return d2;

    throw new Error(`無法解析時間：${s}`);
  }

  function toNumber(v) {
    if (v === null || v === undefined || v === '') return NaN;
    return Number(String(v).replace(/,/g, '').trim());
  }

  function fmtPrice(v, mode) {
    const n = toNumber(v);
    if (!isFinite(n)) return '';
    if (mode === 'fixed6') return n.toFixed(6);
    // raw：整數不補 .0，小數保留原本 number 文字表現（避免強制 6 位）
    // 但若來源本來是字串小數，XLSX 可能已變成 number；這裡用最短表示
    return (Number.isInteger(n) ? String(n) : String(n));
  }

  function entryAct(dir) {
    const s = String(dir || '');
    // 只要含「買」視為多單進場；否則視為空單進場（新賣）
    return s.includes('買') ? '新買' : '新賣';
  }

  function exitAct(dir) {
    const s = String(dir || '');
    // 只要含「賣」視為多單出場（平賣）；否則視為空單回補（平買）
    return s.includes('賣') ? '平賣' : '平買';
  }

  function setPill(el, text, kind) {
    el.textContent = text;
    el.classList.remove('ok', 'bad');
    if (kind) el.classList.add(kind);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function renderTable() {
    const items = [];
    for (const e of xqEvents) items.push(e);
    for (const e of userCanonEvents) items.push(e);

    if (!items.length) {
      els.tblBody.innerHTML = '<tr><td colspan="5" class="hint">尚未載入資料</td></tr>';
      return;
    }

    items.sort((a, b) => a.ts.localeCompare(b.ts) || a.src.localeCompare(b.src));

    const rows = items.slice(0, 2000).map((e, i) => (
      `<tr>
        <td class="mono">${i + 1}</td>
        <td class="mono">${escapeHtml(e.ts)}</td>
        <td class="mono">${escapeHtml(e.px)}</td>
        <td class="mono">${escapeHtml(e.act)}</td>
        <td>${escapeHtml(e.src)}</td>
      </tr>`
    ));

    els.tblBody.innerHTML = rows.join('') + (items.length > 2000
      ? `<tr><td colspan="5" class="hint">（僅顯示前 2000 筆；實際共有 ${items.length} 筆事件）</td></tr>`
      : '');
  }

  async function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error || new Error('讀檔失敗'));
      fr.readAsArrayBuffer(file);
    });
  }

  async function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error || new Error('讀檔失敗'));
      fr.readAsText(file);
    });
  }

  function sheetToRows(ws) {
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  }

  function parseCsvRows(text) {
    return (text || '').split(/\r?\n/).map(line => {
      // XQ 匯出大多簡單 CSV；不處理複雜嵌逗號
      return line.split(',').map(s => s.replace(/^"|"$/g, '').trim());
    });
  }

  function findHeaderRow(rows) {
    const need = ['進場時間', '進場方向', '進場價格', '出場時間', '出場方向', '出場價格'];
    for (let i = 0; i < Math.min(rows.length, 80); i++) {
      const r = (rows[i] || []).map(x => String(x || '').trim());
      const ok = need.every(k => r.includes(k));
      if (ok) return { header: rows[i], headerIdx: i };
    }
    return null;
  }

  function parseXqRows(rows) {
    const found = findHeaderRow(rows);
    if (!found) throw new Error('找不到欄位列（需要含：進場時間/方向/價格、出場時間/方向/價格）');

    const headerRow = found.header.map(x => String(x || '').trim());
    const headerIdx = found.headerIdx;

    const idx = (name) => headerRow.indexOf(name);
    const iEntT = idx('進場時間');
    const iEntD = idx('進場方向');
    const iEntP = idx('進場價格');
    const iExT = idx('出場時間');
    const iExD = idx('出場方向');
    const iExP = idx('出場價格');

    const tsMode = els.tsMode.value;  // '14' or 'canon'
    const pxMode = els.pxMode.value;  // 'raw' or 'fixed6'

    const events = [];

    for (let r = headerIdx + 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.length === 0) continue;

      const entT = row[iEntT];
      const entD = row[iEntD];
      const entP = row[iEntP];
      const exT = row[iExT];
      const exD = row[iExD];
      const exP = row[iExP];

      if (!entT || !entD || entP === '' || !exT || !exD || exP === '') continue;

      const entDt = parseXqDatetime(entT);
      const exDt = parseXqDatetime(exT);

      const ts1 = (tsMode === 'canon') ? fmtTsCanon(entDt) : fmtTs14(entDt);
      const ts2 = (tsMode === 'canon') ? fmtTsCanon(exDt) : fmtTs14(exDt);

      events.push({
        ts: ts1,
        px: fmtPrice(entP, pxMode),
        act: entryAct(entD),
        src: 'XQ匯出',
      });
      events.push({
        ts: ts2,
        px: fmtPrice(exP, pxMode),
        act: exitAct(exD),
        src: 'XQ匯出',
      });
    }

    if (!events.length) throw new Error('解析不到任何交易（請確認匯出檔含「交易分析」明細表）');
    return events;
  }

  async function parseXqFile(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith('.xlsx')) {
      const ab = await readFileAsArrayBuffer(file);
      const wb = XLSX.read(ab, { type: 'array' });

      // 優先「交易分析」，否則第一張
      const sname = wb.SheetNames.includes('交易分析') ? '交易分析' : wb.SheetNames[0];
      const ws = wb.Sheets[sname];
      const rows = sheetToRows(ws);
      return parseXqRows(rows);
    }

    // CSV fallback
    const text = await readFileAsText(file);
    const rows = parseCsvRows(text);
    return parseXqRows(rows);
  }

  function buildOutTextFromEvents(events) {
    // 只輸出：ts px act（三欄）
    return events.map(e => `${e.ts} ${e.px} ${e.act}`).join('\n') + '\n';
  }

  function setDownload(text, filename) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    els.dlCanon.href = url;
    els.dlCanon.download = filename || 'xq-export.txt';
    els.dlCanon.style.display = '';
  }

  function parseUserTxt(text) {
    const lines = (text || '').split(/\r?\n/);
    const out = [];

    for (const ln of lines) {
      const s = ln.trim();
      if (!s) continue;

      // 參數列：BeginTime=... 直接略過
      if (s.includes('BeginTime=') || s.includes('EndTime=') || s.includes('ForceExitTime=')) continue;

      // 把多空 INPOS 行排除：最後一欄 INPOS
      if (/\bINPOS\b/.test(s)) continue;

      // 正常交易列：ts px act（ts 可能是 14碼或 14碼.000000）
      const parts = s.split(/\s+/);
      if (parts.length < 3) continue;

      const ts = parts[0];
      const px = parts[1];
      const act = parts[2];

      if (!ACTIONS.has(act)) continue;

      out.push({
        ts,
        px: px, // 不強制補小數；以你原本 TXT 為主
        act,
        src: '策略TXT',
      });
    }

    return out;
  }

  function normalizeForCompare(e) {
    // 比較用：時間保持字串；價格用 number 做一致化（避免 17792 vs 17792.000000）
    const pxNum = toNumber(e.px);
    return {
      ts: String(e.ts),
      act: String(e.act),
      pxNum: isFinite(pxNum) ? pxNum : NaN,
    };
  }

  function compareSeq(a, b) {
    const A = a.map(normalizeForCompare);
    const B = b.map(normalizeForCompare);

    const n = Math.max(A.length, B.length);
    let firstBad = -1;

    for (let i = 0; i < n; i++) {
      const x = A[i], y = B[i];
      if (!x || !y) { firstBad = i; break; }
      const sameTs = (x.ts === y.ts);
      const sameAct = (x.act === y.act);
      const samePx = (isFinite(x.pxNum) && isFinite(y.pxNum)) ? (x.pxNum === y.pxNum) : (String(a[i].px) === String(b[i].px));

      if (!(sameTs && sameAct && samePx)) { firstBad = i; break; }
    }

    const lines = [];
    lines.push(`XQ 事件數：${a.length}`);
    lines.push(`策略TXT 事件數：${b.length}`);

    if (firstBad === -1) {
      lines.push('結果：一致（逐行相同）。');
      return lines.join('\n');
    }

    lines.push(`結果：不一致（第一個 mismatch：第 ${firstBad + 1} 行）。`);
    lines.push('');

    const from = Math.max(0, firstBad - 5);
    const to = Math.min(n - 1, firstBad + 5);

    lines.push('--- 對照區段（前後 5 行）---');

    for (let i = from; i <= to; i++) {
      const la = a[i] ? `${a[i].ts} ${a[i].px} ${a[i].act}` : '(缺)';
      const lb = b[i] ? `${b[i].ts} ${b[i].px} ${b[i].act}` : '(缺)';
      const ok = (a[i] && b[i] &&
        A[i].ts === B[i].ts &&
        A[i].act === B[i].act &&
        ((isFinite(A[i].pxNum) && isFinite(B[i].pxNum)) ? (A[i].pxNum === B[i].pxNum) : (String(a[i].px) === String(b[i].px)))
      );
      const mark = ok ? ' ' : '!';
      lines.push(`${mark} ${String(i + 1).padStart(5, ' ')} | XQ : ${la}`);
      lines.push(`${mark}       | TXT: ${lb}`);
    }

    lines.push('');
    lines.push('常見原因：XQ 匯出時間粒度（秒）、或同時點多筆成交在匯出時被合併/拆分。');
    return lines.join('\n');
  }

  // UI events
  els.xqFile.addEventListener('change', async () => {
    els.btnConvert.disabled = true;
    els.btnCompare.disabled = true;
    setPill(els.xqStatus, '讀取中…');
    els.canonPreview.style.display = 'none';
    els.dlCanon.style.display = 'none';

    xqEvents = [];
    xqOutText = '';
    renderTable();

    const file = els.xqFile.files && els.xqFile.files[0];
    if (!file) {
      setPill(els.xqStatus, '尚未載入');
      return;
    }

    try {
      xqEvents = await parseXqFile(file);
      xqOutText = buildOutTextFromEvents(xqEvents);

      setPill(els.xqStatus, `已載入：${file.name}（事件 ${xqEvents.length}）`, 'ok');
      els.btnConvert.disabled = false;
      els.btnCompare.disabled = !(els.canonFile.files && els.canonFile.files[0]);
      renderTable();
    } catch (err) {
      console.error(err);
      setPill(els.xqStatus, '解析失敗', 'bad');
      alert(err.message || String(err));
    }
  });

  // 若切換格式，且已經載入 xqEvents，就即時重建輸出
  function rebuildIfHaveXq() {
    if (!xqEvents.length) return;
    // 重新用 rows 解析會麻煩；這裡直接用既有 dt 已經丟掉了，所以簡化：提示重新選檔
    // 最安全做法：格式切換後要求重新載入 xqFile
    // 因為我們在 parseXqRows() 時才決定 ts/px 格式。
    setPill(els.xqStatus, '格式已改，請重新選擇 XQ 檔案以套用', 'bad');
  }
  els.tsMode.addEventListener('change', rebuildIfHaveXq);
  els.pxMode.addEventListener('change', rebuildIfHaveXq);

  els.btnConvert.addEventListener('click', () => {
    if (!xqOutText) return;
    const filename = (els.outName.value || 'xq-export.txt').trim() || 'xq-export.txt';
    setDownload(xqOutText, filename);

    const lines = xqOutText.split(/\r?\n/);
    els.canonPreview.textContent = lines.slice(0, 300).join('\n') + (lines.length > 300 ? '\n…（僅預覽前 300 行）' : '');
    els.canonPreview.style.display = '';
  });

  els.canonFile.addEventListener('change', async () => {
    els.btnCompare.disabled = true;
    setPill(els.cmpStatus, '讀取中…');
    els.cmpResult.style.display = 'none';

    userCanonEvents = [];
    renderTable();

    const file = els.canonFile.files && els.canonFile.files[0];
    if (!file) {
      setPill(els.cmpStatus, '尚未比較');
      return;
    }

    try {
      const text = await readFileAsText(file);
      userCanonEvents = parseUserTxt(text);

      setPill(els.cmpStatus, `已載入：${file.name}（交易列 ${userCanonEvents.length}）`, 'ok');
      els.btnCompare.disabled = !(xqEvents && xqEvents.length);
      renderTable();
    } catch (err) {
      console.error(err);
      setPill(els.cmpStatus, '解析失敗', 'bad');
      alert(err.message || String(err));
    }
  });

  els.btnCompare.addEventListener('click', () => {
    if (!xqEvents.length || !userCanonEvents.length) return;
    const rep = compareSeq(xqEvents, userCanonEvents);
    els.cmpResult.textContent = rep;
    els.cmpResult.style.display = '';
    if (rep.includes('一致')) setPill(els.cmpStatus, '一致', 'ok');
    else setPill(els.cmpStatus, '不一致', 'bad');
  });

})();
