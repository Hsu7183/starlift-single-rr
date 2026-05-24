const assert = require('assert');
const core = require('../xq-trade-to-txt-core.js');

function tsAt(index) {
  const d = new Date(Date.UTC(2024, 5, 3, 9, 0 + index, 0));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${day}${hh}${mm}${ss}`;
}

function makeRows(count) {
  const acts = ['新買', '平賣', '新賣', '平買'];
  return Array.from({ length: count }, (_, i) => ({
    ts: tsAt(i),
    px: String(22000 + i),
    act: acts[i % acts.length]
  }));
}

function toText(rows) {
  return rows.map(core.rowLine).join('\n');
}

{
  const left = makeRows(540);
  const right = left.slice(132);
  const result = core.compareTexts(toText(left), toText(right), {
    mode: 'timeAction',
    ignoreHeader: true,
    autoOffset: true
  });

  assert.strictEqual(result.leftCount, 540);
  assert.strictEqual(result.rightCount, 408);
  assert.strictEqual(result.sameEventCount, 408);
  assert.strictEqual(result.leftOnlyCount, 132);
  assert.strictEqual(result.rightOnlyCount, 0);
  assert.strictEqual(result.firstRight.found, true);
  assert.strictEqual(result.firstRight.oneBased, 133);
  assert.strictEqual(result.missingPrefix, 132);
  assert.strictEqual(result.strategyLogicConsistentCount, 408);
  assert.strictEqual(result.realErrorCount, 0);
  assert.match(result.inference, /缺少基準TXT前 132 筆/);
}

{
  const left = makeRows(618);
  const prefix = makeRows(242).map((r, i) => ({
    ts: tsAt(i - 1000),
    px: String(18000 + i),
    act: r.act
  }));
  const right = prefix.concat(left);
  const result = core.compareTexts(toText(left), toText(right), {
    mode: 'timeAction',
    ignoreHeader: true,
    autoOffset: true
  });

  assert.strictEqual(result.leftCount, 618);
  assert.strictEqual(result.rightCount, 860);
  assert.strictEqual(result.sameEventCount, 618);
  assert.strictEqual(result.rightOnlyCount, 242);
  assert.strictEqual(result.firstRight.found, false);
  assert.strictEqual(result.firstLeft.found, true);
  assert.strictEqual(result.firstLeft.oneBased, 243);
  assert.strictEqual(result.rightOffset, 242);
  assert.strictEqual(result.strategyLogicConsistentCount, 618);
  assert.strictEqual(result.realErrorCount, 0);
  assert.strictEqual(result.alignmentType, 'left-first-in-right');
}

// Case A: time/action equal, price different -> slippage, not real error.
{
  const left = '20240605102100 21484 新買';
  const right = '20240605102100 21480 新買';

  const result = core.compareTexts(left, right, {
    mode: 'timeAction',
    ignoreHeader: true,
    autoOffset: true
  });

  assert.strictEqual(result.strategyLogicConsistentCount, 1);
  assert.strictEqual(result.slippageDiffCount, 1);
  assert.strictEqual(result.realErrorCount, 0);
  assert.strictEqual(result.alignedRows[0].status, 'slippage');
  assert.strictEqual(result.alignedRows[0].slippage.raw, -4);
  assert.strictEqual(result.alignedRows[0].slippage.adjusted, 4);
}

// Case B: time different -> real error.
{
  const left = '20240605102100 21484 新買';
  const right = '20240605102200 21484 新買';
  const result = core.compareTexts(left, right, { autoOffset: true });

  assert.strictEqual(result.strategyLogicConsistentCount, 0);
  assert.strictEqual(result.realErrorCount, 1);
  assert.strictEqual(result.alignedRows[0].status, 'mismatch');
}

// Case C: action different -> real error.
{
  const left = '20240605102100 21484 新買';
  const right = '20240605102100 21484 新賣';
  const result = core.compareTexts(left, right, { autoOffset: true });

  assert.strictEqual(result.strategyLogicConsistentCount, 0);
  assert.strictEqual(result.realErrorCount, 1);
  assert.strictEqual(result.alignedRows[0].status, 'mismatch');
}

// Case D: right side missing event -> missing event.
{
  const left = [
    '20240605102100 21484 新買',
    '20240605103000 21520 平賣'
  ].join('\n');
  const right = '20240605102100 21484 新買';
  const result = core.compareTexts(left, right, { autoOffset: true });

  assert.strictEqual(result.strategyLogicConsistentCount, 1);
  assert.strictEqual(result.realErrorCount, 0);
  assert.strictEqual(result.missingEventCount, 1);
  assert.strictEqual(result.alignedRows[1].status, 'left-extra');
}

{
  const csv = [
    '進場時間,進場方向,進場價格,出場時間,出場方向,出場價格',
    '2024/06/25 09:49:00,賣出,22646,2024/06/25 10:10:00,買進,22590'
  ].join('\n');
  const converted = core.convertTradeDetailText(csv, { header: '', baseRows: [] });

  assert.strictEqual(converted.stats.rawLineCount, 2);
  assert.strictEqual(converted.stats.convertedRowCount, 1);
  assert.strictEqual(converted.stats.skippedRowCount, 1);
  assert.strictEqual(converted.stats.convertedEventCount, 2);
  assert.strictEqual(core.rowLine(converted.rows[0]), '20240625094900 22646 新賣');
  assert.strictEqual(core.rowLine(converted.rows[1]), '20240625101000 22590 平買');
}

console.log('xq-trade-to-txt-core tests passed');
