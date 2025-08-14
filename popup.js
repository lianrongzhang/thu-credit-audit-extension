window.addEventListener('error', (e) => setStatus('JS 錯誤：' + (e?.error?.message || e.message)));
window.addEventListener('unhandledrejection', (e) => setStatus('Promise 錯誤：' + (e?.reason?.message || e.reason)));


const $ = (sel) => document.querySelector(sel);
const statusEl = $('#status');
const resultEl = $('#result');
const setyearEl = $('#setyear');
const stypeEl = $('#stype');
const majrEl = $('#majr');
const subMajrEl = $('#subMajr');
const fetchBtn = $('#fetchBtn');
const exportBtn = $('#exportBtn');
const compareBtn = $('#compareBtn');
const rawFrame = $('#rawFrame');

let lastRows = [];
let lastReport = null; // ⬅️ 儲存最近一次比對結果
let lastFetchedHtml = ''; // ⬅️ 新增：儲存最近一次校方回傳原始 HTML，供 iframe 失敗時解析

function setStatus(msg) { statusEl.textContent = msg || ''; }

function htmlToDoc(html) {
  const doc = document.implementation.createHTMLDocument('resp');
  doc.documentElement.innerHTML = html;
  return doc;
}

// 使用 iframe + srcdoc 來完全隔離伺服器回傳的 HTML
function renderRawHtmlInIframe(html, baseHref = 'https://fsis.thu.edu.tw/') {
  if (!rawFrame) return;

  // 讓相對連結可用、且一律新分頁
  const baseTag = `<base href="${baseHref}" target="_blank">`;

  let srcdoc = '';
  if (/<html[\s>]/i.test(html)) {
    // 已經是完整 HTML：插入 <base> 到 <head>
    if (/<head[\s>]/i.test(html)) {
      srcdoc = html.replace(/<head[^>]*>/i, (m) => `${m}\n${baseTag}`);
    } else {
      srcdoc = html.replace(/<html[^>]*>/i, (m) => `${m}\n<head>${baseTag}</head>`);
    }
  } else {
    // 不是完整文件：包一層
    srcdoc = `<!doctype html>
<html>
<head>${baseTag}<meta charset="utf-8"><style>body{margin:8px;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans TC",Arial,sans-serif;}</style></head>
<body>${html}</body></html>`;
  }

  rawFrame.srcdoc = srcdoc; // sandbox iframe 顯示，不執行對方腳本
}

function getSubMajrOptionEl() {
  // 先找已選取的（radio/option），再退而求其次找第一個
  return (
    document.querySelector('#subMajr [name="p_grop"]:checked') ||
    document.querySelector('#subMajr [name="p_grop"]') ||
    document.querySelector('#subMajr [name="p_grop[]"]:checked') ||
    document.querySelector('#subMajr [name="p_grop[]"]')
  );
}

// ---------- 解析工具：學年度 / 學系 ----------
function parseYearOptions(html) {
  const doc = htmlToDoc(html);
  const select = doc.querySelector('#setyear, select[name="setyear"]');
  const opts = [];
  if (select) {
    for (const opt of select.querySelectorAll('option')) {
      const value = (opt.value || '').trim();
      const text = (opt.textContent || '').trim();
      if (value) {
        opts.push({ value, text, selected: opt.selected || false });
      }
    }
  }
  return opts;
}

function pickLatestNumeric(options) {
  const nums = options
    .map(o => o.value)
    .filter(v => /^\d+$/.test(v))
    .map(v => parseInt(v, 10));
  if (nums.length === 0) return options[0]?.value ?? '';
  return String(Math.max(...nums));
}

function renderOptions(selectEl, opts, preferred) {
  selectEl.innerHTML = '';
  for (const o of opts) {
    const op = document.createElement('option');
    op.value = o.value;
    op.textContent = o.text || o.value;
    if (preferred != null) {
      if (String(o.value) === String(preferred)) op.selected = true;
    } else if (o.selected) {
      op.selected = true;
    }
    selectEl.appendChild(op);
  }
}

function parseMajrOptions(html) {
  const doc = htmlToDoc(html);
  const select = doc.querySelector('select[name="majr"]');
  const opts = [];
  if (select) {
    for (const opt of select.querySelectorAll('option')) {
      const value = (opt.value || '').trim();
      const text = (opt.textContent || '').replace(/^[\s\-–]+/, '').trim();
      if (value && value !== 'XXX') opts.push({ value, text });
    }
  }
  return opts;
}

function renderSubMajrOptionsInDOM(html) {
  const sel = subMajrEl;
  sel.innerHTML = html;
}

// ---------- 動態載入 ----------
async function loadYears() {
  setStatus('載入學年度清單…');
  const { ok, html, error } = await chrome.runtime.sendMessage({ type: 'LOAD_SETYEAR_OPTIONS' });
  if (!ok) { setStatus('學年度載入失敗：' + error); return; }

  const years = parseYearOptions(html);
  if (!years.length) {
    // 後援：若站方頁面暫時變更，至少維持一個選項避免阻塞
    renderOptions(setyearEl, [{ value: '114', text: '114' }], '114');
    setStatus('找不到遠端學年度，下拉以後援資料顯示');
    return;
  }
  const latest = pickLatestNumeric(years);
  renderOptions(setyearEl, years, latest);
  setStatus(`學年度已載入（預設：${latest}）`);
}

function renderMajrOptions(opts) {
  majrEl.innerHTML = '';
  for (const o of opts) {
    const op = document.createElement('option');
    op.value = o.value;
    op.textContent = o.text;
    majrEl.appendChild(op);
  }
}

async function loadMajr() {
  setStatus('載入學系清單…');
  const { ok, html, error } = await chrome.runtime.sendMessage({
    type: 'LOAD_MAJR_OPTIONS',
    payload: { stype: stypeEl.value }
  });
  if (!ok) { setStatus('載入失敗：' + error); return; }
  const opts = parseMajrOptions(html);
  if (!opts.length) {
    setStatus('找不到學系清單，可能站方回傳格式變更');
  } else {
    renderMajrOptions(opts);
    setStatus('學系清單已載入');
  }
}

async function loadSubMajr() {
  setStatus('載入子學系清單…');
  const { ok, html, error } = await chrome.runtime.sendMessage({
    type: 'LOAD_SUBMAJR_OPTIONS',
    payload: { stype: stypeEl.value, majr: majrEl.value }
  });
  if (!ok) { setStatus('載入失敗：' + error); return; }
  const trimmed_html = html.replace(/&nbsp;/g, '');
  renderSubMajrOptionsInDOM(trimmed_html);

  // 可選：若有多個選項，預設勾第一個
  const first = getSubMajrOptionEl();
  if (first && !document.querySelector('#subMajr [name="p_grop"]:checked')) {
    first.checked = true;
  }

  setStatus('子學系清單已載入');
}


// ---------- 解析表格 / 渲染 / 匯出 ----------
function parseMustTable(html) {
  const doc = htmlToDoc(html);
  const tables = Array.from(doc.querySelectorAll('table'));
  if (!tables.length) return { columns: [], rows: [] };
  let best = tables[0], maxCells = 0;
  for (const t of tables) {
    const cells = t.querySelectorAll('td,th').length;
    if (cells > maxCells) { maxCells = cells; best = t; }
  }
  const headers = Array.from(best.querySelectorAll('thead th, tr:first-child th, tr:first-child td'))
    .map(th => th.textContent.trim());
  const rows = [];
  const bodyRows = best.tBodies.length ? best.tBodies[0].rows : best.rows;
  for (let i = 1; i < bodyRows.length; i++) {
    const tr = bodyRows[i];
    const cells = Array.from(tr.cells).map(td => td.textContent.trim());
    if (cells.length) rows.push(cells);
  }
  return { columns: headers, rows };
}

function renderTable({ columns, rows }) {
  resultEl.innerHTML = '';
  if (!rows.length) {
    resultEl.innerHTML = '<div class="empty">查無資料或格式未解析</div>';
    exportBtn.disabled = true;
    return;
  }
  const table = document.createElement('table');
  table.className = 'table';
  const thead = document.createElement('thead');
  const trh = document.createElement('tr');
  for (const c of columns) {
    const th = document.createElement('th');
    th.textContent = c;
    trh.appendChild(th);
  }
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const r of rows) {
    const tr = document.createElement('tr');
    for (const v of r) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  resultEl.appendChild(table);
  exportBtn.disabled = false;
}

function toCSV(columns, rows) {
  const esc = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  const lines = [];
  if (columns.length) lines.push(columns.map(esc).join(','));
  for (const r of rows) lines.push(r.map(esc).join(','));
  return lines.join('\r\n');
}

function toCSVLine(arr) {
  const fix = (v) => {
    const s = String(v ?? '');
    // 純數字且長度>=12（Excel 常轉科學記號）
    if (/^\d{12,}$/.test(s)) return "'" + s;
    return s;
  };
  const esc = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  return arr.map(x => esc(fix(x))).join(',');
}

function buildCSVWithReport(rawColumns, rawRows, report) {
  const lines = [];

  // 區段1：原始必修表
  lines.push('=== 必修表 Raw Table ===');
  if (rawColumns?.length) lines.push(toCSVLine(rawColumns));
  for (const r of (rawRows || [])) lines.push(toCSVLine(r));
  lines.push(''); // 空行

  // 若沒有比對結果，就只輸出必修表
  if (!report) return lines.join('\r\n');

  // 區段2：比對摘要
  const s = report.summary || {};
  lines.push('=== 比對摘要 Summary ===');
  lines.push(toCSVLine(['已修總學分', s.earnedTotalCredits]));
  lines.push(toCSVLine(['必修應修學分合計', s.mustTotalCredits]));
  lines.push(toCSVLine(['必修已修學分', s.earnedRequiredCredits]));
  lines.push(toCSVLine(['必修尚缺學分', s.missingRequiredCredits]));
  if (s.electiveCreditsTarget != null) {
    lines.push(toCSVLine(['選修應修學分', s.electiveCreditsTarget]));
    lines.push(toCSVLine(['已修選修(估算)', s.earnedElectiveCredits]));
  }
  if (s.graduateCreditsTarget != null) {
    lines.push(toCSVLine(['畢業學分門檻', s.graduateCreditsTarget]));
    lines.push(toCSVLine(['距離畢業尚缺', s.remainingToGraduate]));
  }
  lines.push('');

  // 區段3：已通過的必修
  lines.push('=== 已通過的必修 Passed Required ===');
  lines.push(toCSVLine(['課程名稱', '學分', '學年度', '學期', '選課代號', 'GPA/備註']));
  for (const x of (report.details?.passedRequired || [])) {
    const src = x.source || {};
    lines.push(toCSVLine([x.name, x.credit, src.year, src.term, src.code, src.gpa]));
  }
  lines.push('');

  // 區段4：尚未通過的必修
  lines.push('=== 尚未通過的必修 Missing Required ===');
  lines.push(toCSVLine(['課程名稱', '學分']));
  for (const x of (report.details?.missingRequired || [])) {
    lines.push(toCSVLine([x.name, x.credit]));
  }
  lines.push('');

  // 區段5：已通過但未對上的課（可能是選修或課名不一致）
  lines.push('=== 已通過但未匹配必修的課程 Unmatched Passed ===');
  lines.push(toCSVLine(['學年度', '學期', '選課代號', '科目名稱', '學分', 'GPA/備註']));
  for (const r of (report.details?.unmatchedPassed || [])) {
    lines.push(toCSVLine([r.year, r.term, r.code, r.name, r.credit, r.gpa]));
  }

  return lines.join('\r\n');
}

// ---------- 事件 ----------
async function handleFetch() {
  setStatus('查詢中…');
  // 先把自建表格容器清空/隱藏
  resultEl.innerHTML = '';
  resultEl.style.display = 'none';
  exportBtn.disabled = true;
  lastRows = [];

  const setyear = setyearEl.value;
  const stype = stypeEl.value;
  const majr = majrEl.value;

  const subMajrElNow = getSubMajrOptionEl();  // ⬅️ 每次呼叫即時抓
  const payload = subMajrElNow && subMajrElNow.value
    ? { setyear, stype, majr, subMajr: subMajrElNow.value }
    : { setyear, stype, majr };

  const { ok, html, error } = await chrome.runtime.sendMessage({
    type: 'FETCH_MUSTLIST',
    payload
  });
  if (!ok) { setStatus('查詢失敗：' + error); return; }

  // 儲存原始 HTML（供後續比對離線解析，不依賴 iframe sandbox）
  lastFetchedHtml = html;

  // ▶︎ 直接顯示校方回傳 HTML 到 iframe
  renderRawHtmlInIframe(html, 'https://fsis.thu.edu.tw/');
  
  // ▶︎ 保留解析資料流程（但不渲染自建表格）
  const parsed = parseMustTable(html);
  lastRows = parsed;          // 讓比對/CSV 照常使用
  // 不呼叫 renderTable(parsed)
  
  // 如果有解析到資料，啟用匯出按鈕
  if (parsed.rows && parsed.rows.length > 0) {
    exportBtn.disabled = false;
  }
  
  setStatus('完成');
}

async function handleExport() {
  if (!lastRows || !lastRows.rows || !lastRows.rows.length) return;

  // 用 CRLF，且加 BOM，Excel 開啟不會亂碼
  const csv = buildCSVWithReport(lastRows.columns, lastRows.rows, lastReport);
  const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' });

  const url = URL.createObjectURL(blob);
  const hasReport = !!lastReport;
  const filename = `THU_mustlist_${setyearEl.value}_${stypeEl.value}_${majrEl.value}${hasReport ? '_with-report' : ''}.csv`;
  chrome.downloads.download({ url, filename, saveAs: true });
}

// 綁定事件
stypeEl.addEventListener('change', loadMajr);
setyearEl.addEventListener('change', loadMajr);
majrEl.addEventListener('change', loadSubMajr);
fetchBtn.addEventListener('click', handleFetch);
exportBtn.addEventListener('click', handleExport);
compareBtn.addEventListener('click', handleCompare);

// 啟動流程：先載年度，再載學系
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await loadYears();
  } catch (e) {
    setStatus('初始化年度失敗：' + e);
  }
  try {
    await loadMajr();
  } catch (e) {
    setStatus('初始化學系失敗：' + e);
  }
});

// ========= 新增：在當前分頁注入程式，擷取「歷年成績」表格 =========
async function scrapeTranscriptFromActiveTab() {
  // 1) 先找「一般視窗(normal) 的作用中分頁」，且 URL 必須是 http/https
  const normalWins = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  // 先找目前聚焦的 normal 視窗裡的 active tab
  let targetTab = null;
  const focusedWin = normalWins.find(w => w.focused);
  if (focusedWin) targetTab = focusedWin.tabs.find(t => t.active);

  // 如果沒找到，找最近一個看起來像學校成績頁的分頁
  const allTabs = normalWins.flatMap(w => w.tabs || []);
  if (!targetTab || !/^https?:/i.test(targetTab.url)) {
    targetTab =
      allTabs.find(t => /^https?:/i.test(t.url) && /thu\.edu\.tw/i.test(t.url)) ||
      allTabs.find(t => /^https?:/i.test(t.url));
  }

  if (!targetTab || !/^https?:/i.test(targetTab.url)) {
    throw new Error('找不到可注入的瀏覽器分頁。請先切到學校的「歷年成績」頁，再按一次「抓成績＋比對」。');
  }

  // 安全護欄：避免對 chrome-extension:// 或 chrome:// 注入
  if (/^chrome(-extension)?:\/\//i.test(targetTab.url)) {
    throw new Error('目前聚焦的是擴充視窗。請切到學校的「歷年成績」頁，再按一次「抓成績＋比對」。');
  }

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    func: () => {
      function norm(s){ return String(s||'').trim(); }
      const targetHeaders = ['學年度','學期','選課代號','科目名稱','學分','GPA'];
      function tableMatches(t){
        const firstRow = t.tHead?.rows?.[0] || t.rows?.[0];
        if (!firstRow) return false;
        const headers = Array.from(firstRow.cells).map(th => norm(th.textContent));
        return targetHeaders.every(h => headers.includes(h));
      }
      const tables = Array.from(document.querySelectorAll('table'));
      const table = tables.find(tableMatches);
      if (!table) return { ok:false, error:'找不到符合格式的歷年成績表格' };

      const headRow = table.tHead?.rows?.[0] || table.rows?.[0];
      const headerIdx = {};
      Array.from(headRow.cells).forEach((th, i) => { headerIdx[norm(th.textContent)] = i; });

      const bodyRows = table.tBodies?.[0]?.rows?.length ? table.tBodies[0].rows : Array.from(table.rows).slice(1);
      const records = [];
      for (const tr of bodyRows) {
        const cells = tr.cells; if (!cells || cells.length === 0) continue;
        records.push({
          year:   norm(cells[headerIdx['學年度']]?.textContent),
          term:   norm(cells[headerIdx['學期']]?.textContent),
          code:   norm(cells[headerIdx['選課代號']]?.textContent),
          name:   norm(cells[headerIdx['科目名稱']]?.textContent),
          credit: norm(cells[headerIdx['學分']]?.textContent),
          gpa:    norm(cells[headerIdx['GPA']]?.textContent)
        });
      }
      return { ok:true, data:records };
    }
  });

  if (!result?.ok) throw new Error(result?.error || '擷取失敗');
  return result.data;
}
// ========= 新增：解析「必修科目表」(從 popup 的 #result 內的表格) =========
// 在 #result 找到最可能的「課綱表」：含 必修/選修/畢業學分 等關鍵字者

function findCurriculumTable() {
  // 優先：從 iframe 取（若 sandbox 可讀）
  let tables = [];
  try {
    if (rawFrame?.contentDocument?.body) {
      tables = Array.from(rawFrame.contentDocument.body.querySelectorAll('table'));
    }
  } catch (e) {
    console.warn('存取 iframe 失敗，改用離線 HTML 解析：', e);
  }

  // 後援：如果 iframe 內無表格或取不到，改用 lastFetchedHtml 手動解析
  if (!tables.length && lastFetchedHtml) {
    const temp = document.createElement('div');
    temp.innerHTML = lastFetchedHtml;
    tables = Array.from(temp.querySelectorAll('table'));
  }

  if (!tables.length) throw new Error('尚未查詢到必修表（請先按「查詢」）');

  let best = null, bestScore = -1;
  for (const t of tables) {
    const txt = t.innerText || t.textContent || '';
    let score = 0;
    if (/必修學分數/.test(txt)) score += 5;
    if (/畢業學分數/.test(txt)) score += 5;
    if (/必修\s*Department Required Courses/i.test(txt)) score += 6;
    if (/Required\s*Credits/i.test(txt)) score += 6;
    if (/選修\s*Elective/i.test(txt)) score += 3;
    if (/Elective\s*Credits/i.test(txt)) score += 3;
    if (/必修Department/i.test(txt)) score += 8;
    if (/科.*目.*Required.*Courses/i.test(txt)) score += 7;
    if (t.querySelector('thead')) score += 1;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best || tables[0];
}

// 由表頭或第一筆資料列來推斷「課名欄 / 學分欄」
function detectFirstCourseColumns(table, sectionHeaderRowIndex) {
  // 嘗試從前兩列（複合表頭）找欄位
  const probeRows = [table.rows[0], table.rows[1]].filter(Boolean);
  let headers = [];
  for (const r of probeRows) {
    headers = headers.concat(Array.from(r.cells).map(c => (c.textContent || '').trim()));
  }
  let nameCol = 1;
  let creditCol = 2;
  const nameIdx = headers.findIndex(h => /科.*目|Required\s*Courses/i.test(h));
  if (nameIdx >= 0) nameCol = nameIdx % (table.rows[0].cells.length || (nameIdx + 1));
  const creditIdx = headers.findIndex(h => /學分|Credits/i.test(h));
  if (creditIdx >= 0) creditCol = creditIdx % (table.rows[0].cells.length || (creditIdx + 1));
  return { nameCol, creditCol };
}

function parseMustListFromPopup() {
  const table = findCurriculumTable();
  if (!table) throw new Error('找不到課綱表格');

  // 收集資料列
  const rows = table.tBodies?.[0]?.rows?.length ? Array.from(table.tBodies[0].rows) : Array.from(table.rows).slice(1);
  if (!rows.length) throw new Error('課綱表格沒有資料列');

  // 將每列合併文字，方便偵測區段
  const rowText = (tr) => Array.from(tr.cells).map(td => (td.textContent || '').trim()).join(' ');

  console.log('表格共有', rows.length, '列資料');
  
  // 先掃一遍找到「必修區段標題」所在索引
  let requiredStart = -1;
  for (let i = 0; i < rows.length; i++) {
    const txt = rowText(rows[i]);
    console.log(`第 ${i} 列內容:`, txt);
    if (/必修\s*Department Required Courses/i.test(txt) || 
        /^必修\s*$/.test(txt) || 
        /Required\s*Courses/i.test(txt) ||
        /必修課程|必修科目/i.test(txt) ||
        /必修Department/i.test(txt)) {  // 新增：匹配 "必修Department Required Courses"
      requiredStart = i;
      console.log('找到必修區段標題在第', i, '列');
      break;
    }
  }
  if (requiredStart < 0) throw new Error('未能定位到「必修」區段標題。請檢查開發者工具查看表格內容。');

  // 推斷欄位位置
  const { nameCol, creditCol } = detectFirstCourseColumns(table, requiredStart);
  console.log('推斷欄位位置 - 課名欄:', nameCol, '學分欄:', creditCol);

  const requiredCourses = [];
  let requiredCreditsTarget = null, electiveCreditsTarget = null, graduateCreditsTarget = null;

  // 從必修區段標題那一列開始往下掃，直到遇到「必修學分數 / 選修學分數 / 畢業學分數」
  for (let i = requiredStart; i < rows.length; i++) {
    const tr = rows[i];
    const txt = rowText(tr);

    // 總結列（遇到就停）- 支援中英文格式
    if (/必修學分數|Required\s*Credits/i.test(txt)) { 
      const m = txt.match(/(?:必修學分數|Required\s*Credits).*?(\d+)/i); 
      if (m) {
        requiredCreditsTarget = parseInt(m[1],10); 
        console.log('找到必修學分數:', requiredCreditsTarget);
      }
      // 不 break，繼續找選修/畢業
    }
  if (/選修學分數|Elective\s*Credits/i.test(txt)) { 
      const m = txt.match(/(?:選修學分數|Elective\s*Credits).*?(\d+)/i); 
      if (m) {
        electiveCreditsTarget = parseInt(m[1],10);
        console.log('找到選修學分數:', electiveCreditsTarget);
      }
      continue; 
    }
  if (/畢業學分數|Graduated?\s*Credits/i.test(txt)) { 
      const m = txt.match(/(?:畢業學分數|Graduated?\s*Credits).*?(\d+)/i); 
      if (m) {
        graduateCreditsTarget = parseInt(m[1],10);
        console.log('找到畢業學分數:', graduateCreditsTarget);
      }
      continue; 
    }

    // 跳過真正的區段標題列本身，但⚠️它常常「同一列就含第一筆課程」
    // 解析策略：嘗試抓該列的課名欄，如果像「代碼-課名」就一併當課程列收進來
    const cellElement = tr.cells[nameCol];
    if (!cellElement) continue;
    
    // 先嘗試從 <a> 標籤中提取課程名稱
    const linkElement = cellElement.querySelector('a');
    let cellText = '';
    if (linkElement) {
      cellText = linkElement.textContent.trim();
    } else {
      cellText = cellElement.textContent.trim();
    }
    
    if (!cellText) continue;
    
    // 若同列含區段標題 + 課名，抽出「代碼-課名」子字串
    let nameRaw = cellText;
    const mCN = nameRaw.match(/[0-9A-Za-z]{3,}\s*-\s*.*/);
    if (mCN) nameRaw = mCN[0];

    const creditRaw = (tr.cells[creditCol]?.textContent || '').trim();
    const looksLikeCourse = /^[0-9A-Za-z]{3,}\s*-\s*/.test(nameRaw) || 
                           /專題|論文|研究|導論|實作|實驗|課程/.test(nameRaw) ||
                           /Seminar|Thesis|Masters|Research/i.test(nameRaw) ||
                           (/^\d+$/.test(creditRaw) && parseFloat(creditRaw) > 0); // 如果學分欄是數字，也認為是課程

    if (looksLikeCourse) {
      const credit = parseFloat(creditRaw);
      console.log('找到課程:', nameRaw, '學分:', credit);
      requiredCourses.push({
        name: nameRaw,
        key:  normalizeName(nameRaw),         // 你先前已經定義好的正規化：會保留 #1/#2… 序號
        credit: isNaN(credit) ? 0 : credit
      });
    }
  }

  if (!requiredCourses.length) {
    throw new Error('未能解析必修課程列（表格格式可能與預期不同）');
  }
  
  // 如果還沒找到學分數，嘗試從表格的特殊結構中解析
  if (requiredCreditsTarget == null || electiveCreditsTarget == null || graduateCreditsTarget == null) {
    console.log('嘗試從特殊結構中解析學分數...');
    for (let i = 0; i < rows.length; i++) {
      const tr = rows[i];
      if (tr.cells.length >= 3) {
        const cell1 = tr.cells[0]?.textContent?.trim() || '';
        const cell2 = tr.cells[1]?.textContent?.trim() || '';
        const cell3 = tr.cells[2]?.textContent?.trim() || '';
        
        // 檢查是否是學分數總結列
        const combinedText = cell1 + cell2;
        if (/必修學分數.*Required.*Credits/i.test(combinedText) && /^\d+$/.test(cell3)) {
          requiredCreditsTarget = parseInt(cell3, 10);
          console.log('從特殊結構找到必修學分數:', requiredCreditsTarget);
        } else if (/選修學分數.*Elective.*Credits/i.test(combinedText) && /^\d+$/.test(cell3)) {
          electiveCreditsTarget = parseInt(cell3, 10);
          console.log('從特殊結構找到選修學分數:', electiveCreditsTarget);
        } else if (/畢業學分數.*Graduated.*Credits/i.test(combinedText) && /^\d+$/.test(cell3)) {
          graduateCreditsTarget = parseInt(cell3, 10);
          console.log('從特殊結構找到畢業學分數:', graduateCreditsTarget);
        }
      }
    }
  }
  
  if (requiredCreditsTarget == null) {
    requiredCreditsTarget = requiredCourses.reduce((s, x) => s + (x.credit || 0), 0);
  }

  console.log('最終解析結果:', {
    requiredCourses: requiredCourses.length,
    requiredCreditsTarget,
    electiveCreditsTarget,
    graduateCreditsTarget
  });

  return { requiredCourses, requiredCreditsTarget, electiveCreditsTarget, graduateCreditsTarget };
}
// ========= 新增：比對邏輯 =========


function toHalfParen(s){ return s.replace(/（/g,'(').replace(/）/g,')'); }
function chineseOrdinalToRoman(s){
  return s.replace(/一/g,'I').replace(/二/g,'II').replace(/三/g,'III').replace(/四/g,'IV').replace(/五/g,'V');
}
function romanParenToHash(s){
  // 注意順序：先 III/IV/II，再 I，避免部分替換
  return s
    .replace(/\(III\)/gi,'#3')
    .replace(/\(IV\)/gi,'#4')
    .replace(/\(II\)/gi,'#2')
    .replace(/\(V\)/gi,'#5')
    .replace(/\(I\)/gi,'#1');
}

function normalizeName(nameRaw){
  if(!nameRaw) return '';
  let s = String(nameRaw);

  // 統一括號 → 中文序號轉羅馬 → 轉 #n
  s = toHalfParen(s);
  s = s.replace(/\((.*?)\)/g,(m,inner)=>'('+chineseOrdinalToRoman(inner)+')');
  s = romanParenToHash(s);

  // ★ 只要括號裡包含 #n，就把整段括號收斂成 #n（丟掉英文）
  s = s.replace(/\([^)]*#(\d+)[^)]*\)/g, '#$1');

  // 移除其他括號內容
  s = s.replace(/\([^)]*\)/g, '');

  // 去掉代碼前綴「12345-」
  s = s.replace(/^[0-9A-Za-z]+-\s*/, '');

  // 去雜訊（保留 #n）
  s = s.replace(/[()．.，,。；;：:\s]/g,'');

  // 去掉重複的 #n（例如 "#1#1" → "#1"）
  s = s.replace(/#(\d+)(?:#\1)+/g, '#$1');

  return s.toLowerCase();
}

function isPassed(gpaText){
  const t = String(gpaText||'').trim();
  if(!t) return false;
  if(/抵免|免修|採計|通過/i.test(t)) return true;
  if(/^f$/i.test(t) || /^w/i.test(t) || /不及格/.test(t)) return false;
  return true;
}


function compareTranscriptWithMust(transcript, mustInfo){
  const { requiredCourses, requiredCreditsTarget, electiveCreditsTarget, graduateCreditsTarget } = mustInfo;

  const mustMap = new Map(); // key -> {name, credit}
  for (const m of requiredCourses) {
    if (m.key) mustMap.set(m.key, { name: m.name, credit: m.credit });
  }

  let earnedTotalCredits = 0;
  let earnedRequiredCredits = 0;
  const passedRequired = new Map(); // key -> {name, credit, source}
  const unmatchedPassed = [];

  for (const r of transcript){
    const credit = parseFloat(r.credit);
    const passed = isPassed(r.gpa);
    const key = normalizeName(r.name);

    if (passed && !isNaN(credit)) earnedTotalCredits += credit;
    if (!passed || !key) continue;

    if (mustMap.has(key)){
      if (!passedRequired.has(key)){
        const req = mustMap.get(key);
        const useCredit = req.credit || credit || 0;
        passedRequired.set(key, { name: req.name, credit: useCredit, source: r });
        earnedRequiredCredits += useCredit;
      }
    } else {
      unmatchedPassed.push(r);
    }
  }

  const missingRequired = [];
  for (const [k, req] of mustMap.entries()){
    if (!passedRequired.has(k)) missingRequired.push({ name: req.name, credit: req.credit });
  }

  const earnedElectiveCredits = Math.max(0, earnedTotalCredits - earnedRequiredCredits);

  return {
    summary: {
      earnedTotalCredits,
      mustTotalCredits: requiredCreditsTarget ?? 0,
      earnedRequiredCredits,
      missingRequiredCredits: Math.max((requiredCreditsTarget ?? 0) - earnedRequiredCredits, 0),
      electiveCreditsTarget: electiveCreditsTarget ?? null,
      earnedElectiveCredits,
      graduateCreditsTarget: graduateCreditsTarget ?? null,
      remainingToGraduate: (graduateCreditsTarget!=null) ? Math.max(graduateCreditsTarget - earnedTotalCredits, 0) : null
    },
    details: {
      passedRequired: Array.from(passedRequired.values()),
      missingRequired,
      unmatchedPassed
    }
  };
}

// ★ 若仍在缺學分或有未通過必修，就不要顯示「🎉」
function renderComparisonReport(report) {
  const wrap = document.createElement('div');
  wrap.className = 'compare-report';
  const s = report.summary;

  // 顯示用課名美化：拿掉開頭代碼與純英文括號備註 (Seminar (I)) / (Masters’ Thesis) 等
  function prettifyCourseName(name){
    if(!name) return '';
    let out = String(name);
    // 去前綴代碼 28126- / ABC123- 等
    out = out.replace(/^[0-9A-Za-z]+-\s*/, '');
    // 移除尾端含英文字母的括號（可能含內層括號），保留中文/全形括號內容
    // 例如："專題討論（一） (Seminar (I))" → "專題討論（一）"
    // 規則：找到第一個 尾端 空白 + '(' 直到結尾；若括號內容含 A-Za-z 則整段砍掉
    // 可能還有多重英文括號，迴圈處理
    let changed = true;
    while (changed) {
      changed = false;
      const m = out.match(/^(.*?)(\s*\((?:[^)]|\)[^)]*?)*\)\s*)$/); // 粗略抓最後一段括號
      if (m) {
        const full = m[2];
        if (/[A-Za-z]/.test(full)) { // 只有含英文字母才去掉
          out = m[1].trimEnd();
          changed = true;
          continue;
        }
      }
      // 簡化版本：若剩餘尾端形如 (....) 且含英文字母直接砍
      out = out.replace(/\s*\((?=[^)]*[A-Za-z])[\s\S]*$/,'');
    }
    // 去除多餘空白
    out = out.trim();
    return out.trim();
  }

  const lines = [];
  lines.push('<h3>比對結果</h3>');
  lines.push('<ul class="stat">');
  lines.push(`<li>已修總學分：<b>${s.earnedTotalCredits}</b></li>`);
  lines.push(`<li>必修應修學分合計：<b>${s.mustTotalCredits}</b></li>`);
  lines.push(`<li>必修已修學分：<b>${s.earnedRequiredCredits}</b></li>`);
  lines.push(`<li>必修尚缺學分：<b>${s.missingRequiredCredits}</b></li>`);
  if (s.electiveCreditsTarget != null) {
    lines.push(`<li>選修應修學分：<b>${s.electiveCreditsTarget}</b>（已修選修估算：<b>${s.earnedElectiveCredits}</b>）</li>`);
  }
  if (s.graduateCreditsTarget != null) {
    lines.push(`<li>畢業學分門檻：<b>${s.graduateCreditsTarget}</b>（距離畢業還差：<b>${s.remainingToGraduate}</b>）</li>`);
  }
  lines.push('</ul>');

  lines.push(`<details open><summary>已通過的必修（${report.details.passedRequired.length} 門）</summary>`);
  lines.push(`<ol>${report.details.passedRequired.map(x => `<li>${prettifyCourseName(x.name)}（${x.credit}學分）</li>`).join('')}</ol>`);
  lines.push('</details>');

  const missCnt = report.details.missingRequired.length;
  lines.push(`<details ${missCnt ? 'open' : ''}><summary>尚未通過的必修（${missCnt} 門）</summary>`);
  lines.push(missCnt
    ? `<ol>${report.details.missingRequired.map(x => `<li>${prettifyCourseName(x.name)}（${x.credit}學分）</li>`).join('')}</ol>`
    : '<div>目前無尚未通過的必修。</div>');
  lines.push('</details>');

  // 只有在「缺學分=0 且 未通過清單=0」時才顯示 🎉
  if (s.missingRequiredCredits === 0 && report.details.missingRequired.length === 0) {
    lines.push('<div>🎉 必修皆已通過！</div>');
  }

  wrap.innerHTML = lines.join('');
  
  // 找到 rawPanel 並在其後插入比對結果
  const rawPanel = document.querySelector('#rawPanel');
  
  // 移除舊的比對報告（如果存在）
  const oldReport = document.querySelector('.compare-report');
  if (oldReport) oldReport.remove();
  
  // 添加分隔線和新的比對報告
  const sep = document.createElement('hr');
  sep.style.margin = '20px 0';
  rawPanel.parentNode.insertBefore(sep, rawPanel.nextSibling);
  rawPanel.parentNode.insertBefore(wrap, sep.nextSibling);
}


// ========= 新增：主流程（按鈕事件） =========
async function handleCompare() {
  try {
    setStatus('擷取成績中（請先打開「歷年成績」頁面）…');
    const transcript = await scrapeTranscriptFromActiveTab();
    setStatus(`擷取到 ${transcript.length} 筆成績，解析必修表中…`);

    console.log('開始解析必修表...');
    const mustCourses = parseMustListFromPopup(); // 需先按「查詢」抓到必修
    console.log('解析到的必修課程:', mustCourses);
    
    const report = compareTranscriptWithMust(transcript, mustCourses);

    renderComparisonReport(report);
    lastReport = report; // ⬅️ 存起來，匯出用
    setStatus('比對完成');
  } catch (e) {
    setStatus('比對失敗：' + e.message);
    console.error('比對錯誤詳情:', e);
    
    // 顯示更詳細的錯誤信息給用戶
    const errorDetails = document.createElement('div');
    errorDetails.style.cssText = 'background:#ffebee;border:1px solid #f44336;padding:8px;margin:8px 0;border-radius:4px;';
    errorDetails.innerHTML = `
      <strong>錯誤詳情：</strong><br>
      ${e.message}<br>
      <small>請檢查開發者工具 Console 了解更多資訊</small>
    `;
    
    const rawPanel = document.querySelector('#rawPanel');
    if (rawPanel && rawPanel.nextSibling) {
      rawPanel.parentNode.insertBefore(errorDetails, rawPanel.nextSibling);
    }
  }
}
