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

let lastRows = [];
let lastReport = null; // ⬅️ 新增：儲存最近一次比對結果

function setStatus(msg) { statusEl.textContent = msg || ''; }

function htmlToDoc(html) {
  const doc = document.implementation.createHTMLDocument('resp');
  doc.documentElement.innerHTML = html;
  return doc;
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
  resultEl.innerHTML = '';
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

  const parsed = parseMustTable(html);
  lastRows = parsed;
  renderTable(parsed);
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

// ========= 新增：DOM 參照 =========
const compareBtn = document.querySelector('#compareBtn');

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
  const container = document.querySelector('#result');
  const tables = Array.from(container?.querySelectorAll('table') || []);
  if (!tables.length) throw new Error('尚未查詢到必修表（請先按「查詢」）');

  let best = null, bestScore = -1;
  for (const t of tables) {
    const txt = t.innerText || t.textContent || '';
    let score = 0;
    if (/必修學分數/.test(txt)) score += 5;
    if (/畢業學分數/.test(txt)) score += 5;
    if (/必修\s*Department Required Courses/i.test(txt)) score += 6;
    if (/選修\s*Elective/i.test(txt)) score += 3;
    if (t.querySelector('thead')) score += 1;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  return best || tables[0];
}

// 由表頭或第一筆資料列來推斷「課名欄 / 學分欄」
function detectFirstCourseColumns(table, sectionHeaderRowIndex) {
  const headRow = table.tHead?.rows?.[0] || table.rows[0];
  const headers = Array.from(headRow?.cells || []).map(th => (th.textContent || '').trim());
  let nameCol = 0;
  let creditCol = headers.findIndex(h => /學分/i.test(h));
  if (creditCol < 0) creditCol = 1; // 預設第 2 欄

  // 如果表頭沒學分，嘗試用區段標題下一列當樣本推斷
  const allRows = table.tBodies?.[0]?.rows?.length ? Array.from(table.tBodies[0].rows) : Array.from(table.rows).slice(1);
  const sampleRow = allRows[sectionHeaderRowIndex + 1] || allRows[0];
  if (sampleRow) {
    const cells = Array.from(sampleRow.cells).map(td => (td.textContent || '').trim());
    // 找到課名看起來像「代碼-課名」的欄
    const nameIdx = cells.findIndex(c => /^[0-9A-Za-z]{3,}\s*-\s*/.test(c));
    if (nameIdx >= 0) nameCol = nameIdx;
    // 在課名欄之後第一個「純數字」欄位視為學分
    if (creditCol < 0 || creditCol <= nameCol) {
      const after = cells.slice(nameCol + 1);
      const rel = after.findIndex(c => /^\d+(\.\d+)?$/.test(c));
      if (rel >= 0) creditCol = nameCol + 1 + rel;
    }
  }
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

  // 先掃一遍找到「必修區段標題」所在索引
  let requiredStart = -1;
  for (let i = 0; i < rows.length; i++) {
    const txt = rowText(rows[i]);
    if (/必修\s*Department Required Courses/i.test(txt) || /^必修\s*$/.test(txt)) {
      requiredStart = i;
      break;
    }
  }
  if (requiredStart < 0) throw new Error('未能定位到「必修」區段標題');

  // 推斷欄位位置
  const { nameCol, creditCol } = detectFirstCourseColumns(table, requiredStart);

  const requiredCourses = [];
  let requiredCreditsTarget = null, electiveCreditsTarget = null, graduateCreditsTarget = null;

  // 從必修區段標題那一列開始往下掃，直到遇到「必修學分數 / 選修學分數 / 畢業學分數」
  for (let i = requiredStart; i < rows.length; i++) {
    const tr = rows[i];
    const txt = rowText(tr);

    // 總結列（遇到就停）
    if (/必修學分數/i.test(txt)) { const m = txt.match(/必修學分數.*?(\d+)/); if (m) requiredCreditsTarget = parseInt(m[1],10); break; }
    if (/選修學分數/i.test(txt)) { const m = txt.match(/選修學分數.*?(\d+)/); if (m) electiveCreditsTarget = parseInt(m[1],10); continue; }
    if (/畢業學分數/i.test(txt)) { const m = txt.match(/畢業學分數.*?(\d+)/); if (m) graduateCreditsTarget = parseInt(m[1],10); continue; }

    // 跳過真正的區段標題列本身，但⚠️它常常「同一列就含第一筆課程」
    // 解析策略：嘗試抓該列的課名欄，如果像「代碼-課名」就一併當課程列收進來
    const cellText = (tr.cells[nameCol]?.textContent || '').trim();
    if(!cellText) continue;
    // 若同列含區段標題 + 課名，抽出「代碼-課名」子字串
    let nameRaw = cellText;
    const mCN = nameRaw.match(/[0-9A-Za-z]{3,}\s*-\s*.*/);
    if (mCN) nameRaw = mCN[0];

    const creditRaw = (tr.cells[creditCol]?.textContent || '').trim();
    const looksLikeCourse = /^[0-9A-Za-z]{3,}\s*-\s*/.test(nameRaw) || /專題|論文|研究|導論|實作|實驗|課程/.test(nameRaw);

    if (looksLikeCourse) {
      const credit = parseFloat(creditRaw);
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
  if (requiredCreditsTarget == null) {
    requiredCreditsTarget = requiredCourses.reduce((s, x) => s + (x.credit || 0), 0);
  }

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
  lines.push(`<ol>${report.details.passedRequired.map(x => `<li>${x.name}（${x.credit}學分）</li>`).join('')}</ol>`);
  lines.push('</details>');

  const missCnt = report.details.missingRequired.length;
  lines.push(`<details ${missCnt ? 'open' : ''}><summary>尚未通過的必修（${missCnt} 門）</summary>`);
  lines.push(missCnt
    ? `<ol>${report.details.missingRequired.map(x => `<li>${x.name}（${x.credit}學分）</li>`).join('')}</ol>`
    : '<div>目前無尚未通過的必修。</div>');
  lines.push('</details>');

  // 只有在「缺學分=0 且 未通過清單=0」時才顯示 🎉
  if (s.missingRequiredCredits === 0 && report.details.missingRequired.length === 0) {
    lines.push('<div>🎉 必修皆已通過！</div>');
  }

  wrap.innerHTML = lines.join('');
  const resultEl = document.querySelector('#result');
  const sep = document.createElement('hr');
  resultEl.appendChild(sep);
  resultEl.appendChild(wrap);
}


// ========= 新增：主流程（按鈕事件） =========
async function handleCompare() {
  try {
    setStatus('擷取成績中（請先打開「歷年成績」頁面）…');
    const transcript = await scrapeTranscriptFromActiveTab();
    setStatus(`擷取到 ${transcript.length} 筆成績，解析必修表中…`);

    const mustCourses = parseMustListFromPopup(); // 需先按「查詢」抓到必修
    const report = compareTranscriptWithMust(transcript, mustCourses);

    renderComparisonReport(report);
    lastReport = report; // ⬅️ 存起來，匯出用
    setStatus('比對完成');
  } catch (e) {
    setStatus('比對失敗：' + e.message);
    console.error(e);
  }
}
compareBtn?.addEventListener('click', handleCompare);
