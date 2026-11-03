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
