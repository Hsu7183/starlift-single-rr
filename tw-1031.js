// tw-1031.js — 台股 1031（直接讀上傳區 /reports）
// 顯示：每週盈虧圖 + 交易明細；不含 KPI；只做多（買進/加碼/再加碼 -> 新買；賣出 -> 平賣）
(function(){
  // ===== DOM/小工具 =====
  var $ = function(s){ return document.querySelector(s); };
  var statusEl = $('#autostatus');
  function setStatus(msg, bad){
    if(!statusEl) return;
    statusEl.textContent = msg;
    statusEl.style.background = bad ? '#fee2e2' : '#eef4ff';
    statusEl.style.color = bad ? '#b91c1c' : '#0d6efd';
  }
  function fmtInt(n){ return Math.round(n || 0).toLocaleString(); }
  function tsPretty(ts14){
    return ts14.slice(0,4) + '/' + ts14.slice(4,6) + '/' + ts14.slice(6,8) + ' ' +
           ts14.slice(8,10) + ':' + ts14.slice(10,12);
  }

  // ===== Supabase（優先用上傳頁掛的全域變數） =====
  var SUPABASE_URL = (typeof window.SUPABASE_URL === 'string' && window.SUPABASE_URL) ?
                      window.SUPABASE_URL : 'https://byhbmmnacezzgkwfkozs.supabase.co';
  var SUPABASE_KEY = (typeof window.SUPABASE_ANON_KEY === 'string' && window.SUPABASE_ANON_KEY) ?
                      window.SUPABASE_ANON_KEY :
                      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ5aGJtbW5hY2V6emdrd2Zrb3pzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1OTE0NzksImV4cCI6MjA3NDE2NzQ3OX0.VCSye3-fKrQphejdJSWAM6iRzv_7gkl8MLe7NeVszR0';
  var BUCKET = 'reports';
  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    global:{ fetch:function(u,o){ o=o||{}; return fetch(u, Object.assign({}, o, {cache:'no-store'})); } }
  });
  try{
    var prj = (new URL(SUPABASE_URL).hostname || '').split('.')[0];
    var projBadge = $('#projBadge'); if(projBadge){ projBadge.textContent = 'Bucket: '+BUCKET+'（Public）｜Project: '+prj; }
  }catch(_){}

  // ===== DOM 參照 =====
  var sel = $('#fileSel');
  var btnLoad = $('#btnLoad');
  var btnRefresh = $('#btnRefresh');
  var currentFile = $('#currentFile');
  var periodText = $('#periodText');

  var q = new URLSearchParams(location.search);
  var OVERRIDE_FILE = q.get('file') || '';

  // ===== 列清單（遞迴掃描、優先 1031） =====
  function listRecursive(path, acc){
    path = path || '';
    acc = acc || [];
    var p = path && path.slice(-1) !== '/' ? path + '/' : path;
    return sb.storage.from(BUCKET).list(p, { limit:1000, sortBy:{column:'name',order:'asc'} })
      .then(function(r){
        var data = r.data || [];
        var promises = [];
        for(var i=0;i<data.length;i++){
          var it = data[i];
          if(!it.id && !it.metadata){
            promises.push(listRecursive(p + it.name, acc));
          }else{
            acc.push({ fullPath: p + it.name, item: it });
          }
        }
        return Promise.all(promises).then(function(){ return acc; });
      });
  }

  function scoreByNameDate(name){
    var m = (name || '').match(/\b(20\d{6})\b/g);
    if(!m || !m.length) return 0;
    var maxv = 0;
    for(var i=0;i<m.length;i++){ var v = +m[i]; if(v>maxv) maxv=v; }
    return maxv;
  }

  function refreshList(){
    setStatus('讀取上傳區清單…');
    if(sel){ sel.innerHTML = '<option value="">（選擇檔案）</option>'; }
    if(btnLoad) btnLoad.disabled = true;
    return listRecursive('', [])
      .then(function(all){
        var files = [];
        for(var i=0;i<all.length;i++){
          var fp = all[i].fullPath;
          if(/\.txt$|\.csv$/i.test(fp)){
            files.push({
              path: fp,
              name: fp.split('/').pop(),
              size: (all[i].item && all[i].item.metadata && all[i].item.metadata.size) ? all[i].item.metadata.size : 0,
              updated: all[i].item && all[i].item.updated_at ? all[i].item.updated_at : ''
            });
          }
        }
        var prefer = [];
        for(var j=0;j<files.length;j++){ if(/1031/i.test(files[j].name)) prefer.push(files[j]); }
        var list = prefer.length ? prefer : files;
        list.sort(function(a,b){
          var sa=scoreByNameDate(a.name), sb=scoreByNameDate(b.name);
          if(sa!==sb) return sb-sa;
          var ta=a.updated?Date.parse(a.updated):0, tb=b.updated?Date.parse(b.updated):0;
          if(ta!==tb) return tb-ta;
          return (b.size||0)-(a.size||0);
        });
        if(sel){
          for(var k=0;k<list.length;k++){
            var opt = document.createElement('option');
            var label = list[k].path + (list[k].updated?(' · '+list[k].updated.replace('T',' ').slice(0,16)):' · —');
            opt.value = list[k].path; opt.textContent = label;
            sel.appendChild(opt);
          }
          btnLoad.disabled = !sel.value;
        }
        setStatus('就緒');
      })
      .catch(function(err){
        console.error(err);
        setStatus('清單讀取失敗：' + (err && err.message ? err.message : String(err)), true);
      });
  }
  if(sel){ sel.addEventListener('change', function(){ if(btnLoad) btnLoad.disabled = !sel.value; }); }
  if(btnRefresh){ btnRefresh.addEventListener('click', function(){ refreshList(); }); }

  // ===== 下載 =====
  function fetchText(u){
    return fetch(u, {cache:'no-store'}).then(function(res){
      if(!res.ok) throw new Error(res.status + ' ' + res.statusText);
      return res.text();
    });
  }

  // ===== 1031 專屬：CSV -> canonical 轉換（只做多） =====
  // 來源：YYYYMMDD,hhmmss,price,動作,後續欄位...
  // 映射：買進/加碼攤平/再加碼攤平 -> 新買；賣出 -> 平賣；其他忽略
  function toCanonFrom1031CSV(raw){
    var txt = raw.replace(/\ufeff/gi,'')
                 .replace(/[\u200B-\u200D]/g,'')
                 .replace(/[\x00-\x09\x0B-\x1F\x7F]/g,'')
                 .replace(/\r\n?/g,'\n');
    var out = [];
    var lines = txt.split('\n');
    function mapAction(a){
      if(/賣出/.test(a)) return '平賣';
      if(/買進|加碼攤平|再加碼攤平/.test(a)) return '新買';
      return '';
    }
    for(var i=0;i<lines.length;i++){
      var line = lines[i]; if(!line || !line.trim()) continue;
      if(/^\s*日期\s*,\s*時間\s*,\s*價格\s*,\s*動作/i.test(line)) continue;
      // 允許動作後還有一串說明，所以只抓前四欄
      var m = line.match(/^\s*(\d{8})\s*,\s*(\d{5,6})\s*,\s*(\d+(?:\.\d+)?)\s*,\s*([^,]+)\s*/);
      if(!m) continue;
      var d8 = m[1];
      var t = m[2]; if(t.length===5) t = '0' + t; // 90500 -> 090500
      var px = Number(m[3]); var p6 = isFinite(px) ? px.toFixed(6) : m[3];
      var act = mapAction((m[4]||'').trim());
      if(!act) continue; // 只做多 + 賣出
      out.push(d8 + t + '.000000 ' + p6 + ' ' + act);
    }
    return { canon: out.join('\n'), ok: out.length };
  }

  // ===== 每週盈虧圖 =====
  var chWeekly = null;
  function weekStartDateUTC(ms){
    var d=new Date(ms), dow=(d.getUTCDay()+6)%7;
    var s=new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()-dow));
    return s.toISOString().slice(0,10);
  }
  function buildWeeklyFromExecs(execs){
    var m={}, order=[];
    for(var i=0;i<execs.length;i++){
      var e = execs[i];
      if(e.side!=='SELL' || typeof e.pnlFull !== 'number') continue;
      var wk = weekStartDateUTC(e.tsMs);
      if(!m.hasOwnProperty(wk)){ m[wk]=0; order.push(wk); }
      m[wk] += e.pnlFull;
    }
    var labels = order;
    var weekly = labels.map(function(wk){ return m[wk]||0; });
    var cum=[], s=0; for(var j=0;j<weekly.length;j++){ s+=weekly[j]; cum.push(s); }
    return { labels:labels, weekly:weekly, cum:cum };
  }
  function renderWeeklyChart(execs){
    var card=$('#weeklyCard'), ctx=$('#chWeekly');
    var W = buildWeeklyFromExecs(execs);
    if(!W.labels.length){ if(card) card.style.display='none'; return; }
    if(card) card.style.display='';
    if(chWeekly){ try{ chWeekly.destroy(); }catch(_e){} }
    chWeekly = new Chart(ctx, {
      data:{
        labels:W.labels,
        datasets:[
          { type:'bar',  label:'每週獲利', data:W.weekly, borderWidth:1 },
          { type:'line', label:'累積淨利', data:W.cum,    borderWidth:2, tension:0.2, pointRadius:0 }
        ]
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ display:true } },
        scales:{ x:{ ticks:{ maxTicksLimit:12 } } }
      }
    });
  }

  // ===== 交易明細表 =====
  function renderTxTable(execs){
    var tb = $('#txBody'); if(!tb) return;
    tb.innerHTML='';
    if(!execs.length){
      tb.innerHTML = '<tr><td colspan="7" class="muted">（無資料）</td></tr>';
      return;
    }
    for(var i=0;i<execs.length;i++){
      var e = execs[i];
      var tr=document.createElement('tr');
      tr.className = (e.side==='SELL'?'sell-row':'buy-row');
      var fee = e.fee!=null ? e.fee : 0;
      var tax = e.tax!=null ? e.tax : 0;
      var amt = e.side==='SELL' ? (e.sellAmount||0) : (e.buyAmount||0);
      var tsShow = e.ts ? tsPretty(e.ts) : (e.tsMs ? new Date(e.tsMs).toISOString().slice(0,16).replace('T',' ') : '—');
      tr.innerHTML =
        '<td>'+tsShow+'</td>'+
        '<td>'+(e.side==='BUY'?'買進':(e.side==='SELL'?'賣出':(e.side||'—')) )+'</td>'+
        '<td>'+(e.price!=null ? Number(e.price).toFixed(2) : '—')+'</td>'+
        '<td class="right">'+fmtInt(e.shares||0)+'</td>'+
        '<td class="right">'+fmtInt(fee)+'</td>'+
        '<td class="right">'+fmtInt(tax)+'</td>'+
        '<td class="right">'+fmtInt(amt)+'</td>';
      tb.appendChild(tr);
    }
  }

  // ===== 載入並渲染 =====
  function loadAndRender(fullPath){
    setStatus('下載/解析…');
    var url = /^https?:\/\//i.test(fullPath) ? fullPath : sb.storage.from(BUCKET).getPublicUrl(fullPath).data.publicUrl;
    return fetchText(url)
      .then(function(raw){
        var conv = toCanonFrom1031CSV(raw);
        if(!conv.ok) throw new Error('TXT 內容無可解析的交易行（1031 CSV 轉換失敗）');
        var rows = window.ETF_ENGINE.parseCanon(conv.canon);
        if(!rows.length) throw new Error('轉換後資料為空');
        var start = rows[0].day, end = rows[rows.length-1].day;
        if(periodText) periodText.textContent = start + ' - ' + end;
        if(currentFile) currentFile.textContent = fullPath;
        setStatus('回測/繪圖…');
        var CFG = window.ETF_ENGINE.defaultCFG ? window.ETF_ENGINE.defaultCFG() : {};
        var bt  = window.ETF_ENGINE.backtest(rows, CFG);
        renderWeeklyChart(bt.execs);
        renderTxTable(bt.execs);
        setStatus('完成');
      })
      .catch(function(err){
        console.error(err);
        setStatus('錯誤：' + (err && err.message ? err.message : String(err)), true);
      });
  }

  // ===== 事件 & 開機 =====
  if(btnLoad){ btnLoad.addEventListener('click', function(){ if(sel && sel.value) loadAndRender(sel.value); }); }

  (function boot(){
    refreshList().then(function(){
      if(OVERRIDE_FILE){
        if(currentFile) currentFile.textContent = OVERRIDE_FILE.split('/').pop() || OVERRIDE_FILE;
        return loadAndRender(OVERRIDE_FILE);
      }
      if(sel && sel.options.length>1){
        sel.selectedIndex = 1;
        return loadAndRender(sel.value);
      }else{
        setStatus('清單為空，請先到「資料上傳區」上傳檔案。', true);
      }
    });
  })();
})();
