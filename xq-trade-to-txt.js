(function () {
  'use strict';

  const core = window.XQTradeTxtCore;
  if (!core) {
    throw new Error('xq-trade-to-txt-core.js 尚未載入');
  }

  const $ = (id) => document.getElementById(id);

  const els = {
    fileHeaderSource: $('fileHeaderSource'),
    fileTradeDetail: $('fileTradeDetail'),
    filesTradeBatch: $('filesTradeBatch'),
    nameHeaderSource: $('nameHeaderSource'),
    nameTradeDetail: $('nameTradeDetail'),
    namesTradeBatch: $('namesTradeBatch'),
    btnConvertDetail: $('btnConvertDetail'),
    btnDownloadDetail: $('btnDownloadDetail'),
    btnBatchConvert: $('btnBatchConvert'),
    btnBatchDownload: $('btnBatchDownload'),
    headerSourcePreview: $('headerSourcePreview'),
    detailPreview: $('detailPreview'),
    batchSummary: $('batchSummary'),
    fileCompareBase: $('fileCompareBase'),
    fileCompareTarget: $('fileCompareTarget'),
    nameCompareBase: $('nameCompareBase'),
    nameCompareTarget: $('nameCompareTarget'),
    btnUseDetailAsTarget: $('btnUseDetailAsTarget'),
    btnCompare: $('btnCompare'),
    btnClearAll: $('btnClearAll'),
    compareBasePreview: $('compareBasePreview'),
    compareTargetPreview: $('compareTargetPreview'),
    leftOnlyPreview: $('leftOnlyPreview'),
    rightOnlyPreview: $('rightOnlyPreview'),
    summaryBox: $('summaryBox'),
    compareBody: $('compareBody')
  };

  const state = {
    headerText: '',
    headerSourceRawTxt: '',
    convertedDetailTxt: '',
    convertedDetailFilename: '',
    convertedStats: null,
    batchResults: [],
    compareBaseTxt: '',
    compareTargetTxt: ''
  };

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setPreview(el, txt) {
    if (el) el.textContent = txt || '';
  }

  function fmtPoint(v) {
    if (!Number.isFinite(v)) return '--';
    const rounded = Math.round(v * 100) / 100;
    return `${rounded > 0 ? '+' : ''}${rounded.toFixed(Number.isInteger(rounded) ? 0 : 2)} 點`;
  }

  function makeOutputFilename(originalName) {
    const name = String(originalName || 'output');
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return `${name}_toTXT.txt`;
    return `${name.slice(0, dot)}_toTXT.txt`;
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
          best = txt;
          bestScore = score;
        }
      } catch (_) {}
    }

    return best || new TextDecoder('utf-8').decode(buf);
  }

  function scoreDecodedText(txt) {
    const s = String(txt || '');
    let score = 0;
    if (/Script=|CalcBeginTime=|BeginTime=|ForceExitTime=/.test(s)) score += 60;
    if (/新買|新賣|平買|平賣|強制平倉|進場|出場|交易/.test(s)) score += 90;
    if (/[嚙�]/.test(s)) score -= 200;
    score += Math.min((s.match(/[\u4e00-\u9fff]/g) || []).length, 80);
    return score;
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

  function rowLine(row) {
    return core.rowLine(row);
  }

  function selectedCompareOptions() {
    const modeEl = $('compareMode');
    const mode1155201 = $('mode1155201') ? $('mode1155201').checked : false;
    return {
      mode: mode1155201 ? 'timeAction' : (modeEl ? modeEl.value : 'timeAction'),
      ignoreHeader: $('ignoreHeaderFirstLine') ? $('ignoreHeaderFirstLine').checked : true,
      autoOffset: $('autoOffsetAlign') ? $('autoOffsetAlign').checked : true,
      slippageMode: $('slippageAnalysisMode') ? $('slippageAnalysisMode').checked : true,
      mode1155201
    };
  }

  function ensureCompareControls() {
    const host = els.btnCompare && els.btnCompare.closest('.filebox');
    if (!host || $('compareMode')) return;

    const panel = document.createElement('div');
    panel.className = 'compare-options';
    panel.style.cssText = [
      'display:grid',
      'gap:8px',
      'margin:10px 0 4px',
      'font-size:13px',
      'color:#334155'
    ].join(';');
    panel.innerHTML = `
      <label style="display:grid;gap:6px;font-weight:800;">
        比對模式
        <select id="compareMode" style="padding:8px 10px;border:1px solid #cbd5e1;border-radius:10px;">
          <option value="timeAction" selected>忽略價格，只比時間 + 動作</option>
          <option value="strict">嚴格比對：時間 + 價格 + 動作</option>
        </select>
      </label>
      <label style="display:flex;gap:8px;align-items:center;">
        <input id="slippageAnalysisMode" type="checkbox" checked>
        滑價分析模式：時間 + 動作一致即視為交易邏輯一致
      </label>
      <label style="display:flex;gap:8px;align-items:center;">
        <input id="mode1155201" type="checkbox">
        11552-01 模式：回踩 ROD / Open MARKET 停損與回吐，價格差異視為滑價
      </label>
      <label style="display:flex;gap:8px;align-items:center;">
        <input id="ignoreHeaderFirstLine" type="checkbox" checked>
        忽略 header 第一行
      </label>
      <label style="display:flex;gap:8px;align-items:center;">
        <input id="autoOffsetAlign" type="checkbox" checked>
        自動偵測右邊第一筆在左邊的位置並做 offset 對齊
      </label>
    `;
    const actionRow = host.querySelector('.action-row');
    host.insertBefore(panel, actionRow || null);
  }

  function ensureCompareHeaders() {
    const table = els.compareBody && els.compareBody.closest('table');
    if (!table) return;
    const headRow = table.querySelector('thead tr');
    if (!headRow) return;
    headRow.innerHTML = `
      <th style="width:70px">序號</th>
      <th style="width:130px">結果</th>
      <th>左欄：基準TXT</th>
      <th>右欄：測試TXT</th>
      <th style="width:110px">時間</th>
      <th style="width:110px">價格</th>
      <th style="width:110px">動作</th>
      <th style="width:180px">滑價</th>
    `;
  }

  function ensureSlippageCharts() {
    if ($('slippageChartCard')) return;
    const summaryCard = els.summaryBox && els.summaryBox.closest('.card');
    if (!summaryCard || !summaryCard.parentNode) return;

    const card = document.createElement('div');
    card.id = 'slippageChartCard';
    card.className = 'card';
    card.innerHTML = `
      <p class="block-title">滑價圖表</p>
      <div class="grid2">
        <div>
          <p class="hint">滑價分布圖：X 軸為方向修正後的絕對滑價點數區間，Y 軸為次數。</p>
          <canvas id="slippageDistCanvas" width="620" height="260" style="width:100%;height:260px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;"></canvas>
        </div>
        <div>
          <p class="hint">累積滑價曲線：顯示照交易版真實成交後，累積多消耗點數。</p>
          <canvas id="slippageCumCanvas" width="620" height="260" style="width:100%;height:260px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;"></canvas>
        </div>
      </div>
    `;
    summaryCard.parentNode.insertBefore(card, summaryCard.nextSibling);
  }

  function statsSummary(stats, baseFirstRow) {
    if (!stats) return '';
    const first = stats.firstEvent ? rowLine(stats.firstEvent) : '無';
    const last = stats.lastEvent ? rowLine(stats.lastEvent) : '無';
    const warning =
      baseFirstRow && stats.firstEvent && stats.firstEvent.ts > baseFirstRow.ts
        ? '\n警告：測試TXT起始時間晚於基準TXT，可能交易明細匯出區間不完整。'
        : '';

    return [
      '轉檔結果摘要',
      `原始交易明細列數：${stats.rawLineCount}`,
      `成功轉換列數：${stats.convertedRowCount}`,
      `成功轉換事件數：${stats.convertedEventCount}`,
      `跳過列數：${stats.skippedRowCount}`,
      `第一筆轉換事件：${first}`,
      `最後一筆轉換事件：${last}`,
      warning
    ].join('\n');
  }

  function convertTradeText(txt) {
    const baseRows = state.headerSourceRawTxt
      ? core.parseIndicatorTxt(state.headerSourceRawTxt, { ignoreHeader: true }).rows
      : [];
    return core.convertTradeDetailText(txt, {
      header: state.headerText,
      baseRows
    });
  }

  async function convertSingleTradeFile(file) {
    const txt = await readFileSmart(file);
    const result = convertTradeText(txt);
    return {
      filename: makeOutputFilename(file.name),
      text: result.text,
      rowsCount: result.rows.length,
      stats: result.stats
    };
  }

  function renderSummary(result) {
    const modeLabel = result.mode1155201
      ? '11552-01 模式（時間 + 動作一致即策略邏輯一致）'
      : (result.mode === 'strict' ? '嚴格比對：時間 + 價格 + 動作' : '忽略價格：只比時間 + 動作');
    const firstText = result.firstRight.found
      ? `是，在左邊第 ${result.firstRight.oneBased} 筆`
      : '否';
    const offsetText = result.autoOffsetUsed
      ? `已啟用，逐筆表從左邊第 ${result.leftOffset + 1} 筆 vs 右邊第 1 筆開始`
      : '未啟用或找不到可對齊起點';
    const s = result.slippageStats;

    els.summaryBox.textContent = [
      '比對結果摘要',
      `比對模式：${modeLabel}`,
      '',
      '【策略邏輯摘要】',
      `策略邏輯一致：${result.strategyLogicConsistentCount}`,
      `滑價差異：${result.slippageDiffCount}`,
      `真正錯誤：${result.realErrorCount}`,
      `缺少事件：${result.missingEventCount}`,
      '',
      '【完全相同筆數與順序比對】',
      `結果：${result.orderExact ? '完全相同' : '不完全相同'}`,
      `逐筆完全相同數：${result.directExactCount}`,
      `逐筆時間/動作一致數：${result.directLogicCount}`,
      `逐筆錯位數：${result.directMisalignedCount}`,
      `逐筆長度差異：${result.directExtraCount}`,
      '',
      '【集合比對】',
      `左邊總筆數：${result.leftCount}`,
      `右邊總筆數：${result.rightCount}`,
      `相同事件數（時間+動作）：${result.sameEventCount}`,
      `完全相同事件數（時間+價格+動作）：${result.exactEventCount}`,
      `左有右無事件數：${result.leftOnlyCount}`,
      `右有左無事件數：${result.rightOnlyCount}`,
      '',
      '【重新對齊比對】',
      `右邊第一筆是否存在於左邊：${firstText}`,
      result.firstRight.found ? `右邊第一筆：${rowLine(result.rightRows[0])}` : '',
      result.firstRight.found ? `左邊對應筆：${rowLine(result.firstRight.row)}` : '',
      `offset 對齊：${offsetText}`,
      result.firstRight.found && result.missingPrefix > 0 ? `右邊疑似缺少左邊前 ${result.missingPrefix} 筆` : '',
      '',
      '【滑價統計】',
      `總可比較筆數：${s.totalComparable}`,
      `平均真實滑價：${fmtPoint(s.average)}`,
      `平均絕對滑價：${fmtPoint(s.averageAbs)}`,
      `最大正滑價：${fmtPoint(s.maxPositive)}`,
      `最大負滑價：${fmtPoint(s.maxNegative)}`,
      `滑價標準差：${fmtPoint(s.stddev)}`,
      `正滑價次數：${s.positiveCount}`,
      `負滑價次數：${s.negativeCount}`,
      `零滑價次數：${s.zeroCount}`,
      `累積多消耗點數：${fmtPoint(s.totalCost)}`,
      '',
      '【滑價分類統計】',
      `0 點：${s.buckets['0']} 次`,
      `1~2 點：${s.buckets['1-2']} 次`,
      `3~5 點：${s.buckets['3-5']} 次`,
      `6~10 點：${s.buckets['6-10']} 次`,
      `10 點以上：${s.buckets['10+']} 次`,
      '',
      '方向修正：新買/平買價格較低為正滑價；新賣/平賣價格較高為正滑價。強制平倉會依前一個持倉方向推定。',
      `推論結果：${result.inference}`
    ].filter(line => line !== '').join('\n');
  }

  function loadDiffPreviews(result) {
    setPreview(
      els.leftOnlyPreview,
      result.setDiff.leftOnly.length
        ? result.setDiff.leftOnly.map(rowLine).join('\n')
        : '無'
    );
    setPreview(
      els.rightOnlyPreview,
      result.setDiff.rightOnly.length
        ? result.setDiff.rightOnly.map(rowLine).join('\n')
        : '無'
    );
  }

  function rowClass(status) {
    if (status === 'same') return 'ok';
    if (status === 'slippage' || status === 'left-extra' || status === 'right-extra') return 'warn';
    return 'bad';
  }

  function boolCell(ok, hasBoth, warnWhenFalse) {
    if (!hasBoth) return '<span class="neu">--</span>';
    if (ok) return '<span class="ok">相同</span>';
    return warnWhenFalse ? '<span class="warn">滑價</span>' : '<span class="bad">不同</span>';
  }

  function slippageText(row) {
    if (!row || !row.slippage) return '--';
    const raw = row.slippage.raw;
    const adjusted = row.slippage.adjusted;
    if (Number.isFinite(adjusted)) {
      return `真實 ${fmtPoint(adjusted)}（原始 ${fmtPoint(raw)}）`;
    }
    return `原始 ${fmtPoint(raw)}`;
  }

  function renderCompareTable(rows) {
    if (!rows.length) {
      els.compareBody.innerHTML = '<tr><td colspan="8" class="neu">沒有可比對資料。</td></tr>';
      return;
    }

    els.compareBody.innerHTML = rows.map((r, idx) => {
      const hasBoth = !!r.left && !!r.right;
      const leftPrefix = r.leftIndex ? `#${r.leftIndex} ` : '';
      const rightPrefix = r.rightIndex ? `#${r.rightIndex} ` : '';
      const priceWarn = r.status === 'slippage';
      return `
        <tr>
          <td>${idx + 1}</td>
          <td class="${rowClass(r.status)}">${escapeHtml(r.statusText)}</td>
          <td>${escapeHtml(leftPrefix + (r.leftLine || '--'))}</td>
          <td>${escapeHtml(rightPrefix + (r.rightLine || '--'))}</td>
          <td>${boolCell(r.sameTs, hasBoth, false)}</td>
          <td>${boolCell(r.samePx, hasBoth, priceWarn)}</td>
          <td>${boolCell(r.sameAct, hasBoth, false)}</td>
          <td class="${priceWarn ? 'warn' : (r.status === 'same' ? 'ok' : 'neu')}">${escapeHtml(slippageText(r))}</td>
        </tr>
      `;
    }).join('');
  }

  function drawNoData(canvas, label) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#64748b';
    ctx.font = '14px Arial';
    ctx.fillText(label || '無滑價資料', 24, 40);
  }

  function drawSlippageCharts(result) {
    ensureSlippageCharts();
    const distCanvas = $('slippageDistCanvas');
    const cumCanvas = $('slippageCumCanvas');
    const stats = result && result.slippageStats;
    if (!stats || !stats.totalComparable) {
      drawNoData(distCanvas, '無滑價分布資料');
      drawNoData(cumCanvas, '無累積滑價資料');
      return;
    }

    drawDistribution(distCanvas, stats.buckets);
    drawCumulative(cumCanvas, stats.cumulativeCost);
  }

  function drawDistribution(canvas, buckets) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const labels = ['0', '1-2', '3-5', '6-10', '10+'];
    const values = labels.map(k => buckets[k] || 0);
    const max = Math.max(...values, 1);
    const w = canvas.width;
    const h = canvas.height;
    const pad = 36;
    const chartW = w - pad * 2;
    const chartH = h - pad * 2;
    const barW = chartW / labels.length * 0.62;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0f172a';
    ctx.font = '14px Arial';
    ctx.fillText('滑價分布圖', pad, 22);
    ctx.strokeStyle = '#cbd5e1';
    ctx.beginPath();
    ctx.moveTo(pad, pad);
    ctx.lineTo(pad, h - pad);
    ctx.lineTo(w - pad, h - pad);
    ctx.stroke();

    labels.forEach((label, i) => {
      const x = pad + (chartW / labels.length) * i + (chartW / labels.length - barW) / 2;
      const barH = values[i] / max * chartH;
      const y = h - pad - barH;
      ctx.fillStyle = '#f59e0b';
      ctx.fillRect(x, y, barW, barH);
      ctx.fillStyle = '#334155';
      ctx.font = '12px Arial';
      ctx.fillText(label, x + 4, h - 12);
      ctx.fillText(String(values[i]), x + 4, Math.max(y - 6, 34));
    });
  }

  function drawCumulative(canvas, values) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const pad = 36;
    const chartW = w - pad * 2;
    const chartH = h - pad * 2;
    const min = Math.min(...values, 0);
    const max = Math.max(...values, 0);
    const span = Math.max(max - min, 1);

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0f172a';
    ctx.font = '14px Arial';
    ctx.fillText('累積滑價曲線（多消耗點數）', pad, 22);
    ctx.strokeStyle = '#cbd5e1';
    ctx.beginPath();
    ctx.moveTo(pad, pad);
    ctx.lineTo(pad, h - pad);
    ctx.lineTo(w - pad, h - pad);
    ctx.stroke();

    const zeroY = h - pad - ((0 - min) / span) * chartH;
    ctx.strokeStyle = '#e2e8f0';
    ctx.beginPath();
    ctx.moveTo(pad, zeroY);
    ctx.lineTo(w - pad, zeroY);
    ctx.stroke();

    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 2;
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = pad + (values.length <= 1 ? 0 : (i / (values.length - 1)) * chartW);
      const y = h - pad - ((v - min) / span) * chartH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = '#334155';
    ctx.font = '12px Arial';
    ctx.fillText(`最終：${fmtPoint(values[values.length - 1] || 0)}`, pad, h - 12);
  }

  async function loadHeaderSource() {
    const file = els.fileHeaderSource.files[0];
    els.nameHeaderSource.textContent = file ? file.name : '未選擇檔案';
    if (!file) {
      state.headerText = '';
      state.headerSourceRawTxt = '';
      setPreview(els.headerSourcePreview, '');
      return;
    }

    const txt = await readFileSmart(file);
    state.headerSourceRawTxt = txt;
    state.headerText = core.getHeaderFromTxt(txt);
    setPreview(els.headerSourcePreview, txt);
  }

  async function convertDetail() {
    try {
      const file = els.fileTradeDetail.files[0];
      if (!file) {
        alert('請先選擇檔案2：交易明細。');
        return;
      }

      const result = await convertSingleTradeFile(file);
      state.convertedDetailTxt = result.text;
      state.convertedDetailFilename = result.filename;
      state.convertedStats = result.stats;

      const baseRows = state.headerSourceRawTxt
        ? core.parseIndicatorTxt(state.headerSourceRawTxt, { ignoreHeader: true }).rows
        : [];
      const summary = statsSummary(result.stats, baseRows[0]);
      setPreview(els.detailPreview, `${summary}\n\n${result.text}`);
      alert(`檔案2 轉換完成，共 ${result.rowsCount} 筆事件。\n輸出檔名：${result.filename}`);
    } catch (err) {
      console.error(err);
      alert('檔案2 轉換失敗：' + (err && err.message ? err.message : err));
    }
  }

  function downloadDetail() {
    if (!state.convertedDetailTxt) {
      alert('請先完成檔案2轉換。');
      return;
    }
    downloadTextFile(state.convertedDetailFilename || 'trade_toTXT.txt', state.convertedDetailTxt);
  }

  async function batchConvert() {
    try {
      const files = Array.from(els.filesTradeBatch.files || []);
      if (!files.length) {
        alert('請先選擇批量檔案。');
        return;
      }

      state.batchResults = [];
      const lines = [];

      for (const f of files) {
        try {
          const result = await convertSingleTradeFile(f);
          state.batchResults.push({
            originalName: f.name,
            outputName: result.filename,
            text: result.text,
            rowsCount: result.rowsCount,
            stats: result.stats,
            ok: true
          });
          lines.push(`成功：${f.name} -> ${result.filename}，事件 ${result.rowsCount}，原始列 ${result.stats.rawLineCount}，跳過 ${result.stats.skippedRowCount}`);
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          state.batchResults.push({ originalName: f.name, outputName: '', text: '', rowsCount: 0, ok: false, error: msg });
          lines.push(`失敗：${f.name} -> ${msg}`);
        }
      }

      els.batchSummary.textContent = lines.join('\n');
      alert(`批量轉換完成。\n成功 ${state.batchResults.filter(x => x.ok).length} 個，失敗 ${state.batchResults.filter(x => !x.ok).length} 個。`);
    } catch (err) {
      console.error(err);
      alert('批量轉換失敗：' + (err && err.message ? err.message : err));
    }
  }

  async function batchDownload() {
    const okList = state.batchResults.filter(x => x.ok);
    if (!okList.length) {
      alert('請先完成批量轉換。');
      return;
    }
    for (const item of okList) {
      downloadTextFile(item.outputName, item.text);
      await new Promise(resolve => setTimeout(resolve, 180));
    }
  }

  async function loadCompareBaseFile() {
    const file = els.fileCompareBase.files[0];
    els.nameCompareBase.textContent = file ? file.name : '未選擇檔案';
    if (!file) return;
    const txt = await readFileSmart(file);
    state.compareBaseTxt = txt;
    setPreview(els.compareBasePreview, txt);
  }

  async function loadCompareTargetFile() {
    const file = els.fileCompareTarget.files[0];
    els.nameCompareTarget.textContent = file ? file.name : '未選擇檔案';
    if (!file) return;
    const txt = await readFileSmart(file);
    state.compareTargetTxt = txt;
    setPreview(els.compareTargetPreview, txt);
  }

  function useDetailAsTarget() {
    if (!state.convertedDetailTxt) {
      alert('請先把單檔檔案2轉成指標TXT。');
      return;
    }
    state.compareTargetTxt = state.convertedDetailTxt;
    els.nameCompareTarget.textContent = '已使用：單檔檔案2轉出TXT';
    setPreview(els.compareTargetPreview, state.compareTargetTxt);
  }

  function compareNow() {
    try {
      if (!state.compareBaseTxt) {
        alert('請先載入左欄：基準TXT');
        return;
      }
      if (!state.compareTargetTxt) {
        alert('請先載入或指定右欄：測試TXT');
        return;
      }

      const options = selectedCompareOptions();
      const result = core.compareTexts(state.compareBaseTxt, state.compareTargetTxt, options);

      renderSummary(result);
      loadDiffPreviews(result);
      renderCompareTable(result.alignedRows);
      drawSlippageCharts(result);
    } catch (err) {
      console.error(err);
      alert('比對失敗：' + (err && err.message ? err.message : err));
    }
  }

  function clearAll() {
    state.headerText = '';
    state.headerSourceRawTxt = '';
    state.convertedDetailTxt = '';
    state.convertedDetailFilename = '';
    state.convertedStats = null;
    state.batchResults = [];
    state.compareBaseTxt = '';
    state.compareTargetTxt = '';

    els.fileHeaderSource.value = '';
    els.fileTradeDetail.value = '';
    els.filesTradeBatch.value = '';
    els.fileCompareBase.value = '';
    els.fileCompareTarget.value = '';

    els.nameHeaderSource.textContent = '未選擇檔案';
    els.nameTradeDetail.textContent = '未選擇檔案';
    els.namesTradeBatch.textContent = '未選擇檔案';
    els.nameCompareBase.textContent = '未選擇檔案';
    els.nameCompareTarget.textContent = '未選擇檔案';

    setPreview(els.headerSourcePreview, '');
    setPreview(els.detailPreview, '');
    setPreview(els.compareBasePreview, '');
    setPreview(els.compareTargetPreview, '');
    setPreview(els.leftOnlyPreview, '');
    setPreview(els.rightOnlyPreview, '');
    els.batchSummary.textContent = '';
    els.summaryBox.textContent = '尚未執行。';
    els.compareBody.innerHTML = '<tr><td colspan="8" class="neu">尚未執行。</td></tr>';
    drawSlippageCharts(null);
  }

  ensureCompareControls();
  ensureCompareHeaders();
  ensureSlippageCharts();

  els.fileHeaderSource.addEventListener('change', loadHeaderSource);
  els.fileTradeDetail.addEventListener('change', (e) => {
    const file = e.target.files[0];
    els.nameTradeDetail.textContent = file ? file.name : '未選擇檔案';
  });
  els.filesTradeBatch.addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    els.namesTradeBatch.textContent = files.length ? files.map(f => f.name).join('\n') : '未選擇檔案';
  });
  els.fileCompareBase.addEventListener('change', loadCompareBaseFile);
  els.fileCompareTarget.addEventListener('change', loadCompareTargetFile);
  els.btnConvertDetail.addEventListener('click', convertDetail);
  els.btnDownloadDetail.addEventListener('click', downloadDetail);
  els.btnBatchConvert.addEventListener('click', batchConvert);
  els.btnBatchDownload.addEventListener('click', batchDownload);
  els.btnUseDetailAsTarget.addEventListener('click', useDetailAsTarget);
  els.btnCompare.addEventListener('click', compareNow);
  els.btnClearAll.addEventListener('click', clearAll);
})();
