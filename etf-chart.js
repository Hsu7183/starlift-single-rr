/* ===========================================================================
 * js/etf-chart.js  (ETF/股票策略圖表模組)
 * 依賴 Chart.js v4.x
 * 提供：
 *   ETFChart.drawEquityCurve(ctx, labels, equity)
 *   ETFChart.drawMaeMfeScatter(ctx, MAEs, MFEs)
 *   ETFChart.drawIsHist(ctx, ISbps)
 *   ETFChart.drawPartRate(ctx, partRates)
 * =========================================================================== */

(function(global){
  'use strict';

  // 通用顏色
  const colorRed = '#d32f2f';
  const colorGreen = '#10b981';
  const colorBlue = '#0d6efd';
  const colorGray = '#999';

  function drawEquityCurve(ctx, labels, equity){
    if(!ctx) return;
    new Chart(ctx,{
      type:'line',
      data:{
        labels: labels,
        datasets:[{
          label:'Equity (每百萬 %)',
          data: equity.map(x=>x*100),
          borderColor: colorRed,
          borderWidth: 2,
          fill:false,
          pointRadius:0
        }]
      },
      options:{
        responsive:true,
        maintainAspectRatio:false,
        plugins:{ legend:{display:false}, title:{display:false} },
        scales:{
          x:{ ticks:{autoSkip:true,maxRotation:0,minRotation:0,color:colorGray} },
          y:{ ticks:{color:colorGray}, grid:{color:'#eee'} }
        }
      }
    });
  }

  function drawMaeMfeScatter(ctx, MAEs, MFEs){
    if(!ctx) return;
    const data = MAEs.map((x,i)=>({x, y: MFEs[i]||0}));
    new Chart(ctx,{
      type:'scatter',
      data:{
        datasets:[{
          label:'MAE/MFE',
          data:data,
          backgroundColor:colorBlue,
          pointRadius:4,
          pointHoverRadius:6
        }]
      },
      options:{
        responsive:true,
        maintainAspectRatio:false,
        plugins:{ legend:{display:false}, tooltip:{enabled:true} },
        scales:{
          x:{ title:{display:true,text:'MAE (%)'}, grid:{color:'#eee'}, ticks:{color:colorGray} },
          y:{ title:{display:true,text:'MFE (%)'}, grid:{color:'#eee'}, ticks:{color:colorGray} }
        }
      }
    });
  }

  function drawIsHist(ctx, arr, bins=20){
    if(!ctx) return;
    if(!arr || arr.length===0){ new Chart(ctx,{type:'bar',data:{labels:[],datasets:[]}}); return; }

    const min=Math.min(...arr), max=Math.max(...arr);
    const w=(max-min)/bins || 1;
    const edges=[...Array(bins+1)].map((_,i)=>min+i*w);
    const counts=Array(bins).fill(0);
    arr.forEach(v=>{
      let k=Math.floor((v-min)/w);
      if(k>=bins) k=bins-1;
      if(k<0) k=0;
      counts[k]++;
    });
    const labels=counts.map((_,i)=>edges[i].toFixed(1));
    new Chart(ctx,{
      type:'bar',
      data:{
        labels:labels,
        datasets:[{
          label:'ISbps 分佈',
          data:counts,
          backgroundColor:colorGreen
        }]
      },
      options:{
        responsive:true,
        maintainAspectRatio:false,
        plugins:{ legend:{display:false} },
        scales:{
          x:{ title:{display:true,text:'ISbps'}, ticks:{color:colorGray}, grid:{color:'#f0f0f0'} },
          y:{ title:{display:true,text:'次數'}, ticks:{color:colorGray}, grid:{color:'#f0f0f0'} }
        }
      }
    });
  }

  function drawPartRate(ctx, arr){
    if(!ctx) return;
    if(!arr || arr.length===0){ new Chart(ctx,{type:'bar',data:{labels:[],datasets:[]}}); return; }

    const sorted=[...arr].sort((a,b)=>a-b);
    const labels = sorted.map((_,i)=> (i+1));
    new Chart(ctx,{
      type:'line',
      data:{
        labels:labels,
        datasets:[{
          label:'Participation Rate',
          data:sorted.map(x=>x*100),
          borderColor:colorBlue,
          borderWidth:2,
          fill:false,
          pointRadius:0
        }]
      },
      options:{
        responsive:true,
        maintainAspectRatio:false,
        plugins:{ legend:{display:false} },
        scales:{
          x:{ title:{display:true,text:'Trade #'}, ticks:{color:colorGray}, grid:{color:'#f5f5f5'} },
          y:{ title:{display:true,text:'參與率 (%)'}, ticks:{color:colorGray}, grid:{color:'#f5f5f5'} }
        }
      }
    });
  }

  global.ETFChart = {
    drawEquityCurve,
    drawMaeMfeScatter,
    drawIsHist,
    drawPartRate
  };

})(window);
