import { SUPPORTED_CURRENCIES } from './rates.js';

// ==================== ЧЕКИ: РАЗБОР ОТВЕТА ИИ И СВЕРКА ИТОГА ====================

export const ADJUSTMENT_TYPES = ['service', 'tax', 'tip', 'discount', 'other'];

export const ADJUSTMENT_LABELS = {
    service: 'Сервисный сбор',
    tax: 'Налог',
    tip: 'Чаевые',
    discount: 'Скидка',
    other: 'Прочее',
};

const round2 = (n) => Math.round(n * 100) / 100;

function pickCurrency(value, fallback) {
    const code = String(value || '').trim().toUpperCase();
    return SUPPORTED_CURRENCIES.includes(code) ? code : fallback;
}

function normalizeAdjustments(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
        .map(adj => {
            const type = ADJUSTMENT_TYPES.includes(adj?.type) ? adj.type : 'other';
            let amount = Number(adj?.amount) || 0;
            // Скидка всегда уменьшает сумму, даже если ИИ вернул её положительным числом
            if (type === 'discount' && amount > 0) amount = -amount;
            return { type, name: String(adj?.name || ADJUSTMENT_LABELS[type]), amount: round2(amount) };
        })
        .filter(adj => adj.amount !== 0);
}

// Распределяет сборы и скидки по позициям пропорционально цене, чтобы сумма позиций
// совпадала с реально оплаченной, а категории получили свою долю сервисного сбора
export function allocateAdjustments(basePrices, adjustmentsTotal) {
    const subtotal = basePrices.reduce((s, p) => s + p, 0);
    if (!adjustmentsTotal || subtotal <= 0) return basePrices.map(round2);

    const finals = basePrices.map(p => round2(p + adjustmentsTotal * (p / subtotal)));
    // Остаток от округления — на самую дорогую позицию, чтобы итог сошёлся до копейки
    const target = round2(subtotal + adjustmentsTotal);
    const diff = round2(target - finals.reduce((s, p) => s + p, 0));
    if (diff !== 0) {
        const maxIdx = basePrices.indexOf(Math.max(...basePrices));
        finals[maxIdx] = round2(finals[maxIdx] + diff);
    }
    return finals;
}

// Итог по позициям не сходится с итогом чека больше чем на 1% (и больше чем на 1 единицу валюты)
export function isTotalMismatch(itemsTotal, receiptTotal) {
    if (typeof receiptTotal !== 'number' || typeof itemsTotal !== 'number') return false;
    const diff = Math.abs(itemsTotal - receiptTotal);
    return diff > 1 && diff > Math.abs(receiptTotal) * 0.01;
}

// Превращает JSON от ИИ в чек и позиции. source: 'receipt' | 'voice' | 'text'
export function normalizeAiResult(parsed, { source, categories, fallbackCurrency, todayStr, defaultShop }) {
    const rawItems = Array.isArray(parsed?.items) ? parsed.items : [];
    const receiptCurrency = pickCurrency(parsed?.currency, fallbackCurrency);

    const items = rawItems
        .map(item => ({
            name: String(item?.name || item?.originalName || 'Без названия'),
            originalName: String(item?.originalName || item?.name || ''),
            basePrice: round2(Number(item?.price) || 0),
            // В чеке одна валюта; в тексте и голосе у каждой траты может быть своя
            currency: source === 'receipt' ? receiptCurrency : pickCurrency(item?.currency, receiptCurrency),
            category: categories.includes(item?.category) ? item.category : categories[0],
        }))
        .filter(item => item.basePrice !== 0);

    const currencies = [...new Set(items.map(i => i.currency))];
    const singleCurrency = currencies.length === 1 ? currencies[0] : null;

    const adjustments = source === 'receipt' && singleCurrency ? normalizeAdjustments(parsed?.adjustments) : [];
    const adjustmentsTotal = round2(adjustments.reduce((s, a) => s + a.amount, 0));
    const finals = allocateAdjustments(items.map(i => i.basePrice), adjustmentsTotal);
    items.forEach((item, idx) => { item.originalPrice = finals[idx]; });

    const subtotal = round2(items.reduce((s, i) => s + i.basePrice, 0));
    const itemsTotal = round2(items.reduce((s, i) => s + i.originalPrice, 0));
    const statedTotal = Number(parsed?.total);
    const total = singleCurrency && Number.isFinite(statedTotal) && statedTotal > 0 ? round2(statedTotal) : (singleCurrency ? itemsTotal : null);

    const receiptDate = /^\d{4}-\d{2}-\d{2}$/.test(parsed?.receiptDate || '') ? parsed.receiptDate : todayStr;

    return {
        receipt: {
            shop: String(parsed?.shopName || defaultShop),
            receiptDate,
            currency: singleCurrency,
            subtotal: singleCurrency ? subtotal : null,
            adjustments,
            total,
            source,
        },
        items,
    };
}

// Сумма чека в его валюте; null, если в чеке смешаны валюты
export function receiptTotalInCurrency(items) {
    const currencies = new Set(items.map(i => i.currency));
    if (currencies.size !== 1) return null;
    return { amount: round2(items.reduce((s, i) => s + (Number(i.originalPrice) || 0), 0)), currency: [...currencies][0] };
}

// Ключ группировки старых записей без receiptId (до миграции) — как раньше: время загрузки + магазин
export function legacyReceiptKey(item) {
    return `${item.createdAt || item.receiptDate}_${item.shop || 'Не указано'}`;
}

// Детерминированный id чека из ключа группировки — повторный запуск не создаст дублей
export function legacyReceiptId(key) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
        hash ^= key.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `legacy_${hash.toString(36)}_${key.length}`;
}

// ==================== ЧЕРНОВИК ЧЕКА ДЛЯ РЕДАКТОРА ====================
// Один редактор для трёх случаев: проверка ответа ИИ, ручной ввод и правка сохранённого чека.
// В новом чеке price — цена без общих сборов (сборы распределяются при сохранении);
// в сохранённом — итоговая цена позиции, сборы уже внутри.

export function draftFromAi({ receipt, items }, previewUrl = null) {
    return {
        mode: 'new',
        source: receipt.source,
        receiptId: null,
        shop: receipt.shop,
        receiptDate: receipt.receiptDate,
        currency: receipt.currency || items[0]?.currency,
        items: items.map(i => ({ name: i.name, originalName: i.originalName, price: i.basePrice, currency: i.currency, category: i.category })),
        adjustments: receipt.adjustments.map(a => ({ ...a })),
        total: receipt.total,
        previewUrl,
    };
}

export function emptyDraft({ currency, category, todayStr }) {
    return {
        mode: 'new',
        source: 'manual',
        receiptId: null,
        shop: '',
        receiptDate: todayStr,
        currency,
        items: [{ name: '', originalName: '', price: null, currency, category }],
        adjustments: [],
        total: null,
        previewUrl: null,
    };
}

export function draftFromReceipt({ key, receiptId, shop, receiptDate, stored, items }) {
    return {
        mode: 'edit',
        source: stored?.source || 'legacy',
        key,
        receiptId,
        shop,
        receiptDate,
        currency: stored?.currency || items[0]?.currency,
        items: items.map(i => ({
            id: i.id,
            name: i.name,
            originalName: i.originalName || '',
            price: Number(i.originalPrice) || 0,
            initialPrice: Number(i.originalPrice) || 0,
            currency: i.currency,
            category: i.category,
        })),
        adjustments: [],
        total: stored?.total ?? null,
        previewUrl: null,
    };
}

// Итоги для подсказки в редакторе: сумма позиций (с распределёнными сборами) и сверка с итогом чека
export function summarizeDraft(draft) {
    const rows = draft.items.filter(i => Number(i.price));
    const currencies = [...new Set(rows.map(i => i.currency))];
    const currency = currencies.length === 1 ? currencies[0] : null;
    const adjustmentsTotal = currency ? draft.adjustments.reduce((s, a) => s + (Number(a.amount) || 0), 0) : 0;
    const itemsTotal = round2(rows.reduce((s, i) => s + Number(i.price), 0) + adjustmentsTotal);
    const total = Number(draft.total);
    return {
        currency,
        itemsTotal,
        mismatch: currency && Number.isFinite(total) && total > 0 ? isTotalMismatch(itemsTotal, total) : false,
    };
}

// Проверяет черновик и возвращает позиции для записи; бросает Error с понятным текстом
export function buildItemsFromDraft(draft, categories) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.receiptDate || '')) throw new Error('Укажите дату чека');

    const rows = draft.items.filter(i => String(i.name || '').trim() || Number(i.price));
    if (rows.length === 0) throw new Error('Добавьте хотя бы одну позицию');
    rows.forEach((row, idx) => {
        if (!String(row.name || '').trim()) throw new Error(`Позиция ${idx + 1}: укажите название`);
        if (!Number.isFinite(Number(row.price)) || Number(row.price) === 0) throw new Error(`«${row.name}»: укажите цену`);
        if (!SUPPORTED_CURRENCIES.includes(row.currency)) throw new Error(`«${row.name}»: неизвестная валюта`);
    });

    const currencies = new Set(rows.map(r => r.currency));
    const adjustments = draft.mode === 'new' && currencies.size === 1
        ? normalizeAdjustments(draft.adjustments)
        : [];
    const adjustmentsTotal = round2(adjustments.reduce((s, a) => s + a.amount, 0));
    const basePrices = rows.map(r => round2(Number(r.price)));
    const finals = draft.mode === 'new' ? allocateAdjustments(basePrices, adjustmentsTotal) : basePrices;

    const items = rows.map((row, idx) => {
        const item = {
            name: String(row.name).trim(),
            originalName: String(row.originalName || '').trim() || String(row.name).trim(),
            currency: row.currency,
            // У сохранённой позиции из удалённой категории категория остаётся, пока её не сменят явно
            category: categories.includes(row.category) || (row.id && row.category) ? row.category : categories[0],
            originalPrice: finals[idx],
        };
        if (row.id) item.id = row.id;
        if (draft.mode === 'new') {
            item.basePrice = basePrices[idx];
        } else if (row.initialPrice !== undefined && round2(Number(row.price)) !== round2(row.initialPrice)) {
            // Цену поправили вручную — старая «цена до сборов» больше не актуальна
            item.basePrice = finals[idx];
        }
        return item;
    });

    return { items, adjustments, singleCurrency: currencies.size === 1 ? [...currencies][0] : null };
}
