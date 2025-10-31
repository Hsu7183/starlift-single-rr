// tw-1031.js — 台股 1031（讀「資料上傳區 /reports」）
// 只顯示：每週盈虧圖 + 交易明細；不含 KPI；只做多（買進/加碼/再加碼 -> 新買；賣出 -> 平賣）
(function(){
  // ===== DOM/工具 =====
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
    return ts14.slice(0,4)+'/'+ts14.slice(4,6)+'/'+ts14.slice(6,8)+' '+
           ts14.slice(8,10)+':'+ts14.slice(10,12);
  }

  // ===== Supabase（沿用上傳頁全域；無則 fallback） =====
  var SUPABASE_URL = (typeof window.SUPABASE_URL==='string' && window.SUPABASE_URL) ?
                      window.SUPABASE_URL : 'https://byhbmmnacezzgkwfkozs.supabase.co';
  var SUPABASE_KEY = (typeof window.SUPABASE_ANON_KEY==='string' && window.SUPABASE_ANON_KEY) ?
                      window.SUPABASE_ANON_KEY :
                      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ5aGJtbW5hY2V6emdrd2Zrb3pzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg1OTE0NzksImV4cCI6MjA3NDE2NzQ3OX0.VCSye3-fKrQphejdJSWAM6iRzv_7gkl8MLe7NeVszR0';
  var BUCKET = 'reports';
  var sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    global:{ fetch:function(u,o){o=o||{};return fetch(u,Object.assign({},o,{cache:'no-store'}));} }
  });
  try{
    var prj=(new URL(SUPABASE_URL).hostname||'').split('.')[0];
    var badge=$('#projBadge'); if(badge){ badge.textContent='Bucket: '+BUCKET+'（Public）｜Project: '+prj; }
  }catch(_){}

  // ===== DOM refs =====
  var sel = $('#fileSel'), btnLoad = $('#btnLoad'), btnRefresh = $('#btnRefresh');
  var currentFile = $('#currentFile'), periodText = $('#periodText');
  var q = new URLSearchParams(location.search);
  var OVERRIDE_FILE = q.get('file') || '';

  // ===== 遞迴列清單（只列 .txt/.csv；優先 1031） =====
  function listRecursive(path, acc){
    path = path || ''; acc = acc || [];
    var p = path && path.slice(-1)!=='/' ? path+'/' : path;
    return sb.storage.from(BUCKET).list(p, { limit:1000, sortBy:{column:'name',order:'asc'} })
      .then(function(r){
        var data=r.data||[], jobs=[];
        for(var i=0;i<data.length;i++){
          var it=data[i];
          if(!it.id && !it.metadata){ jobs.push(listRecursive(p+it.name, acc)); }
          else{ acc.push({ fullPath:p+it.name, item:it }); }
        }
        return Promise.all(jobs).then(function(){ return acc; });
      });
  }
  function scoreByNameDate(name){
    var m=(name||'').match(/\b(20\d{6})\b/g), mx=0; if(!m) return 0;
    for(var i=0;i<m.length;i++){ var v=+m[i]; if(v>mx) mx=v; } return mx;
  }
  function refreshList(){
    setStatus('讀取上傳區清單…');
    if(sel){ sel.innerHTML='<option value="">（選擇檔案）</option>'; } if(btnLoad) btnLoad.disabled=true;
    return listRecursive('',[]).then(function(all){
      var files=[], i, fp;
      for(i=0;i<all.length;i++){
        fp=all[i].fullPath;
        if(/\.txt$|\.csv$/i.test(fp)){
          files.push({
            path:fp, name:fp.split('/').pop(),
            size:(all[i].item&&all[i].item.metadata&&all[i].item.metadata.size)||0,
            updated:(all[i].item&&all[i].item.updated_at)||''
          });
        }
      }
      var f1031=[], list;
      for(i=0;i<files.length;i++) if(/1031/i.test(files[i].name)) f1031.push(files[i]);
      list = f1031.length? f1031 : files;
      list.sort(function(a,b){
        var sa=scoreByNameDate(a.name), sb=scoreByNameDate(b.name);
        if(sa!==sb) return sb-sa;
        var ta=a.updated?Date.parse(a.updated):0, tb=b.updated?Date.parse(b.updated):0;
        if(ta!==tb) return tb-ta;
        return (b.size||0)-(a.size||0);
      });
      if(sel){
        for(i=0;i<list.length;i++){
          var opt=document.createElement('option');
          var label=list[i].path + (list[i].updated?(' · '+list[i].updated.replace('T',' ').slice(0,16)):' · —');
          opt.value=list[i].path; opt.textContent=label; sel.appendChild(opt);
        }
        btnLoad.disabled=!sel.value;
      }
      setStatus('就緒');
    }).catch(function(err){ console.error(err); setStatus('清單讀取失敗：'+(err&&err.message||String(err)),true); });
  }
  if(sel) sel.addEventListener('change', function(){ if(btnLoad) btnLoad.disabled=!sel.value; });
  if(btnRefresh) btnRefresh.addEventListener('click', function(){ refreshList(); });

  // ===== 下載 =====
  function fetchText(u){
    return fetch(u,{cache:'no-store'}).then(function(r){ if(!r.ok) throw new Error(r.status+' '+r.statusText); return r.text(); });
  }

  // ===== 1031 專屬：CSV -> canonical 轉換（只做多） =====
  // 每行：日期,時間,價格,動作,……（後面說明不管）
  function toCanonFrom1031CSV(raw){
    var txt = raw.replace(/\ufeff/gi,'').replace(/[\u200B-\u200D]/g,'').replace(/[\x00-\x09\x0B-\x1F\x7F]/g,'').replace(/\r\n?/g,'\n');
    var out=[], lines=txt.split('\n');
    function mapAction(a){
      if(a.indexOf('賣出')>=0) return '平賣';
      if(a.indexOf('買進')>=0 || a.indexOf('加碼攤平')>=0 || a.indexOf('再加碼攤平')>=0) return '新買';
      return '';
    }
    for(var i=0;i<lines.length;i++){
      var line=lines[i]; if(!line || !line.trim()) continue;
      // 切前四欄（若多逗號，只取前四欄）
      var parts=line.split(',');
      if(parts.length<4) continue;
      var d8=String(parts[0]).trim();
      if(!/^\d{8}$/.test(d8)) {
        // 可能是表頭：日期,時間,價格,動作,說明
        if(i===0) continue; else continue;
      }
      var t=String(parts[1]).trim();
      if(/^\d{5}$/.test(t)) t='0'+t; // 90500 -> 090500
      if(!/^\d{6}$/.test(t)) continue;

      var px=parseFloat(String(parts[2]).trim());
      if(!isFinite(px)) continue;
      var p6=px.toFixed(6);

      var actRaw=String(parts[3]).trim();
      var act=mapAction(actRaw);
      if(!act) continue; // 只做多 + 賣出

      out.push(d8+t+'.000000 '+p6+' '+act);
    }
    return { canon: out.join('\n'), ok: out.length };
  }

  // ===== 每週盈虧圖 =====
  var chWeekly=null;
  function weekStartDateUTC(ms){
    var d=new Date(ms), dow=(d.getUTCDay()+6)%7;
    var s=new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()-dow));
    return s.toISOString().slice(0,10);
  }
  function buildWeeklyFromExecs(execs){
    var map={}, order=[], i,e,wk;
    for(i=0;i<execs.length;i++){
      e=execs[i]; if(e.side!=='SELL' || typeof e.pnlFull!=='number') continue;
      wk=weekStartDateUTC(e.tsMs); if(!(wk in map)){ map[wk]=0; order.push(wk); } map[wk]+=e.pnlFull;
    }
    var labels=order, weekly=labels.map(function(k){return map[k]||0;}), cum=[], s=0;
    for(i=0;i<weekly.length;i++){ s+=weekly[i]; cum.push(s); }
    return { labels:labels, weekly:weekly, cum:cum };
  }
  function renderWeeklyChart(execs){
    var card=$('#weeklyCard'), ctx=$('#chWeekly'), W=buildWeeklyFromExecs(execs);
    if(!W.labels.length){ if(card) card.style.display='none'; return; }
    if(card) card.style.display='';
    if(chWeekly){ try{ chWeekly.destroy(); }catch(_e){} }
    chWeekly=new Chart(ctx,{
      data:{ labels:W.labels, datasets:[
        { type:'bar', label:'每週獲利', data:W.weekly, borderWidth:1 },
        { type:'line', label:'累積淨利', data:W.cum, borderWidth:2, tension:0.2, pointRadius:0 }
      ]},
      options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{display:true}}, scales:{ x:{ticks:{maxTicksLimit:12}} } }
    });
  }

  // ===== 交易明細表 =====
  function renderTxTable(execs){
    var tb=$('#txBody'); if(!tb) return; tb.innerHTML='';
    if(!execs.length){ tb.innerHTML='<tr><td colspan="7" class="muted">（無資料）</td></tr>'; return; }
    for(var i=0;i<execs.length;i++){
      var e=execs[i], fee=e.fee||0, tax=e.tax||0, amt=(e.side==='SELL'?(e.sellAmount||0):(e.buyAmount||0));
      var tsShow = e.ts ? tsPretty(e.ts) : (e.tsMs ? new Date(e.tsMs).toISOString().slice(0,16).replace('T',' ') : '—');
      var tr=document.createElement('tr');
      tr.className=(e.side==='SELL'?'sell-row':'buy-row');
      tr.innerHTML=
        '<td>'+tsShow+'</td>'+
        '<td>'+(e.side==='BUY'?'買進':(e.side==='SELL'?'賣出':(e.side||'—')) )+'</td>'+
        '<td>'+(e.price!=null?Number(e.price).toFixed(2):'—')+'</td>'+
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
    return fetchText(url).then(function(raw){
      var conv=toCanonFrom1031CSV(raw);
      if(!conv.ok) throw new Error('TXT 內容無可解析的交易行（1031 CSV 轉換失敗）');
      var rows=window.ETF_ENGINE.parseCanon(conv.canon);
      if(!rows.length) throw new Error('轉換後資料為空');
      var start=rows[0].day, end=rows[rows.length-1].day;
      if(periodText) periodText.textContent=start+' - '+end;
      if(currentFile) currentFile.textContent=fullPath;
      setStatus('回測/繪圖…');
      var CFG = window.ETF_ENGINE.defaultCFG ? window.ETF_ENGINE.defaultCFG() : {};
      var bt  = window.ETF_ENGINE.backtest(rows, CFG);
      renderWeeklyChart(bt.execs);
      renderTxTable(bt.execs);
      setStatus('完成');
    }).catch(function(err){ console.error(err); setStatus('錯誤：'+(err&&err.message||String(err)), true); });
  }

  // ===== 事件 & 開機 =====
  if(btnLoad) btnLoad.addEventListener('click', function(){ if(sel && sel.value) loadAndRender(sel.value); });
  refreshList().then(function(){
    if(OVERRIDE_FILE){ if(currentFile) currentFile.textContent=OVERRIDE_FILE.split('/').pop()||OVERRIDE_FILE; return loadAndRender(OVERRIDE_FILE); }
    if(sel && sel.options.length>1){ sel.selectedIndex=1; return loadAndRender(sel.value); }
    setStatus('清單為空，請先到「資料上傳區」上傳檔案。', true);
  });
})();
