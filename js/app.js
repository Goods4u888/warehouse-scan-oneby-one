// ============================================================================
// View router + UI wiring. DB.* does all data access, QR.* does codes/camera,
// I18n/t() does display strings.
// ============================================================================

const CATS = {
  Cement: 'cement', Steel: 'steel', Aggregate: 'aggregate',
  'Pipe & Fittings': 'hardware', Hardware: 'hardware',
  Electrical: 'electrical', 'Sanitary Ware': 'sanitary', Paint: 'paint',
  Lumber: 'lumber', 'Cleaning Supplies': 'cleaning',
  Flooring: 'flooring', Ceiling: 'ceiling', Furniture: 'furniture', 'Curtains & Blinds': 'curtains',
};
function catClass(category) {
  return CATS[category] || 'other';
}

// category is stored (and matched against skus.category / the "add
// category" flow) as the English name seeded in schema.sql/the mockup
// seeds — this only changes how it's *displayed* in Thai, same pattern as
// every other t()-driven label. A category a staff member typed by hand
// (via the "+" add-category button) has no entry here and just falls back
// to whatever they typed, which is normal since that's already Thai text.
const CATEGORY_LABELS_TH = {
  Cement: 'ปูนซีเมนต์', Steel: 'เหล็ก', Aggregate: 'หินและทราย',
  'Pipe & Fittings': 'ท่อและอุปกรณ์ประปา', Hardware: 'ฮาร์ดแวร์',
  Electrical: 'ไฟฟ้า', 'Sanitary Ware': 'สุขภัณฑ์', Paint: 'สีและอุปกรณ์ทาสี',
  Lumber: 'ไม้และวัสดุแผ่น', 'Cleaning Supplies': 'อุปกรณ์ทำความสะอาด',
  Flooring: 'พื้นและวัสดุปูพื้น', Ceiling: 'ฝ้าเพดาน', Furniture: 'เฟอร์นิเจอร์',
  'Curtains & Blinds': 'ผ้าม่านและมู่ลี่',
};
function catLabel(category) {
  return I18n.current === 'th' ? (CATEGORY_LABELS_TH[category] || category) : category;
}
function fmtQty(n) {
  const num = Number(n);
  return Number.isInteger(num) ? String(num) : num.toFixed(2).replace(/\.?0+$/, '');
}
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function statusLabel(status) {
  const map = {
    all: t('statusAll'), pending: t('statusPending'), preparing: t('statusPreparing'),
    ready: t('statusReady'), fulfilled: t('statusFulfilled'), cancelled: t('statusCancelled'),
  };
  return map[status] || status;
}
const STATUS_ICONS = {
  all: 'list', pending: 'clock', preparing: 'package', ready: 'checkCircle', fulfilled: 'checkSquare',
};

// ---- Toast -------------------------------------------------------------------
function toast(msg, kind = '') {
  const host = document.getElementById('toast-host');
  const el = document.createElement('div');
  el.className = `toast ${kind}`.trim();
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ---- Sheet (bottom modal) -------------------------------------------------------
const Sheet = {
  open(title, bodyHtml) {
    document.getElementById('sheet-title').textContent = title;
    document.getElementById('sheet-body').innerHTML = bodyHtml;
    document.getElementById('scrim').hidden = false;
  },
  close() {
    document.getElementById('scrim').hidden = true;
    document.getElementById('sheet-body').innerHTML = '';
  },
};
document.getElementById('sheet-close').addEventListener('click', Sheet.close);
document.getElementById('scrim').addEventListener('click', (e) => {
  if (e.target.id === 'scrim') Sheet.close();
});

// ---- Language ----------------------------------------------------------------
document.getElementById('lang-toggle').addEventListener('click', () => {
  I18n.setLang(I18n.current === 'th' ? 'en' : 'th');
});
// Called by I18n.setLang() after it repaints every data-i18n element. Anything
// built by JS (not plain markup) needs its own re-render here.
function onLanguageChange() {
  renderRequestTabs();
  if (currentView === 'stock') { renderStockFacets(); renderStock(); }
  else if (currentView === 'receive') { loadReceiveForm(); loadReturnForm(); updateReceiveSectionTitle(); }
  else if (currentView === 'issue') { resetScanView(); }
  else if (currentView === 'requests') { loadRequests(); }
  else if (currentView === 'reports') { loadReport(currentReport); }
}

// ---- Router --------------------------------------------------------------------
const VIEWS = ['stock', 'receive', 'issue', 'requests', 'reports'];
let currentView = 'stock';

function showView(name) {
  if (currentView === 'issue' && name !== 'issue') {
    QR.stopScanner(document.getElementById('scan-video'));
  }
  currentView = name;
  VIEWS.forEach((v) => {
    document.getElementById(`view-${v}`).hidden = v !== name;
  });
  document.querySelectorAll('.tabbar button').forEach((b) => {
    if (b.dataset.view === name) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  if (name === 'stock') loadStock();
  if (name === 'receive') { loadReceiveForm(); loadReturnForm(); }
  if (name === 'issue') resetScanView();
  if (name === 'requests') loadRequests();
  if (name === 'reports') loadReport(currentReport);
}

document.querySelectorAll('.tabbar button').forEach((b) => {
  b.addEventListener('click', () => showView(b.dataset.view));
});
document.getElementById('btn-refresh').addEventListener('click', () => showView(currentView));

// ============================================================================
// STOCK
// ============================================================================
let stockRows = [];
let stockFacet = 'all';
let stockSearch = '';

document.getElementById('stock-search').addEventListener('input', (e) => {
  stockSearch = e.target.value;
  renderStock();
});

async function loadStock() {
  const list = document.getElementById('stock-list');
  list.innerHTML = skeletonCards(4);
  try {
    stockRows = await DB.stockBySku();
    renderStockFacets();
    renderStock();
  } catch (err) {
    list.innerHTML = '';
    toast(err.message || 'Could not load stock', 'error');
  }
}

function renderStockFacets() {
  const cats = ['all', ...new Set(stockRows.map((r) => r.category))];
  const el = document.getElementById('stock-facets');
  el.innerHTML = cats.map((c) => `
    <button class="facet" data-cat="${escapeHtml(c)}" aria-pressed="${c === stockFacet}">${icon(c === 'all' ? 'list' : catIcon(c), 14)}<span>${c === 'all' ? t('facetAll') : escapeHtml(catLabel(c))}</span></button>
  `).join('');
  el.querySelectorAll('.facet').forEach((btn) => {
    btn.addEventListener('click', () => { stockFacet = btn.dataset.cat; renderStockFacets(); renderStock(); });
  });
}

function renderStock() {
  let rows = stockFacet === 'all' ? stockRows : stockRows.filter((r) => r.category === stockFacet);
  const q = stockSearch.trim().toLowerCase();
  if (q) {
    rows = rows.filter((r) => r.sku_code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
  }
  document.getElementById('stock-total').textContent = stockRows.length;
  document.getElementById('stock-low-count').textContent = stockRows.filter((r) => r.is_low).length;

  const list = document.getElementById('stock-list');
  if (!rows.length) {
    list.innerHTML = `<div class="empty"><p>${q ? t('emptySearchResults', escapeHtml(stockSearch.trim())) : t('emptyStockCategory')}</p></div>`;
    return;
  }
  list.innerHTML = rows.map((r) => `
    <div class="card card-clickable" data-sku-id="${r.sku_id}" role="button" tabindex="0">
      <div class="card-row">
        <div>
          <div class="card-title">${escapeHtml(r.name)}</div>
          <div class="card-meta mono">${escapeHtml(r.sku_code)}</div>
        </div>
        <div style="text-align:right">
          <div class="stat-figure" style="font-size:var(--t-sec)">${fmtQty(r.on_hand)}<span style="font-size:var(--t-micro);color:var(--ink-3)"> ${escapeHtml(r.base_uom)}</span></div>
        </div>
      </div>
      <div class="card-row" style="margin-top:var(--s3)">
        <span class="chip chip-cat-${catClass(r.category)}">${icon(catIcon(r.category), 12)}${escapeHtml(catLabel(r.category))}</span>
        ${r.is_low
          ? `<span class="chip chip-low"><span class="dot"></span>${t('chipBelowThreshold', fmtQty(r.min_threshold))}</span>`
          : `<span class="chip chip-ok"><span class="dot"></span>${t('chipOk')}</span>`}
      </div>
    </div>
  `).join('');
}

// Tapping a Stock card opens its item detail sheet — event delegation since
// the list is fully re-rendered on every search/facet/refresh.
document.getElementById('stock-list').addEventListener('click', (e) => {
  const card = e.target.closest('[data-sku-id]');
  if (!card) return;
  const row = stockRows.find((r) => r.sku_id === card.dataset.skuId);
  if (row) openItemDetailSheet(row);
});
document.getElementById('stock-list').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const card = e.target.closest('[data-sku-id]');
  if (!card) return;
  e.preventDefault();
  const row = stockRows.find((r) => r.sku_id === card.dataset.skuId);
  if (row) openItemDetailSheet(row);
});

document.getElementById('btn-scan-shortcut').addEventListener('click', () => showView('issue'));

// ---- Item detail (Stock -> tap a card) ---------------------------------------
// A read-only summary of one item — on-hand/threshold/status plus its most
// recent movements (js/db.js: movementHistoryForSku) — with shortcuts into
// the same Issue/Receive/Print actions available elsewhere, so a card tap
// covers "what is this, how much do we have, what happened to it lately" in
// one place instead of needing Reports/Scan/Manage items separately.
function openItemDetailSheet(row) {
  Sheet.open(t('itemDetailTitle'), `
    ${row.image_paths?.[0] ? `<img class="idet-photo" src="${DB.getItemPhotoUrl(row.image_paths[0])}" alt="">` : ''}
    <div class="card-row" style="align-items:flex-start">
      <div>
        <div class="card-title" style="font-size:var(--t-sec)">${escapeHtml(row.name)}</div>
        <div class="card-meta mono">${escapeHtml(row.sku_code)}</div>
      </div>
      <span class="chip chip-cat-${catClass(row.category)}">${icon(catIcon(row.category), 12)}${escapeHtml(catLabel(row.category))}</span>
    </div>

    <div class="card-row" style="margin-top:var(--s5)">
      <div>
        <div class="stat-label">${t('onHandLabel')}</div>
        <div class="stat-figure">${fmtQty(row.on_hand)}<span style="font-size:var(--t-micro);color:var(--ink-3)"> ${escapeHtml(row.base_uom)}</span></div>
      </div>
      ${row.is_low
        ? `<span class="chip chip-low"><span class="dot"></span>${t('chipBelowThreshold', fmtQty(row.min_threshold))}</span>`
        : `<span class="chip chip-ok"><span class="dot"></span>${t('chipOk')}</span>`}
    </div>
    <div class="field-hint">${t('itemDetailThresholdHint', fmtQty(row.min_threshold), escapeHtml(row.base_uom))}</div>

    <div class="section-head"><h2>${t('itemDetailRecentActivity')}</h2></div>
    <div id="idet-movements">${skeletonCards(2)}</div>

    <div class="idet-actions">
      <button class="btn btn-primary" id="idet-btn-issue" data-icon="check"><span>${t('scanActionIssue')}</span></button>
      <button class="btn btn-outline" id="idet-btn-receive" data-icon="package"><span>${t('scanActionReceive')}</span></button>
    </div>
    <div class="field-with-btn" style="margin-top:var(--s2)">
      <div class="qty-field">
        <label class="qty-field-label" for="idet-print-qty">${t('fieldCopies')}</label>
        <input type="number" class="qty-mini-input" id="idet-print-qty" min="1" max="${STICKERS_PER_SHEET_MAX}" value="${STICKERS_PER_SHEET}">
      </div>
      <button class="btn btn-outline" id="idet-btn-print">${icon('printer', 16)}<span>${t('btnPrintSticker')}</span></button>
    </div>
  `);
  applyStaticIcons();

  document.getElementById('idet-btn-issue').addEventListener('click', () => {
    Sheet.close();
    showView('issue');
    onItemScanned(row.sku_code, 'issue');
  });
  document.getElementById('idet-btn-receive').addEventListener('click', () => {
    Sheet.close();
    showView('issue');
    onItemScanned(row.sku_code, 'receive');
  });
  document.getElementById('idet-btn-print').addEventListener('click', () => {
    printSkuSticker({ sku_code: row.sku_code, name: row.name }, readStickerCount('idet-print-qty'));
  });

  loadItemDetailMovements(row.sku_code);
}

async function loadItemDetailMovements(skuCode) {
  const box = document.getElementById('idet-movements');
  if (!box) return;
  try {
    const rows = await DB.movementHistoryForSku(skuCode, 5);
    if (!box.isConnected) return; // sheet closed while this was in flight
    if (!rows.length) {
      box.innerHTML = `<div class="empty"><p>${t('itemDetailNoActivity')}</p></div>`;
      return;
    }
    const typeLabel = { receive: t('mvReceive'), issue: t('mvIssue'), return: t('mvReturn') };
    const sign = { receive: '+', issue: '−', return: '+' };
    const qtyClass = { receive: 'pos', issue: 'neg', return: 'pos' };
    box.innerHTML = `<div class="idet-move-list">${rows.map((m) => `
      <div class="idet-move-row">
        <div class="idet-move-row-text">
          <span class="card-title" style="font-size:var(--t-meta)">${escapeHtml(typeLabel[m.type] || m.type)}</span>
          <span class="card-meta">${fmtDate(m.created_at)}${m.performed_by ? ` · ${escapeHtml(m.performed_by)}` : ''}</span>
          ${m.image_paths?.length ? `<button type="button" class="btn btn-ghost btn-sm idet-move-photos" data-paths="${escapeHtml(JSON.stringify(m.image_paths))}">${icon('image', 13)}<span>${t('btnViewPhotos', m.image_paths.length)}</span></button>` : ''}
        </div>
        <span class="idet-move-qty ${qtyClass[m.type] || ''}">${sign[m.type] || ''}${fmtQty(m.qty)} ${escapeHtml(m.uom)}</span>
      </div>
    `).join('')}</div>`;
    box.querySelectorAll('.idet-move-photos').forEach((btn) => {
      btn.addEventListener('click', () => openEvidenceLightbox(JSON.parse(btn.getAttribute('data-paths'))));
    });
  } catch (err) {
    if (box.isConnected) box.innerHTML = '';
  }
}

function skeletonCards(n) {
  return Array.from({ length: n }).map(() => `<div class="card"><div class="skeleton" style="height:52px"></div></div>`).join('');
}

// ============================================================================
// MANAGE ITEMS (SKU master-data CRUD)
// ============================================================================
let miAllSkus = [];
let miEditingId = null;
let miCategories = [];
// IDs checked via the Manage Items checkboxes, for the bulk "print selected"
// A4 sticker sheet. Reset each time the sheet is (re)opened — selection
// isn't meant to persist across separate visits to Manage Items.
let miSelectedIds = new Set();

document.getElementById('btn-manage-items').addEventListener('click', openManageItemsSheet);

async function refreshSkuCaches() {
  try {
    activeSkus = await DB.listSkus({ activeOnly: true });
  } catch (_) { /* ignore — next view load will surface any real error */ }
  if (currentView === 'stock') loadStock();
}

function openManageItemsSheet() {
  miSelectedIds = new Set();
  Sheet.open(t('manageItemsTitle'), manageItemsSheetHtml());
  wireManageItemsForm();
  loadManageItemsCategories();
  loadManageItemsList();
}

async function loadManageItemsCategories() {
  try {
    miCategories = await DB.listCategories();
    renderCategoryOptions();
  } catch (err) {
    toast(err.message || 'Could not load categories', 'error');
  }
}

function renderCategoryOptions(selected = '') {
  const sel = document.getElementById('mi-category');
  if (!sel) return;
  const current = selected || sel.value;
  sel.innerHTML = `
    <option value="" disabled ${current ? '' : 'selected'}>${t('selectCategoryPlaceholder')}</option>
    ${miCategories.map((c) => `<option value="${escapeHtml(c.name)}" ${c.name === current ? 'selected' : ''}>${escapeHtml(catLabel(c.name))}</option>`).join('')}
  `;
}

function miSubmitButtonInner(mode) {
  return mode === 'edit'
    ? `${icon('checkCircle', 16)}<span>${t('saveChanges')}</span>`
    : `${icon('plusCircle', 16)}<span>${t('addItem')}</span>`;
}

function manageItemsSheetHtml() {
  return `
    <div id="mi-error"></div>
    <form id="form-manage-item">
      <div class="field-row">
        <div class="field">
          <label for="mi-sku-code">${t('fieldSkuCode')}</label>
          <input type="text" id="mi-sku-code" disabled placeholder="${t('skuCodeAutoPlaceholder')}">
        </div>
        <div class="field">
          <label for="mi-category">${t('fieldCategory')}</label>
          <div class="field-with-btn">
            <select id="mi-category" required></select>
            <button type="button" class="btn-icon-add" id="mi-category-add-btn" title="${t('addCategoryTitle')}" aria-label="${t('addCategoryTitle')}">${icon('plusCircle', 18)}</button>
          </div>
          <div class="new-category-row" id="mi-category-new-row" hidden>
            <input type="text" id="mi-category-new-input" placeholder="${t('newCategoryPlaceholder')}">
            <button type="button" class="btn btn-outline btn-sm" id="mi-category-new-confirm">${icon('check', 14)}<span>${t('add')}</span></button>
            <button type="button" class="btn btn-ghost btn-sm" id="mi-category-new-cancel">${icon('xCircle', 14)}</button>
          </div>
        </div>
      </div>
      <div class="field">
        <label for="mi-name">${t('fieldName')}</label>
        <input type="text" id="mi-name" required>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="mi-base-uom">${t('fieldBaseUom')}</label>
          <input type="text" id="mi-base-uom" required>
        </div>
        <div class="field">
          <label for="mi-min-threshold">${t('fieldMinThreshold')}</label>
          <input type="number" id="mi-min-threshold" min="0" step="any" required>
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="mi-alt-uom">${t('fieldAltUom')}</label>
          <input type="text" id="mi-alt-uom">
        </div>
        <div class="field">
          <label for="mi-conversion-factor">${t('fieldConversionFactor')}</label>
          <input type="number" id="mi-conversion-factor" min="0" step="any">
        </div>
      </div>
      <div class="field">
        <label for="mi-photo">${t('fieldItemPhoto')}</label>
        <input type="file" id="mi-photo" accept="image/*" multiple>
        <div class="evidence-thumbs" id="mi-photo-preview"></div>
      </div>
      <div class="card-row">
        <button type="button" class="btn btn-ghost" id="mi-cancel-edit" hidden>${icon('xCircle', 16)}<span>${t('cancel')}</span></button>
        <button type="submit" class="btn btn-primary btn-block" id="mi-submit">${miSubmitButtonInner('add')}</button>
      </div>
    </form>

    <div class="mi-bulk-bar">
      <label class="mi-check mi-select-all">
        <input type="checkbox" id="mi-select-all">
        <span>${t('selectAll')}</span>
      </label>
      <button type="button" class="btn btn-primary btn-sm" id="mi-print-selected" disabled>${icon('printer', 14)}<span id="mi-print-selected-label">${t('btnPrintSelected')}</span></button>
    </div>

    <div class="section-head"><h2>${t('activeItems')}</h2></div>
    <div id="mi-active-list" class="card-list"></div>
    <div class="section-head"><h2>${t('inactiveItems')}</h2></div>
    <div id="mi-inactive-list" class="card-list"></div>
  `;
}

// Distinct from evidenceState (Receive/Return/Issue) — an item can have
// several photos, sourced from two places at once while the form is open:
// existingPaths (already on the item, from sku_images) minus whatever's in
// removedPaths, plus newFiles (picked just now, not yet uploaded). The
// final photo set is only resolved at submit time — see onManageItemSubmit.
let miPhotos = { existingPaths: [], removedPaths: new Set(), newFiles: [] };

function resetMiPhotos() {
  miPhotos = { existingPaths: [], removedPaths: new Set(), newFiles: [] };
}

function wireMiPhotoPicker() {
  renderMiPhotoThumbs();
  document.getElementById('mi-photo').addEventListener('change', (e) => {
    miPhotos.newFiles.push(...Array.from(e.target.files));
    e.target.value = '';
    renderMiPhotoThumbs();
  });
}

function renderMiPhotoThumbs() {
  const box = document.getElementById('mi-photo-preview');
  if (!box) return;
  const kept = miPhotos.existingPaths.filter((p) => !miPhotos.removedPaths.has(p));
  const thumbs = [
    ...kept.map((p) => ({ kind: 'existing', key: p, src: DB.getItemPhotoUrl(p) })),
    ...miPhotos.newFiles.map((f, i) => ({ kind: 'new', key: String(i), src: URL.createObjectURL(f) })),
  ];
  box.innerHTML = thumbs.map((th) => `
    <div class="evidence-thumb">
      <img src="${th.src}" alt="">
      <button type="button" class="evidence-thumb-remove" data-kind="${th.kind}" data-key="${escapeHtml(th.key)}" aria-label="${escapeHtml(t('btnRemoveItem'))}">${icon('xCircle', 12)}</button>
    </div>
  `).join('');
  box.querySelectorAll('.evidence-thumb-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.kind === 'existing') {
        miPhotos.removedPaths.add(btn.dataset.key);
      } else {
        miPhotos.newFiles.splice(Number(btn.dataset.key), 1);
      }
      renderMiPhotoThumbs();
    });
  });
}

function wireManageItemsForm() {
  miEditingId = null;
  const form = document.getElementById('form-manage-item');
  form.addEventListener('submit', onManageItemSubmit);
  wireMiPhotoPicker();
  document.getElementById('mi-cancel-edit').addEventListener('click', () => {
    miEditingId = null;
    form.reset();
    document.getElementById('mi-sku-code').value = '';
    renderCategoryOptions();
    resetMiPhotos();
    renderMiPhotoThumbs();
    document.getElementById('mi-submit').innerHTML = miSubmitButtonInner('add');
    document.getElementById('mi-cancel-edit').hidden = true;
  });

  const addBtn = document.getElementById('mi-category-add-btn');
  const newRow = document.getElementById('mi-category-new-row');
  const newInput = document.getElementById('mi-category-new-input');
  addBtn.addEventListener('click', () => {
    newRow.hidden = !newRow.hidden;
    if (!newRow.hidden) newInput.focus();
  });
  document.getElementById('mi-category-new-cancel').addEventListener('click', () => {
    newInput.value = '';
    newRow.hidden = true;
  });
  document.getElementById('mi-category-new-confirm').addEventListener('click', () => onAddCategory(newInput, newRow));
  newInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); onAddCategory(newInput, newRow); }
  });

  // Bulk-print toolbar lives outside the two list containers that
  // renderManageItemsLists() rewrites, so it's wired once here rather than
  // on every render (unlike the per-row checkboxes, which are re-bound each
  // time since renderManageItemsLists() recreates those elements).
  document.getElementById('mi-select-all').addEventListener('change', (e) => {
    if (e.target.checked) {
      miAllSkus.forEach((s) => miSelectedIds.add(s.id));
    } else {
      miSelectedIds.clear();
    }
    renderManageItemsLists();
  });
  document.getElementById('mi-print-selected').addEventListener('click', printSelectedStickers);
}

async function onAddCategory(newInput, newRow) {
  const name = newInput.value.trim();
  const errEl = document.getElementById('mi-error');
  errEl.innerHTML = '';
  if (!name) return;
  try {
    await DB.createCategory(name);
    miCategories = await DB.listCategories();
    renderCategoryOptions(name);
    newInput.value = '';
    newRow.hidden = true;
    toast(t('toastCategoryCreated'), 'success');
  } catch (err) {
    const msg = /duplicate|unique/i.test(err.message || '') ? t('errorCategoryExists') : (err.message || 'Could not add category');
    errEl.innerHTML = `<div class="form-error">${escapeHtml(msg)}</div>`;
  }
}

async function onManageItemSubmit(e) {
  e.preventDefault();
  const errEl = document.getElementById('mi-error');
  errEl.innerHTML = '';
  const patch = {
    name: document.getElementById('mi-name').value.trim(),
    category: document.getElementById('mi-category').value.trim(),
    base_uom: document.getElementById('mi-base-uom').value.trim(),
    alt_uom: document.getElementById('mi-alt-uom').value.trim() || null,
    conversion_factor: document.getElementById('mi-conversion-factor').value
      ? parseFloat(document.getElementById('mi-conversion-factor').value) : null,
    min_threshold: parseFloat(document.getElementById('mi-min-threshold').value || '0'),
  };
  const btn = document.getElementById('mi-submit');
  btn.disabled = true;
  try {
    // Resolve the final photo set: existing photos minus whatever was
    // removed, plus newly picked files uploaded now.
    const keptPaths = miPhotos.existingPaths.filter((p) => !miPhotos.removedPaths.has(p));
    const uploadedPaths = [];
    for (const file of miPhotos.newFiles) {
      uploadedPaths.push(await DB.uploadItemPhoto(file));
    }
    const finalPaths = [...keptPaths, ...uploadedPaths];

    if (miEditingId) {
      await DB.updateSku(miEditingId, patch);
      await DB.setSkuImages(miEditingId, finalPaths);
      toast(t('toastItemUpdated'), 'success');
    } else {
      await DB.createSku({ ...patch, imagePaths: finalPaths });
      toast(t('toastItemCreated'), 'success');
    }
    miEditingId = null;
    e.target.reset();
    document.getElementById('mi-sku-code').value = '';
    renderCategoryOptions();
    resetMiPhotos();
    renderMiPhotoThumbs();
    document.getElementById('mi-submit').innerHTML = miSubmitButtonInner('add');
    document.getElementById('mi-cancel-edit').hidden = true;
    await loadManageItemsList();
    await refreshSkuCaches();
  } catch (err) {
    errEl.innerHTML = `<div class="form-error">${escapeHtml(err.message || 'Could not save item')}</div>`;
  } finally {
    btn.disabled = false;
  }
}

async function loadManageItemsList() {
  try {
    miAllSkus = await DB.listSkus({ activeOnly: false });
    renderManageItemsLists();
  } catch (err) {
    toast(err.message || 'Could not load items', 'error');
  }
}

function renderManageItemsLists() {
  // Drop any selected id that no longer exists (e.g. after a reload) so the
  // toolbar's count/checkbox state never drifts from what's actually there.
  const liveIds = new Set(miAllSkus.map((s) => s.id));
  miSelectedIds.forEach((id) => { if (!liveIds.has(id)) miSelectedIds.delete(id); });

  const active = miAllSkus.filter((s) => s.is_active);
  const inactive = miAllSkus.filter((s) => !s.is_active);
  const activeEl = document.getElementById('mi-active-list');
  const inactiveEl = document.getElementById('mi-inactive-list');
  activeEl.innerHTML = active.length ? active.map(miRowHtml).join('') : `<div class="empty"><p>${t('emptyGeneric')}</p></div>`;
  inactiveEl.innerHTML = inactive.length ? inactive.map(miRowHtml).join('') : `<div class="empty"><p>${t('emptyGeneric')}</p></div>`;

  document.querySelectorAll('[data-mi-edit]').forEach((btn) => {
    btn.addEventListener('click', () => startEditSku(btn.dataset.miEdit));
  });
  document.querySelectorAll('[data-mi-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => toggleSkuActive(btn.dataset.miToggle, btn.dataset.toActive === 'true'));
  });
  document.querySelectorAll('[data-mi-print]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sku = miAllSkus.find((s) => s.id === btn.dataset.miPrint);
      if (sku) printSkuSticker(sku, readStickerCount(`mi-print-qty-${sku.id}`));
    });
  });
  document.querySelectorAll('[data-mi-units]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const sku = miAllSkus.find((s) => s.id === btn.dataset.miUnits);
      if (sku) generateMissingUnitStickers(sku);
    });
  });
  document.querySelectorAll('[data-mi-select]').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) miSelectedIds.add(cb.dataset.miSelect);
      else miSelectedIds.delete(cb.dataset.miSelect);
      updateBulkPrintToolbar();
    });
  });
  updateBulkPrintToolbar();
}

// Keeps the "select all" checkbox and "Print selected" button in sync with
// miSelectedIds — called after every list render and every checkbox change,
// since the count/enabled-state can't just be computed once.
function updateBulkPrintToolbar() {
  const selectAll = document.getElementById('mi-select-all');
  const printBtn = document.getElementById('mi-print-selected');
  const label = document.getElementById('mi-print-selected-label');
  if (!selectAll || !printBtn || !label) return;
  const count = miSelectedIds.size;
  selectAll.checked = miAllSkus.length > 0 && count === miAllSkus.length;
  printBtn.disabled = count === 0;
  label.textContent = count > 0 ? `${t('btnPrintSelected')} · ${t('selectedCount', count)}` : t('btnPrintSelected');
}

function miRowHtml(s) {
  const checked = miSelectedIds.has(s.id) ? 'checked' : '';
  return `
    <div class="card">
      <div class="card-row mi-row-head">
        <label class="mi-check">
          <input type="checkbox" data-mi-select="${s.id}" ${checked} aria-label="${t('selectAll')}">
        </label>
        ${s.image_paths?.[0] ? `<img class="mi-row-thumb" src="${DB.getItemPhotoUrl(s.image_paths[0])}" alt="">` : ''}
        <div>
          <div class="card-title">${escapeHtml(s.name)}</div>
          <div class="card-meta mono">${escapeHtml(s.sku_code)} · ${escapeHtml(s.base_uom)}</div>
        </div>
      </div>
      <div class="card-row" style="margin-top:var(--s3)">
        <span class="chip chip-cat-${catClass(s.category)}">${icon(catIcon(s.category), 12)}${escapeHtml(catLabel(s.category))}</span>
      </div>
      <div class="card-row" style="margin-top:var(--s3);flex-wrap:wrap">
        <button class="btn btn-outline btn-sm" data-mi-edit="${s.id}">${icon('pencil', 14)}<span>${t('btnEdit')}</span></button>
        <div class="qty-field">
          <label class="qty-field-label" for="mi-print-qty-${s.id}">${t('fieldCopies')}</label>
          <input type="number" class="qty-mini-input" id="mi-print-qty-${s.id}" min="1" max="${STICKERS_PER_SHEET_MAX}" value="${STICKERS_PER_SHEET}">
        </div>
        <button class="btn btn-outline btn-sm" data-mi-print="${s.id}">${icon('printer', 14)}<span>${t('btnPrintSticker')}</span></button>
        <button class="btn btn-outline btn-sm" data-mi-units="${s.id}">${icon('qr', 14)}<span>${t('btnGenerateMissingUnits')}</span></button>
        ${s.is_active
          ? `<button class="btn btn-ghost btn-sm" data-mi-toggle="${s.id}" data-to-active="false">${icon('xCircle', 14)}<span>${t('btnDeactivate')}</span></button>`
          : `<button class="btn btn-ghost btn-sm" data-mi-toggle="${s.id}" data-to-active="true">${icon('checkCircle', 14)}<span>${t('btnActivate')}</span></button>`}
      </div>
    </div>
  `;
}

// A single item's sticker is never printed just once: physically you need
// one for the shelf/bin plus spares (a worn sticker, a second bin holding
// the same item, etc.), so every "print sticker" action for one item
// prints a full A4 sheet of repeated copies instead of a lone sticker.
// Reuses the same grid layout as the bulk "Print selected" action below
// (.print-sticker-grid in app.css) — just every cell is the same item.
// idPrefix must be unique per caller (Manage Items / Receive / Return all
// call this) so their copies' QR container ids never collide if two of
// these somehow render back to back.
const STICKERS_PER_SHEET = 20;
const STICKERS_PER_SHEET_MAX = 200;
function printStickerSheet(sku, idPrefix, count = STICKERS_PER_SHEET) {
  const box = document.getElementById('admin-print-sheet');
  const copies = Array.from({ length: count }, (_, i) => i);
  box.innerHTML = copies
    .map((i) => QR.stickerHtml({ skuCode: sku.sku_code, skuName: sku.name, idPrefix: `${idPrefix}${i}-` }))
    .join('');
  copies.forEach((i) => QR.renderInto(document.getElementById(`${idPrefix}${i}-${sku.sku_code}`), sku.sku_code, 120));
  window.print();
}

// One sticker per PHYSICAL unit, each with its own unit_code (e.g.
// "CEM-014#0007") rather than the item's shared sku_code — used right
// after receiving mints new item_units rows (see create_item_units() in
// schema.sql), so every unit gets its own numbered QR to scan one-by-one at
// fulfillment/return. Same print surface/CSS as printStickerSheet above,
// just one distinct code per sticker instead of N copies of the same one.
function printUnitStickers(units, skuName) {
  if (!units.length) return;
  const box = document.getElementById('admin-print-sheet');
  box.innerHTML = units
    .map((u, i) => QR.stickerHtml({ skuCode: u.unit_code, skuName, idPrefix: `unit-sticker-qr-${i}-` }))
    .join('');
  units.forEach((u, i) => QR.renderInto(document.getElementById(`unit-sticker-qr-${i}-${u.unit_code}`), u.unit_code, 120));
  window.print();
}

// Reads the copies-to-print field next to a print button (see
// .qty-mini-input in app.css) — falls back to STICKERS_PER_SHEET for
// anything blank/non-numeric/zero, and caps at STICKERS_PER_SHEET_MAX so a
// mistyped value can't queue up an enormous print job.
function readStickerCount(inputId) {
  const el = document.getElementById(inputId);
  const n = el ? parseInt(el.value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, STICKERS_PER_SHEET_MAX) : STICKERS_PER_SHEET;
}

// Print an item's permanent sticker on demand from Manage Items — not tied
// to a receive/return event.
function printSkuSticker(sku, count) {
  printStickerSheet(sku, 'mi-sticker-qr-', count);
}

// One-time backfill for stock that predates unit tracking (or was received
// in a fractional amount before this SKU's units caught up): mints exactly
// enough new item_units to close the gap between qty_on_hand and how many
// units are actually in_stock right now, then prints them. Safe to run
// repeatedly — once the counts match, there's nothing left to generate.
async function generateMissingUnitStickers(sku) {
  try {
    const inStock = await DB.countInStockUnits(sku.id);
    const gap = Math.floor(sku.qty_on_hand) - inStock;
    if (gap <= 0) {
      toast(t('toastNoMissingUnits'), 'success');
      return;
    }
    await DB.createItemUnits(sku.id, gap);
    const units = await DB.listRecentUnits(sku.id, gap);
    printUnitStickers(units, sku.name);
    toast(t('toastUnitsGenerated', gap), 'success');
  } catch (err) {
    toast(err.message || 'Could not generate unit stickers', 'error');
  }
}

// Bulk version: every checked Manage Items row, laid out as a grid of
// individually-cuttable stickers on plain A4 paper (no specific
// label-sheet brand/alignment to match — see .print-sticker-grid in
// app.css). Each item prints as many copies as its own row's "Copies"
// field says (readStickerCount, same field the single-item print button
// next to it reads) — not just one each — so a bulk run behaves exactly
// like running "Print sticker" on every checked row in turn. Copy index
// is folded into each QR container's id since the same sku_code can
// legitimately need more than one container on screen at once here.
function printSelectedStickers() {
  const items = miAllSkus.filter((s) => miSelectedIds.has(s.id));
  if (!items.length) {
    toast(t('toastNoItemsSelected'), 'error');
    return;
  }
  const jobs = [];
  items.forEach((s) => {
    const count = readStickerCount(`mi-print-qty-${s.id}`);
    for (let i = 0; i < count; i++) jobs.push({ sku: s, i });
  });
  const box = document.getElementById('admin-print-sheet');
  box.innerHTML = jobs
    .map(({ sku, i }) => QR.stickerHtml({ skuCode: sku.sku_code, skuName: sku.name, idPrefix: `mi-bulk-qr-${i}-` }))
    .join('');
  jobs.forEach(({ sku, i }) => QR.renderInto(document.getElementById(`mi-bulk-qr-${i}-${sku.sku_code}`), sku.sku_code, 120));
  window.print();
}

function startEditSku(id) {
  const sku = miAllSkus.find((s) => s.id === id);
  if (!sku) return;
  miEditingId = id;
  document.getElementById('mi-sku-code').value = sku.sku_code;
  document.getElementById('mi-name').value = sku.name;
  renderCategoryOptions(sku.category);
  document.getElementById('mi-base-uom').value = sku.base_uom;
  document.getElementById('mi-alt-uom').value = sku.alt_uom || '';
  document.getElementById('mi-conversion-factor').value = sku.conversion_factor ?? '';
  document.getElementById('mi-min-threshold').value = sku.min_threshold;
  miPhotos = { existingPaths: sku.image_paths ? [...sku.image_paths] : [], removedPaths: new Set(), newFiles: [] };
  renderMiPhotoThumbs();
  document.getElementById('mi-submit').innerHTML = miSubmitButtonInner('edit');
  document.getElementById('mi-cancel-edit').hidden = false;
  document.getElementById('sheet-body').scrollTop = 0;
}

async function toggleSkuActive(id, toActive) {
  try {
    await DB.setSkuActive(id, toActive);
    toast(toActive ? t('toastItemActivated') : t('toastItemDeactivated'), 'success');
    await loadManageItemsList();
    await refreshSkuCaches();
  } catch (err) {
    toast(err.message || 'Could not update item', 'error');
  }
}

// ============================================================================
// EVIDENCE PHOTOS — shared by all four places that create a transaction
// (Receive tab, Return tab, and the scan flow's Issue/Receive panels).
// files are kept as plain File objects client-side (never uploaded until
// the form actually submits) and compressed+uploaded together right before
// the RPC call — see DB.uploadEvidenceImages in js/db.js. prefix is the
// form's id prefix (e.g. "rc", "rt", "issue", "scan-rc"), keeping each
// form's picker state independent.
// ============================================================================
const evidenceState = {};

function wireEvidencePicker(prefix) {
  evidenceState[prefix] = [];
  const input = document.getElementById(`${prefix}-photos`);
  if (!input) return;
  input.addEventListener('change', (e) => {
    evidenceState[prefix] = [...(evidenceState[prefix] || []), ...Array.from(e.target.files)];
    e.target.value = '';
    renderEvidenceThumbs(prefix);
  });
}

function renderEvidenceThumbs(prefix) {
  const box = document.getElementById(`${prefix}-photos-preview`);
  if (!box) return;
  const files = evidenceState[prefix] || [];
  box.innerHTML = files.map((file, i) => `
    <div class="evidence-thumb" data-i="${i}">
      <img src="${URL.createObjectURL(file)}" alt="">
      <button type="button" class="evidence-thumb-remove" data-i="${i}" aria-label="${escapeHtml(t('btnRemoveItem'))}">${icon('xCircle', 12)}</button>
    </div>
  `).join('');
  box.querySelectorAll('.evidence-thumb-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      evidenceState[prefix].splice(Number(btn.getAttribute('data-i')), 1);
      renderEvidenceThumbs(prefix);
    });
  });
}

function resetEvidence(prefix) {
  evidenceState[prefix] = [];
  const box = document.getElementById(`${prefix}-photos-preview`);
  if (box) box.innerHTML = '';
}

// Compresses+uploads whatever's currently picked for `prefix`, returning
// the storage paths to pass into DB.receiveStock/returnStock/issueStock —
// [] if nothing was picked (photos are optional everywhere).
async function uploadEvidenceFor(prefix, type) {
  const files = evidenceState[prefix] || [];
  if (!files.length) return [];
  return DB.uploadEvidenceImages(files, type);
}

// Viewing evidence later — Reports' movement table and the item-detail
// "recent movements" panel both call this with a transaction's
// image_paths (from the movement_history view). Signed URLs are generated
// on click, not eagerly for every row, since the bucket is private.
function openEvidenceLightbox(paths) {
  DB.getEvidenceUrls(paths)
    .then((items) => {
      if (!items.length) { toast(t('errorPhotosUnavailable'), 'error'); return; }
      let idx = 0;
      const overlay = document.createElement('div');
      overlay.className = 'evidence-lightbox';
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
      const render = () => {
        overlay.innerHTML = `
          <button type="button" class="evidence-lightbox-close" aria-label="${escapeHtml(t('cancel'))}">${icon('xCircle', 20)}</button>
          <img src="${items[idx].signedUrl}" alt="">
          ${items.length > 1 ? `<div class="evidence-lightbox-thumbs">${items.map((it, i) => `<img src="${it.signedUrl}" data-i="${i}" class="${i === idx ? 'active' : ''}">`).join('')}</div>` : ''}
        `;
        overlay.querySelector('.evidence-lightbox-close').addEventListener('click', () => overlay.remove());
        overlay.querySelectorAll('.evidence-lightbox-thumbs img').forEach((img) => {
          img.addEventListener('click', () => { idx = Number(img.getAttribute('data-i')); render(); });
        });
      };
      render();
      document.body.appendChild(overlay);
    })
    .catch((err) => toast(err.message || 'Could not load photos', 'error'));
}

// ============================================================================
// RECEIVE
// ============================================================================
let activeSkus = [];

// Split from loadReceiveForm() on purpose: this only refreshes the SKU
// dropdown, without touching #receive-result. loadReceiveForm() (below)
// additionally clears the result/error boxes, which is right when entering
// the tab or switching language, but would be wrong right after a
// successful submit — it would wipe the sticker that submit just rendered,
// in the same tick, before it's ever seen. The submit handler calls this
// function instead of loadReceiveForm() for that reason.
async function refreshReceiveSkuOptions() {
  try {
    activeSkus = await DB.listSkus({ activeOnly: true });
    const sel = document.getElementById('rc-sku');
    sel.innerHTML = activeSkus.map((s) => `<option value="${s.id}" data-uom="${escapeHtml(s.base_uom)}">${escapeHtml(s.sku_code)} — ${escapeHtml(s.name)}</option>`).join('');
    if (activeSkus.length) document.getElementById('rc-uom').value = activeSkus[0].base_uom;
    sel.onchange = () => {
      const opt = sel.options[sel.selectedIndex];
      document.getElementById('rc-uom').value = opt.dataset.uom;
    };
  } catch (err) {
    toast(err.message || 'Could not load items', 'error');
  }
}

function loadReceiveForm() {
  document.getElementById('receive-result').innerHTML = '';
  document.getElementById('receive-error').innerHTML = '';
  refreshReceiveSkuOptions();
}

wireEvidencePicker('rc');

document.getElementById('form-receive').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('receive-error');
  errEl.innerHTML = '';
  const skuId = document.getElementById('rc-sku').value;
  const qty = parseFloat(document.getElementById('rc-qty').value);
  const uom = document.getElementById('rc-uom').value.trim();
  const supplierRef = document.getElementById('rc-supplier').value.trim();
  const receivedBy = document.getElementById('rc-by').value.trim();

  const btn = e.target.querySelector('button[type="submit"]');
  const label = document.getElementById('rc-submit-label');
  btn.disabled = true; label.textContent = t('btnGenerating');
  try {
    const imagePaths = await uploadEvidenceFor('rc', 'receive');
    const sku = await DB.receiveStock({ skuId, qty, uom, receivedBy, supplierRef, imagePaths });
    await renderReceiveResult(sku, qty, uom);
    e.target.reset();
    resetEvidence('rc');
    refreshReceiveSkuOptions();
    toast(t('toastStockReceived', fmtQty(qty), escapeHtml(uom), escapeHtml(sku.sku_code)), 'success');
  } catch (err) {
    errEl.innerHTML = `<div class="form-error">${escapeHtml(err.message || 'Could not receive stock')}</div>`;
  } finally {
    btn.disabled = false; label.textContent = t('btnGenerateLot');
  }
});

// sku here is the *updated* row receive_stock() returned (qty_on_hand
// already includes this delivery) — qty/uom are this specific delivery's
// amount, shown as a confirmation line above the item's one permanent
// sticker (which itself carries no quantity — see qr.js).
async function renderReceiveResult(sku, qty, uom) {
  const box = document.getElementById('receive-result');
  // create_item_units() (called inside receive_stock() in schema.sql)
  // already minted one numbered unit per whole item in this delivery —
  // fetch them back for printing instead of the old single
  // shared-sku_code sticker, which only still applies when the delivery
  // was purely fractional (no whole units to number).
  const unitCount = Math.floor(qty);
  const units = unitCount >= 1 ? await DB.listRecentUnits(sku.id, unitCount) : [];
  box.innerHTML = `
    <div class="card">
      <div class="eyebrow">${t('stickerReady')}</div>
      <p class="field-hint">${t('receiveConfirmLine', fmtQty(qty), escapeHtml(uom), fmtQty(sku.qty_on_hand))}</p>
      ${units.length ? `
        <p class="field-hint">${t('labelUnitsMinted', units.length)}</p>
        <button class="btn btn-outline btn-block" id="btn-print-unit-stickers" style="margin-top:var(--s3)">${icon('printer', 16)}<span>${t('btnPrintUnitStickers', units.length)}</span></button>
      ` : `
        ${QR.stickerHtml({ skuCode: sku.sku_code, skuName: sku.name })}
        <div class="field-with-btn" style="margin-top:var(--s4)">
          <div class="qty-field">
            <label class="qty-field-label" for="rc-print-qty">${t('fieldCopies')}</label>
            <input type="number" class="qty-mini-input" id="rc-print-qty" min="1" max="${STICKERS_PER_SHEET_MAX}" value="${STICKERS_PER_SHEET}">
          </div>
          <button class="btn btn-outline" id="btn-print-sticker">${icon('printer', 16)}<span>${t('btnPrintSticker')}</span></button>
        </div>
      `}
    </div>`;
  if (units.length) {
    document.getElementById('btn-print-unit-stickers').addEventListener('click', () => printUnitStickers(units, sku.name));
  } else {
    QR.renderInto(document.getElementById(`sticker-qr-${sku.sku_code}`), sku.sku_code, 120);
    document.getElementById('btn-print-sticker').addEventListener('click', () => printStickerSheet(sku, 'rc-sticker-qr-', readStickerCount('rc-print-qty')));
  }
}

// ---- Receive / Return mode toggle -------------------------------------------
document.querySelectorAll('#receive-mode-tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#receive-mode-tabs button').forEach((x) => x.setAttribute('aria-pressed', x === b));
    const mode = b.dataset.mode;
    document.getElementById('receive-mode-receive').hidden = mode !== 'receive';
    document.getElementById('receive-mode-return').hidden = mode !== 'return';
    updateReceiveSectionTitle();
  });
});
function currentReceiveMode() {
  const pressed = document.querySelector('#receive-mode-tabs button[aria-pressed="true"]');
  return pressed ? pressed.dataset.mode : 'receive';
}
function updateReceiveSectionTitle() {
  document.getElementById('receive-section-title').textContent =
    currentReceiveMode() === 'return' ? t('returnTitle') : t('receiveTitle');
}

// ============================================================================
// RETURN (materials coming back into stock — adds to the item's running
// total, same as receiving)
// ============================================================================
let returnActiveSkus = [];

// Same split as refreshReceiveSkuOptions()/loadReceiveForm() above, for the
// same reason: don't let a post-submit refresh wipe the sticker that submit
// just rendered into #return-result.
async function refreshReturnSkuOptions() {
  try {
    returnActiveSkus = await DB.listSkus({ activeOnly: true });
    const sel = document.getElementById('rt-sku');
    sel.innerHTML = returnActiveSkus.map((s) => `<option value="${s.id}" data-uom="${escapeHtml(s.base_uom)}">${escapeHtml(s.sku_code)} — ${escapeHtml(s.name)}</option>`).join('');
    if (returnActiveSkus.length) document.getElementById('rt-uom').value = returnActiveSkus[0].base_uom;
    sel.onchange = () => {
      const opt = sel.options[sel.selectedIndex];
      document.getElementById('rt-uom').value = opt.dataset.uom;
    };
  } catch (err) {
    toast(err.message || 'Could not load items', 'error');
  }
}

function loadReturnForm() {
  document.getElementById('return-result').innerHTML = '';
  document.getElementById('return-error').innerHTML = '';
  refreshReturnSkuOptions();
}

wireEvidencePicker('rt');

document.getElementById('form-return').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('return-error');
  errEl.innerHTML = '';
  const skuId = document.getElementById('rt-sku').value;
  const qty = parseFloat(document.getElementById('rt-qty').value);
  const uom = document.getElementById('rt-uom').value.trim();
  const note = document.getElementById('rt-note').value.trim();
  const returnedBy = document.getElementById('rt-by').value.trim();

  const btn = e.target.querySelector('button[type="submit"]');
  const label = document.getElementById('rt-submit-label');
  btn.disabled = true; label.textContent = t('btnGenerating');
  try {
    const imagePaths = await uploadEvidenceFor('rt', 'return');
    const sku = await DB.returnStock({ skuId, qty, uom, returnedBy, note, imagePaths });
    renderReturnResult(sku, qty, uom);
    e.target.reset();
    resetEvidence('rt');
    refreshReturnSkuOptions();
    toast(t('toastStockReturned', fmtQty(qty), escapeHtml(uom), escapeHtml(sku.sku_code)), 'success');
  } catch (err) {
    errEl.innerHTML = `<div class="form-error">${escapeHtml(err.message || 'Could not record return')}</div>`;
  } finally {
    btn.disabled = false; label.textContent = t('btnGenerateReturnLot');
  }
});

function renderReturnResult(sku, qty, uom) {
  const box = document.getElementById('return-result');
  box.innerHTML = `
    <div class="card">
      <div class="eyebrow">${t('stickerReady')}</div>
      <p class="field-hint">${t('returnConfirmLine', fmtQty(qty), escapeHtml(uom), fmtQty(sku.qty_on_hand))}</p>
      ${QR.stickerHtml({ skuCode: sku.sku_code, skuName: sku.name })}
      <div class="field-with-btn" style="margin-top:var(--s4)">
        <div class="qty-field">
          <label class="qty-field-label" for="rt-print-qty">${t('fieldCopies')}</label>
          <input type="number" class="qty-mini-input" id="rt-print-qty" min="1" max="${STICKERS_PER_SHEET_MAX}" value="${STICKERS_PER_SHEET}">
        </div>
        <button class="btn btn-outline" id="btn-print-return-sticker">${icon('printer', 16)}<span>${t('btnPrintSticker')}</span></button>
      </div>
    </div>`;
  QR.renderInto(document.getElementById(`sticker-qr-${sku.sku_code}`), sku.sku_code, 120);
  document.getElementById('btn-print-return-sticker').addEventListener('click', () => printStickerSheet(sku, 'rt-sticker-qr-', readStickerCount('rt-print-qty')));
}

// ---- Return against a request number ---------------------------------------
// Rather than staff free-typing an item + quantity from memory (the exact
// human-error source this exists to close off), this looks up exactly what
// was issued for a request (from the transactions ledger, via
// DB.listIssuedItemsForRequest) and only ever lets a quantity be adjusted
// downward from there — nothing can be "returned" that was never actually
// taken out. One screen, not a two-step review like the fulfill-by-request
// flow: there's no "why couldn't this happen" case here that needs a
// mandatory remark the way a declined issue does, so the extra step would
// just be friction. Saving loops DB.returnStock() once per item with a
// qty > 0 — the same RPC the plain return form below already uses,
// unchanged.
let returnByRequestRows = [];
let returnByRequestMeta = null;
let returnByRequestCode = '';

document.getElementById('btn-rt-lookup-request').addEventListener('click', async () => {
  const code = document.getElementById('rt-request-code').value.trim();
  const errEl = document.getElementById('rt-request-lookup-error');
  errEl.textContent = '';
  if (!code) return;
  try {
    const result = await DB.listIssuedItemsForRequest(code);
    if (!result.items.length) {
      errEl.textContent = t('emptyNoIssuedItemsForRequest', code);
      return;
    }
    returnByRequestCode = code;
    returnByRequestMeta = result.meta;
    returnByRequestRows = result.items.map((tx) => ({
      txnId: tx.id,
      skuId: tx.sku_id,
      requestId: tx.request_id,
      name: tx.skus?.name || '',
      skuCode: tx.skus?.sku_code || '',
      baseUom: tx.skus?.base_uom || tx.uom,
      issuedQty: tx.qty,
      returnQty: tx.qty,
      mode: 'manual', // 'manual' (typed qty) or 'scan' (scan back the numbered units issued for this request)
      scannedUnits: [],
    }));
    openReturnByRequestSheet();
  } catch (err) {
    errEl.textContent = err.message || 'Could not look up request';
  }
});
document.getElementById('rt-request-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('btn-rt-lookup-request').click(); }
});

// Validates a scanned unit for a return-by-request row: must belong to
// this row's SKU, still be issued, and — the guard the user specifically
// asked for — issued under *this* request, not some other one.
function validateReturnUnitScan(row, unit, code) {
  if (!unit) return { ok: false, reason: t('toastUnitNotFound', code) };
  if (unit.sku_id !== row.skuId) return { ok: false, reason: t('toastWrongItemScanned', unit.unit_code) };
  if (unit.status !== 'issued' || unit.issued_request_id !== row.requestId) return { ok: false, reason: t('toastUnitNotIssuedHere', unit.unit_code) };
  if (row.scannedUnits.includes(unit.unit_code)) return { ok: false, reason: t('toastUnitAlreadyScanned', unit.unit_code) };
  if (row.scannedUnits.length >= row.issuedQty) return { ok: false, reason: t('toastRequestLineComplete') };
  return { ok: true };
}

function updateReturnScanRowUI(row) {
  const countEl = document.getElementById(`rtreq-scan-count-${row.txnId}`);
  if (countEl) countEl.textContent = t('labelScanCount', row.scannedUnits.length, row.baseUom);
  const undoBtn = document.getElementById(`rtreq-scan-undo-${row.txnId}`);
  if (undoBtn) undoBtn.disabled = row.scannedUnits.length === 0;
  row.returnQty = row.scannedUnits.length;
}

function returnByRequestRowHtml(row) {
  const scanned = row.scannedUnits.length;
  return `
    <div class="card" style="margin-bottom:var(--s3)">
      <div class="card-title">${escapeHtml(row.name)}</div>
      <div class="card-meta mono">${escapeHtml(row.skuCode)}</div>
      <div class="segmented rtreq-mode-tabs" data-id="${row.txnId}" role="tablist" style="margin-top:var(--s3)">
        <button type="button" data-mode="manual" aria-pressed="${row.mode === 'manual'}">${t('scanModeManual')}</button>
        <button type="button" data-mode="scan" aria-pressed="${row.mode === 'scan'}">${t('scanModeUnits')}</button>
      </div>
      ${row.mode === 'manual' ? `
        <div class="field" style="margin-top:var(--s3)">
          <label for="rtreq-qty-${row.txnId}">${t('fieldQtyReturned')}</label>
          <input type="number" class="rtreq-qty-input" id="rtreq-qty-${row.txnId}" data-id="${row.txnId}" min="0" step="any" max="${row.issuedQty}" value="${row.returnQty}">
          <p class="field-hint">${t('hintIssuedQty', fmtQty(row.issuedQty), escapeHtml(row.baseUom))}</p>
        </div>
      ` : `
        <div class="rtreq-scan-slot" data-id="${row.txnId}" style="margin-top:var(--s3)"></div>
        <p class="scan-note">${t('hintScanUnitsReturn')}</p>
        <div class="stat-figure" id="rtreq-scan-count-${row.txnId}" style="font-size:var(--t-card)">${t('labelScanCount', scanned, row.baseUom)}</div>
        <p class="field-hint">${t('hintIssuedQty', fmtQty(row.issuedQty), escapeHtml(row.baseUom))}</p>
        <button type="button" class="btn btn-outline rtreq-scan-undo" id="rtreq-scan-undo-${row.txnId}" data-id="${row.txnId}" style="margin-top:var(--s2)" ${scanned === 0 ? 'disabled' : ''}>${t('btnUndoLastScan')}</button>
      `}
    </div>
  `;
}

function openReturnByRequestSheet() {
  const meta = returnByRequestMeta;
  Sheet.open(t('returnByRequestTitle', returnByRequestCode), `
    <div id="rtreq-error"></div>
    <div class="confirm-rows" style="margin-bottom:var(--s4)">
      <div class="confirm-row"><span>${t('fieldRequesterName2')}</span><strong>${escapeHtml(meta.requester_name || '—')}</strong></div>
      <div class="confirm-row"><span>${t('fieldDepartment')}</span><strong>${escapeHtml(meta.department || t('noDepartment'))}</strong></div>
      <div class="confirm-row"><span>${t('fieldWorkArea')}</span><strong>${escapeHtml(meta.work_area || t('noWorkArea'))}</strong></div>
      <div class="confirm-row"><span>${t('fieldBuilding')}</span><strong>${escapeHtml(meta.building || t('noBuilding'))}</strong></div>
    </div>
    <div id="rtreq-item-rows">${returnByRequestRows.map(returnByRequestRowHtml).join('')}</div>
    <div class="field">
      <label for="rtreq-by">${t('fieldReturnedBy')}</label>
      <input type="text" id="rtreq-by" placeholder="${escapeHtml(t('fieldReturnedByPh'))}" required>
    </div>
    <div class="field">
      <label for="rtreq-note">${t('fieldReturnNote')}</label>
      <input type="text" id="rtreq-note" placeholder="${escapeHtml(t('fieldReturnNotePh'))}">
    </div>
    <div class="field">
      <label for="rtreq-photos">${t('fieldEvidencePhotos')}</label>
      <input type="file" id="rtreq-photos" accept="image/*" multiple>
      <div class="evidence-thumbs" id="rtreq-photos-preview"></div>
    </div>
    <div class="field">
      <label for="rtreq-form-photo">${t('fieldFormPhoto')}</label>
      <input type="file" id="rtreq-form-photo" accept="image/*" capture="environment">
    </div>
    <div class="field">
      <label>${t('fieldSignature')}</label>
      <canvas id="rtreq-signature" class="signature-pad"></canvas>
      <button type="button" class="btn btn-ghost btn-sm" id="rtreq-signature-clear">${t('btnClearSignature')}</button>
    </div>
    <button type="button" class="btn btn-primary btn-block" id="btn-rtreq-save" style="margin-top:var(--s4)">${icon('check', 16)}<span id="rtreq-save-label">${t('btnSave')}</span></button>
  `);
  applyStaticIcons();
  wirePhotoPickerKeepState('rtreq');
  document.querySelectorAll('.rtreq-qty-input').forEach((input) => {
    input.addEventListener('input', () => {
      const row = returnByRequestRows.find((r) => r.txnId === input.dataset.id);
      row.returnQty = input.value === '' ? '' : Number(input.value);
    });
  });
  document.querySelectorAll('.rtreq-mode-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = returnByRequestRows.find((r) => r.txnId === btn.dataset.id);
      const mode = btn.dataset.mode;
      if (row.mode === mode) return;
      UnitScan.stop();
      row.mode = mode;
      if (mode === 'manual') row.returnQty = row.issuedQty;
      openReturnByRequestSheet();
    });
  });
  document.querySelectorAll('.rtreq-scan-undo').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = returnByRequestRows.find((r) => r.txnId === btn.dataset.id);
      UnitScan.undo(row);
    });
  });
  document.getElementById('rtreq-form-photo').addEventListener('change', (e) => {
    if (!evidenceState.rtreq) evidenceState.rtreq = [];
    if (e.target.files[0]) evidenceState.rtreq.push(e.target.files[0]);
  });
  Signature.mount(document.getElementById('rtreq-signature'));
  document.getElementById('rtreq-signature-clear').addEventListener('click', () => {
    Signature.clear(document.getElementById('rtreq-signature'));
  });
  document.getElementById('btn-rtreq-save').addEventListener('click', onReturnByRequestSave);

  returnByRequestRows.forEach((row) => {
    row.onScanChange = () => updateReturnScanRowUI(row);
    row.validateUnitScan = (unit, code) => validateReturnUnitScan(row, unit, code);
    if (row.mode === 'scan') {
      const slot = document.querySelector(`.rtreq-scan-slot[data-id="${row.txnId}"]`);
      if (slot) UnitScan.start(row, slot);
    }
  });
}

async function onReturnByRequestSave() {
  const errEl = document.getElementById('rtreq-error');
  errEl.innerHTML = '';

  // Defensive re-sync, same reasoning as the fulfill flow above.
  document.querySelectorAll('.rtreq-qty-input').forEach((input) => {
    const row = returnByRequestRows.find((r) => r.txnId === input.dataset.id);
    if (row) row.returnQty = input.value === '' ? '' : Number(input.value);
  });

  const returnedBy = document.getElementById('rtreq-by').value.trim();
  const note = document.getElementById('rtreq-note').value.trim();

  const invalid = returnByRequestRows.find((r) => r.returnQty !== 0 && !(r.returnQty > 0));
  if (invalid) {
    errEl.innerHTML = `<div class="form-error">${escapeHtml(t('errorQtyRequired'))}</div>`;
    document.getElementById(`rtreq-qty-${invalid.txnId}`)?.focus();
    return;
  }
  const overIssued = returnByRequestRows.find((r) => Number(r.returnQty) > Number(r.issuedQty));
  if (overIssued) {
    errEl.innerHTML = `<div class="form-error">${escapeHtml(t('errorReturnExceedsIssued', overIssued.name, fmtQty(overIssued.issuedQty), overIssued.baseUom))}</div>`;
    document.getElementById(`rtreq-qty-${overIssued.txnId}`)?.focus();
    return;
  }
  const returningRows = returnByRequestRows.filter((r) => r.returnQty > 0);
  if (!returningRows.length || !returnedBy) {
    errEl.innerHTML = `<div class="form-error">${escapeHtml(t('fieldRequiredGeneric'))}</div>`;
    return;
  }

  const btn = document.getElementById('btn-rtreq-save');
  const label = document.getElementById('rtreq-save-label');
  btn.disabled = true; label.textContent = t('btnGenerating');
  try {
    UnitScan.stop();
    const signatureCanvas = document.getElementById('rtreq-signature');
    if (signatureCanvas && !Signature.isEmpty(signatureCanvas)) {
      if (!evidenceState.rtreq) evidenceState.rtreq = [];
      evidenceState.rtreq.push(await Signature.toBlob(signatureCanvas));
    }
    const imagePaths = await uploadEvidenceFor('rtreq', 'return');
    for (const row of returningRows) {
      const unitCodes = row.mode === 'scan' ? row.scannedUnits : null;
      await DB.returnStock({ skuId: row.skuId, qty: Number(row.returnQty), uom: row.baseUom, returnedBy, note: note || null, imagePaths, requestId: row.requestId, unitCodes });
    }
    toast(t('toastReturnByRequestDone', returningRows.length), 'success');
    resetEvidence('rtreq');
    Sheet.close();
    document.getElementById('rt-request-code').value = '';
    refreshReturnSkuOptions();
  } catch (err) {
    errEl.innerHTML = `<div class="form-error">${escapeHtml(err.message || 'Could not record return')}</div>`;
    btn.disabled = false; label.textContent = t('btnSave');
  }
}

// ============================================================================
// ISSUE / SCAN
// ============================================================================
function resetScanView() {
  teardownCountMode();
  document.getElementById('scan-step-camera').hidden = false;
  document.getElementById('scan-step-issue').hidden = true;
  document.getElementById('scan-step-issue').innerHTML = '';
  document.getElementById('scan-manual').value = '';
  const status = document.getElementById('scan-status');
  status.textContent = t('scanHintDefault');

  const video = document.getElementById('scan-video');
  const canvas = document.getElementById('scan-canvas');
  QR.startScanner(video, canvas, onItemScanned, (err) => {
    status.textContent = t('scanHintNoCamera');
  }, () => {
    status.textContent = t('scanHintNotRecognized');
  });
}

// ----------------------------------------------------------------------------
// SCAN-TO-COUNT — an alternative to typing a received quantity: the camera
// stays live and every further scan of the SAME item's QR counts as "+1
// unit", for someone physically placing items on the shelf one at a time.
// Nothing is written to the database until "Confirm", so "Undo" is just
// decrementing a local counter — walking away mid-count leaves no partial
// transaction behind, and a failed confirm can safely resume counting.
// Reuses the single #scan-video/#scan-canvas pair (re-parenting the visible
// `.scan-frame` into whichever panel needs it) rather than opening a second
// camera stream, since QR.startScanner() doesn't stop a stream it didn't
// start itself.
// ----------------------------------------------------------------------------
let countState = null; // { count } while receive count-mode is active, else null

function moveCameraInto(slotEl) {
  const frame = document.querySelector('.scan-frame');
  if (frame) slotEl.appendChild(frame);
}

function restoreCameraHome() {
  const stepCamera = document.getElementById('scan-step-camera');
  const canvas = document.getElementById('scan-canvas');
  const frame = document.querySelector('.scan-frame');
  if (stepCamera && frame && frame.parentElement !== stepCamera) {
    stepCamera.insertBefore(frame, canvas);
  }
}

function stopCountScanner() {
  QR.stopScanner(document.getElementById('scan-video'));
}

function startCountScanner(sku) {
  const video = document.getElementById('scan-video');
  const canvas = document.getElementById('scan-canvas');
  const status = document.getElementById('scan-rc-count-status');
  QR.startScanner(video, canvas, (code) => onCountScan(code, sku), () => {
    if (status) status.textContent = t('scanHintNoCamera');
  }, () => {
    if (status) status.textContent = t('scanHintNotRecognized');
  });
}

function onCountScan(code, sku) {
  if (!countState) return; // count mode was cancelled while a detect was in flight
  if (code !== sku.sku_code) {
    toast(t('toastWrongItemScanned', code), 'error');
    startCountScanner(sku);
    return;
  }
  countState.count += 1;
  try { navigator.vibrate && navigator.vibrate(60); } catch (_) {}
  renderCountDisplay(sku);
  startCountScanner(sku); // onDetect ends the loop; keep listening for the next unit
}

function renderCountDisplay(sku) {
  const display = document.getElementById('scan-rc-count-display');
  if (display) display.textContent = t('labelScanCount', countState.count, sku.base_uom);
  const undoBtn = document.getElementById('btn-rc-count-undo');
  if (undoBtn) undoBtn.disabled = countState.count === 0;
  const confirmBtn = document.getElementById('btn-confirm-scan-count');
  if (confirmBtn) confirmBtn.disabled = countState.count === 0;
}

function teardownCountMode() {
  if (countState) {
    stopCountScanner();
    restoreCameraHome();
    countState = null;
  }
}

// ----------------------------------------------------------------------------
// UNIT SCAN — generic "scan numbered unit stickers one by one" engine
// shared by the Fulfill and Return-by-request sheets (js/db.js
// findUnitByCode()). Reuses the same camera-reparenting helpers as the
// Receive scan-to-count mode above (moveCameraInto/restoreCameraHome/
// stopCountScanner are already generic — nothing there is receive-specific)
// rather than duplicating them. Exactly one row can be actively scanning at
// a time, since there's only one physical camera; starting a row stops
// whichever row had it. Purely local until the caller uses the accumulated
// unit codes (issue_stock/return_stock at Confirm) — nothing is written to
// item_units mid-scan, so an abandoned session leaves no trace.
// ----------------------------------------------------------------------------
const UnitScan = {
  activeRow: null, // the row object currently owning the camera, or null

  isActive(row) { return this.activeRow === row; },

  start(row, slotEl) {
    this.stop();
    this.activeRow = row;
    moveCameraInto(slotEl);
    this._loop();
  },

  stop() {
    if (!this.activeRow) return;
    stopCountScanner();
    restoreCameraHome();
    this.activeRow = null;
  },

  undo(row) {
    if (!row.scannedUnits.length) return;
    row.scannedUnits.pop();
    row.onScanChange && row.onScanChange();
  },

  async _loop() {
    const row = this.activeRow;
    if (!row) return;
    const video = document.getElementById('scan-video');
    const canvas = document.getElementById('scan-canvas');
    QR.startScanner(video, canvas, async (code) => {
      if (this.activeRow !== row) return; // stopped/switched before this fired
      let unit = null;
      try { unit = await DB.findUnitByCode(code); } catch (_) { unit = null; }
      if (this.activeRow !== row) return; // stopped/switched while the lookup was in flight
      const result = row.validateUnitScan(unit, code);
      if (result.ok) {
        row.scannedUnits.push(unit.unit_code);
        try { navigator.vibrate && navigator.vibrate(60); } catch (_) {}
      } else {
        toast(result.reason, 'error');
      }
      row.onScanChange && row.onScanChange();
      if (this.activeRow === row) this._loop();
    }, () => { /* no camera — row stays in scan mode but nothing more happens */ }, () => { /* not recognized; loop continues on its own */ });
  },
};

document.getElementById('btn-lookup-lot').addEventListener('click', () => {
  const code = document.getElementById('scan-manual').value.trim();
  if (code) onItemScanned(code);
});

async function onItemScanned(code, preferredAction = null) {
  QR.stopScanner(document.getElementById('scan-video'));
  // A request-code QR (printed on the slip via printRequestSlip()/
  // js/request.js renderPrintSheet()) looks like REQ-260914-005 — visually
  // distinct from a sku_code (e.g. CEM-014), so this branches on the
  // prefix alone rather than trying a sku lookup first and falling back;
  // that would waste a round-trip on every request-code scan, which is
  // meant to be the common case at the counter, not the exception.
  if (code.startsWith('REQ-')) {
    openFulfillRequestSheet(code);
    return;
  }
  document.getElementById('scan-status').textContent = t('scanLookingUp', code);
  try {
    const sku = await DB.findSkuByCode(code);
    if (!sku) {
      toast(t('toastItemNotFound', code), 'error');
      resetScanView();
      return;
    }
    const openRequests = await DB.listRequests({});
    const forThisSku = openRequests.filter((r) => r.sku_id === sku.sku_id && r.status !== 'fulfilled' && r.status !== 'cancelled');
    renderScannedItem(sku, forThisSku, preferredAction);
  } catch (err) {
    toast(err.message || 'Lookup failed', 'error');
    resetScanView();
  }
}

// One permanent sticker per item now covers both directions: issuing
// (deduct, against an open request) and receiving more (add) — this is the
// screen that lets scanning the same code do either. Defaults to the Issue
// tab when there's an open request to fulfill, otherwise to Receive (there's
// nothing to issue against, so that's the useful action).
function renderScannedItem(sku, openRequests, preferredAction = null) {
  document.getElementById('scan-step-camera').hidden = true;
  const box = document.getElementById('scan-step-issue');
  box.hidden = false;
  const defaultAction = preferredAction || (openRequests.length ? 'issue' : 'receive');
  box.innerHTML = `
    <div class="card">
      <div class="eyebrow">${t('itemFound')}</div>
      <div class="card-title">${escapeHtml(sku.name)}</div>
      <div class="card-meta mono">${escapeHtml(sku.sku_code)}</div>
      <div class="card-row" style="margin-top:var(--s3)">
        <span class="chip chip-cat-${catClass(sku.category)}">${icon(catIcon(sku.category), 12)}${escapeHtml(catLabel(sku.category))}</span>
        <span class="stat-figure" style="font-size:var(--t-card)">${t('unitOnHand', fmtQty(sku.on_hand), escapeHtml(sku.base_uom))}</span>
      </div>
    </div>

    <div class="segmented" id="scan-action-tabs" role="tablist" style="margin-top:var(--s5)">
      <button data-action="issue" aria-pressed="${defaultAction === 'issue'}" data-icon="check"><span>${t('scanActionIssue')}</span></button>
      <button data-action="receive" aria-pressed="${defaultAction === 'receive'}" data-icon="package"><span>${t('scanActionReceive')}</span></button>
    </div>

    <div id="scan-action-issue" ${defaultAction === 'issue' ? '' : 'hidden'}>
      ${openRequests.length ? `
        <div class="field" style="margin-top:var(--s4)">
          <label for="issue-request">${t('fieldFulfillWhich')}</label>
          <select id="issue-request">
            ${openRequests.map((r) => `<option value="${r.id}" data-qty="${r.qty_requested}">${escapeHtml(t('optionRequestLine', r.request_code, r.requester_name, fmtQty(r.qty_requested), sku.base_uom))}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label for="issue-qty">${t('fieldActualQty')}</label>
          <input type="number" id="issue-qty" min="0.0001" step="any" max="${sku.on_hand}">
          <div class="field-hint" id="issue-qty-hint"></div>
        </div>
        <div class="field">
          <label for="issue-picked-up-by">${t('fieldPickedUpBy')}</label>
          <input type="text" id="issue-picked-up-by" placeholder="${escapeHtml(t('fieldReceivedByPh'))}">
        </div>
        <div class="field">
          <label for="issue-photos">${t('fieldEvidencePhotos')}</label>
          <input type="file" id="issue-photos" accept="image/*" multiple>
          <div class="evidence-thumbs" id="issue-photos-preview"></div>
        </div>
        <div id="issue-error"></div>
        <button class="btn btn-primary btn-block" id="btn-confirm-issue">${icon('check', 16)}<span id="issue-confirm-label">${t('btnConfirmIssue')}</span></button>
      ` : `
        <div class="empty" style="margin-top:var(--s4)">
          <p>${t('emptyNoOpenRequest')}</p>
        </div>
      `}
    </div>

    <div id="scan-action-receive" ${defaultAction === 'receive' ? '' : 'hidden'}>
      <div class="segmented" id="rc-mode-tabs" role="tablist" style="margin-top:var(--s4)">
        <button data-mode="manual" aria-pressed="true" data-icon="pencil"><span>${t('scanModeManual')}</span></button>
        <button data-mode="count" aria-pressed="false" data-icon="qr"><span>${t('scanModeCount')}</span></button>
      </div>

      <div id="scan-rc-manual">
        <div class="field" style="margin-top:var(--s4)">
          <label for="scan-rc-qty">${t('fieldQtyReceived')}</label>
          <input type="number" id="scan-rc-qty" min="0.0001" step="any" value="1">
        </div>
        <div class="field">
          <label for="scan-rc-uom">${t('fieldUnit')}</label>
          <input type="text" id="scan-rc-uom" value="${escapeHtml(sku.base_uom)}">
        </div>
        <div class="field">
          <label for="scan-rc-by">${t('fieldReceivedBy')}</label>
          <input type="text" id="scan-rc-by" placeholder="${escapeHtml(t('fieldReceivedByPh'))}">
        </div>
        <div class="field">
          <label for="scan-rc-photos">${t('fieldEvidencePhotos')}</label>
          <input type="file" id="scan-rc-photos" accept="image/*" multiple>
          <div class="evidence-thumbs" id="scan-rc-photos-preview"></div>
        </div>
        <div id="scan-rc-error"></div>
        <button class="btn btn-primary btn-block" id="btn-confirm-scan-receive">${icon('plusCircle', 16)}<span id="scan-rc-confirm-label">${t('btnConfirmReceive')}</span></button>
      </div>

      <div id="scan-rc-count" hidden>
        <div class="field" style="margin-top:var(--s4)">
          <label for="scan-rc-count-by">${t('fieldReceivedBy')}</label>
          <input type="text" id="scan-rc-count-by" placeholder="${escapeHtml(t('fieldReceivedByPh'))}">
        </div>
        <div id="scan-rc-count-camera-slot"></div>
        <p class="scan-note" id="scan-rc-count-status">${t('hintCountMode')}</p>
        <div class="stat-figure" id="scan-rc-count-display" style="font-size:var(--t-card); margin-top:var(--s3)">${t('labelScanCount', 0, sku.base_uom)}</div>
        <div class="card-row" style="margin-top:var(--s3); gap:var(--s3)">
          <button class="btn btn-outline" id="btn-rc-count-undo" disabled>${t('btnUndoLastScan')}</button>
          <button class="btn btn-ghost" id="btn-rc-count-cancel">${t('btnCancelCount')}</button>
        </div>
        <div id="scan-rc-count-error" style="margin-top:var(--s3)"></div>
        <button class="btn btn-primary btn-block" id="btn-confirm-scan-count" style="margin-top:var(--s3)" disabled>${icon('plusCircle', 16)}<span id="scan-rc-count-confirm-label">${t('btnConfirmReceive')}</span></button>
      </div>
    </div>

    <button class="btn btn-ghost btn-block" id="btn-scan-again" style="margin-top:var(--s4)">${icon('repeat', 16)}<span>${t('btnScanDifferent')}</span></button>
  `;

  document.getElementById('btn-scan-again').addEventListener('click', resetScanView);
  wireEvidencePicker('issue');
  wireEvidencePicker('scan-rc');

  document.querySelectorAll('#scan-action-tabs button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#scan-action-tabs button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      document.getElementById('scan-action-issue').hidden = b.dataset.action !== 'issue';
      document.getElementById('scan-action-receive').hidden = b.dataset.action !== 'receive';
      if (b.dataset.action !== 'receive') teardownCountMode();
    });
  });

  document.querySelectorAll('#rc-mode-tabs button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#rc-mode-tabs button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      const mode = b.dataset.mode;
      document.getElementById('scan-rc-manual').hidden = mode !== 'manual';
      document.getElementById('scan-rc-count').hidden = mode !== 'count';
      if (mode === 'count') {
        countState = { count: 0 };
        renderCountDisplay(sku);
        moveCameraInto(document.getElementById('scan-rc-count-camera-slot'));
        startCountScanner(sku);
      } else {
        teardownCountMode();
      }
    });
  });

  document.getElementById('btn-rc-count-undo')?.addEventListener('click', () => {
    if (!countState || countState.count === 0) return;
    countState.count -= 1;
    renderCountDisplay(sku);
  });

  document.getElementById('btn-rc-count-cancel')?.addEventListener('click', () => {
    teardownCountMode();
    document.querySelectorAll('#rc-mode-tabs button').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.mode === 'manual')));
    document.getElementById('scan-rc-manual').hidden = false;
    document.getElementById('scan-rc-count').hidden = true;
  });

  document.getElementById('btn-confirm-scan-count')?.addEventListener('click', async () => {
    const errEl = document.getElementById('scan-rc-count-error');
    errEl.innerHTML = '';
    if (!countState || !countState.count) {
      errEl.innerHTML = `<div class="form-error">${escapeHtml(t('errorCountZero'))}</div>`;
      return;
    }
    const qty = countState.count;
    const receivedBy = document.getElementById('scan-rc-count-by').value.trim();
    const btn = document.getElementById('btn-confirm-scan-count');
    const label = document.getElementById('scan-rc-count-confirm-label');
    btn.disabled = true; label.textContent = t('btnConfirming');
    stopCountScanner();
    try {
      const updated = await DB.receiveStock({ skuId: sku.sku_id, qty, uom: sku.base_uom, receivedBy, supplierRef: null, imagePaths: [] });
      toast(t('toastStockReceived', fmtQty(qty), escapeHtml(sku.base_uom), escapeHtml(updated.sku_code)), 'success');
      const units = await DB.listRecentUnits(sku.sku_id, Math.floor(qty));
      if (units.length) printUnitStickers(units, sku.name);
      countState = null;
      resetScanView();
    } catch (err) {
      errEl.innerHTML = `<div class="form-error">${escapeHtml(err.message || 'Could not receive stock')}</div>`;
      btn.disabled = false; label.textContent = t('btnConfirmReceive');
      if (countState) startCountScanner(sku); // resume counting since nothing was committed
    }
  });

  const reqSel = document.getElementById('issue-request');
  const qtyInput = document.getElementById('issue-qty');
  if (reqSel) {
    const syncDefault = () => {
      const opt = reqSel.options[reqSel.selectedIndex];
      qtyInput.value = opt.dataset.qty;
      document.getElementById('issue-qty-hint').textContent = t('hintRequested', fmtQty(opt.dataset.qty), sku.base_uom);
    };
    reqSel.addEventListener('change', syncDefault);
    syncDefault();
  }

  document.getElementById('btn-confirm-issue')?.addEventListener('click', async () => {
    const errEl = document.getElementById('issue-error');
    errEl.innerHTML = '';
    const requestId = reqSel.value;
    const actualQty = parseFloat(qtyInput.value);
    const requestedQty = parseFloat(reqSel.options[reqSel.selectedIndex].dataset.qty);
    const performedBy = document.getElementById('issue-picked-up-by').value.trim();

    if (!performedBy) {
      errEl.innerHTML = `<div class="form-error">${escapeHtml(t('fieldPickedUpByRequired'))}</div>`;
      return;
    }

    const btn = document.getElementById('btn-confirm-issue');
    const label = document.getElementById('issue-confirm-label');
    btn.disabled = true; label.textContent = t('btnConfirming');
    try {
      const imagePaths = await uploadEvidenceFor('issue', 'issue');
      const result = await DB.issueStock({ skuId: sku.sku_id, requestId, actualQty, performedBy, imagePaths });
      if (result.has_discrepancy) {
        toast(t('toastIssuedDiscrepancy', fmtQty(requestedQty), fmtQty(actualQty)), 'error');
      } else {
        toast(t('toastIssuedClean'), 'success');
      }
      resetScanView();
    } catch (err) {
      errEl.innerHTML = `<div class="form-error">${escapeHtml(err.message || 'Could not confirm issue')}</div>`;
      btn.disabled = false; label.textContent = t('btnConfirmIssue');
    }
  });

  document.getElementById('btn-confirm-scan-receive')?.addEventListener('click', async () => {
    const errEl = document.getElementById('scan-rc-error');
    errEl.innerHTML = '';
    const qty = parseFloat(document.getElementById('scan-rc-qty').value);
    const uom = document.getElementById('scan-rc-uom').value.trim();
    const receivedBy = document.getElementById('scan-rc-by').value.trim();

    if (!(qty > 0) || !uom) {
      errEl.innerHTML = `<div class="form-error">${escapeHtml(t('fieldRequiredGeneric'))}</div>`;
      return;
    }

    const btn = document.getElementById('btn-confirm-scan-receive');
    const label = document.getElementById('scan-rc-confirm-label');
    btn.disabled = true; label.textContent = t('btnConfirming');
    try {
      const imagePaths = await uploadEvidenceFor('scan-rc', 'receive');
      const updated = await DB.receiveStock({ skuId: sku.sku_id, qty, uom, receivedBy, supplierRef: null, imagePaths });
      toast(t('toastStockReceived', fmtQty(qty), escapeHtml(uom), escapeHtml(updated.sku_code)), 'success');
      resetScanView();
    } catch (err) {
      errEl.innerHTML = `<div class="form-error">${escapeHtml(err.message || 'Could not receive stock')}</div>`;
      btn.disabled = false; label.textContent = t('btnConfirmReceive');
    }
  });
}

// ============================================================================
// FULFILL BY REQUEST CODE — scan the QR on a printed/PDF request slip
// (printRequestSlip() in app.js, renderPrintSheet() in js/request.js) to
// process every still-open item on that request in one pass, instead of
// scanning each item separately and re-typing "picked up by" every time.
// Two-step (adjust -> review -> back to adjust if needed -> confirm) so a
// mistyped quantity is caught before it's committed, not just flagged
// after the fact via a toast like the single-item scan flow does. An item
// that can't be delivered is "declined" here rather than issued: it never
// touches stock or writes a transaction, but still closes the line out as
// fulfilled with a mandatory staff remark (decline_request_item() in
// schema.sql) — see the design conversation this came out of for why that
// beats leaving it open indefinitely or marking it cancelled.
// ============================================================================
let fulfillRows = [];
let fulfillRequestMeta = null;
let fulfillPickedUpBy = '';

async function openFulfillRequestSheet(requestCode) {
  let rows;
  try {
    rows = await DB.getRequestByCode(requestCode);
  } catch (err) {
    toast(err.message || 'Could not load request', 'error');
    resetScanView();
    return;
  }
  // Comment-only rows (no sku_id) have nothing to issue or decline against
  // — they stay managed the ordinary way, via the ordinary status
  // dropdown on the Requests list.
  const openRows = rows.filter((r) => r.sku_id && r.status !== 'fulfilled' && r.status !== 'cancelled');
  if (!openRows.length) {
    toast(t('emptyNoOpenItemsForRequest', requestCode), 'error');
    resetScanView();
    return;
  }
  fulfillRequestMeta = rows[0];
  fulfillPickedUpBy = '';
  fulfillRows = openRows.map((r) => ({
    id: r.id,
    skuId: r.sku_id,
    name: r.skus?.name || '',
    skuCode: r.skus?.sku_code || '',
    baseUom: r.skus?.base_uom || '',
    onHand: r.skus?.qty_on_hand ?? 0,
    requestedQty: r.qty_requested,
    actualQty: r.qty_requested,
    declined: false,
    declineNote: '',
    mode: 'manual', // 'manual' (typed qty) or 'scan' (scan numbered units one by one)
    scannedUnits: [],
    shortfallNote: '',
  }));
  renderFulfillAdjustStep();
}

// Validates one scanned unit against a fulfill row — must belong to this
// row's SKU, still be in_stock, not already scanned this session, and the
// line not already fully covered (scanning stops mattering past that).
function validateFulfillUnitScan(row, unit, code) {
  if (!unit) return { ok: false, reason: t('toastUnitNotFound', code) };
  if (unit.sku_id !== row.skuId) return { ok: false, reason: t('toastWrongItemScanned', unit.unit_code) };
  if (unit.status !== 'in_stock') return { ok: false, reason: t('toastUnitNotAvailable', unit.unit_code) };
  if (row.scannedUnits.includes(unit.unit_code)) return { ok: false, reason: t('toastUnitAlreadyScanned', unit.unit_code) };
  if (row.scannedUnits.length >= row.requestedQty) return { ok: false, reason: t('toastRequestLineComplete') };
  return { ok: true };
}

function fulfillRowHtml(row) {
  const scanned = row.scannedUnits.length;
  return `
    <div class="card" data-row-id="${row.id}" style="margin-bottom:var(--s3)">
      <div class="card-row">
        <div>
          <div class="card-title">${escapeHtml(row.name)}</div>
          <div class="card-meta mono">${escapeHtml(row.skuCode)}</div>
        </div>
        <button type="button" class="btn btn-ghost btn-sm fulfill-decline-toggle" data-id="${row.id}">${icon(row.declined ? 'plusCircle' : 'xCircle', 14)}<span>${row.declined ? t('btnUndoDecline') : t('btnCannotDeliver')}</span></button>
      </div>
      ${!row.declined ? `
        <div class="segmented fulfill-mode-tabs" data-id="${row.id}" role="tablist" style="margin-top:var(--s3)">
          <button type="button" data-mode="manual" aria-pressed="${row.mode === 'manual'}">${t('scanModeManual')}</button>
          <button type="button" data-mode="scan" aria-pressed="${row.mode === 'scan'}">${t('scanModeUnits')}</button>
        </div>
      ` : ''}
      ${!row.declined && row.mode === 'manual' ? `
        <div class="field" style="margin-top:var(--s3)">
          <label for="fulfill-qty-${row.id}">${t('fieldActualQty')}</label>
          <input type="number" class="fulfill-qty-input" id="fulfill-qty-${row.id}" data-id="${row.id}" min="0.0001" step="any" max="${row.onHand}" value="${row.actualQty}">
          <p class="field-hint">${t('hintRequested', fmtQty(row.requestedQty), escapeHtml(row.baseUom))} · ${t('hintOnHand', fmtQty(row.onHand), escapeHtml(row.baseUom))}</p>
        </div>
      ` : ''}
      ${!row.declined && row.mode === 'scan' ? `
        <div class="fulfill-scan-slot" data-id="${row.id}" style="margin-top:var(--s3)"></div>
        <p class="scan-note">${t('hintScanUnitsFulfill')}</p>
        <div class="stat-figure" id="fulfill-scan-count-${row.id}" style="font-size:var(--t-card)">${t('labelScanCount', scanned, row.baseUom)}</div>
        <p class="field-hint">${t('hintRequested', fmtQty(row.requestedQty), escapeHtml(row.baseUom))}</p>
        <button type="button" class="btn btn-outline fulfill-scan-undo" id="fulfill-scan-undo-${row.id}" data-id="${row.id}" style="margin-top:var(--s2)" ${scanned === 0 ? 'disabled' : ''}>${t('btnUndoLastScan')}</button>
        <div class="field" id="fulfill-shortfall-wrap-${row.id}" style="margin-top:var(--s3)" ${scanned > 0 && scanned < row.requestedQty ? '' : 'hidden'}>
          <label for="fulfill-shortfall-${row.id}">${t('fieldDeclineReason')}</label>
          <textarea id="fulfill-shortfall-${row.id}" class="fulfill-shortfall-note" data-id="${row.id}" placeholder="${escapeHtml(t('declineReasonPlaceholder'))}">${escapeHtml(row.shortfallNote)}</textarea>
        </div>
      ` : ''}
      ${row.declined ? `
        <div class="field">
          <label for="fulfill-note-${row.id}">${t('fieldDeclineReason')}</label>
          <textarea id="fulfill-note-${row.id}" class="fulfill-decline-note" data-id="${row.id}" placeholder="${escapeHtml(t('declineReasonPlaceholder'))}">${escapeHtml(row.declineNote)}</textarea>
        </div>
      ` : ''}
    </div>
  `;
}

// Targeted refresh for a scan-mode row after each scan/undo — deliberately
// NOT a full renderFulfillAdjustStep(), which would tear down and recreate
// the DOM node the camera was just moved into mid-scan-loop.
function updateFulfillScanRowUI(row) {
  const countEl = document.getElementById(`fulfill-scan-count-${row.id}`);
  if (countEl) countEl.textContent = t('labelScanCount', row.scannedUnits.length, row.baseUom);
  const undoBtn = document.getElementById(`fulfill-scan-undo-${row.id}`);
  if (undoBtn) undoBtn.disabled = row.scannedUnits.length === 0;
  const wrap = document.getElementById(`fulfill-shortfall-wrap-${row.id}`);
  if (wrap) wrap.hidden = !(row.scannedUnits.length > 0 && row.scannedUnits.length < row.requestedQty);
  row.actualQty = row.scannedUnits.length;
}

function wireFulfillRowEvents() {
  document.querySelectorAll('.fulfill-decline-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      // Capture whatever's currently typed before re-rendering the whole
      // step wipes the DOM out from under it.
      fulfillPickedUpBy = document.getElementById('fulfill-picked-up-by').value;
      UnitScan.stop();
      const row = fulfillRows.find((r) => r.id === btn.dataset.id);
      row.declined = !row.declined;
      row.actualQty = row.declined ? 0 : row.requestedQty;
      row.mode = 'manual';
      row.scannedUnits = [];
      if (!row.declined) row.declineNote = '';
      renderFulfillAdjustStep();
    });
  });
  document.querySelectorAll('.fulfill-qty-input').forEach((input) => {
    input.addEventListener('input', () => {
      const row = fulfillRows.find((r) => r.id === input.dataset.id);
      row.actualQty = input.value === '' ? '' : Number(input.value);
    });
  });
  document.querySelectorAll('.fulfill-decline-note').forEach((ta) => {
    ta.addEventListener('input', () => {
      const row = fulfillRows.find((r) => r.id === ta.dataset.id);
      row.declineNote = ta.value;
    });
  });
  document.querySelectorAll('.fulfill-shortfall-note').forEach((ta) => {
    ta.addEventListener('input', () => {
      const row = fulfillRows.find((r) => r.id === ta.dataset.id);
      row.shortfallNote = ta.value;
    });
  });
  document.querySelectorAll('.fulfill-mode-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => {
      fulfillPickedUpBy = document.getElementById('fulfill-picked-up-by').value;
      const row = fulfillRows.find((r) => r.id === btn.dataset.id);
      const mode = btn.dataset.mode;
      if (row.mode === mode) return;
      UnitScan.stop();
      row.mode = mode;
      if (mode === 'manual') {
        row.actualQty = row.requestedQty;
      }
      renderFulfillAdjustStep();
    });
  });
  document.querySelectorAll('.fulfill-scan-undo').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = fulfillRows.find((r) => r.id === btn.dataset.id);
      UnitScan.undo(row);
    });
  });
}

// Re-attaches a photo picker without resetting evidenceState[prefix] —
// wireEvidencePicker() (shared with Receive/single-item Issue) always
// resets its state on call, which would silently drop already-selected
// photos every time a re-render happens mid-flow (a fulfill row's "cannot
// deliver" toggle, or a return row's Manual/Scan units toggle).
function wirePhotoPickerKeepState(prefix) {
  if (!evidenceState[prefix]) evidenceState[prefix] = [];
  const input = document.getElementById(`${prefix}-photos`);
  input.addEventListener('change', (e) => {
    evidenceState[prefix] = [...evidenceState[prefix], ...Array.from(e.target.files)];
    e.target.value = '';
    renderEvidenceThumbs(prefix);
  });
  renderEvidenceThumbs(prefix);
}

function wireFulfillPhotoPicker() {
  wirePhotoPickerKeepState('fulfill');
}

function renderFulfillAdjustStep() {
  const meta = fulfillRequestMeta;
  Sheet.open(t('fulfillRequestTitle', meta.request_code), `
    <div id="fulfill-error"></div>
    <div class="confirm-rows" style="margin-bottom:var(--s4)">
      <div class="confirm-row"><span>${t('fieldRequesterName2')}</span><strong>${escapeHtml(meta.requester_name)}</strong></div>
      <div class="confirm-row"><span>${t('fieldDepartment')}</span><strong>${escapeHtml(meta.department || t('noDepartment'))}</strong></div>
      <div class="confirm-row"><span>${t('fieldWorkArea')}</span><strong>${escapeHtml(meta.work_area || t('noWorkArea'))}</strong></div>
      <div class="confirm-row"><span>${t('fieldBuilding')}</span><strong>${escapeHtml(meta.building || t('noBuilding'))}</strong></div>
    </div>
    <div id="fulfill-item-rows">${fulfillRows.map(fulfillRowHtml).join('')}</div>
    <div class="field">
      <label for="fulfill-picked-up-by">${t('fieldPickedUpBy')}</label>
      <input type="text" id="fulfill-picked-up-by" placeholder="${escapeHtml(t('fieldReceivedByPh'))}" value="${escapeHtml(fulfillPickedUpBy)}">
    </div>
    <div class="field">
      <label for="fulfill-photos">${t('fieldEvidencePhotos')}</label>
      <input type="file" id="fulfill-photos" accept="image/*" multiple>
      <div class="evidence-thumbs" id="fulfill-photos-preview"></div>
    </div>
    <button type="button" class="btn btn-primary btn-block" id="btn-fulfill-review" style="margin-top:var(--s4)">${icon('arrowRight', 16)}<span>${t('btnReviewFulfill')}</span></button>
  `);
  applyStaticIcons();
  wireFulfillRowEvents();
  wireFulfillPhotoPicker();
  document.getElementById('btn-fulfill-review').addEventListener('click', onFulfillReviewClick);

  fulfillRows.forEach((row) => {
    row.onScanChange = () => updateFulfillScanRowUI(row);
    row.validateUnitScan = (unit, code) => validateFulfillUnitScan(row, unit, code);
    if (row.mode === 'scan') {
      const slot = document.querySelector(`.fulfill-scan-slot[data-id="${row.id}"]`);
      if (slot) UnitScan.start(row, slot);
    }
  });
}

function onFulfillReviewClick() {
  const errEl = document.getElementById('fulfill-error');
  errEl.innerHTML = '';
  fulfillPickedUpBy = document.getElementById('fulfill-picked-up-by').value.trim();

  // Defensive re-sync in case a browser fires 'input' inconsistently —
  // cheap, and guarantees fulfillRows reflects exactly what's on screen
  // right before validating it.
  document.querySelectorAll('.fulfill-qty-input').forEach((input) => {
    const row = fulfillRows.find((r) => r.id === input.dataset.id);
    if (row && !row.declined) row.actualQty = input.value === '' ? '' : Number(input.value);
  });
  document.querySelectorAll('.fulfill-decline-note').forEach((ta) => {
    const row = fulfillRows.find((r) => r.id === ta.dataset.id);
    if (row) row.declineNote = ta.value;
  });

  const deliveringRows = fulfillRows.filter((r) => !r.declined);
  const decliningRows = fulfillRows.filter((r) => r.declined);

  const missingQty = deliveringRows.find((r) => !(r.actualQty > 0));
  if (missingQty) {
    errEl.innerHTML = `<div class="form-error">${escapeHtml(t('errorQtyRequired'))}</div>`;
    document.getElementById(`fulfill-qty-${missingQty.id}`)?.focus();
    return;
  }
  // Separate from the check above on purpose — "you left this blank" and
  // "there isn't enough on the shelf" are different problems with
  // different fixes (type a number vs. lower the qty or mark it
  // undeliverable), and lumping them into one generic message was exactly
  // what made a real insufficient-stock case unreadable as anything but
  // "you forgot to enter a quantity" (see REQ-260914-008).
  const overStock = deliveringRows.find((r) => Number(r.actualQty) > Number(r.onHand));
  if (overStock) {
    errEl.innerHTML = `<div class="form-error">${escapeHtml(t('errorInsufficientStockFor', overStock.name, fmtQty(overStock.onHand), overStock.baseUom))}</div>`;
    document.getElementById(`fulfill-qty-${overStock.id}`)?.focus();
    return;
  }
  const missingNote = decliningRows.find((r) => !r.declineNote.trim());
  if (missingNote) {
    errEl.innerHTML = `<div class="form-error">${escapeHtml(t('errorDeclineReasonRequired'))}</div>`;
    document.getElementById(`fulfill-note-${missingNote.id}`)?.focus();
    return;
  }
  // A scan-mode row that stopped short of the requested count needs the
  // same "what happened" explanation a decline does — just attached to a
  // partial delivery instead of a zero one.
  const missingShortfall = deliveringRows.find((r) => r.mode === 'scan' && r.scannedUnits.length > 0 && r.scannedUnits.length < r.requestedQty && !r.shortfallNote.trim());
  if (missingShortfall) {
    errEl.innerHTML = `<div class="form-error">${escapeHtml(t('errorDeclineReasonRequired'))}</div>`;
    document.getElementById(`fulfill-shortfall-${missingShortfall.id}`)?.focus();
    return;
  }
  if (deliveringRows.length && !fulfillPickedUpBy) {
    errEl.innerHTML = `<div class="form-error">${escapeHtml(t('fieldPickedUpByRequired'))}</div>`;
    return;
  }
  UnitScan.stop();

  renderFulfillReviewStep();
}

function renderFulfillReviewStep() {
  const meta = fulfillRequestMeta;
  Sheet.open(t('fulfillRequestTitle', meta.request_code), `
    <div id="fulfill-error"></div>
    <p class="field-hint" style="margin-bottom:var(--s4)">${t('fulfillReviewHeading')}</p>
    <div class="table-scroll">
      <table>
        <thead><tr><th>${t('colItem')}</th><th>${t('colRequested')}</th><th>${t('colActual')}</th></tr></thead>
        <tbody>
          ${fulfillRows.map((r) => `
            <tr${!r.declined && Number(r.actualQty) !== Number(r.requestedQty) ? ' style="background:var(--discrepancy-wash)"' : ''}>
              <td>${escapeHtml(r.name)} <span class="mono">(${escapeHtml(r.skuCode)})</span></td>
              <td class="num">${fmtQty(r.requestedQty)} ${escapeHtml(r.baseUom)}</td>
              <td class="num">${r.declined ? `<span class="chip chip-low">${t('chipNotDelivered')}</span>` : `${fmtQty(r.actualQty)} ${escapeHtml(r.baseUom)}`}</td>
            </tr>
            ${r.declined ? `<tr><td colspan="3" class="card-meta">${escapeHtml(r.declineNote)}</td></tr>` : ''}
          `).join('')}
        </tbody>
      </table>
    </div>
    <div class="confirm-row" style="margin-top:var(--s4)"><span>${t('fieldPickedUpBy')}</span><strong>${escapeHtml(fulfillPickedUpBy || '—')}</strong></div>
    <div class="field" style="margin-top:var(--s4)">
      <label for="fulfill-form-photo">${t('fieldFormPhoto')}</label>
      <input type="file" id="fulfill-form-photo" accept="image/*" capture="environment">
    </div>
    <div class="field">
      <label>${t('fieldSignature')}</label>
      <canvas id="fulfill-signature" class="signature-pad"></canvas>
      <button type="button" class="btn btn-ghost btn-sm" id="fulfill-signature-clear">${t('btnClearSignature')}</button>
    </div>
    <button type="button" class="btn btn-outline btn-block" id="btn-fulfill-back" style="margin-top:var(--s4)">${icon('arrowRight', 16)}<span>${t('btnBackToAdjust')}</span></button>
    <button type="button" class="btn btn-primary btn-block" id="btn-fulfill-confirm" style="margin-top:var(--s3)">${icon('check', 16)}<span id="fulfill-confirm-label">${t('btnConfirmFulfill')}</span></button>
  `);
  applyStaticIcons();
  document.getElementById('btn-fulfill-back').addEventListener('click', renderFulfillAdjustStep);
  document.getElementById('btn-fulfill-confirm').addEventListener('click', onFulfillConfirmClick);
  document.getElementById('fulfill-form-photo').addEventListener('change', (e) => {
    if (!evidenceState.fulfill) evidenceState.fulfill = [];
    if (e.target.files[0]) evidenceState.fulfill.push(e.target.files[0]);
  });
  Signature.mount(document.getElementById('fulfill-signature'));
  document.getElementById('fulfill-signature-clear').addEventListener('click', () => {
    Signature.clear(document.getElementById('fulfill-signature'));
  });
}

async function onFulfillConfirmClick() {
  const errEl = document.getElementById('fulfill-error');
  errEl.innerHTML = '';
  const btn = document.getElementById('btn-fulfill-confirm');
  const label = document.getElementById('fulfill-confirm-label');
  btn.disabled = true; label.textContent = t('btnConfirming');

  try {
    const signatureCanvas = document.getElementById('fulfill-signature');
    if (signatureCanvas && !Signature.isEmpty(signatureCanvas)) {
      if (!evidenceState.fulfill) evidenceState.fulfill = [];
      evidenceState.fulfill.push(await Signature.toBlob(signatureCanvas));
    }
    const imagePaths = await uploadEvidenceFor('fulfill', 'issue');
    let delivered = 0;
    let declined = 0;
    let failed = 0;
    for (const row of fulfillRows) {
      try {
        if (row.declined) {
          await DB.declineRequestItem(row.id, row.declineNote.trim());
          declined++;
        } else {
          const unitCodes = row.mode === 'scan' ? row.scannedUnits : null;
          const shortfallNote = row.mode === 'scan' ? row.shortfallNote.trim() || null : null;
          await DB.issueStock({ skuId: row.skuId, requestId: row.id, actualQty: Number(row.actualQty), performedBy: fulfillPickedUpBy, imagePaths, unitCodes, shortfallNote });
          delivered++;
        }
      } catch (err) {
        failed++;
      }
    }
    toast(t('toastFulfillDone', delivered, declined), failed ? 'error' : 'success');
    resetEvidence('fulfill');
    Sheet.close();
    resetScanView();
    loadRequests();
  } catch (err) {
    errEl.innerHTML = `<div class="form-error">${escapeHtml(err.message || 'Could not complete fulfillment')}</div>`;
    btn.disabled = false; label.textContent = t('btnConfirmFulfill');
  }
}

// ============================================================================
// REQUESTS
// ============================================================================
const REQUEST_STATUSES = ['all', 'pending', 'preparing', 'ready', 'fulfilled'];
let requestStatus = 'all';
let requestSearch = '';
let requestRows = [];

function renderRequestTabs() {
  const el = document.getElementById('request-status-tabs');
  el.innerHTML = REQUEST_STATUSES.map((s) => `<button data-status="${s}" aria-pressed="${s === requestStatus}">${icon(STATUS_ICONS[s] || 'list', 15)}<span>${statusLabel(s)}</span></button>`).join('');
  el.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => { requestStatus = b.dataset.status; renderRequestTabs(); loadRequests(); });
  });
}
renderRequestTabs();

document.getElementById('request-search').addEventListener('input', (e) => {
  requestSearch = e.target.value;
  renderRequestsList();
});

async function loadRequests() {
  const list = document.getElementById('requests-list');
  list.innerHTML = skeletonCards(3);
  try {
    requestRows = await DB.listRequests({ status: requestStatus === 'all' ? null : requestStatus });
    renderRequestsList();
  } catch (err) {
    list.innerHTML = '';
    toast(err.message || 'Could not load requests', 'error');
  }
}

function renderRequestsList() {
  const list = document.getElementById('requests-list');
  const q = requestSearch.trim().toLowerCase();
  const rows = q ? requestRows.filter((r) =>
    (r.requester_name || '').toLowerCase().includes(q) ||
    (r.picked_up_by || '').toLowerCase().includes(q) ||
    (r.request_code || '').toLowerCase().includes(q) ||
    (r.department || '').toLowerCase().includes(q) ||
    (r.notes || '').toLowerCase().includes(q) ||
    (r.work_area || '').toLowerCase().includes(q) ||
    (r.skus?.name || '').toLowerCase().includes(q) ||
    (r.skus?.sku_code || '').toLowerCase().includes(q) ||
    (r.created_at || '').slice(0, 10).includes(q) ||
    fmtDate(r.created_at).toLowerCase().includes(q)
  ) : requestRows;

  if (!rows.length) {
    if (q) {
      list.innerHTML = `<div class="empty"><p>${t('emptySearchResults', escapeHtml(requestSearch.trim()))}</p></div>`;
      return;
    }
    list.innerHTML = `<div class="empty"><p>${t('emptyRequests', requestStatus === 'all' ? '' : statusLabel(requestStatus) + ' ')}</p>
      <button class="btn btn-primary btn-sm" id="empty-new-request">${icon('plusCircle', 14)}<span>${t('btnNewRequest')}</span></button></div>`;
    document.getElementById('empty-new-request')?.addEventListener('click', openNewRequestSheet);
    return;
  }
  list.innerHTML = rows.map((r) => {
    const hasItem = !!r.sku_id;
    const title = hasItem ? escapeHtml(r.skus?.name || 'Unknown item') : (r.department ? escapeHtml(r.department) : t('generalRequest'));
    const meta = hasItem
      ? `${escapeHtml(r.requester_name)} · ${fmtQty(r.qty_requested)} ${escapeHtml(r.skus?.base_uom || '')}${r.department ? ' · ' + escapeHtml(r.department) : ''}`
      : escapeHtml(r.requester_name);
    // Internal requests set needed_by; requests submitted through the public
    // form (with or without an item) don't, so fall back to when it came in.
    const whenLine = r.needed_by ? t('neededBy', fmtDate(r.needed_by)) : fmtDateTime(r.created_at);
    return `
    <div class="card">
      <div class="card-row">
        <div>
          <div class="card-title">${title}</div>
          <div class="card-meta">${meta}</div>
        </div>
        ${r.status === 'fulfilled' && r.staff_note
          ? `<span class="chip chip-low">${t('chipNotDelivered')}</span>`
          : `<span class="chip ${statusChipClass(r.status)}">${statusLabel(r.status)}</span>`}
      </div>
      ${r.work_area ? `<div class="card-meta" style="margin-top:var(--s2)">${icon('mapPin', 12)} ${escapeHtml(r.work_area)}</div>` : ''}
      ${r.notes ? `<div class="card-meta" style="margin-top:var(--s2)">${escapeHtml(r.notes)}</div>` : ''}
      <div class="card-row" style="margin-top:var(--s3)">
        <span class="card-meta mono">${escapeHtml(r.request_code)} · ${whenLine}</span>
        ${nextStatusButton(r)}
      </div>
      ${r.status === 'fulfilled' && r.staff_note ? `<div class="card-meta" style="margin-top:var(--s2)">${escapeHtml(r.staff_note)}</div>` : ''}
      ${r.status === 'fulfilled' && r.picked_up_by ? `<div class="card-meta" style="margin-top:var(--s2)">${escapeHtml(t('pickedUpBy', r.picked_up_by))}</div>` : ''}
      ${r.approver?.name ? `<div class="card-meta" style="margin-top:var(--s1)">${escapeHtml(t('approvedBy', r.approver.name))}</div>` : ''}
      <div class="card-row" style="margin-top:var(--s2)">
        <button class="btn btn-ghost btn-sm" data-print="${escapeHtml(r.request_code)}" title="${escapeHtml(t('btnPrintPdf'))}" aria-label="${escapeHtml(t('btnPrintPdf'))}">${icon('printer', 14)}<span>${t('btnPrintPdf')}</span></button>
      </div>
    </div>
  `;
  }).join('');
  list.querySelectorAll('[data-print]').forEach((btn) => {
    btn.addEventListener('click', () => printRequestSlip(btn.dataset.print));
  });
  list.querySelectorAll('[data-advance]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await DB.setRequestStatus(btn.dataset.advance, btn.dataset.to);
        toast(t('toastStatusUpdated', statusLabel(btn.dataset.to)), 'success');
        loadRequests();
      } catch (err) {
        toast(err.message || 'Could not update request', 'error');
      }
    });
  });
}

function statusChipClass(status) {
  if (status === 'fulfilled') return 'chip-ok';
  if (status === 'cancelled') return 'chip-neutral';
  return 'chip-low';
}
function nextStatusButton(r) {
  // RLS refuses this anyway for a requester-role account (see
  // set_request_status()/schema.sql) — hidden here too so the button never
  // shows something they can't actually do.
  if (currentProfile?.role === 'requester') return '';
  const next = { pending: 'preparing', preparing: 'ready' }[r.status];
  if (!next) return '';
  return `<button class="btn btn-outline btn-sm" data-advance="${r.id}" data-to="${next}">${icon('arrowRight', 14)}<span>${t('btnMarkStatus', statusLabel(next))}</span></button>`;
}

// "Export PDF" on a request card, and on the post-submit confirmation in
// openNewRequestSheet() below — same printable requisition slip as the
// public form's post-submit confirmation screen (.print-sheet in
// request.html/js/request.js). rowsOverride lets the post-submit
// confirmation hand in rows it fetched directly (DB.getRequestByCode) —
// the properly skus-joined shape, independent of whatever status filter
// the Requests list currently has selected; without it, this filters the
// already-loaded requestRows (one row per item, all sharing request_code —
// see create_public_request()/create_authenticated_request() in
// schema.sql), same as every other caller. Only ever called for a request
// that already exists — there's nothing to print before create*_request()
// has run.
function printRequestSlip(requestCode, rowsOverride) {
  const rows = rowsOverride || requestRows.filter((r) => r.request_code === requestCode);
  if (!rows.length) return;
  const first = rows[0];
  const itemRows = rows.filter((r) => r.sku_id);

  const itemsHtml = itemRows.length
    ? itemRows.map((r, i) => `
        <tr>
          <td class="print-col-no">${i + 1}</td>
          <td>${escapeHtml(r.skus?.name || '')} <span class="mono">(${escapeHtml(r.skus?.sku_code || '')})</span></td>
          <td class="print-col-qty">${fmtQty(r.qty_requested)}</td>
          <td class="print-col-unit">${escapeHtml(r.skus?.base_uom || '')}</td>
        </tr>
      `).join('')
    : `<tr><td colspan="4">${escapeHtml(t('generalRequest'))}</td></tr>`;

  document.getElementById('request-print-sheet').innerHTML = `
    <div class="print-sheet-letterhead">
      <img class="print-sheet-logo" src="img/logo-property-office.png" alt="">
      <div class="print-sheet-org-name">${escapeHtml(t('orgName'))}</div>
    </div>
    <div class="print-sheet-head">
      <div class="print-sheet-title">${escapeHtml(t('printFormTitle'))}</div>
      <div class="print-sheet-code-group">
        <div class="print-sheet-code">${escapeHtml(first.request_code)}</div>
        <div class="print-sheet-qr" id="request-print-qr"></div>
      </div>
    </div>
    <table class="print-sheet-meta">
      <tr>
        <th>${escapeHtml(t('printFieldDate'))}</th><td>${escapeHtml(fmtDateTime(first.created_at))}</td>
        <th>${escapeHtml(t('fieldDepartment'))}</th><td>${escapeHtml(first.department || t('noDepartment'))}</td>
      </tr>
      <tr>
        <th>${escapeHtml(t('fieldRequesterName2'))}</th><td>${escapeHtml(first.requester_name)}</td>
        <th>${escapeHtml(t('fieldWorkArea'))}</th><td>${escapeHtml(first.work_area || '—')}</td>
      </tr>
      <tr>
        <th>${escapeHtml(t('fieldBuilding'))}</th><td colspan="3">${escapeHtml(first.building || t('noBuilding'))}</td>
      </tr>
    </table>
    <table class="print-sheet-items">
      <thead>
        <tr>
          <th class="print-col-no">${escapeHtml(t('printColNo'))}</th>
          <th>${escapeHtml(t('colItem'))}</th>
          <th class="print-col-qty">${escapeHtml(t('printColQty'))}</th>
          <th class="print-col-unit">${escapeHtml(t('fieldUnit'))}</th>
        </tr>
      </thead>
      <tbody>${itemsHtml}</tbody>
    </table>
    ${first.notes ? `
      <div class="print-sheet-notes">
        <strong>${escapeHtml(t('fieldComment'))}</strong>
        <span>${escapeHtml(first.notes)}</span>
      </div>
    ` : ''}
    <div class="print-sheet-signatures">
      <div class="print-sig-box"><div class="print-sig-line"></div><div class="print-sig-label">${escapeHtml(t('sigRequester'))}</div></div>
      <div class="print-sig-box"><div class="print-sig-line"></div><div class="print-sig-label">${escapeHtml(t('sigApprover'))}</div></div>
      <div class="print-sig-box"><div class="print-sig-line"></div><div class="print-sig-label">${escapeHtml(t('sigIssuer'))}</div></div>
      <div class="print-sig-box"><div class="print-sig-line"></div><div class="print-sig-label">${escapeHtml(t('sigReceiver'))}</div></div>
    </div>
    <div class="print-sheet-footer">${escapeHtml(t('printFooterNote', first.request_code))}</div>
  `;
  // Scanning this at the counter is what drives openFulfillRequestSheet()
  // below — encodes the request_code exactly like an item sticker encodes
  // a sku_code, so the same scanner/decode path (js/qr.js) hands it to
  // onItemScanned() unchanged; the REQ- prefix is what tells that function
  // which kind of code it just read.
  QR.renderInto(document.getElementById('request-print-qr'), first.request_code, 72);
  window.print();
}

document.getElementById('btn-new-request').addEventListener('click', openNewRequestSheet);

// Multiple items + a comment, same search-and-cart pattern as the public
// form (js/request.js) — ported here rather than shared, since the two
// pages don't share a module system, using activeSkus (already loaded for
// Stock) instead of a fresh catalog fetch and an `nr-` id prefix so it
// can't collide with request.html's own copy of these same ids.
let nrItems = [];
let nrBuildings = [];
let nrDepartments = [];

async function loadNrBuildings() {
  try {
    nrBuildings = await DB.listBuildings();
    renderNrBuildingOptions();
  } catch (err) {
    toast(err.message || 'Could not load buildings', 'error');
  }
}
function renderNrBuildingOptions(selected = '') {
  const sel = document.getElementById('nr-building');
  if (!sel) return;
  const current = selected || sel.value;
  sel.innerHTML = `
    <option value="">${t('noBuilding')}</option>
    ${nrBuildings.map((b) => `<option value="${escapeHtml(b.name)}" ${b.name === current ? 'selected' : ''}>${escapeHtml(b.name)}</option>`).join('')}
  `;
}
async function onAddNrBuilding(newInput, newRow) {
  const name = newInput.value.trim();
  const errEl = document.getElementById('nr-error');
  errEl.innerHTML = '';
  if (!name) return;
  try {
    await DB.createBuilding(name);
    nrBuildings = await DB.listBuildings();
    renderNrBuildingOptions(name);
    newInput.value = '';
    newRow.hidden = true;
    toast(t('toastBuildingAdded'), 'success');
  } catch (err) {
    const msg = /duplicate|unique/i.test(err.message || '') ? t('errorBuildingExists') : (err.message || 'Could not add building');
    errEl.innerHTML = `<div class="form-error">${escapeHtml(msg)}</div>`;
  }
}

// Department dropdown — only rendered/relevant when showRequesterField is
// true (Staff/Admin naming someone else): a plain Requester's own
// department always comes from their profile server-side regardless of
// what's sent (see create_authenticated_request() in schema.sql), same
// reasoning that already hides the requester-name field for that role.
async function loadNrDepartments() {
  try {
    nrDepartments = await DB.listDepartments();
    renderNrDepartmentOptions();
  } catch (err) {
    toast(err.message || 'Could not load departments', 'error');
  }
}
function renderNrDepartmentOptions(selected = '') {
  const sel = document.getElementById('nr-department');
  if (!sel) return;
  const current = selected || sel.value;
  sel.innerHTML = `
    <option value="">${t('noDepartment')}</option>
    ${nrDepartments.map((d) => `<option value="${escapeHtml(d.name)}" ${d.name === current ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}
  `;
}
async function onAddNrDepartment(newInput, newRow) {
  const name = newInput.value.trim();
  const errEl = document.getElementById('nr-error');
  errEl.innerHTML = '';
  if (!name) return;
  try {
    await DB.createDepartment(name);
    nrDepartments = await DB.listDepartments();
    renderNrDepartmentOptions(name);
    newInput.value = '';
    newRow.hidden = true;
  } catch (err) {
    const msg = /duplicate|unique/i.test(err.message || '') ? t('errorDepartmentExists') : (err.message || 'Could not add department');
    errEl.innerHTML = `<div class="form-error">${escapeHtml(msg)}</div>`;
  }
}

// Work area dropdown — same "reference table + inline add" pattern as
// Building above, but unlike Department, shown to every role: it describes
// where the work is, not an attribute of who's asking, so it's never
// profile-derived. Required, same as on the public form.
// Shown inside the same Sheet right after a successful submit — same
// "confirmation + Export PDF" shape as the public form's post-submit
// screen (js/request.js showConfirmView()), adapted to this modal instead
// of a full page swap. Fetches its own properly skus-joined rows via
// DB.getRequestByCode() rather than reading requestRows, since the
// Requests list's current status filter shouldn't determine whether this
// can find the request it just created (see printRequestSlip() above).
async function showNewRequestConfirmation(requestCode) {
  let rows;
  try {
    rows = await DB.getRequestByCode(requestCode);
  } catch (err) {
    toast(err.message || 'Could not load the submitted request', 'error');
    return;
  }
  if (!rows.length) return;
  const first = rows[0];
  const itemRows = rows.filter((r) => r.sku_id);

  Sheet.open(t('requestSubmittedTitle'), `
    <p class="field-hint" style="text-align:center;margin-bottom:var(--s4)">${t('requestSubmittedHint')}</p>
    <div class="confirm-code" style="margin-bottom:var(--s4)">${escapeHtml(first.request_code)}</div>
    <div class="confirm-rows">
      <div class="confirm-row"><span>${t('fieldRequesterName2')}</span><strong>${escapeHtml(first.requester_name)}</strong></div>
      <div class="confirm-row"><span>${t('fieldDepartment')}</span><strong>${escapeHtml(first.department || t('noDepartment'))}</strong></div>
      <div class="confirm-row"><span>${t('fieldWorkArea')}</span><strong>${escapeHtml(first.work_area || t('noWorkArea'))}</strong></div>
      <div class="confirm-row"><span>${t('fieldBuilding')}</span><strong>${escapeHtml(first.building || t('noBuilding'))}</strong></div>
    </div>
    ${itemRows.length ? `
      <p class="eyebrow" style="margin-top:var(--s4)">${t('confirmItemsHeading')}</p>
      <div class="req-item-list">
        ${itemRows.map((r) => `
          <div class="req-item-row req-item-row-readonly">
            <span class="req-item-row-text">
              <strong>${escapeHtml(r.skus?.name || '')}</strong>
              <span class="card-meta mono">${escapeHtml(r.skus?.sku_code || '')}</span>
            </span>
            <span class="req-item-row-qty-display">${fmtQty(r.qty_requested)} ${escapeHtml(r.skus?.base_uom || '')}</span>
          </div>
        `).join('')}
      </div>
    ` : ''}
    ${first.notes ? `<div class="confirm-comment" style="margin-top:var(--s4)">${escapeHtml(first.notes)}</div>` : ''}
    <button type="button" class="btn btn-outline btn-block" id="nrc-print" style="margin-top:var(--s5)">${icon('printer', 16)}<span>${t('btnPrintPdf')}</span></button>
    <button type="button" class="btn btn-primary btn-block" id="nrc-done" style="margin-top:var(--s3)">${icon('checkCircle', 16)}<span>${t('btnDone')}</span></button>
  `);
  applyStaticIcons();
  document.getElementById('nrc-print').addEventListener('click', () => printRequestSlip(requestCode, rows));
  document.getElementById('nrc-done').addEventListener('click', () => Sheet.close());
}

function openNewRequestSheet() {
  nrItems = [];
  // A Requester's own identity is never editable here — the RPC always uses
  // their profile regardless of what's sent, so there's no point showing a
  // field that can't change anything. Staff/Admin still get it, now
  // optional: filled in, it names who this is actually for (a walk-in who
  // called it in); left blank, it submits under their own name.
  const showRequesterField = currentProfile?.role !== 'requester';
  Sheet.open(t('newRequestTitle'), `
    <div id="nr-error"></div>
    <form id="form-new-request">
      ${showRequesterField ? `
        <div class="field">
          <label for="nr-requester">${t('fieldRequesterName')}</label>
          <input type="text" id="nr-requester">
          <p class="field-hint">${t('fieldRequesterNameOptionalHint')}</p>
        </div>
        <div class="field">
          <label for="nr-department">${t('fieldDepartment')}</label>
          <div class="field-with-btn">
            <select id="nr-department"></select>
            <button type="button" class="btn-icon-add" id="nr-department-add-btn" title="${t('addDepartmentTitle')}" aria-label="${t('addDepartmentTitle')}">${icon('plusCircle', 18)}</button>
          </div>
          <div class="new-category-row" id="nr-department-new-row" hidden>
            <input type="text" id="nr-department-new-input" placeholder="${t('newDepartmentPlaceholder')}">
            <button type="button" class="btn btn-outline btn-sm" id="nr-department-new-confirm">${icon('check', 14)}<span>${t('add')}</span></button>
            <button type="button" class="btn btn-ghost btn-sm" id="nr-department-new-cancel">${icon('xCircle', 14)}</button>
          </div>
        </div>
      ` : ''}
      <div class="field">
        <label>${t('fieldSelectItems')}</label>
        <div class="search-wrap" data-icon="search">
          <input type="search" class="search-input" id="nr-item-search" placeholder="${escapeHtml(t('searchItemsPlaceholder'))}" autocomplete="off">
        </div>
        <div id="nr-item-results" class="req-item-results"></div>
        <div id="nr-item-list" class="req-item-list"></div>
      </div>
      <div class="field">
        <label for="nr-needed">${t('fieldNeededBy')}</label>
        <input type="date" id="nr-needed">
      </div>
      <div class="field">
        <label for="nr-workarea">${t('fieldWorkArea')}</label>
        <input type="text" id="nr-workarea" placeholder="${escapeHtml(t('fieldWorkAreaPh'))}" required>
      </div>
      <div class="field">
        <label for="nr-building">${t('fieldBuilding')}</label>
        <div class="field-with-btn">
          <select id="nr-building"></select>
          <button type="button" class="btn-icon-add" id="nr-building-add-btn" title="${t('addBuildingTitle')}" aria-label="${t('addBuildingTitle')}">${icon('plusCircle', 18)}</button>
        </div>
        <div class="new-category-row" id="nr-building-new-row" hidden>
          <input type="text" id="nr-building-new-input" placeholder="${t('newBuildingPlaceholder')}">
          <button type="button" class="btn btn-outline btn-sm" id="nr-building-new-confirm">${icon('check', 14)}<span>${t('add')}</span></button>
          <button type="button" class="btn btn-ghost btn-sm" id="nr-building-new-cancel">${icon('xCircle', 14)}</button>
        </div>
      </div>
      <div class="field">
        <label for="nr-comment">${t('fieldComment')}</label>
        <textarea id="nr-comment" placeholder="${escapeHtml(t('fieldCommentPh'))}" style="min-height:100px"></textarea>
        <p class="field-hint" id="nr-comment-hint">${t('fieldCommentHint')}</p>
      </div>
      <button class="btn btn-primary btn-block" type="submit">${icon('send', 16)}<span>${t('btnSubmitRequest')}</span></button>
    </form>
  `);
  applyStaticIcons();
  renderNrItemList();
  loadNrBuildings();
  document.getElementById('nr-item-search').addEventListener('input', renderNrItemResults);
  const nrBuildingAddBtn = document.getElementById('nr-building-add-btn');
  const nrBuildingNewRow = document.getElementById('nr-building-new-row');
  const nrBuildingNewInput = document.getElementById('nr-building-new-input');
  nrBuildingAddBtn.addEventListener('click', () => {
    nrBuildingNewRow.hidden = !nrBuildingNewRow.hidden;
    if (!nrBuildingNewRow.hidden) nrBuildingNewInput.focus();
  });
  document.getElementById('nr-building-new-cancel').addEventListener('click', () => {
    nrBuildingNewInput.value = '';
    nrBuildingNewRow.hidden = true;
  });
  document.getElementById('nr-building-new-confirm').addEventListener('click', () => onAddNrBuilding(nrBuildingNewInput, nrBuildingNewRow));
  nrBuildingNewInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); onAddNrBuilding(nrBuildingNewInput, nrBuildingNewRow); }
  });
  if (showRequesterField) {
    loadNrDepartments();
    const nrDepartmentAddBtn = document.getElementById('nr-department-add-btn');
    const nrDepartmentNewRow = document.getElementById('nr-department-new-row');
    const nrDepartmentNewInput = document.getElementById('nr-department-new-input');
    nrDepartmentAddBtn.addEventListener('click', () => {
      nrDepartmentNewRow.hidden = !nrDepartmentNewRow.hidden;
      if (!nrDepartmentNewRow.hidden) nrDepartmentNewInput.focus();
    });
    document.getElementById('nr-department-new-cancel').addEventListener('click', () => {
      nrDepartmentNewInput.value = '';
      nrDepartmentNewRow.hidden = true;
    });
    document.getElementById('nr-department-new-confirm').addEventListener('click', () => onAddNrDepartment(nrDepartmentNewInput, nrDepartmentNewRow));
    nrDepartmentNewInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onAddNrDepartment(nrDepartmentNewInput, nrDepartmentNewRow); }
    });
  }
  document.getElementById('form-new-request').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('nr-error');
    errEl.innerHTML = '';
    const comment = document.getElementById('nr-comment').value.trim();

    const missingQty = nrItems.find((it) => !it.qty || Number(it.qty) <= 0);
    if (missingQty) {
      errEl.innerHTML = `<div class="form-error">${escapeHtml(t('errorQtyRequired'))}</div>`;
      const qtyInput = document.querySelector(`.req-item-row-qty[data-id="${CSS.escape(missingQty.id)}"]`);
      if (qtyInput) qtyInput.focus();
      return;
    }
    if (!nrItems.length && !comment) {
      errEl.innerHTML = `<div class="form-error">${escapeHtml(t('errorItemOrComment'))}</div>`;
      return;
    }

    try {
      const created = await DB.createRequest({
        items: nrItems.map((it) => ({ skuId: it.id, qty: Number(it.qty) })),
        comment: comment || null,
        neededBy: document.getElementById('nr-needed').value,
        requesterName: showRequesterField ? document.getElementById('nr-requester').value.trim() : '',
        department: showRequesterField ? document.getElementById('nr-department').value.trim() : '',
        building: document.getElementById('nr-building').value.trim() || null,
        workArea: document.getElementById('nr-workarea').value.trim() || null,
      });
      toast(t('toastRequestSubmitted'), 'success');
      loadRequests();
      const requestCode = (Array.isArray(created) ? created[0] : created)?.request_code;
      if (requestCode) showNewRequestConfirmation(requestCode);
      else Sheet.close();
    } catch (err) {
      errEl.innerHTML = `<div class="form-error">${escapeHtml(err.message || 'Could not submit request')}</div>`;
    }
  });
}

function renderNrItemResults() {
  const box = document.getElementById('nr-item-results');
  const q = document.getElementById('nr-item-search').value.trim().toLowerCase();
  if (!q) {
    box.innerHTML = '';
    box.hidden = true;
    return;
  }
  const addedIds = new Set(nrItems.map((it) => it.id));
  const matches = activeSkus
    .filter((s) => !addedIds.has(s.id) && (s.name.toLowerCase().includes(q) || s.sku_code.toLowerCase().includes(q)))
    .slice(0, 8);
  box.hidden = false;
  box.innerHTML = matches.length
    ? matches.map((s) => `
        <button type="button" class="req-item-option" data-id="${escapeHtml(s.id)}">
          ${s.image_paths?.[0] ? `<img class="req-item-option-thumb" src="${DB.getItemPhotoUrl(s.image_paths[0])}" alt="">` : icon(catIcon(s.category), 16)}
          <span class="req-item-option-text">
            <strong>${escapeHtml(s.name)}</strong>
            <span class="card-meta mono">${escapeHtml(s.sku_code)} · ${escapeHtml(s.base_uom)}</span>
          </span>
        </button>
      `).join('')
    : `<div class="req-item-empty">${escapeHtml(t('emptySearchResultsShort'))}</div>`;

  box.querySelectorAll('.req-item-option').forEach((btn) => {
    btn.addEventListener('click', () => addNrItem(btn.getAttribute('data-id')));
  });
}

function addNrItem(id) {
  if (nrItems.some((it) => it.id === id)) return;
  const item = activeSkus.find((s) => s.id === id);
  if (!item) return;
  nrItems.push({ id: item.id, name: item.name, sku_code: item.sku_code, base_uom: item.base_uom, qty: '' });
  document.getElementById('nr-item-search').value = '';
  document.getElementById('nr-item-results').innerHTML = '';
  document.getElementById('nr-item-results').hidden = true;
  renderNrItemList();
  const qtyInput = document.querySelector(`.req-item-row-qty[data-id="${CSS.escape(id)}"]`);
  if (qtyInput) qtyInput.focus();
}

function renderNrItemList() {
  const box = document.getElementById('nr-item-list');
  box.innerHTML = nrItems.map((it) => `
    <div class="req-item-row" data-id="${escapeHtml(it.id)}">
      <span class="req-item-row-text">
        <strong>${escapeHtml(it.name)}</strong>
        <span class="card-meta mono">${escapeHtml(it.sku_code)} · ${escapeHtml(it.base_uom)}</span>
      </span>
      <input type="number" class="req-item-row-qty" data-id="${escapeHtml(it.id)}" min="0.0001" step="any"
        value="${it.qty === '' ? '' : escapeHtml(String(it.qty))}" placeholder="${escapeHtml(t('fieldQtyNeeded'))}">
      <button type="button" class="req-item-row-remove" data-id="${escapeHtml(it.id)}" data-icon="xCircle" aria-label="${escapeHtml(t('btnRemoveItem'))}"></button>
    </div>
  `).join('');
  applyStaticIcons();

  box.querySelectorAll('.req-item-row-qty').forEach((input) => {
    input.addEventListener('input', () => {
      const it = nrItems.find((x) => x.id === input.getAttribute('data-id'));
      if (it) it.qty = input.value;
    });
  });
  box.querySelectorAll('.req-item-row-remove').forEach((btn) => {
    btn.addEventListener('click', () => removeNrItem(btn.getAttribute('data-id')));
  });

  const hint = document.getElementById('nr-comment-hint');
  if (hint) hint.hidden = nrItems.length > 0;
}

function removeNrItem(id) {
  nrItems = nrItems.filter((it) => it.id !== id);
  renderNrItemList();
}

// ============================================================================
// REPORTS
// ============================================================================
let currentReport = 'stock';
let reportSearch = '';
let reportRawRows = [];

document.querySelectorAll('#report-tabs button').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('#report-tabs button').forEach((x) => x.setAttribute('aria-pressed', x === b));
    currentReport = b.dataset.report;
    loadReport(currentReport);
  });
});

document.getElementById('report-search').addEventListener('input', (e) => {
  reportSearch = e.target.value;
  renderReportTable(currentReport);
});

function reportSearchFields(kind) {
  return {
    stock: ['sku_code', 'name', 'category'],
    movement: ['sku_code', 'sku_name', 'performed_by', 'request_code', 'type'],
    discrepancy: ['request_code', 'requester_name', 'sku_code', 'sku_name'],
    lowstock: ['sku_code', 'name', 'category'],
    building: ['building'],
  }[kind] || [];
}

async function loadReport(kind) {
  const body = document.getElementById('report-body');
  body.innerHTML = `<div class="card"><div class="skeleton" style="height:160px"></div></div>`;
  try {
    if (kind === 'stock') reportRawRows = await DB.stockBySku();
    else if (kind === 'movement') reportRawRows = await DB.movementHistory();
    else if (kind === 'requests') reportRawRows = await DB.listRequests();
    else if (kind === 'discrepancy') reportRawRows = await DB.discrepancyReport();
    else if (kind === 'lowstock') reportRawRows = await DB.lowStock();
    else if (kind === 'building') reportRawRows = await DB.buildingReport();
    renderReportTable(kind);
  } catch (err) {
    body.innerHTML = '';
    toast(err.message || 'Could not load report', 'error');
  }
}

// requests rows are joined (r.skus.name, not a flat sku_name) and need a
// couple of derived fields, so they get their own filter here rather than
// going through the flat-field reportSearchFields() path.
function filterRequestsReport(allRows, q) {
  if (!q) return allRows;
  return allRows.filter((r) =>
    (r.requester_name || '').toLowerCase().includes(q) ||
    (r.department || '').toLowerCase().includes(q) ||
    (r.notes || '').toLowerCase().includes(q) ||
    (r.work_area || '').toLowerCase().includes(q) ||
    (r.request_code || '').toLowerCase().includes(q) ||
    (r.skus?.name || '').toLowerCase().includes(q) ||
    (r.skus?.sku_code || '').toLowerCase().includes(q) ||
    (r.created_at || '').slice(0, 10).includes(q) ||
    fmtDate(r.created_at).toLowerCase().includes(q)
  );
}

function renderReportTable(kind) {
  const body = document.getElementById('report-body');
  const allRows = reportRawRows;
  const q = reportSearch.trim().toLowerCase();
  const fields = reportSearchFields(kind);
  const rows = kind === 'requests'
    ? filterRequestsReport(allRows, q)
    : (q ? allRows.filter((r) => fields.some((f) => String(r[f] ?? '').toLowerCase().includes(q))) : allRows);

  if (q && !rows.length) {
    body.innerHTML = `<div class="empty"><p>${t('emptySearchResults', escapeHtml(reportSearch.trim()))}</p></div>`;
    return;
  }
  if (!allRows.length) {
    if (kind === 'discrepancy') { body.innerHTML = `<div class="empty"><p>${t('emptyDiscrepancies')}</p></div>`; return; }
    if (kind === 'lowstock') { body.innerHTML = `<div class="empty"><p>${t('emptyLowStock')}</p></div>`; return; }
    if (kind === 'requests') { body.innerHTML = `<div class="empty"><p>${t('emptyGeneric')}</p></div>`; return; }
    if (kind === 'building') { body.innerHTML = `<div class="empty"><p>${t('emptyBuildingReport')}</p></div>`; return; }
  }

  if (kind === 'stock') {
    body.innerHTML = tableHtml(
      [t('colSku'), t('colName'), t('colCategory'), t('colOnHand'), t('colThreshold'), t('colStatus')],
      rows.map((r) => [escapeHtml(r.sku_code), escapeHtml(r.name), escapeHtml(catLabel(r.category)),
        `<span class="num">${fmtQty(r.on_hand)} ${escapeHtml(r.base_uom)}</span>`,
        `<span class="num">${fmtQty(r.min_threshold)}</span>`,
        r.is_low ? `<span class="chip chip-low">${t('rowLow')}</span>` : `<span class="chip chip-ok">${t('chipOk')}</span>`]),
    );
  } else if (kind === 'movement') {
    body.innerHTML = tableHtml(
      [t('colWhen'), t('colType'), t('colSku'), t('colQty'), t('colBy'), t('colRequest'), t('colEvidence')],
      rows.map((r) => [fmtDateTime(r.created_at), r.type, `${escapeHtml(r.sku_code)} — ${escapeHtml(r.sku_name)}`,
        `<span class="num">${fmtQty(r.qty)} ${escapeHtml(r.uom)}</span>`, r.performed_by ? escapeHtml(r.performed_by) : '—',
        r.request_code ? escapeHtml(r.request_code) : '—',
        r.image_paths?.length
          ? `<button type="button" class="btn btn-ghost btn-sm report-view-photos" data-paths="${escapeHtml(JSON.stringify(r.image_paths))}">${icon('image', 13)}<span>${t('btnViewPhotos', r.image_paths.length)}</span></button>`
          : '—']),
    );
    body.querySelectorAll('.report-view-photos').forEach((btn) => {
      btn.addEventListener('click', () => openEvidenceLightbox(JSON.parse(btn.getAttribute('data-paths'))));
    });
  } else if (kind === 'discrepancy') {
    body.innerHTML = tableHtml(
      [t('colWhen'), t('colRequest'), t('colSku'), t('colRequested'), t('colActual'), t('colVariance')],
      rows.map((r) => [fmtDateTime(r.created_at), `${escapeHtml(r.request_code)} (${escapeHtml(r.requester_name)})`, `${escapeHtml(r.sku_code)} — ${escapeHtml(r.sku_name)}`,
        `<span class="num">${fmtQty(r.requested_qty)}</span>`, `<span class="num">${fmtQty(r.actual_qty)}</span>`,
        `<span class="num" style="color:var(--discrepancy)">${r.variance > 0 ? '+' : ''}${fmtQty(r.variance)}</span>`]),
    );
  } else if (kind === 'lowstock') {
    body.innerHTML = tableHtml(
      [t('colSku'), t('colName'), t('colCategory'), t('colOnHand'), t('colThreshold')],
      rows.map((r) => [escapeHtml(r.sku_code), escapeHtml(r.name), escapeHtml(catLabel(r.category)), `<span class="num">${fmtQty(r.on_hand)} ${escapeHtml(r.base_uom)}</span>`, `<span class="num">${fmtQty(r.min_threshold)}</span>`]),
    );
  } else if (kind === 'requests') {
    body.innerHTML = tableHtml(
      [t('colWhen'), t('colRequest'), t('colRequester'), t('colDepartment'), t('colWorkArea'), t('colItem'), t('colComment'), t('colStatus')],
      rows.map((r) => [
        fmtDateTime(r.created_at), escapeHtml(r.request_code), escapeHtml(r.requester_name), r.department ? escapeHtml(r.department) : t('noDepartment'),
        r.work_area ? escapeHtml(r.work_area) : '—',
        r.skus ? `${escapeHtml(r.skus.sku_code)} — ${escapeHtml(r.skus.name)}${r.qty_requested ? ` (${fmtQty(r.qty_requested)} ${escapeHtml(r.skus.base_uom || '')})` : ''}` : t('generalRequest'),
        r.notes ? escapeHtml(r.notes) : '—',
        `<span class="chip ${statusChipClass(r.status)}">${statusLabel(r.status)}</span>`,
      ]),
    );
  } else if (kind === 'building') {
    body.innerHTML = tableHtml(
      ['#', t('colBuilding'), t('colRequestCount'), t('colLastRequested')],
      rows.map((r, i) => [i + 1, escapeHtml(r.building), `<span class="num">${fmtQty(r.request_count)}</span>`, fmtDate(r.last_requested_at)]),
    );
  }
}

function tableHtml(headers, rows) {
  if (!rows.length) return `<div class="empty"><p>${t('emptyGeneric')}</p></div>`;
  return `<div class="table-scroll"><table>
    <thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
  </table></div>`;
}

// ============================================================================
// MANAGE STAFF (admin-only — user_profiles CRUD). Mirrors the Manage Items
// list+edit-sheet pattern above (openManageItemsSheet/miRowHtml/etc) — same
// shape, simpler data. Creating the underlying login is still a manual step
// in the Supabase dashboard (see the field hint below); this only manages
// the profile — name/role/department/active — layered on top of that.
// ============================================================================
let msAllStaff = [];
let msEditingId = null;
let msDepartments = [];

// Backed by the departments table (schema.sql) — shared across every admin
// and device, not just the browser that typed a new one in. Mirrors
// loadManageItemsCategories()/renderCategoryOptions()/onAddCategory() above.
async function loadManageStaffDepartments() {
  try {
    msDepartments = await DB.listDepartments();
    renderDepartmentOptions();
  } catch (err) {
    toast(err.message || 'Could not load departments', 'error');
  }
}
function renderDepartmentOptions(selected = '') {
  const sel = document.getElementById('ms-department');
  if (!sel) return;
  const current = selected || sel.value;
  sel.innerHTML = `
    <option value="">${t('noDepartment')}</option>
    ${msDepartments.map((d) => `<option value="${escapeHtml(d.name)}" ${d.name === current ? 'selected' : ''}>${escapeHtml(d.name)}</option>`).join('')}
  `;
}
async function onAddDepartment(newInput, newRow) {
  const name = newInput.value.trim();
  const errEl = document.getElementById('ms-error');
  errEl.innerHTML = '';
  if (!name) return;
  try {
    await DB.createDepartment(name);
    msDepartments = await DB.listDepartments();
    renderDepartmentOptions(name);
    newInput.value = '';
    newRow.hidden = true;
    toast(t('toastDepartmentAdded'), 'success');
  } catch (err) {
    const msg = /duplicate|unique/i.test(err.message || '') ? t('errorDepartmentExists') : (err.message || 'Could not add department');
    errEl.innerHTML = `<div class="form-error">${escapeHtml(msg)}</div>`;
  }
}

document.getElementById('btn-manage-staff').addEventListener('click', openManageStaffSheet);

const ROLE_LABELS = { requester: () => t('roleRequester'), staff: () => t('roleStaff'), admin: () => t('roleAdmin') };
function roleLabel(role) {
  return (ROLE_LABELS[role] || (() => role))();
}

function openManageStaffSheet() {
  msEditingId = null;
  Sheet.open(t('manageStaffTitle'), manageStaffSheetHtml());
  wireManageStaffForm();
  loadManageStaffDepartments();
  loadManageStaffList();
}

function manageStaffSheetHtml() {
  return `
    <div id="ms-error"></div>
    <div id="ms-credentials" hidden></div>
    <form id="form-manage-staff">
      <div class="field">
        <label for="ms-email">${t('fieldStaffEmail')}</label>
        <input type="email" id="ms-email" required>
        <p class="field-hint">${t('fieldStaffEmailHint')}</p>
      </div>
      <div class="field">
        <label for="ms-name">${t('fieldStaffName')}</label>
        <input type="text" id="ms-name" required>
      </div>
      <div class="field-row">
        <div class="field">
          <label for="ms-role">${t('fieldStaffRole')}</label>
          <select id="ms-role" required>
            <option value="requester">${t('roleRequester')}</option>
            <option value="staff">${t('roleStaff')}</option>
            <option value="admin">${t('roleAdmin')}</option>
          </select>
        </div>
        <div class="field">
          <label for="ms-department">${t('fieldStaffDepartment')}</label>
          <div class="field-with-btn">
            <select id="ms-department"></select>
            <button type="button" class="btn-icon-add" id="ms-department-add-btn" title="${t('addDepartmentTitle')}" aria-label="${t('addDepartmentTitle')}">${icon('plusCircle', 18)}</button>
          </div>
          <div class="new-category-row" id="ms-department-new-row" hidden>
            <input type="text" id="ms-department-new-input" placeholder="${t('newDepartmentPlaceholder')}">
            <button type="button" class="btn btn-outline btn-sm" id="ms-department-new-confirm">${icon('check', 14)}<span>${t('add')}</span></button>
            <button type="button" class="btn btn-ghost btn-sm" id="ms-department-new-cancel">${icon('xCircle', 14)}</button>
          </div>
        </div>
      </div>
      <div class="card-row">
        <button type="button" class="btn btn-ghost" id="ms-cancel-edit" hidden>${icon('xCircle', 16)}<span>${t('cancel')}</span></button>
        <button type="submit" class="btn btn-primary btn-block" id="ms-submit">${msSubmitButtonInner('add')}</button>
      </div>
    </form>

    <div class="section-head"><h2>${t('activeStaff')}</h2></div>
    <div id="ms-active-list" class="card-list"></div>
    <div class="section-head"><h2>${t('inactiveStaff')}</h2></div>
    <div id="ms-inactive-list" class="card-list"></div>
  `;
}

function msSubmitButtonInner(mode) {
  return mode === 'edit'
    ? `${icon('checkCircle', 16)}<span>${t('btnSaveStaff')}</span>`
    : `${icon('plusCircle', 16)}<span>${t('btnAddStaff')}</span>`;
}

function wireManageStaffForm() {
  document.getElementById('form-manage-staff').addEventListener('submit', onManageStaffSubmit);
  document.getElementById('ms-cancel-edit').addEventListener('click', () => resetManageStaffForm());

  const addBtn = document.getElementById('ms-department-add-btn');
  const newRow = document.getElementById('ms-department-new-row');
  const newInput = document.getElementById('ms-department-new-input');
  addBtn.addEventListener('click', () => {
    newRow.hidden = !newRow.hidden;
    if (!newRow.hidden) newInput.focus();
  });
  document.getElementById('ms-department-new-cancel').addEventListener('click', () => {
    newInput.value = '';
    newRow.hidden = true;
  });
  document.getElementById('ms-department-new-confirm').addEventListener('click', () => onAddDepartment(newInput, newRow));
  newInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); onAddDepartment(newInput, newRow); }
  });
}

function resetManageStaffForm() {
  msEditingId = null;
  const form = document.getElementById('form-manage-staff');
  form.reset();
  document.getElementById('ms-email').disabled = false;
  renderDepartmentOptions();
  document.getElementById('ms-submit').innerHTML = msSubmitButtonInner('add');
  document.getElementById('ms-cancel-edit').hidden = true;
}

// Shown once, right after a brand-new login is created — a toast isn't
// enough here since the admin needs time to copy the password before it's
// gone for good (the server never stores or shows it again).
function staffCredentialsHtml(email, password) {
  return `
    <div class="card">
      <p class="card-title">${t('staffCredentialsTitle')}</p>
      <p class="card-meta">${escapeHtml(email)}</p>
      <div class="field-with-btn" style="margin-top:var(--s2)">
        <input type="text" id="ms-credentials-password" value="${escapeHtml(password)}" readonly>
        <button type="button" class="btn btn-outline btn-sm" id="ms-credentials-copy">${icon('copy', 14)}<span>${t('btnCopy')}</span></button>
      </div>
      <p class="field-hint">${t('staffCredentialsHint')}</p>
      <div class="card-row" style="margin-top:var(--s3)">
        <button type="button" class="btn btn-primary btn-block" id="ms-credentials-done">${icon('checkCircle', 16)}<span>${t('btnDone')}</span></button>
      </div>
    </div>
  `;
}

function showStaffCredentials(email, password) {
  const box = document.getElementById('ms-credentials');
  box.innerHTML = staffCredentialsHtml(email, password);
  box.hidden = false;
  document.getElementById('form-manage-staff').hidden = true;
  document.getElementById('ms-credentials-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(password).then(() => toast(t('toastPasswordCopied'), 'success'));
  });
  document.getElementById('ms-credentials-done').addEventListener('click', async () => {
    hideStaffCredentials();
    resetManageStaffForm();
    await loadManageStaffList();
  });
  document.getElementById('sheet-body').scrollTop = 0;
}

function hideStaffCredentials() {
  const box = document.getElementById('ms-credentials');
  box.hidden = true;
  box.innerHTML = '';
  document.getElementById('form-manage-staff').hidden = false;
}

async function onManageStaffSubmit(e) {
  e.preventDefault();
  const errEl = document.getElementById('ms-error');
  errEl.innerHTML = '';
  const btn = document.getElementById('ms-submit');
  btn.disabled = true;
  try {
    if (!msEditingId) {
      const email = document.getElementById('ms-email').value.trim();
      const result = await DB.createStaffLogin({
        email,
        name: document.getElementById('ms-name').value.trim(),
        role: document.getElementById('ms-role').value,
        department: document.getElementById('ms-department').value.trim(),
      });
      if (result.generated_password) {
        showStaffCredentials(email, result.generated_password);
        return;
      }
      toast(t('toastStaffSaved'), 'success');
      resetManageStaffForm();
      await loadManageStaffList();
      return;
    }
    await DB.upsertProfile({
      id: msEditingId,
      name: document.getElementById('ms-name').value.trim(),
      role: document.getElementById('ms-role').value,
      department: document.getElementById('ms-department').value.trim(),
      isActive: true,
    });
    toast(t('toastStaffSaved'), 'success');
    resetManageStaffForm();
    await loadManageStaffList();
  } catch (err) {
    errEl.innerHTML = `<div class="form-error">${escapeHtml(err.message || 'Could not save')}</div>`;
  } finally {
    btn.disabled = false;
  }
}

async function loadManageStaffList() {
  try {
    msAllStaff = await DB.listStaff();
    renderManageStaffLists();
  } catch (err) {
    toast(err.message || 'Could not load staff', 'error');
  }
}

function renderManageStaffLists() {
  const active = msAllStaff.filter((s) => s.is_active);
  const inactive = msAllStaff.filter((s) => !s.is_active);
  document.getElementById('ms-active-list').innerHTML = active.length ? active.map(msRowHtml).join('') : `<div class="empty"><p>${t('emptyGeneric')}</p></div>`;
  document.getElementById('ms-inactive-list').innerHTML = inactive.length ? inactive.map(msRowHtml).join('') : `<div class="empty"><p>${t('emptyGeneric')}</p></div>`;

  document.querySelectorAll('[data-ms-edit]').forEach((btn) => {
    btn.addEventListener('click', () => startEditStaff(btn.dataset.msEdit));
  });
  document.querySelectorAll('[data-ms-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => toggleStaffActive(btn.dataset.msToggle, btn.dataset.toActive === 'true'));
  });
}

function msRowHtml(s) {
  return `
    <div class="card">
      <div class="card-row">
        <div>
          <div class="card-title">${escapeHtml(s.name)}</div>
          <div class="card-meta">${escapeHtml(roleLabel(s.role))}${s.department ? ' · ' + escapeHtml(s.department) : ''}</div>
        </div>
      </div>
      <div class="card-row" style="margin-top:var(--s3)">
        <button class="btn btn-outline btn-sm" data-ms-edit="${s.id}">${icon('pencil', 14)}<span>${t('btnEdit')}</span></button>
        ${s.is_active
          ? `<button class="btn btn-ghost btn-sm" data-ms-toggle="${s.id}" data-to-active="false">${icon('xCircle', 14)}<span>${t('btnDeactivate')}</span></button>`
          : `<button class="btn btn-ghost btn-sm" data-ms-toggle="${s.id}" data-to-active="true">${icon('checkCircle', 14)}<span>${t('btnActivate')}</span></button>`}
      </div>
    </div>
  `;
}

function startEditStaff(id) {
  const s = msAllStaff.find((x) => x.id === id);
  if (!s) return;
  msEditingId = id;
  const emailEl = document.getElementById('ms-email');
  emailEl.value = '';
  emailEl.placeholder = t('fieldStaffEmail');
  emailEl.disabled = true;
  document.getElementById('ms-name').value = s.name;
  document.getElementById('ms-role').value = s.role;
  renderDepartmentOptions(s.department || '');
  document.getElementById('ms-submit').innerHTML = msSubmitButtonInner('edit');
  document.getElementById('ms-cancel-edit').hidden = false;
  document.getElementById('sheet-body').scrollTop = 0;
}

async function toggleStaffActive(id, toActive) {
  const s = msAllStaff.find((x) => x.id === id);
  if (!s) return;
  try {
    await DB.upsertProfile({ id, name: s.name, role: s.role, department: s.department, isActive: toActive });
    toast(t('toastStaffSaved'), 'success');
    await loadManageStaffList();
  } catch (err) {
    toast(err.message || 'Could not update', 'error');
  }
}

// ============================================================================
// AUTH GATE — admin.html only. Nothing under DB.* will actually return data
// for an unauthenticated caller (Row Level Security enforces that at the
// database itself, see schema.sql), so this gate is about presenting the
// right screen, not the real security boundary.
// ============================================================================
let appBooted = false;
// The signed-in person's own profile (name/role/department) — fetched once
// per session right after login (see DB.getMyProfile()) and used to gate
// the UI by role. Never used for anything security-sensitive on its own;
// Row Level Security (schema.sql) is the real boundary, this just decides
// what to show.
let currentProfile = null;

async function initApp() {
  if (appBooted) return;
  appBooted = true;
  try {
    currentProfile = await DB.getMyProfile();
  } catch (_) {
    currentProfile = null;
  }
  if (!currentProfile) {
    // Signed in through Supabase Auth, but no user_profiles row — RLS
    // would refuse almost everything, so there's nothing useful to show.
    appBooted = false;
    toast(t('errorNoProfile'), 'error');
    await Auth.signOut();
    await refreshAuthUi();
    return;
  }
  applyRoleGate(currentProfile.role);
  try {
    activeSkus = await DB.listSkus({ activeOnly: true });
  } catch (_) { /* stock/requests view will surface the error */ }
  showView(currentProfile.role === 'requester' ? 'requests' : 'stock');
}

// Client-side only — a Requester account genuinely can't reach
// staff/admin-only data even if this were bypassed, since the matching
// tables are gated by is_staff_or_admin() in schema.sql. This is purely
// about not showing screens/controls a role can't use.
function applyRoleGate(role) {
  const visibleTabs = {
    requester: ['requests'],
    staff: ['stock', 'receive', 'issue', 'requests'],
    admin: ['stock', 'receive', 'issue', 'requests', 'reports'],
  }[role] || [];
  document.querySelectorAll('.tabbar button[data-view]').forEach((btn) => {
    btn.hidden = !visibleTabs.includes(btn.dataset.view);
  });

  document.getElementById('btn-manage-items').hidden = role !== 'admin';
  document.getElementById('btn-manage-staff').hidden = role !== 'admin';

  const requestsTabLabel = document.querySelector('.tabbar button[data-view="requests"] span[data-i18n]');
  if (requestsTabLabel) {
    requestsTabLabel.dataset.i18n = role === 'requester' ? 'tabMyRequests' : 'tabRequests';
    requestsTabLabel.textContent = t(requestsTabLabel.dataset.i18n);
  }
}

function showLoginScreen() {
  document.getElementById('login-screen').hidden = false;
  document.getElementById('app-shell').hidden = true;
}

function showAppShell() {
  document.getElementById('login-screen').hidden = true;
  document.getElementById('app-shell').hidden = false;
  initApp();
}

async function refreshAuthUi() {
  let session = null;
  try {
    session = await Auth.getSession();
  } catch (_) { /* treat as signed out */ }
  if (session) showAppShell();
  else showLoginScreen();
}

document.getElementById('form-admin-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = document.getElementById('login-error');
  errEl.innerHTML = '';
  const btn = document.getElementById('login-submit');
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  btn.disabled = true;
  try {
    await Auth.signIn(email, password);
    document.getElementById('login-password').value = '';
    await refreshAuthUi();
  } catch (err) {
    errEl.innerHTML = `<div class="form-error">${escapeHtml(t('errorLoginFailed'))}</div>`;
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  await Auth.signOut();
  appBooted = false;
  currentProfile = null;
  await refreshAuthUi();
});

// ---- Boot ------------------------------------------------------------------------
(async function init() {
  document.documentElement.lang = I18n.current;
  I18n.applyStatic();
  applyStaticIcons();
  await refreshAuthUi();
})();
