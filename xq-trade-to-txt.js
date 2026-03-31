(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const els = {
    fileHeaderSource: $('fileHeaderSource'),
    fileTradeDetail: $('fileTradeDetail'),
    fileTradeAll: $('fileTradeAll'),

    nameHeaderSource: $('nameHeaderSource'),
    nameTradeDetail: $('nameTradeDetail'),
    nameTradeAll: $('nameTradeAll'),

    btnConvertDetail: $('btnConvertDetail'),
    btnDownloadDetail: $('btnDownloadDetail'),
    btnConvertAll: $('btnConvertAll'),
    btnDownloadAll: $('btnDownloadAll'),

    detailPreview: $('detailPreview'),
    allPreview: $('allPreview'),

    fileCompareBase: $('fileCompareBase'),
    fileCompareTarget: $('fileCompareTarget'),
    nameCompareBase: $('nameCompareBase'),
    nameCompareTarget: $('nameCompareTarget'),

    btnUseDetailAsTarget: $('btnUseDetailAsTarget'),
    btnUseAllAsTarget: $('btnUseAllAsTarget'),
    btnCompare: $('btnCompare'),
    btnClearAll: $('btnClearAll'),

    compareBasePreview: $('compareBasePreview'),
    compareTargetPreview: $('compareTargetPreview'),
    summaryBox: $('summaryBox'),
    compareBody: $('compareBody')
  };

  const state = {
    headerText: '',

    convertedDetailTxt: '',
    convertedAllTxt: '',

    compareBaseTxt: '',
    compareTargetTxt: ''
  };

  const ACTIONS = new Set(['新買', '平賣', '新賣', '平買', '強制平倉']);
  const DEFAULT_FORCE_EXIT = '131200';

  function normalizeText(s) {
    return String(s || '')
      .replace(/\ufeff/g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/\u3000/g, ' ')
      .replace(/[ \t]+/g, ' ');
  }

  function cleanLines(s) {
    return normalizeText(s)
      .split('\n')
      .map(x => x.trim())
      .filter(Boolean);
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function pad6(t) {
    return String(t || '').replace(/\D/g, '').padStart(6, '0').slice(0, 6);
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

  async function readAsText(file) {
    return await file.text();
  }

  async function readAsArrayBuffer(file) {
    return await file.arrayBuffer();
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
      const m = lines[i].match(/^(\d{14})\s+(-?\d+(?:\.\d+)?)\s+(新買|平賣|新賣|平買|強制平倉)$/);
      if (!m) continue;
      rows.push({
        ts: m[1],
        px: normalizePrice(m[2]),
        act: m[3],
        line: `${m[1]} ${normalizePrice(m[2])} ${m[3]}`
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

  function excelSerialToDate(serial) {
    const utcDays = Math.floor(serial - 25569);
    const utcValue = utcDays * 86400;
    const dateInfo = new Date(utcValue * 1000);

    const fractionalDay = serial - Math.floor(serial) + 0.0000001;
    let totalSeconds = Math.floor(86400 * fractionalDay);

    const seconds = totalSeconds % 60;
    totalSeconds -= seconds;
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor(totalSeconds / 60) % 60;

    return new Date(
      dateInfo.getUTCFullYear(),
      dateInfo.getUTCMonth(),
      dateInfo.getUTCDate(),
      hours,
      minutes,
      seconds
    );
  }

  function ymdhmsFromDate(d) {
    return (
      d.getFullYear() +
      pad2(d.getMonth() + 1) +
      pad2(d.getDate()) +
      pad2(d.getHours()) +
      pad2(d.getMinutes()) +
      pad2(d.getSeconds())
    );
  }

  function parseAnyTs(value) {
    if (value == null || value === '') return '';

    if (typeof value === 'number' && Number.isFinite(value)) {
      return ymdhmsFromDate(excelSerialToDate(value));
    }

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

  function arr2dFromCsvText(text) {
    const wb = XLSX.read(text, { type: 'string' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  }

  async function arr2dFromXlsxFile(file) {
    const buf = await readAsArrayBuffer(file);
    const wb = XLSX.read(buf, { type: 'array' });

    let targetName = wb.SheetNames[0];
    const pref = wb.SheetNames.find(n => /交易分析/i.test(n));
    if (pref) targetName = pref;

    const ws = wb.Sheets[targetName];
    return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  }

  function findCol(headers, keywords) {
    const h = headers.map(x => String(x || '').trim().toLowerCase());
    for (const kw of keywords) {
      const idx = h.findIndex(v => v.includes(kw));
      if (idx >= 0) return idx;
    }
    return -1;
  }

  function dedupeRows(rows) {
    const map = new Map();
    for (const r of rows) {
      const key = `${r.ts}|${r.px}|${r.act}`;
      if (!map.has(key)) map.set(key, r);
    }
    return [...map.values()];
  }

  function guessAction(rawAction, rawSide, rawBS, ts, px, baseRows, forceExitTime) {
    const act = textCell(rawAction);
    const side = textCell(rawSide);
    const bs = textCell(rawBS);
    const mix = `${act}|${side}|${bs}`;

    if (/強制平倉|強平/.test(mix)) return '強制平倉';
    if (/新買/.test(mix)) return '新買';
    if (/平賣/.test(mix)) return '平賣';
    if (/新賣/.test(mix)) return '新賣';
    if (/平買/.test(mix)) return '平買';

    if (/買進|買入|buy/i.test(mix)) return '新買';
    if (/賣出|sell/i.test(mix)) return '平賣';
    if (/放空|賣空|short/i.test(mix)) return '新賣';
    if (/回補|補回|cover/i.test(mix)) return '平買';

    const same = (baseRows || []).find(r => r.ts === ts && r.px === px);
    if (same) return same.act;

    if (ts && ts.slice(8, 14) === forceExitTime) return '強制平倉';

    return '';
  }

  function convertArr2dToIndicatorRows(arr2d, header, baseRows) {
    if (!arr2d || !arr2d.length) return [];

    const headers = (arr2d[0] || []).map(x => textCell(x));
    const forceExitTime = getForceExitTimeFromHeader(header);

    const idxTs = findCol(headers, ['日期時間', '成交時間', 'datetime', 'time', '時間']);
    const idxDate = findCol(headers, ['日期', 'date']);
    const idxTime = findCol(headers, ['時間', 'time']);
    const idxPx = findCol(headers, ['成交價格', '成交價', '價格', 'price']);
    const idxAction = findCol(headers, ['動作', 'action', '交易別', '類型']);
    const idxSide = findCol(headers, ['買賣別', '方向', 'side']);
    const idxBS = findCol(headers, ['買賣', 'buy/sell']);

    const rows = [];

    for (let i = 1; i < arr2d.length; i++) {
      const row = arr2d[i] || [];

      let ts = '';
      if (idxTs >= 0) ts = parseAnyTs(row[idxTs]);

      if (!ts && idxDate >= 0 && idxTime >= 0) {
        const d = parseAnyTs(row[idxDate]);
        const t = parseAnyTs(row[idxTime]);
        if (d && t) ts = d.slice(0, 8) + t.slice(8, 14);
      }

      if (!ts) {
        for (const cell of row) {
          const p = parseAnyTs(cell);
          if (p) {
            ts = p;
            break;
          }
        }
      }

      if (!ts) continue;

      let px = '';
      if (idxPx >= 0) px = normalizePrice(row[idxPx]);

      if (!px) {
        for (const cell of row) {
          const n = normalizePrice(cell);
          if (n && Number(n) > 1000) {
            px = n;
            break;
          }
        }
      }

      if (!px) continue;

      const act = guessAction(
        idxAction >= 0 ? row[idxAction] : '',
        idxSide >= 0 ? row[idxSide] : '',
        idxBS >= 0 ? row[idxBS] : '',
        ts, px, baseRows, forceExitTime
      );

      if (!ACTIONS.has(act)) continue;

      rows.push({ ts, px, act });
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

  function setPreview(el, txt) {
    el.textContent = txt || '';
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

  async function convertDetail() {
    try {
      const file = els.fileTradeDetail.files[0];
      if (!file) {
        alert('請先載入 檔案2：交易輸出交易明細');
        return;
      }

      let arr2d = [];
      const txt = await readAsText(file);
      arr2d = arr2dFromCsvText(txt);

      const baseRows = state.headerText ? parseIndicatorTxt(state.headerText).rows : [];
      const rows = convertArr2dToIndicatorRows(arr2d, state.headerText, baseRows);
      const out = buildIndicatorTxt(state.headerText, rows);

      state.convertedDetailTxt = out;
      setPreview(els.detailPreview, out);

      alert(`檔案2 轉換完成，共 ${rows.length} 筆。`);
    } catch (err) {
      console.error(err);
      alert('檔案2 轉換失敗，請打開 F12 Console 看錯誤。');
    }
  }

  async function convertAll() {
    try {
      const file = els.fileTradeAll.files[0];
      if (!file) {
        alert('請先載入 檔案3：交易輸出全部資料');
        return;
      }

      let arr2d = [];
      const lower = file.name.toLowerCase();

      if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
        arr2d = await arr2dFromXlsxFile(file);
      } else {
        const txt = await readAsText(file);
        arr2d = arr2dFromCsvText(txt);
      }

      const baseRows = state.headerText ? parseIndicatorTxt(state.headerText).rows : [];
      const rows = convertArr2dToIndicatorRows(arr2d, state.headerText, baseRows);
      const out = buildIndicatorTxt(state.headerText, rows);

      state.convertedAllTxt = out;
      setPreview(els.allPreview, out);

      alert(`檔案3 轉換完成，共 ${rows.length} 筆。`);
    } catch (err) {
      console.error(err);
      alert('檔案3 轉換失敗，請打開 F12 Console 看錯誤。');
    }
  }

  function downloadDetail() {
    if (!state.convertedDetailTxt) {
      alert('請先完成 檔案2 轉換。');
      return;
    }
    downloadTextFile('trade-detail-converted.txt', state.convertedDetailTxt);
  }

  function downloadAll() {
    if (!state.convertedAllTxt) {
      alert('請先完成 檔案3 轉換。');
      return;
    }
    downloadTextFile('trade-all-converted.txt', state.convertedAllTxt);
  }

  async function loadCompareBaseFile() {
    const file = els.fileCompareBase.files[0];
    if (!file) return;

    const txt = await readAsText(file);
    state.compareBaseTxt = txt;
    els.nameCompareBase.textContent = file.name;
    setPreview(els.compareBasePreview, txt);
  }

  async function loadCompareTargetFile() {
    const file = els.fileCompareTarget.files[0];
    if (!file) return;

    const txt = await readAsText(file);
    state.compareTargetTxt = txt;
    els.nameCompareTarget.textContent = file.name;
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

  function useAllAsTarget() {
    if (!state.convertedAllTxt) {
      alert('請先把 檔案3 轉成指標TXT。');
      return;
    }
    state.compareTargetTxt = state.convertedAllTxt;
    els.nameCompareTarget.textContent = '已使用：檔案3轉出TXT';
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
      alert('比對失敗，請打開 F12 Console 看錯誤。');
    }
  }

  function clearAll() {
    state.headerText = '';
    state.convertedDetailTxt = '';
    state.convertedAllTxt = '';
    state.compareBaseTxt = '';
    state.compareTargetTxt = '';

    els.fileHeaderSource.value = '';
    els.fileTradeDetail.value = '';
    els.fileTradeAll.value = '';
    els.fileCompareBase.value = '';
    els.fileCompareTarget.value = '';

    els.nameHeaderSource.textContent = '尚未載入';
    els.nameTradeDetail.textContent = '尚未載入';
    els.nameTradeAll.textContent = '尚未載入';
    els.nameCompareBase.textContent = '尚未載入';
    els.nameCompareTarget.textContent = '尚未載入';

    setPreview(els.detailPreview, '');
    setPreview(els.allPreview, '');
    setPreview(els.compareBasePreview, '');
    setPreview(els.compareTargetPreview, '');

    els.summaryBox.textContent = '尚未執行。';
    els.compareBody.innerHTML = '<tr><td colspan="7" class="neu">尚未執行。</td></tr>';
  }

  els.fileHeaderSource.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    els.nameHeaderSource.textContent = file ? file.name : '尚未載入';
    if (!file) {
      state.headerText = '';
      return;
    }

    const txt = await readAsText(file);
    state.headerText = getHeaderFromTxt(txt);
  });

  els.fileTradeDetail.addEventListener('change', (e) => {
    const file = e.target.files[0];
    els.nameTradeDetail.textContent = file ? file.name : '尚未載入';
  });

  els.fileTradeAll.addEventListener('change', (e) => {
    const file = e.target.files[0];
    els.nameTradeAll.textContent = file ? file.name : '尚未載入';
  });

  els.fileCompareBase.addEventListener('change', loadCompareBaseFile);
  els.fileCompareTarget.addEventListener('change', loadCompareTargetFile);

  els.btnConvertDetail.addEventListener('click', convertDetail);
  els.btnDownloadDetail.addEventListener('click', downloadDetail);
  els.btnConvertAll.addEventListener('click', convertAll);
  els.btnDownloadAll.addEventListener('click', downloadAll);

  els.btnUseDetailAsTarget.addEventListener('click', useDetailAsTarget);
  els.btnUseAllAsTarget.addEventListener('click', useAllAsTarget);
  els.btnCompare.addEventListener('click', compareNow);
  els.btnClearAll.addEventListener('click', clearAll);
})();
