import { escapeHtml, formatMoney } from './utils.js';
import { SUPPORTED_CURRENCIES } from './rates.js';
import { ADJUSTMENT_LABELS, summarizeDraft } from './receipts.js';

// ==================== РЕДАКТОР ЧЕКА ====================
// Полноэкранная форма поверх приложения. Хранит черновик и отдаёт его в onSave/onDelete.

const TITLES = {
    new: { receipt: 'Проверьте чек', voice: 'Проверьте запись', text: 'Проверьте запись', manual: 'Новая трата' },
    edit: 'Редактировать чек',
};

let draft = null;
let categories = [];
let handlers = {};
let saving = false;

const el = (id) => document.getElementById(id);

function currencyOptions(selected) {
    return SUPPORTED_CURRENCIES.map(c => `<option value="${c}" ${c === selected ? 'selected' : ''}>${c}</option>`).join('');
}

function categoryOptions(selected) {
    const options = categories.map(c => `<option value="${escapeHtml(c)}" ${c === selected ? 'selected' : ''}>${escapeHtml(c)}</option>`);
    if (selected && !categories.includes(selected)) {
        options.unshift(`<option value="${escapeHtml(selected)}" selected>${escapeHtml(selected)} (удалена)</option>`);
    }
    return options.join('');
}

function renderItems() {
    el('editor-items').innerHTML = draft.items.map((item, idx) => `
        <div class="bg-slate-50 border border-slate-200/70 rounded-2xl p-3 space-y-2">
            <div class="flex gap-2">
                <input data-field="name" data-index="${idx}" value="${escapeHtml(item.name)}" placeholder="Название" class="flex-1 min-w-0 h-10 bg-white border border-slate-200 rounded-xl px-3 focus:outline-none focus:border-indigo-500">
                <button data-editor="remove-item" data-index="${idx}" class="w-10 h-10 rounded-xl text-slate-400 hover:text-red-600 hover:bg-red-50 flex items-center justify-center shrink-0" title="Удалить позицию">
                    <i class="fa-solid fa-trash-can text-xs"></i>
                </button>
            </div>
            ${item.originalName && item.originalName !== item.name ? `<p class="text-[11px] text-slate-400 px-1">${escapeHtml(item.originalName)}</p>` : ''}
            <div class="flex gap-2">
                <input data-field="price" data-index="${idx}" value="${item.price ?? ''}" inputmode="decimal" placeholder="Цена" class="w-24 min-w-0 h-10 bg-white border border-slate-200 rounded-xl px-3 font-bold focus:outline-none focus:border-indigo-500">
                <select data-field="currency" data-index="${idx}" class="w-[74px] shrink-0 h-10 bg-white border border-slate-200 rounded-xl px-1.5 text-sm font-semibold focus:outline-none">${currencyOptions(item.currency)}</select>
                <select data-field="category" data-index="${idx}" class="flex-1 min-w-0 h-10 bg-white border border-slate-200 rounded-xl px-2 text-sm font-semibold focus:outline-none">${categoryOptions(item.category)}</select>
            </div>
        </div>
    `).join('');
}

function renderAdjustments() {
    const box = el('editor-adjustments-box');
    if (draft.mode !== 'new' || draft.adjustments.length === 0) {
        box.classList.add('hidden');
        return;
    }
    box.classList.remove('hidden');
    el('editor-adjustments').innerHTML = draft.adjustments.map((adj, idx) => `
        <div class="flex items-center gap-2">
            <span class="flex-1 min-w-0 text-xs text-slate-600 truncate">${escapeHtml(ADJUSTMENT_LABELS[adj.type] || adj.type)} — ${escapeHtml(adj.name)}</span>
            <input data-field="adj-amount" data-index="${idx}" value="${adj.amount}" inputmode="decimal" class="w-24 h-9 bg-white border border-amber-200 rounded-xl px-2.5 text-sm font-bold focus:outline-none">
            <button data-editor="remove-adjustment" data-index="${idx}" class="w-9 h-9 rounded-xl text-slate-400 hover:text-red-600 hover:bg-red-50 flex items-center justify-center shrink-0">
                <i class="fa-solid fa-xmark text-xs"></i>
            </button>
        </div>
    `).join('');
}

function renderSummary() {
    const { currency, itemsTotal, mismatch } = summarizeDraft(draft);
    el('editor-items-total').innerText = currency ? `${formatMoney(itemsTotal)} ${currency}` : 'разные валюты';
    el('editor-total-row').classList.toggle('hidden', !currency);
    el('editor-mismatch').classList.toggle('hidden', !mismatch);
    if (mismatch) {
        el('editor-mismatch').innerText = `Сумма позиций не совпадает с итогом чека. Проверьте цены — возможно, позиция пропущена или прочитана неверно.`;
    }
}

function renderAll() {
    el('editor-title').innerText = draft.mode === 'edit' ? TITLES.edit : (TITLES.new[draft.source] || TITLES.new.manual);
    el('editor-hint').classList.toggle('hidden', draft.mode !== 'new' || draft.source === 'manual');
    el('editor-shop').value = draft.shop || '';
    el('editor-date').value = draft.receiptDate || '';
    el('editor-currency').innerHTML = currencyOptions(draft.currency);
    el('editor-total').value = draft.total ?? '';
    el('editor-delete-btn').classList.toggle('hidden', draft.mode !== 'edit');

    const preview = el('editor-preview');
    if (draft.previewUrl) {
        preview.src = draft.previewUrl;
        el('editor-preview-box').classList.remove('hidden');
    } else {
        el('editor-preview-box').classList.add('hidden');
    }

    renderItems();
    renderAdjustments();
    renderSummary();
    setSaving(false);
}

function setSaving(value) {
    saving = value;
    el('editor-save-btn').disabled = value;
    el('editor-save-btn').innerHTML = value
        ? '<i class="fa-solid fa-spinner fa-spin"></i> Сохранение…'
        : '<i class="fa-solid fa-check"></i> Сохранить';
}

function parseNumber(value) {
    const normalized = String(value).replace(/\s/g, '').replace(',', '.');
    if (normalized === '' || normalized === '-') return null;
    const n = Number(normalized);
    return Number.isFinite(n) ? n : null;
}

function onInput(e) {
    const target = e.target;
    const field = target.dataset.field;
    if (!field) return;
    const idx = Number(target.dataset.index);

    if (field === 'name') draft.items[idx].name = target.value;
    else if (field === 'price') draft.items[idx].price = parseNumber(target.value);
    else if (field === 'currency') draft.items[idx].currency = target.value;
    else if (field === 'category') draft.items[idx].category = target.value;
    else if (field === 'adj-amount') draft.adjustments[idx].amount = parseNumber(target.value) ?? 0;
    renderSummary();
}

function onClick(e) {
    const btn = e.target.closest('[data-editor]');
    if (!btn) return;
    const idx = Number(btn.dataset.index);
    const action = btn.dataset.editor;

    if (action === 'remove-item') {
        draft.items.splice(idx, 1);
        if (draft.items.length === 0) addItem();
        renderItems();
        renderSummary();
    } else if (action === 'remove-adjustment') {
        draft.adjustments.splice(idx, 1);
        renderAdjustments();
        renderSummary();
    }
}

function addItem() {
    const last = draft.items[draft.items.length - 1];
    draft.items.push({ name: '', originalName: '', price: null, currency: last?.currency || draft.currency, category: last?.category || categories[0] });
}

export function initEditor(callbacks) {
    handlers = callbacks;
    const root = el('receipt-editor');
    root.addEventListener('input', onInput);
    root.addEventListener('change', onInput);
    root.addEventListener('click', onClick);

    el('editor-shop').addEventListener('input', (e) => { draft.shop = e.target.value; });
    el('editor-date').addEventListener('change', (e) => { draft.receiptDate = e.target.value; });
    el('editor-total').addEventListener('input', (e) => { draft.total = parseNumber(e.target.value); renderSummary(); });
    // Валюта чека меняет валюту всех позиций — так быстрее исправить ошибку ИИ
    el('editor-currency').addEventListener('change', (e) => {
        draft.currency = e.target.value;
        draft.items.forEach(i => { i.currency = e.target.value; });
        renderItems();
        renderSummary();
    });
    el('editor-add-item').addEventListener('click', () => {
        addItem();
        renderItems();
        renderSummary();
        const inputs = el('editor-items').querySelectorAll('[data-field="name"]');
        inputs[inputs.length - 1]?.focus();
    });
    el('editor-cancel-btn').addEventListener('click', closeEditor);
    el('editor-close-btn').addEventListener('click', closeEditor);
    el('editor-save-btn').addEventListener('click', async () => {
        if (saving) return;
        setSaving(true);
        const ok = await handlers.onSave(draft);
        if (ok) closeEditor();
        else setSaving(false);
    });
    el('editor-delete-btn').addEventListener('click', async () => {
        if (saving) return;
        setSaving(true);
        const ok = await handlers.onDelete(draft);
        if (ok) closeEditor();
        else setSaving(false);
    });
}

export function openEditor(newDraft, categoryList) {
    draft = newDraft;
    categories = categoryList;
    renderAll();
    el('receipt-editor').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    el('receipt-editor-scroll').scrollTop = 0;
}

export function closeEditor() {
    el('receipt-editor').classList.add('hidden');
    document.body.style.overflow = '';
    draft = null;
}

export function isEditorOpen() {
    return draft !== null;
}
