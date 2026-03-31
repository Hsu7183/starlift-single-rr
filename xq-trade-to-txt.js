(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const els = {
    fileHeaderSource: $('fileHeaderSource'),
    fileTradeDetail: $('fileTradeDetail'),

    nameHeaderSource: $('nameHeaderSource'),
    nameTradeDetail: $('nameTradeDetail'),

    btnConvertDetail: $('btnConvertDetail'),
    btnDownloadDetail: $('btnDownloadDetail'),

    headerSourcePreview: $('headerSourcePreview'),
    detailPreview: $('detailPreview'),

    fileCompareBase: $('fileCompareBase'),
    fileCompareTarget: $('fileCompareTarget'),
    nameCompareBase: $('nameCompareBase'),
    nameCompareTarget: $('nameCompareTarget'),

    btnUseDetailAsTarget: $('btnUseDetailAsTarget'),
    btnCompare: $('btnCompare'),
    btnClearAll: $('btnClearAll'),

    compareBasePreview: $('compareBasePreview'),
    compareTargetPreview: $('compareTargetPreview'),
    summaryBox: $('summaryBox'),
    compareBody: $('compareBody')
  };

  const state = {
    headerText: '',
    headerSourceRawTxt: '',
    convertedDetailTxt: '',
    compareBaseTxt: '',
    compareTargetTxt: ''
  };

  const DEFAULT_FORCE_EXIT = '131200';

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalizeLineBreaks(s) {
    return String(s || '').replace(/\r\n?/g, '\n');
  }

  function cleanLines(s) {
    return normalizeLineBreaks(s)
      .split('\n')
      .map(x => x.trim())
      .filter(Boolean);
  }

  function setPreview(el, txt) {
    el.textContent = txt || '';
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function pad6(s) {
    return String(s || '').replace(/\D/g, '').padStart(6, '0').slice(0, 6);
  }

  function normalizePrice(v) {
    if (v == null || v === '') return '';
    const n = Number(String(v).replace(/,/g, '').trim());
    if (!Number.isFinite(n)) return '';
    return String(Math.round(n));
  }

  function textCell(v) {
    return String(v == null ? '' : v).trim();
  }

  async function readFileSmart(file) {
    const buf = await file.arrayBuffer();
    const encodings = ['utf-8', 'big5', 'utf-16le', 'utf-16be'];

    let best = '';
    let bestScore = -1;

    for (const enc of encodings) {
      try {
        const txt = new TextDecoder(enc, { fatal: false }).decode(buf);
        const score = scoreDecodedText(txt);
        if (score > bestScore) {
          bestScore = score;
          best = txt;
        }
      } catch (_) {}
    }

    return best || new TextDecoder('utf-8').decode(buf);
  }

  function scoreDecodedText(txt) {
    const s = String(txt || '');
    let score = 0;

    if (/CalcBeginTime=|BeginTime=|ForceExitTime=/.test(s)) score += 50;
    if (/新買|平賣|新賣|平買|強制平倉/.test(s)) score += 80;
    if (/商品名稱|進場時間|進場方向|出場時間|出場方向|出場價格/.test(s)) score += 80;
    if (/[�]/.test(s)) score -= 200;

    const chineseCount = (s.match(/[\u4e00-\u9fff]/g) || []).length;
    score += Math.min(chineseCount, 80);

    return score;
  }

  function getHeaderFromTxt(txt) {
    const lines = cleanLines(txt);
    if (!lines.length) return '';
    return /^[A-Za-z_][A-Za-z0-9_]*=/.test(lines[0]) ? lines[0] : '';
  }

  function getForceExitTimeFromHeader(header) {
    const m = String(header || '').match(/ForceExitTime=(\d{5,6})/i);
    return m ? pad6(m[1]) : DEFAULT_FORCE_EXIT;
  }

  function parseIndicatorTxt(txt) {
    const lines = cleanLines(txt);
    let header = '';
    let startIdx = 0;

    if (lines.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(lines[0])) {
      header = lines[0];
      startIdx = 1;
    }

    const rows = [];
    for (let i = startIdx; i < lines.length; i++) {
      const m = lines[i].match(/^(\d{14})(?:\.0{1,6})?\s+(-?\d+(?:\.\d+)?)\s+(新買|平賣|新賣|平買|強制平倉)\s*$/);
      if (!m) continue;
      rows.push({
        ts: m[1],
        px: normalizePrice(m[2]),
        act: m[3]
      });
    }

    rows.sort((a, b) => {
      if (a.ts !== b.ts) return a.ts.localeCompare(b.ts);
      if (a.px !== b.px) return Number(a.px) - Number(b.px);
      return a.act.localeCompare(b.act);
    });

    return { header, rows };
  }

  function buildIndicatorTxt(header, rows) {
    const body = rows.map(r => `${r.ts} ${r.px} ${r.act}`).join('\n');
    return header ? (body ? `${header}\n${body}` : header) : body;
  }

  function parseAnyTs(value) {
    if (value == null || value === '') return '';

    const s = String(value).trim();
    if (!s) return '';

    const digits = s.replace(/\D/g, '');
    if (digits.length >= 14) return digits.slice(0, 14);

    const m1 = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
    if (m1) {
      return (
        m1[1] +
        pad2(m1[2]) +
        pad2(m1[3]) +
        pad2(m1[4]) +
        pad2(m1[5]) +
        pad2(m1[6] || '00')
      );
    }

    const m2 = s.match(/^(\d{8})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
    if (m2) {
      return m2[1] + pad2(m2[2]) + pad2(m2[3]) + pad2(m2[4] || '00');
    }

    return '';
  }

  function parseTradeDetailText(text) {
    const raw = normalizeLineBreaks(text).replace(/\ufeff/g, '');
    const lines = raw.split('\n').filter(line => line.trim() !== '');
    if (!lines.length) return [];

    const delimiter = lines[0].includes('\t') ? '\t' : ',';
    return lines.map(line => splitCsvLike(line, delimiter));
  }

  function splitCsvLike(line, delimiter) {
    const out = [];
    let cur = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (ch === delimiter && !inQuotes) {
        out.push(cur.trim());
        cur = '';
        continue;
      }

      cur += ch;
    }
    out.push(cur.trim());
    return out;
  }

  function findCol(headers, exactName) {
    return headers.findIndex(h => textCell(h) === exactName);
  }

  function mapEntryAction(dir) {
    const s = textCell(dir);
    if (/買進|買入|buy/i.test(s)) return '新買';
    if (/賣出|賣空|放空|short|sell/i.test(s)) return '新賣';
    return '';
  }

  function mapExitAction(dir, ts, px, baseRows, forceExitTime) {
    const s = textCell(dir);

    const same = (baseRows || []).find(r => r.ts === ts && r.px === px);
    if (same && same.act === '強制平倉') return '強制平倉';

    if (ts && ts.slice(8, 14) === forceExitTime) return '強制平倉';

    if (/賣出|sell/i.test(s)) return '平賣';
    if (/買進|買入|buy/i.test(s)) return '平買';

    return '';
  }

  function dedupeRows(rows) {
    const map = new Map();
    for (const r of rows) {
      const key = `${r.ts}|${r.px}|${r.act}`;
      if (!map.has(key)) map.set(key, r);
    }
    return [...map.values()];
  }

  function convertTradeDetailToIndicatorRows(arr2d, header, baseRows) {
    if (!arr2d || !arr2d.length) return [];

    const headers = (arr2d[0] || []).map(x => textCell(x));
    const idxEntryTime = findCol(headers, '進場時間');
    const idxEntryDir  = findCol(headers, '進場方向');
    const idxEntryPx   = findCol(headers, '進場價格');
    const idxExitTime  = findCol(headers, '出場時間');
    const idxExitDir   = findCol(headers, '出場方向');
    const idxExitPx    = findCol(headers, '出場價格');

    if (
      idxEntryTime < 0 || idxEntryDir < 0 || idxEntryPx < 0 ||
      idxExitTime < 0 || idxExitDir < 0 || idxExitPx < 0
    ) {
      throw new Error('檔案2欄位不符合預期，找不到 進場時間/進場方向/進場價格/出場時間/出場方向/出場價格');
    }

    const forceExitTime = getForceExitTimeFromHeader(header);
    const rows = [];

    for (let i = 1; i < arr2d.length; i++) {
      const row = arr2d[i] || [];

      const inTs = parseAnyTs(row[idxEntryTime]);
      const inPx = normalizePrice(row[idxEntryPx]);
      const inAct = mapEntryAction(row[idxEntryDir]);

      if (inTs && inPx && inAct) {
        rows.push({ ts: inTs, px: inPx, act: inAct });
      }

      const outTs = parseAnyTs(row[idxExitTime]);
      const outPx = normalizePrice(row[idxExitPx]);
      const outAct = mapExitAction(row[idxExitDir], outTs, outPx, baseRows, forceExitTime);

      if (outTs && outPx && outAct) {
        rows.push({ ts: outTs, px: outPx, act: outAct });
      }
    }

    rows.sort((a, b) => {
      if (a.ts !== b.ts) return a.ts.localeCompare(b.ts);
      if (a.px !== b.px) return Number(a.px) - Number(b.px);
      return a.act.localeCompare(b.act);
    });

    return dedupeRows(rows);
  }

  function downloadTextFile(filename, content) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function intersectRange(baseRows, testRows) {
    if (!baseRows.length || !testRows.length) {
      return { baseCut: [], testCut: [], rangeText: '無交集' };
    }

    const baseStart = baseRows[0].ts;
    const baseEnd = baseRows[baseRows.length - 1].ts;
    const testStart = testRows[0].ts;
    const testEnd = testRows[testRows.length - 1].ts;

    const start = baseStart > testStart ? baseStart : testStart;
    const end = baseEnd < testEnd ? baseEnd : testEnd;

    if (start > end) {
      return { baseCut: [], testCut: [], rangeText: '無交集' };
    }

    return {
      baseCut: baseRows.filter(r => r.ts >= start && r.ts <= end),
      testCut: testRows.filter(r => r.ts >= start && r.ts <= end),
      rangeText: `${start} ~ ${end}`
    };
  }

  function compareIndicatorRows(baseRows, testRows) {
    const { baseCut, testCut, rangeText } = intersectRange(baseRows, testRows);
    const maxLen = Math.max(baseCut.length, testCut.length);

    const result = [];
    let sameCount = 0;

    for (let i = 0; i < maxLen; i++) {
      const l = baseCut[i] || null;
      const r = testCut[i] || null;

      const sameTs = !!l && !!r && l.ts === r.ts;
      const samePx = !!l && !!r && l.px === r.px;
      const sameAct = !!l && !!r && l.act === r.act;
      const allSame = sameTs && samePx && sameAct;

      if (allSame) sameCount++;

      result.push({
        leftLine: l ? `${l.ts} ${l.px} ${l.act}` : '',
        rightLine: r ? `${r.ts} ${r.px} ${r.act}` : '',
        sameTs,
        samePx,
        sameAct,
        allSame
      });
    }

    return {
      rangeText,
      baseCut,
      testCut,
      result,
      sameCount,
      sameRate: maxLen ? sameCount / maxLen : 0,
      baseOnly: Math.max(0, baseCut.length - testCut.length),
      testOnly: Math.max(0, testCut.length - baseCut.length)
    };
  }

  function renderCompareTable(compareRows) {
    if (!compareRows.length) {
      els.compareBody.innerHTML = '<tr><td colspan="7" class="neu">沒有可比對資料。</td></tr>';
      return;
    }

    els.compareBody.innerHTML = compareRows.map((r, i) => `
      <tr>
        <td>${i + 1}</td>
        <td class="${r.allSame ? 'ok' : 'bad'}">${r.allSame ? '相符' : '不符'}</td>
        <td>${escapeHtml(r.leftLine || '—')}</td>
        <td>${escapeHtml(r.rightLine || '—')}</td>
        <td class="${r.sameTs ? 'ok' : 'bad'}">${r.sameTs ? '相同' : '不同'}</td>
        <td class="${r.samePx ? 'ok' : 'bad'}">${r.samePx ? '相同' : '不同'}</td>
        <td class="${r.sameAct ? 'ok' : 'bad'}">${r.sameAct ? '相同' : '不同'}</td>
      </tr>
    `).join('');
  }

  function renderSummary(compare) {
    els.summaryBox.textContent =
`重疊區間：${compare.rangeText}
基準筆數：${compare.baseCut.length}
測試筆數：${compare.testCut.length}
完全相符筆數：${compare.sameCount}
完全相符率：${(compare.sameRate * 100).toFixed(2)}%
基準多出筆數：${compare.baseOnly}
測試多出筆數：${compare.testOnly}`;
  }

  async function loadHeaderSource() {
    const file = els.fileHeaderSource.files[0];
    els.nameHeaderSource.textContent = file ? file.name : '尚未載入';

    if (!file) {
      state.headerText = '';
      state.headerSourceRawTxt = '';
      setPreview(els.headerSourcePreview, '');
      return;
    }

    const txt = await readFileSmart(file);
    state.headerSourceRawTxt = txt;
    state.headerText = getHeaderFromTxt(txt);
    setPreview(els.headerSourcePreview, txt);
  }

  async function convertDetail() {
    try {
      const file = els.fileTradeDetail.files[0];
      if (!file) {
        alert('請先載入 檔案2：交易輸出交易明細');
        return;
      }

      const txt = await readFileSmart(file);
      const arr2d = parseTradeDetailText(txt);
      const baseRows = state.headerSourceRawTxt ? parseIndicatorTxt(state.headerSourceRawTxt).rows : [];

      const rows = convertTradeDetailToIndicatorRows(arr2d, state.headerText, baseRows);
      const out = buildIndicatorTxt(state.headerText, rows);

      state.convertedDetailTxt = out;
      setPreview(els.detailPreview, out);

      alert(`檔案2 轉換完成，共 ${rows.length} 筆。`);
    } catch (err) {
      console.error(err);
      alert('檔案2 轉換失敗：' + (err && err.message ? err.message : err));
    }
  }

  function downloadDetail() {
    if (!state.convertedDetailTxt) {
      alert('請先完成 檔案2 轉換。');
      return;
    }
    downloadTextFile('trade-detail-converted.txt', state.convertedDetailTxt);
  }

  async function loadCompareBaseFile() {
    const file = els.fileCompareBase.files[0];
    els.nameCompareBase.textContent = file ? file.name : '尚未載入';
    if (!file) return;

    const txt = await readFileSmart(file);
    state.compareBaseTxt = txt;
    setPreview(els.compareBasePreview, txt);
  }

  async function loadCompareTargetFile() {
    const file = els.fileCompareTarget.files[0];
    els.nameCompareTarget.textContent = file ? file.name : '尚未載入';
    if (!file) return;

    const txt = await readFileSmart(file);
    state.compareTargetTxt = txt;
    setPreview(els.compareTargetPreview, txt);
  }

  function useDetailAsTarget() {
    if (!state.convertedDetailTxt) {
      alert('請先把 檔案2 轉成指標TXT。');
      return;
    }
    state.compareTargetTxt = state.convertedDetailTxt;
    els.nameCompareTarget.textContent = '已使用：檔案2轉出TXT';
    setPreview(els.compareTargetPreview, state.compareTargetTxt);
  }

  function compareNow() {
    try {
      if (!state.compareBaseTxt) {
        alert('請先載入 左欄：基準TXT');
        return;
      }
      if (!state.compareTargetTxt) {
        alert('請先載入或指定 右欄：測試TXT');
        return;
      }

      const left = parseIndicatorTxt(state.compareBaseTxt);
      const right = parseIndicatorTxt(state.compareTargetTxt);

      const compare = compareIndicatorRows(left.rows, right.rows);
      renderSummary(compare);
      renderCompareTable(compare.result);
    } catch (err) {
      console.error(err);
      alert('比對失敗：' + (err && err.message ? err.message : err));
    }
  }

  function clearAll() {
    state.headerText = '';
    state.headerSourceRawTxt = '';
    state.convertedDetailTxt = '';
    state.compareBaseTxt = '';
    state.compareTargetTxt = '';

    els.fileHeaderSource.value = '';
    els.fileTradeDetail.value = '';
    els.fileCompareBase.value = '';
    els.fileCompareTarget.value = '';

    els.nameHeaderSource.textContent = '尚未載入';
    els.nameTradeDetail.textContent = '尚未載入';
    els.nameCompareBase.textContent = '尚未載入';
    els.nameCompareTarget.textContent = '尚未載入';

    setPreview(els.headerSourcePreview, '');
    setPreview(els.detailPreview, '');
    setPreview(els.compareBasePreview, '');
    setPreview(els.compareTargetPreview, '');

    els.summaryBox.textContent = '尚未執行。';
    els.compareBody.innerHTML = '<tr><td colspan="7" class="neu">尚未執行。</td></tr>';
  }

  els.fileHeaderSource.addEventListener('change', loadHeaderSource);

  els.fileTradeDetail.addEventListener('change', (e) => {
    const file = e.target.files[0];
    els.nameTradeDetail.textContent = file ? file.name : '尚未載入';
  });

  els.fileCompareBase.addEventListener('change', loadCompareBaseFile);
  els.fileCompareTarget.addEventListener('change', loadCompareTargetFile);

  els.btnConvertDetail.addEventListener('click', convertDetail);
  els.btnDownloadDetail.addEventListener('click', downloadDetail);
  els.btnUseDetailAsTarget.addEventListener('click', useDetailAsTarget);
  els.btnCompare.addEventListener('click', compareNow);
  els.btnClearAll.addEventListener('click', clearAll);
})();
