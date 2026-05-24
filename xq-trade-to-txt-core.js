(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.XQTradeTxtCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_FORCE_EXIT = '131200';
  const ACTIONS = ['新買', '新賣', '平賣', '平買', '強制平倉'];

  function normalizeLineBreaks(s) {
    return String(s || '').replace(/\r\n?/g, '\n');
  }

  function cleanCell(v) {
    return String(v == null ? '' : v).replace(/\ufeff/g, '').trim();
  }

  function cleanHeaderName(v) {
    return cleanCell(v).replace(/\s+/g, '').toLowerCase();
  }

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function pad6(s) {
    return String(s || '').replace(/\D/g, '').padStart(6, '0').slice(0, 6);
  }

  function normalizeTimestampDigits(v) {
    const digits = String(v == null ? '' : v).replace(/\D/g, '');
    if (digits.length >= 14) return digits.slice(0, 14);
    if (digits.length === 12) return digits + '00';
    return '';
  }

  function normalizePrice(v) {
    if (v == null || v === '') return '';
    const n = Number(String(v).replace(/,/g, '').trim());
    if (!Number.isFinite(n)) return '';
    return String(Math.round(n));
  }

  function normalizeAction(raw) {
    const s = cleanCell(raw);
    if (!s) return '';
    if (ACTIONS.includes(s)) return s;
    if (/強制|強平|force/i.test(s)) return '強制平倉';
    if (/新.*買|買進|進場.*買|buy|long/i.test(s)) return '新買';
    if (/新.*賣|賣出|進場.*賣|short/i.test(s)) return '新賣';
    if (/平.*賣|出場.*賣|sell/i.test(s)) return '平賣';
    if (/平.*買|出場.*買|cover/i.test(s)) return '平買';
    return '';
  }

  function parseEventLine(line, lineNo) {
    const text = cleanCell(line);
    if (!text || /^[A-Za-z_][A-Za-z0-9_]*=/.test(text)) return null;

    const m = text.match(/^(\d{12}|\d{14})(?:\.\d{1,6})?\s+(-?\d+(?:\.\d+)?)\s+(.+?)\s*$/);
    if (!m) return null;

    const ts = normalizeTimestampDigits(m[1]);
    const px = normalizePrice(m[2]);
    const act = normalizeAction(m[3]);
    if (!ts || !px || !act) return null;

    return { ts, px, act, sourceLine: text, lineNo: lineNo || 0 };
  }

  function rowLine(row) {
    return row ? `${row.ts} ${row.px} ${row.act}` : '';
  }

  function eventKey(row, mode) {
    if (!row) return '';
    if (mode === 'strict') return `${row.ts}|${row.px}|${row.act}`;
    return `${row.ts}|${row.act}`;
  }

  function sameTimeAction(a, b) {
    return !!a && !!b && a.ts === b.ts && a.act === b.act;
  }

  function sameStrict(a, b) {
    return sameTimeAction(a, b) && a.px === b.px;
  }

  function getHeaderFromTxt(txt) {
    const lines = normalizeLineBreaks(txt).split('\n').map(cleanCell).filter(Boolean);
    if (!lines.length) return '';
    return /^[A-Za-z_][A-Za-z0-9_]*=/.test(lines[0]) ? lines[0] : '';
  }

  function getForceExitTimeFromHeader(header) {
    const m = String(header || '').match(/ForceExitTime=(\d{5,6})/i);
    return m ? pad6(m[1]) : DEFAULT_FORCE_EXIT;
  }

  function parseIndicatorTxt(txt, options) {
    const opts = Object.assign({ ignoreHeader: true }, options || {});
    const lines = normalizeLineBreaks(txt).replace(/\ufeff/g, '').split('\n');
    const rows = [];
    let header = '';
    let skippedHeader = '';
    let skippedLines = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = cleanCell(lines[i]);
      if (!line) continue;

      const parsed = parseEventLine(line, i + 1);
      if (parsed) {
        rows.push(parsed);
        continue;
      }

      if (!header && /^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) {
        header = line;
        skippedHeader = line;
        skippedLines++;
        continue;
      }

      if (opts.ignoreHeader && !skippedHeader && rows.length === 0) {
        skippedHeader = line;
        skippedLines++;
        continue;
      }

      skippedLines++;
    }

    return { header, rows, skippedHeader, skippedLines };
  }

  function parseAnyTs(value, extraTime) {
    const left = cleanCell(value);
    const right = cleanCell(extraTime);
    const s = right ? `${left} ${right}`.trim() : left;
    if (!s) return '';

    const digits = s.replace(/\D/g, '');
    if (digits.length >= 14) return digits.slice(0, 14);
    if (digits.length === 12) return digits + '00';

    const m1 = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
    if (m1) {
      return m1[1] + pad2(m1[2]) + pad2(m1[3]) + pad2(m1[4]) + pad2(m1[5]) + pad2(m1[6] || '00');
    }

    const m2 = s.match(/^(\d{8})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
    if (m2) {
      return m2[1] + pad2(m2[2]) + pad2(m2[3]) + pad2(m2[4] || '00');
    }

    const m3 = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})\s+(\d{3,6})$/);
    if (m3) {
      return m3[1] + pad2(m3[2]) + pad2(m3[3]) + pad6(m3[4]);
    }

    return '';
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
        out.push(cleanCell(cur));
        cur = '';
        continue;
      }
      cur += ch;
    }
    out.push(cleanCell(cur));
    return out;
  }

  function splitRecordLine(line) {
    if (line.includes('\t')) return splitCsvLike(line, '\t');
    if (line.includes(',')) return splitCsvLike(line, ',');
    return line.trim().split(/\s+/).map(cleanCell);
  }

  function parseDelimitedRows(text) {
    return normalizeLineBreaks(text)
      .replace(/\ufeff/g, '')
      .split('\n')
      .map((line, idx) => ({ raw: line, cells: splitRecordLine(line), lineNo: idx + 1 }))
      .filter(r => cleanCell(r.raw) !== '');
  }

  function findIndexBy(headers, predicate) {
    return headers.findIndex(h => predicate(cleanHeaderName(h), cleanCell(h)));
  }

  function hasAny(s, words) {
    return words.some(w => s.includes(w));
  }

  function detectTradeColumns(cells) {
    const entryWords = ['進場', '進倉', 'entry', 'open'];
    const exitWords = ['出場', '出倉', '平倉', '離場', 'exit', 'close'];
    const timeWords = ['時間', '日期', 'date', 'time'];
    const dirWords = ['方向', '買賣', '多空', '動作', '類別', 'side', 'action'];
    const priceWords = ['價格', '價位', '成交價', 'price', '價'];

    const idxEntryTime = findIndexBy(cells, x => hasAny(x, entryWords) && hasAny(x, timeWords));
    const idxExitTime = findIndexBy(cells, x => hasAny(x, exitWords) && hasAny(x, timeWords));
    const idxEntryDir = findIndexBy(cells, x => hasAny(x, entryWords) && hasAny(x, dirWords));
    const idxExitDir = findIndexBy(cells, x => hasAny(x, exitWords) && hasAny(x, dirWords));
    const idxEntryPx = findIndexBy(cells, x => hasAny(x, entryWords) && hasAny(x, priceWords));
    const idxExitPx = findIndexBy(cells, x => hasAny(x, exitWords) && hasAny(x, priceWords));

    if ([idxEntryTime, idxExitTime, idxEntryDir, idxExitDir, idxEntryPx, idxExitPx].every(i => i >= 0)) {
      return { idxEntryTime, idxEntryDir, idxEntryPx, idxExitTime, idxExitDir, idxExitPx };
    }

    const joined = cells.map(cleanHeaderName).join('|');
    const looksLikeHeader = /進場|出場|平倉|entry|exit|price|時間|價格/.test(joined);
    if (looksLikeHeader && cells.length >= 6) {
      return {
        idxEntryTime: 0,
        idxEntryDir: 1,
        idxEntryPx: 2,
        idxExitTime: 3,
        idxExitDir: 4,
        idxExitPx: 5
      };
    }

    return null;
  }

  function inferTradeColumnsFromData(cells) {
    if (!cells || cells.length < 6) return null;
    const tsIndexes = [];
    const pxIndexes = [];
    const actIndexes = [];

    for (let i = 0; i < cells.length; i++) {
      if (parseAnyTs(cells[i])) tsIndexes.push(i);
      if (normalizePrice(cells[i])) pxIndexes.push(i);
      if (/買|賣|buy|sell|short|long/i.test(cleanCell(cells[i]))) actIndexes.push(i);
    }

    if (tsIndexes.length >= 2 && pxIndexes.length >= 2 && actIndexes.length >= 2) {
      return {
        idxEntryTime: tsIndexes[0],
        idxEntryDir: actIndexes[0],
        idxEntryPx: pxIndexes.find(i => i > tsIndexes[0]) ?? pxIndexes[0],
        idxExitTime: tsIndexes[1],
        idxExitDir: actIndexes[1],
        idxExitPx: pxIndexes.find(i => i > tsIndexes[1]) ?? pxIndexes[1]
      };
    }

    return null;
  }

  function mapEntryAction(dir) {
    const s = cleanCell(dir);
    if (/買|buy|long/i.test(s)) return '新買';
    if (/賣|空|sell|short/i.test(s)) return '新賣';
    return '';
  }

  function mapExitAction(dir, ts, px, baseRows, forceExitTime) {
    const s = cleanCell(dir);
    const baseForce = (baseRows || []).find(r => r.ts === ts && r.act === '強制平倉' && (!px || r.px === px));
    if (baseForce || /強制|強平|force/i.test(s) || (ts && ts.slice(8, 14) === forceExitTime)) {
      return '強制平倉';
    }
    if (/賣|sell/i.test(s)) return '平賣';
    if (/買|buy|cover/i.test(s)) return '平買';
    return '';
  }

  function dedupeRows(rows) {
    const seen = new Set();
    const out = [];
    for (const r of rows) {
      const k = eventKey(r, 'strict');
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r);
    }
    return out;
  }

  function sortRows(rows) {
    return rows.slice().sort((a, b) => {
      if (a.ts !== b.ts) return a.ts.localeCompare(b.ts);
      if (a.px !== b.px) return Number(a.px) - Number(b.px);
      return a.act.localeCompare(b.act);
    });
  }

  function buildIndicatorTxt(header, rows) {
    const body = rows.map(rowLine).join('\n');
    return header ? (body ? `${header}\n${body}` : header) : body;
  }

  function convertTradeDetailText(text, options) {
    const opts = Object.assign({ header: '', baseRows: [] }, options || {});
    const records = parseDelimitedRows(text);
    const directEvents = records.map(r => parseEventLine(r.raw, r.lineNo)).filter(Boolean);

    if (directEvents.length && directEvents.length === records.length) {
      const rows = sortRows(dedupeRows(directEvents));
      return {
        rows,
        text: buildIndicatorTxt(opts.header, rows),
        stats: {
          rawLineCount: records.length,
          dataRowCount: records.length,
          convertedRowCount: records.length,
          convertedEventCount: rows.length,
          skippedRowCount: 0,
          skippedDataRowCount: 0,
          firstEvent: rows[0] || null,
          lastEvent: rows[rows.length - 1] || null,
          headerLineNo: 0
        }
      };
    }

    let headerIndex = -1;
    let columns = null;
    for (let i = 0; i < records.length; i++) {
      columns = detectTradeColumns(records[i].cells);
      if (columns) {
        headerIndex = i;
        break;
      }
    }

    let dataStart = 0;
    if (columns) {
      dataStart = headerIndex + 1;
    } else {
      for (let i = 0; i < records.length; i++) {
        columns = inferTradeColumnsFromData(records[i].cells);
        if (columns) {
          dataStart = i;
          break;
        }
      }
    }

    if (!columns) {
      throw new Error('找不到交易明細欄位，請確認檔案包含進場/出場時間、方向、價格。');
    }

    const forceExitTime = getForceExitTimeFromHeader(opts.header);
    const rows = [];
    let convertedRowCount = 0;
    let skippedDataRowCount = 0;

    for (let i = dataStart; i < records.length; i++) {
      const row = records[i].cells || [];
      const before = rows.length;

      const inTs = parseAnyTs(row[columns.idxEntryTime]);
      const inPx = normalizePrice(row[columns.idxEntryPx]);
      const inAct = mapEntryAction(row[columns.idxEntryDir]);
      if (inTs && inPx && inAct) {
        rows.push({ ts: inTs, px: inPx, act: inAct, sourceLine: records[i].raw, lineNo: records[i].lineNo });
      }

      const outTs = parseAnyTs(row[columns.idxExitTime]);
      const outPx = normalizePrice(row[columns.idxExitPx]);
      const outAct = mapExitAction(row[columns.idxExitDir], outTs, outPx, opts.baseRows, forceExitTime);
      if (outTs && outPx && outAct) {
        rows.push({ ts: outTs, px: outPx, act: outAct, sourceLine: records[i].raw, lineNo: records[i].lineNo });
      }

      if (rows.length > before) convertedRowCount++;
      else skippedDataRowCount++;
    }

    const finalRows = sortRows(dedupeRows(rows));
    const skippedRowCount = Math.max(0, records.length - convertedRowCount);
    return {
      rows: finalRows,
      text: buildIndicatorTxt(opts.header, finalRows),
      stats: {
        rawLineCount: records.length,
        dataRowCount: Math.max(0, records.length - dataStart),
        convertedRowCount,
        convertedEventCount: finalRows.length,
        skippedRowCount,
        skippedDataRowCount,
        firstEvent: finalRows[0] || null,
        lastEvent: finalRows[finalRows.length - 1] || null,
        headerLineNo: headerIndex >= 0 ? records[headerIndex].lineNo : 0
      }
    };
  }

  function buildSetDiff(leftRows, rightRows, mode) {
    const rightQueues = new Map();
    for (const r of rightRows) {
      const k = eventKey(r, mode);
      if (!rightQueues.has(k)) rightQueues.set(k, []);
      rightQueues.get(k).push(r);
    }

    const both = [];
    const leftOnly = [];

    for (const l of leftRows) {
      const k = eventKey(l, mode);
      const q = rightQueues.get(k);
      if (q && q.length) {
        both.push({ left: l, right: q.shift() });
      } else {
        leftOnly.push(l);
      }
    }

    const rightOnly = [];
    for (const q of rightQueues.values()) {
      rightOnly.push(...q);
    }

    return { both, leftOnly, rightOnly };
  }

  function classifyPair(left, right) {
    if (left && !right) return 'left-extra';
    if (!left && right) return 'right-extra';
    if (!left && !right) return 'empty';
    if (sameStrict(left, right)) return 'same';
    if (sameTimeAction(left, right)) return 'slippage';
    return 'mismatch';
  }

  function statusText(status) {
    return {
      same: '相同',
      slippage: '滑價差異',
      mismatch: '真正錯誤',
      'left-extra': '左側多一筆',
      'right-extra': '右側多一筆',
      empty: ''
    }[status] || status;
  }

  function effectiveActionForSlippage(action, openSide) {
    if (action !== '強制平倉') return action;
    if (openSide === 'long') return '平賣';
    if (openSide === 'short') return '平買';
    return '';
  }

  function signedSlippage(left, right, effectiveAction) {
    const leftPx = Number(left && left.px);
    const rightPx = Number(right && right.px);
    if (!Number.isFinite(leftPx) || !Number.isFinite(rightPx)) return null;
    const raw = rightPx - leftPx;

    let adjusted = null;
    if (effectiveAction === '新買' || effectiveAction === '平買') adjusted = leftPx - rightPx;
    if (effectiveAction === '新賣' || effectiveAction === '平賣') adjusted = rightPx - leftPx;

    return {
      raw,
      adjusted,
      abs: Math.abs(raw),
      effectiveAction: effectiveAction || ''
    };
  }

  function updateOpenSide(openSide, action) {
    if (action === '新買') return 'long';
    if (action === '新賣') return 'short';
    if (action === '平賣' || action === '平買' || action === '強制平倉') return '';
    return openSide;
  }

  function makeCompareRow(left, right, leftIndex, rightIndex, openSide) {
    const status = classifyPair(left, right);
    const action = left ? left.act : (right ? right.act : '');
    const effectiveAction = effectiveActionForSlippage(action, openSide);
    const slippage = sameTimeAction(left, right) ? signedSlippage(left, right, effectiveAction) : null;

    return {
      left,
      right,
      leftIndex,
      rightIndex,
      leftLine: rowLine(left),
      rightLine: rowLine(right),
      sameTs: !!left && !!right && left.ts === right.ts,
      samePx: !!left && !!right && left.px === right.px,
      sameAct: !!left && !!right && left.act === right.act,
      logicConsistent: sameTimeAction(left, right),
      exact: sameStrict(left, right),
      status,
      statusText: statusText(status),
      slippage
    };
  }

  function compareRowsAtOffset(leftRows, rightRows, leftOffset) {
    const rows = [];
    const leftAvailable = Math.max(0, leftRows.length - leftOffset);
    const len = Math.max(leftAvailable, rightRows.length);
    let openSide = '';

    for (let i = 0; i < len; i++) {
      const li = leftOffset + i;
      const left = li < leftRows.length ? leftRows[li] : null;
      const right = i < rightRows.length ? rightRows[i] : null;
      const row = makeCompareRow(left, right, left ? li + 1 : null, right ? i + 1 : null, openSide);
      rows.push(row);
      const stateAction = left ? left.act : (right ? right.act : '');
      openSide = updateOpenSide(openSide, stateAction);
    }

    return rows;
  }

  function findFirstRightInLeft(leftRows, rightRows) {
    if (!rightRows.length) return { found: false, index: -1, oneBased: 0, row: null };
    const firstKey = eventKey(rightRows[0], 'timeAction');
    const index = leftRows.findIndex(r => eventKey(r, 'timeAction') === firstKey);
    return {
      found: index >= 0,
      index,
      oneBased: index >= 0 ? index + 1 : 0,
      row: index >= 0 ? leftRows[index] : null
    };
  }

  function avg(values) {
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  }

  function stddev(values) {
    if (!values.length) return 0;
    const mean = avg(values);
    const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
    return Math.sqrt(variance);
  }

  function slippageBucket(absValue) {
    if (absValue === 0) return '0';
    if (absValue <= 2) return '1-2';
    if (absValue <= 5) return '3-5';
    if (absValue <= 10) return '6-10';
    return '10+';
  }

  function computeSlippageStats(rows) {
    const records = rows
      .filter(r => r.left && r.right && r.logicConsistent && r.slippage)
      .map((r, idx) => {
        const adjusted = Number.isFinite(r.slippage.adjusted) ? r.slippage.adjusted : r.slippage.raw;
        return {
          index: idx + 1,
          leftIndex: r.leftIndex,
          rightIndex: r.rightIndex,
          raw: r.slippage.raw,
          adjusted,
          abs: Math.abs(adjusted),
          action: r.slippage.effectiveAction || (r.left && r.left.act) || '',
          row: r
        };
      });

    const values = records.map(r => r.adjusted);
    const absValues = records.map(r => Math.abs(r.adjusted));
    const buckets = { '0': 0, '1-2': 0, '3-5': 0, '6-10': 0, '10+': 0 };
    for (const r of records) {
      buckets[slippageBucket(Math.abs(r.adjusted))]++;
    }

    const cumulativeCost = [];
    let runningCost = 0;
    for (const r of records) {
      // Positive adjusted slippage is favorable; cost is the opposite sign.
      runningCost += -r.adjusted;
      cumulativeCost.push(runningCost);
    }

    return {
      records,
      totalComparable: records.length,
      average: avg(values),
      averageAbs: avg(absValues),
      maxPositive: values.length ? Math.max(...values) : 0,
      maxNegative: values.length ? Math.min(...values) : 0,
      stddev: stddev(values),
      positiveCount: values.filter(v => v > 0).length,
      negativeCount: values.filter(v => v < 0).length,
      zeroCount: values.filter(v => v === 0).length,
      buckets,
      cumulativeCost,
      totalCost: runningCost
    };
  }

  function compareTexts(baseText, targetText, options) {
    const opts = Object.assign({
      mode: 'timeAction',
      ignoreHeader: true,
      autoOffset: true,
      slippageMode: true,
      mode1155201: false
    }, options || {});
    const leftParsed = parseIndicatorTxt(baseText, { ignoreHeader: opts.ignoreHeader });
    const rightParsed = parseIndicatorTxt(targetText, { ignoreHeader: opts.ignoreHeader });
    return analyzeRows(leftParsed.rows, rightParsed.rows, opts, leftParsed, rightParsed);
  }

  function analyzeRows(leftRows, rightRows, options, leftParsed, rightParsed) {
    const opts = Object.assign({
      mode: 'timeAction',
      autoOffset: true,
      slippageMode: true,
      mode1155201: false
    }, options || {});

    const mode = opts.mode1155201 ? 'timeAction' : (opts.mode === 'strict' ? 'strict' : 'timeAction');
    const logicSetDiff = buildSetDiff(leftRows, rightRows, 'timeAction');
    const exactSetDiff = buildSetDiff(leftRows, rightRows, 'strict');

    const directRows = compareRowsAtOffset(leftRows, rightRows, 0);
    const pairedDirect = directRows.filter(r => r.left && r.right);
    const directExactCount = pairedDirect.filter(r => r.exact).length;
    const directLogicCount = pairedDirect.filter(r => r.logicConsistent).length;
    const directMisalignedCount = pairedDirect.filter(r => !r.logicConsistent).length;

    const firstRight = findFirstRightInLeft(leftRows, rightRows);
    const leftOffset = opts.autoOffset && firstRight.found ? firstRight.index : 0;
    const alignedRows = compareRowsAtOffset(leftRows, rightRows, leftOffset);
    const alignedPaired = alignedRows.filter(r => r.left && r.right);
    const strategyLogicConsistentCount = alignedPaired.filter(r => r.logicConsistent).length;
    const exactAlignedCount = alignedPaired.filter(r => r.exact).length;
    const slippageDiffCount = alignedPaired.filter(r => r.status === 'slippage').length;
    const realErrorCount = alignedPaired.filter(r => r.status === 'mismatch').length;
    const missingInAlignedCount = alignedRows.filter(r => r.status === 'left-extra' || r.status === 'right-extra').length;
    const missingEventCount = logicSetDiff.leftOnly.length + logicSetDiff.rightOnly.length;
    const missingPrefix = firstRight.found ? firstRight.index : 0;
    const slippageStats = computeSlippageStats(alignedRows);

    let inference = '右邊第一筆不存在於左邊，無法判定是否為前段缺漏造成。';
    if (!rightRows.length) {
      inference = '右邊測試TXT沒有可比對事件。';
    } else if (firstRight.found && firstRight.index > 0 && realErrorCount === 0 && missingInAlignedCount === 0) {
      inference = `測試TXT疑似缺少基準TXT前 ${missingPrefix} 筆，後續可對齊。`;
    } else if (firstRight.found && realErrorCount === 0 && missingInAlignedCount === 0 && slippageDiffCount > 0) {
      inference = '策略邏輯一致，僅有滑價差異。';
    } else if (firstRight.found && realErrorCount === 0 && missingInAlignedCount === 0) {
      inference = '左右事件可從第一筆開始對齊，策略邏輯一致。';
    } else if (firstRight.found) {
      inference = `右邊第一筆存在於左邊第 ${firstRight.oneBased} 筆，但後續仍有 ${realErrorCount} 筆真正錯誤、${missingInAlignedCount} 筆缺少事件。`;
    }

    return {
      mode,
      mode1155201: !!opts.mode1155201,
      slippageMode: !!opts.slippageMode,
      leftParsed: leftParsed || null,
      rightParsed: rightParsed || null,
      leftRows,
      rightRows,
      leftCount: leftRows.length,
      rightCount: rightRows.length,
      setDiff: logicSetDiff,
      exactSetDiff,
      sameEventCount: logicSetDiff.both.length,
      exactEventCount: exactSetDiff.both.length,
      leftOnlyCount: logicSetDiff.leftOnly.length,
      rightOnlyCount: logicSetDiff.rightOnly.length,
      directRows,
      directExactCount,
      directLogicCount,
      directMisalignedCount,
      directExtraCount: Math.abs(leftRows.length - rightRows.length),
      firstRight,
      autoOffsetUsed: !!opts.autoOffset && firstRight.found,
      leftOffset,
      missingPrefix,
      alignedRows,
      strategyLogicConsistentCount,
      exactAlignedCount,
      slippageDiffCount,
      realErrorCount,
      missingInAlignedCount,
      missingEventCount,
      slippageStats,
      inference,
      orderExact:
        leftRows.length === rightRows.length &&
        directRows.length === leftRows.length &&
        directRows.every(r => r.exact)
    };
  }

  return {
    ACTIONS,
    normalizeLineBreaks,
    normalizeTimestampDigits,
    normalizePrice,
    normalizeAction,
    parseEventLine,
    parseIndicatorTxt,
    parseAnyTs,
    getHeaderFromTxt,
    rowLine,
    eventKey,
    buildIndicatorTxt,
    convertTradeDetailText,
    buildSetDiff,
    compareRowsAtOffset,
    findFirstRightInLeft,
    analyzeRows,
    compareTexts,
    statusText,
    sameStrict,
    sameTimeAction,
    signedSlippage,
    computeSlippageStats
  };
});
