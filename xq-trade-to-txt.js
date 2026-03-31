(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const els = {
    fileBaseTxt: $('fileBaseTxt'),
    fileTradeDetail: $('fileTradeDetail'),
    fileTradeAll: $('fileTradeAll'),

    nameBaseTxt: $('nameBaseTxt'),
    nameTradeDetail: $('nameTradeDetail'),
    nameTradeAll: $('nameTradeAll'),

    btnRunDetail: $('btnRunDetail'),
    btnRunAll: $('btnRunAll'),
    btnRunBoth: $('btnRunBoth'),
    btnClearAll: $('btnClearAll'),

    summaryBox: $('summaryBox'),
    basePreview: $('basePreview'),
    convertedPreview: $('convertedPreview'),
    compareBody: $('compareBody')
  };

  const state = {
    baseTextRaw: '',
    baseHeader: '',
    baseRows: [],

    detailFile: null,
    allFile: null
  };

  const CANON_ACTIONS = new Set(['新買', '平賣', '新賣', '平買', '強制平倉']);
  const FORCE_EXIT_TIME_DEFAULT = '131200';

  function normalizeText(s) {
    return String(s || '')
      .replace(/\ufeff/g, '')
      .replace(/\r\n?/g, '\n')
      .replace(/\u3000/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .split('\n')
      .map(x => x.trim())
      .filter(Boolean)
      .join('\n');
  }

  function pad2(n) { return String(n).padStart(2, '0'); }
  function pad6(t) { return String(t || '').replace(/\D/g, '').padStart(6, '0').slice(0, 6); }

  function numFromAny(v) {
    if (v == null) return null;
    const s = String(v).replace(/,/g, '').trim();
    if (!s) return null;
    const x = Number(s);
    return Number.isFinite(x) ? x : null;
  }

  function textCell(v) {
    return String(v == null ? '' : v).trim();
  }

  function parseHeaderForceExit(header) {
    const m = String(header || '').match(/ForceExitTime=(\d{5,6})/i);
    return m ? pad6(m[1]) : FORCE_EXIT_TIME_DEFAULT;
  }

  function parseHeaderLine(txt) {
    const lines = normalizeText(txt).split('\n');
    if (!lines.length) return '';
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(lines[0])) return lines[0];
    return '';
  }

  function parseBaseTxt(txt) {
    const lines = normalizeText(txt).split('\n');
    let header = '';
    let startIdx = 0;

    if (lines.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(lines[0])) {
      header = lines[0];
      startIdx = 1;
    }

    const rows = [];
    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/^(\d{14})\s+(-?\d+(?:\.\d+)?)\s+(新買|平賣|新賣|平買|強制平倉)$/);
      if (!m) continue;
      rows.push({
        ts: m[1],
        px: normalizePriceString(m[2]),
        act: m[3],
        line: `${m[1]} ${normalizePriceString(m[2])} ${m[3]}`
      });
    }
    return { header, rows };
  }

  function normalizePriceString(v) {
    const n = numFromAny(v);
    if (n == null) return '';
    return String(Math.round(n));
  }

  function yyyyMMddhhmmssFromDate(dateObj) {
    return (
      dateObj.getFullYear() +
      pad2(dateObj.getMonth() + 1) +
      pad2(dateObj.getDate()) +
      pad2(dateObj.getHours()) +
      pad2(dateObj.getMinutes()) +
      pad2(dateObj.getSeconds())
    );
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

  function parseAnyTs(value) {
    if (value == null || value === '') return '';
    if (typeof value === 'number' && Number.isFinite(value)) {
      const dt = excelSerialToDate(value);
      return yyyyMMddhhmmssFromDate(dt);
    }

    let s = String(value).trim();
    if (!s) return '';

    let pure = s.replace(/\D/g, '');
    if (pure.length >= 14) return pure.slice(0, 14);

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

  function findColIndex(headers, patterns) {
    const norm = headers.map(h => String(h || '').trim().toLowerCase());
    for (const p of patterns) {
      const idx = norm.findIndex(h => h.includes(p));
      if (idx >= 0) return idx;
    }
    return -1;
  }

  function guessAction(rawAction, rawSide, rawBs, ts, px, baseRows, forceExitTime) {
    const act = textCell(rawAction);
    const side = textCell(rawSide);
    const bs = textCell(rawBs);
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

    const same = baseRows.find(r => r.ts === ts && r.px === px);
    if (same) return same.act;

    if (ts && ts.slice(8, 14) === forceExitTime) return '強制平倉';

    return '';
  }

  function buildTxt(header, rows) {
    const body = rows.map(r => `${r.ts} ${r.px} ${r.act}`).join('\n');
    return header ? (body ? header + '\n' + body : header) : body;
  }

  function sortRows(rows) {
    rows.sort((a, b) => {
      if (a.ts !== b.ts) return a.ts.localeCompare(b.ts);
      if (a.px !== b.px) return Number(a.px) - Number(b.px);
      return a.act.localeCompare(b.act);
    });
    return rows;
  }

  function parseCsvRows(text) {
    const raw = String(text || '').replace(/\ufeff/g, '').replace(/\r\n?/g, '\n');
    const wb = XLSX.read(raw, { type: 'string' });
    const sheetName = wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  }

  function rowsToObjects(arr2d) {
    if (!arr2d || !arr2d.length) return [];
    const headers = arr2d[0].map(x => textCell(x));
    const out = [];
    for (let i = 1; i < arr2d.length; i++) {
      const row = arr2d[i];
      const obj = {};
      headers.forEach((h, idx) => { obj[h || `col${idx}`] = row[idx]; });
      out.push(obj);
    }
    return out;
  }

  function convertTableToCanon(arr2d, baseHeader, baseRows) {
    if (!arr2d || !arr2d.length) return { header: baseHeader || '', rows: [] };

    const headers = (arr2d[0] || []).map(x => textCell(x));
    const forceExitTime = parseHeaderForceExit(baseHeader);

    const idxTs = findColIndex(headers, ['日期時間', '成交時間', '時間', 'datetime', 'date time', 'date']);
    const idxDate = findColIndex(headers, ['日期', 'date']);
    const idxTime = findColIndex(headers, ['時間', 'time']);
    const idxPx = findColIndex(headers, ['成交價格', '價格', 'price', '成交價']);
    const idxAction = findColIndex(headers, ['動作', 'action', '類型', '交易別', '交易類別']);
    const idxSide = findColIndex(headers, ['買賣別', 'side', '方向', 'bs']);
    const idxBuySell = findColIndex(headers, ['買賣', 'buy/sell', '買賣方向']);

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
          if (p) { ts = p; break; }
        }
      }
      if (!ts) continue;

      let px = '';
      if (idxPx >= 0) px = normalizePriceString(row[idxPx]);
      if (!px) {
        for (const cell of row) {
          const n = numFromAny(cell);
          if (n != null && n > 1000) {
            px = normalizePriceString(cell);
            break;
          }
        }
      }
      if (!px) continue;

      const act = guessAction(
        idxAction >= 0 ? row[idxAction] : '',
        idxSide >= 0 ? row[idxSide] : '',
        idxBuySell >= 0 ? row[idxBuySell] : '',
        ts, px, baseRows, forceExitTime
      );

      if (!CANON_ACTIONS.has(act)) continue;

      rows.push({ ts, px, act });
    }

    return {
      header: baseHeader || '',
      rows: sortRows(dedupeRows(rows))
    };
  }

  function dedupeRows(rows) {
    const map = new Map();
    for (const r of rows) {
      const key = `${r.ts}|${r.px}|${r.act}`;
      if (!map.has(key)) map.set(key, r);
    }
    return [...map.values()];
  }

  async function readFileAsText(file) {
    return await file.text();
  }

  async function readFileAsArrayBuffer(file) {
    return await file.arrayBuffer();
  }

  async function loadXlsxRows(file) {
    const buf = await readFileAsArrayBuffer(file);
    const wb = XLSX.read(buf, { type: 'array' });

    let targetName = '';
    const preferred = wb.SheetNames.find(n => /交易分析/i.test(n));
    if (preferred) targetName = preferred;
    else targetName = wb.SheetNames[0];

    const ws = wb.Sheets[targetName];
    return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  }

  function renderCompareTable(compareRows) {
    if (!compareRows.length) {
      els.compareBody.innerHTML = '<tr><td colspan="7" class="neu">沒有可比對資料。</td></tr>';
      return;
    }

    const html = compareRows.map((r, idx) => {
      const cls = r.allSame ? 'ok' : 'bad';
      const txt = r.allSame ? '相符' : '不符';
      return `
        <tr>
          <td>${idx + 1}</td>
          <td class="${cls}">${txt}</td>
          <td>${escapeHtml(r.leftLine || '—')}</td>
          <td>${escapeHtml(r.rightLine || '—')}</td>
          <td class="${r.sameTs ? 'ok' : 'bad'}">${r.sameTs ? '相同' : '不同'}</td>
          <td class="${r.samePx ? 'ok' : 'bad'}">${r.samePx ? '相同' : '不同'}</td>
          <td class="${r.sameAct ? 'ok' : 'bad'}">${r.sameAct ? '相同' : '不同'}</td>
        </tr>
      `;
    }).join('');

    els.compareBody.innerHTML = html;
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function intersectByRange(baseRows, testRows) {
    if (!baseRows.length || !testRows.length) return { baseCut: [], testCut: [], rangeText: '無交集' };

    const baseStart = baseRows[0].ts;
    const baseEnd = baseRows[baseRows.length - 1].ts;
    const testStart = testRows[0].ts;
    const testEnd = testRows[testRows.length - 1].ts;

    const start = baseStart > testStart ? baseStart : testStart;
    const end = baseEnd < testEnd ? baseEnd : testEnd;

    if (start > end) return { baseCut: [], testCut: [], rangeText: '無交集' };

    const baseCut = baseRows.filter(r => r.ts >= start && r.ts <= end);
    const testCut = testRows.filter(r => r.ts >= start && r.ts <= end);

    return {
      baseCut,
      testCut,
      rangeText: `${start} ~ ${end}`
    };
  }

  function compareRows(baseRows, testRows) {
    const { baseCut, testCut, rangeText } = intersectByRange(baseRows, testRows);

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
      sameRate: maxLen ? (sameCount / maxLen) : 0,
      baseOnly: Math.max(0, baseCut.length - testCut.length),
      testOnly: Math.max(0, testCut.length - baseCut.length)
    };
  }

  function renderSummary(title, compare, convertedRows, mode) {
    const text =
`${title}
模式：${mode}
重疊區間：${compare.rangeText}
基準筆數：${compare.baseCut.length}
測試筆數：${compare.testCut.length}
完全相符筆數：${compare.sameCount}
完全相符率：${(compare.sameRate * 100).toFixed(2)}%
基準多出筆數：${compare.baseOnly}
測試多出筆數：${compare.testOnly}
轉換總筆數：${convertedRows.length}`;

    els.summaryBox.textContent = text;
  }

  async function ensureBaseLoaded() {
    const f = els.fileBaseTxt.files[0];
    if (!f) {
      alert('請先載入 檔案1：指標輸出TXT');
      return false;
    }
    const txt = await readFileAsText(f);
    const parsed = parseBaseTxt(txt);

    state.baseTextRaw = txt;
    state.baseHeader = parsed.header;
    state.baseRows = parsed.rows;

    els.basePreview.textContent = buildTxt(parsed.header, parsed.rows);
    return true;
  }

  async function runDetail() {
    if (!(await ensureBaseLoaded())) return;

    const f = els.fileTradeDetail.files[0];
    if (!f) {
      alert('請先載入 檔案2：交易輸出交易明細');
      return;
    }

    let arr2d;
    const name = f.name.toLowerCase();

    if (name.endsWith('.csv') || name.endsWith('.txt')) {
      const txt = await readFileAsText(f);
      arr2d = parseCsvRows(txt);
    } else {
      alert('檔案2 目前請載入 csv 或 txt');
      return;
    }

    const converted = convertTableToCanon(arr2d, state.baseHeader, state.baseRows);
    const convertedText = buildTxt(converted.header, converted.rows);
    els.convertedPreview.textContent = convertedText;

    const compare = compareRows(state.baseRows, converted.rows);
    renderCompareTable(compare.result);
    renderSummary('檔案2 比對摘要', compare, converted.rows, '交易輸出交易明細');
  }

  async function runAll() {
    if (!(await ensureBaseLoaded())) return;

    const f = els.fileTradeAll.files[0];
    if (!f) {
      alert('請先載入 檔案3：交易輸出全部資料');
      return;
    }

    let arr2d;
    const name = f.name.toLowerCase();

    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      arr2d = await loadXlsxRows(f);
    } else if (name.endsWith('.csv') || name.endsWith('.txt')) {
      const txt = await readFileAsText(f);
      arr2d = parseCsvRows(txt);
    } else {
      alert('檔案3 目前支援 xlsx / xls / csv / txt');
      return;
    }

    const converted = convertTableToCanon(arr2d, state.baseHeader, state.baseRows);
    const convertedText = buildTxt(converted.header, converted.rows);
    els.convertedPreview.textContent = convertedText;

    const compare = compareRows(state.baseRows, converted.rows);
    renderCompareTable(compare.result);
    renderSummary('檔案3 比對摘要', compare, converted.rows, '交易輸出全部資料');
  }

  async function runBoth() {
    if (!(await ensureBaseLoaded())) return;

    const parts = [];
    let lastConvertedText = '';
    let lastCompare = null;
    let lastRows = [];

    if (els.fileTradeDetail.files[0]) {
      const f = els.fileTradeDetail.files[0];
      let arr2d;
      const name = f.name.toLowerCase();

      if (name.endsWith('.csv') || name.endsWith('.txt')) {
        const txt = await readFileAsText(f);
        arr2d = parseCsvRows(txt);
        const converted = convertTableToCanon(arr2d, state.baseHeader, state.baseRows);
        const compare = compareRows(state.baseRows, converted.rows);

        parts.push(
`檔案2：交易輸出交易明細
重疊區間：${compare.rangeText}
基準筆數：${compare.baseCut.length}
測試筆數：${compare.testCut.length}
完全相符筆數：${compare.sameCount}
完全相符率：${(compare.sameRate * 100).toFixed(2)}%
基準多出筆數：${compare.baseOnly}
測試多出筆數：${compare.testOnly}
轉換總筆數：${converted.rows.length}`
        );

        lastConvertedText = buildTxt(converted.header, converted.rows);
        lastCompare = compare;
        lastRows = converted.rows;
      }
    }

    if (els.fileTradeAll.files[0]) {
      const f = els.fileTradeAll.files[0];
      let arr2d;
      const name = f.name.toLowerCase();

      if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
        arr2d = await loadXlsxRows(f);
      } else if (name.endsWith('.csv') || name.endsWith('.txt')) {
        const txt = await readFileAsText(f);
        arr2d = parseCsvRows(txt);
      } else {
        alert('檔案3 格式不支援');
        return;
      }

      const converted = convertTableToCanon(arr2d, state.baseHeader, state.baseRows);
      const compare = compareRows(state.baseRows, converted.rows);

      parts.push(
`檔案3：交易輸出全部資料
重疊區間：${compare.rangeText}
基準筆數：${compare.baseCut.length}
測試筆數：${compare.testCut.length}
完全相符筆數：${compare.sameCount}
完全相符率：${(compare.sameRate * 100).toFixed(2)}%
基準多出筆數：${compare.baseOnly}
測試多出筆數：${compare.testOnly}
轉換總筆數：${converted.rows.length}`
      );

      lastConvertedText = buildTxt(converted.header, converted.rows);
      lastCompare = compare;
      lastRows = converted.rows;
    }

    if (!parts.length) {
      alert('請至少載入檔案2或檔案3');
      return;
    }

    els.summaryBox.textContent = parts.join('\n\n----------------------------------------\n\n');
    els.convertedPreview.textContent = lastConvertedText || '';
    renderCompareTable(lastCompare ? lastCompare.result : []);
  }

  function clearAll() {
    state.baseTextRaw = '';
    state.baseHeader = '';
    state.baseRows = [];

    els.fileBaseTxt.value = '';
    els.fileTradeDetail.value = '';
    els.fileTradeAll.value = '';

    els.nameBaseTxt.textContent = '尚未載入';
    els.nameTradeDetail.textContent = '尚未載入';
    els.nameTradeAll.textContent = '尚未載入';

    els.summaryBox.textContent = '尚未執行。';
    els.basePreview.textContent = '';
    els.convertedPreview.textContent = '';
    els.compareBody.innerHTML = '<tr><td colspan="7" class="neu">尚未執行。</td></tr>';
  }

  els.fileBaseTxt.addEventListener('change', async (e) => {
    const f = e.target.files[0];
    els.nameBaseTxt.textContent = f ? f.name : '尚未載入';
    if (!f) return;

    const txt = await readFileAsText(f);
    const parsed = parseBaseTxt(txt);

    state.baseTextRaw = txt;
    state.baseHeader = parsed.header;
    state.baseRows = parsed.rows;

    els.basePreview.textContent = buildTxt(parsed.header, parsed.rows);
  });

  els.fileTradeDetail.addEventListener('change', (e) => {
    const f = e.target.files[0];
    els.nameTradeDetail.textContent = f ? f.name : '尚未載入';
  });

  els.fileTradeAll.addEventListener('change', (e) => {
    const f = e.target.files[0];
    els.nameTradeAll.textContent = f ? f.name : '尚未載入';
  });

  els.btnRunDetail.addEventListener('click', runDetail);
  els.btnRunAll.addEventListener('click', runAll);
  els.btnRunBoth.addEventListener('click', runBoth);
  els.btnClearAll.addEventListener('click', clearAll);
})();
