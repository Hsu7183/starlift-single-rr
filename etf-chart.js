// etf-chart.js — Chart.js: 權益曲線 / 回撤曲線
(function(root){
  let eqChart, ddChart;
  function makeLine(ctx, labels, values, title){
    if(!ctx) return null;
    if(eqChart && ctx.id==='eqChart'){ eqChart.destroy(); }
    if(ddChart && ctx.id==='ddChart'){ ddChart.destroy(); }
    const chart = new Chart(ctx, {
      type:'line',
      data:{ labels, datasets:[{ label:title, data:values, borderWidth:2, tension:0.2, pointRadius:0 }] },
      options:{
        responsive:true, maintainAspectRatio:false,
        interaction:{ mode:'index', intersect:false },
        plugins:{ legend:{ display:false } },
        scales:{ x:{ ticks:{ maxRotation:0, autoSkip:true, maxTicksLimit:12 }}, y:{ beginAtZero:false } }
      }
    });
    if(ctx.id==='eqChart') eqChart=chart;
    if(ctx.id==='ddChart') ddChart=chart;
    return chart;
  }
  function fmtDate(ms){ return new Date(ms).toISOString().slice(0,10); }
  function renderEquity(canvas, series){ return makeLine(canvas, series.map(p=>fmtDate(p.t)), series.map(p=>p.v), '權益曲線'); }
  function renderDrawdown(canvas, series){ return makeLine(canvas, series.map(p=>fmtDate(p.t)), series.map(p=>p.v), '回撤(比例)'); }
  root.ETF_CHART = { renderEquity, renderDrawdown };
})(window);
