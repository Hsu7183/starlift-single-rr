/* ===========================================================================
 * js/etf-chart.js
 * 繪圖模組：專為 00909-ETF 分頁（etf-00909.html）設計。
 * 使用 Chart.js（需載入 CDN）
 *   <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
 *
 * 提供：
 *   ETFChart.drawEquityCurve(ctx, labels, equity)
 *   ETFChart.drawMaeMfeScatter(ctx, maeArr, mfeArr)
 *   ETFChart.drawIsHist(ctx, isbpsArr, bins)
 * =========================================================================== */

(function (global) {
  'use strict';

  function clearCanvas(ctx) {
    if (!ctx || !ctx.getContext) return;
    const c = ctx.getContext('2d');
    c.clearRect(0, 0, ctx.width, ctx.height);
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
          data: equity.map(x => (x * 100).toFixed(2)),
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
              label: ctx => ` ${ctx.parsed.y}%`
            }
          }
        }
      }
    });
  }

  /* === MAE vs MFE 散點圖 === */
  function drawMaeMfeScatter(canvas, MAEs, MFEs) {
    if (!canvas || !MAEs?.length || !MFEs?.length) return;
    clearCanvas(canvas);

    const points = MAEs.map((mae, i) => ({ x: mae, y: MFEs[i] }));
    new Chart(canvas, {
      type: 'scatter',
      data: {
        datasets: [{
          label: 'MAE vs MFE (%)',
          data: points,
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
              label: ctx => `MAE=${ctx.parsed.x.toFixed(2)}%, MFE=${ctx.parsed.y.toFixed(2)}%`
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
    const step = (max - min) / bins;
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
