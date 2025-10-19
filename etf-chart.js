/* ===========================================================================
 * etf-chart.js
 * 繪圖模組：專為 00909-ETF 分頁（etf-00909.html）設計。
 * 使用 Chart.js（需載入 CDN）
 *   <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
 *
 * 提供：
 *   ETFChart.drawEquityCurve(canvas, labels, equity)
 *   ETFChart.drawMaeMfeScatter(canvas, pairs)   // pairs: [{x: maePct, y: mfePct}]
 *   ETFChart.drawIsHist(canvas, isbpsArr, bins)
 * =========================================================================== */

(function (global) {
  'use strict';

  function clearCanvas(canvas) {
    if (!canvas || !canvas.getContext) return;
    const c = canvas.getContext('2d');
    // 使用 canvas 真實寬高，避免在 CSS 縮放時清不乾淨
    c.clearRect(0, 0, canvas.width || canvas.clientWidth, canvas.height || canvas.clientHeight);
  }

  /* === 收益曲線 === */
  function drawEquityCurve(canvas, labels, equity) {
    if (!canvas || !labels?.length || !equity?.length) return;
    clearCanvas(canvas);

    new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: '收益曲線（每百萬 %）',
          // 保持數字，交給軸與 tooltip 格式化
          data: equity.map(x => x * 100),
          borderColor: '#d32f2f',
          borderWidth: 2,
          fill: false,
          pointRadius: 0,
          tension: 0.2
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { ticks: { color: '#555', autoSkip: true, maxTicksLimit: 10 } },
          y: {
            ticks: {
              color: '#555',
              callback: v => v + '%'
            },
            grid: { color: '#eee' }
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: 'index',
            intersect: false,
            callbacks: {
              label: ctx => ` ${Number(ctx.parsed.y).toFixed(2)}%`
            }
          }
        }
      }
    });
  }

  /* === MAE vs MFE 散點圖（吃成對資料） === */
  // pairs: [{ x: maePct, y: mfePct }, ...]
  function drawMaeMfeScatter(canvas, pairs) {
    if (!canvas || !pairs?.length) return;
    clearCanvas(canvas);

    new Chart(canvas, {
      type: 'scatter',
      data: {
        datasets: [{
          label: 'MAE vs MFE (%)',
          data: pairs,
          borderColor: '#1976d2',
          backgroundColor: 'rgba(25,118,210,0.5)',
          pointRadius: 3
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            title: { display: true, text: 'MAE (%)', color: '#555' },
            ticks: { color: '#555' },
            grid: { color: '#eee' }
          },
          y: {
            title: { display: true, text: 'MFE (%)', color: '#555' },
            ticks: { color: '#555' },
            grid: { color: '#eee' }
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => `MAE=${Number(ctx.parsed.x).toFixed(2)}%, MFE=${Number(ctx.parsed.y).toFixed(2)}%`
            }
          }
        }
      }
    });
  }

  /* === ISbps 分佈（直方圖） === */
  function drawIsHist(canvas, arr, bins = 20) {
    if (!canvas || !arr?.length) return;
    clearCanvas(canvas);

    const min = Math.min(...arr), max = Math.max(...arr);
    let range = (max - min);
    // 全等或異常時避免 step=0
    if (!isFinite(range) || range <= 0) { range = 1; }
    const step = range / bins;

    const edges = Array.from({ length: bins + 1 }, (_, i) => min + i * step);
    const counts = new Array(bins).fill(0);
    arr.forEach(v => {
      const idx = Math.min(Math.floor((v - min) / step), bins - 1);
      counts[idx]++;
    });
    const labels = edges.slice(0, -1).map((x, i) =>
      `${x.toFixed(1)}~${(x + step).toFixed(1)}`
    );

    new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'ISbps 分佈',
          data: counts,
          backgroundColor: '#6f42c1'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            ticks: { color: '#555', autoSkip: true, maxRotation: 45, minRotation: 45 },
            grid: { display: false }
          },
          y: {
            ticks: { color: '#555' },
            grid: { color: '#eee' }
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => `Count: ${ctx.parsed.y}`
            }
          }
        }
      }
    });
  }

  /* === 匯出全域 === */
  global.ETFChart = {
    drawEquityCurve,
    drawMaeMfeScatter,
    drawIsHist
  };

})(window);
