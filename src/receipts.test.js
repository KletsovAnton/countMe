import { describe, it, expect } from 'vitest';
import { allocateAdjustments, normalizeAiResult, isTotalMismatch, receiptTotalInCurrency, legacyReceiptId, legacyReceiptKey } from './receipts.js';
import { parseRatesResponse, resolveRateTag, getRatesForDate, resetRatesCache } from './rates.js';

const opts = { source: 'receipt', categories: ['Еда', 'Кафе'], fallbackCurrency: 'THB', todayStr: '2026-11-04', defaultShop: 'Не указано' };

describe('allocateAdjustments', () => {
    it('spreads a service charge proportionally and keeps the exact total', () => {
        const finals = allocateAdjustments([100, 200, 33.33], 33.33);
        expect(finals.reduce((s, p) => s + p, 0)).toBeCloseTo(366.66, 2);
        expect(finals[1]).toBeCloseTo(220, 1);
    });
    it('applies discounts as negative adjustments', () => {
        expect(allocateAdjustments([50, 50], -10)).toEqual([45, 45]);
    });
    it('leaves prices untouched without adjustments', () => {
        expect(allocateAdjustments([10.005, 20], 0)).toEqual([10.01, 20]);
    });
});

describe('normalizeAiResult', () => {
    it('uses the currency detected on the receipt instead of the selector', () => {
        const { receipt, items } = normalizeAiResult({ currency: 'vnd', items: [{ name: 'Фо', price: 50000, category: 'Кафе' }] }, opts);
        expect(receipt.currency).toBe('VND');
        expect(items[0].currency).toBe('VND');
    });
    it('falls back to the selector for unknown currencies', () => {
        const { items } = normalizeAiResult({ currency: 'XYZ', items: [{ name: 'Кофе', price: 80 }] }, opts);
        expect(items[0].currency).toBe('THB');
        expect(items[0].category).toBe('Еда');
    });
    it('folds service charge and VAT into item prices so items sum to the paid total', () => {
        const parsed = {
            items: [{ name: 'Пад-тай', price: 120, category: 'Кафе' }, { name: 'Кола', price: 30, category: 'Кафе' }],
            adjustments: [{ type: 'service', name: 'SC 10%', amount: 15 }, { type: 'tax', name: 'VAT 7%', amount: 11.55 }],
            total: 176.55,
        };
        const { receipt, items } = normalizeAiResult(parsed, opts);
        expect(receipt.subtotal).toBe(150);
        expect(receipt.total).toBe(176.55);
        expect(items[0].basePrice).toBe(120);
        expect(items.reduce((s, i) => s + i.originalPrice, 0)).toBeCloseTo(176.55, 2);
        expect(isTotalMismatch(176.55, receipt.total)).toBe(false);
    });
    it('turns positive discounts negative', () => {
        const { receipt } = normalizeAiResult({ items: [{ name: 'A', price: 100 }], adjustments: [{ type: 'discount', amount: 10 }] }, opts);
        expect(receipt.adjustments[0].amount).toBe(-10);
    });
    it('keeps per-item currencies for text input and has no single total when mixed', () => {
        const parsed = { items: [{ name: 'Кофе', price: 80, currency: 'THB' }, { name: 'Такси', price: 5, currency: 'USD' }] };
        const { receipt, items } = normalizeAiResult(parsed, { ...opts, source: 'text' });
        expect(items.map(i => i.currency)).toEqual(['THB', 'USD']);
        expect(receipt.currency).toBeNull();
        expect(receipt.total).toBeNull();
    });
    it('rejects malformed dates and drops zero-price lines', () => {
        const { receipt, items } = normalizeAiResult({ receiptDate: '15.03.2026', items: [{ name: 'A', price: 0 }, { name: 'B', price: 5 }] }, opts);
        expect(receipt.receiptDate).toBe('2026-11-04');
        expect(items).toHaveLength(1);
    });
});

describe('isTotalMismatch', () => {
    it('ignores rounding noise but flags missed items', () => {
        expect(isTotalMismatch(1000.5, 1000)).toBe(false);
        expect(isTotalMismatch(900, 1000)).toBe(true);
        expect(isTotalMismatch(900, null)).toBe(false);
    });
});

describe('receiptTotalInCurrency', () => {
    it('returns null for mixed currencies', () => {
        expect(receiptTotalInCurrency([{ currency: 'THB', originalPrice: 1 }, { currency: 'USD', originalPrice: 1 }])).toBeNull();
        expect(receiptTotalInCurrency([{ currency: 'THB', originalPrice: 1.1 }, { currency: 'THB', originalPrice: 2.2 }])).toEqual({ amount: 3.3, currency: 'THB' });
    });
});

describe('historical rates', () => {
    it('parses the API format and keeps only supported currencies', () => {
        const parsed = parseRatesResponse({ date: '2025-03-15', rub: { thb: 0.39, usd: 0.0117, btc: 1e-7 } });
        expect(parsed).toEqual({ date: '2025-03-15', rates: { RUB: 1, THB: 0.39, USD: 0.0117 } });
    });
    it('picks the right date tag', () => {
        expect(resolveRateTag('2025-03-15', '2026-11-04')).toBe('2025-03-15');
        expect(resolveRateTag('2026-11-04', '2026-11-04')).toBe('latest');
        expect(resolveRateTag('2027-01-01', '2026-11-04')).toBe('latest');
        expect(resolveRateTag('2023-05-01', '2026-11-04')).toBe('2024-03-02');
        expect(resolveRateTag('garbage', '2026-11-04')).toBe('latest');
    });
    it('requests the receipt date and falls back to the mirror', async () => {
        resetRatesCache();
        const calls = [];
        const fakeFetch = async (url) => {
            calls.push(url);
            if (url.includes('jsdelivr')) return { ok: false };
            return { ok: true, json: async () => ({ date: '2025-03-15', rub: { thb: 0.39 } }) };
        };
        const result = await getRatesForDate('2025-03-15', '2026-11-04', fakeFetch);
        expect(calls[0]).toContain('currency-api@2025-03-15');
        expect(calls[1]).toContain('2025-03-15.currency-api.pages.dev');
        expect(result.rates.THB).toBe(0.39);
    });
});

describe('legacy migration ids', () => {
    it('are stable for the same receipt and differ between receipts', () => {
        const a = legacyReceiptKey({ createdAt: '2026-10-01T10:00:00.000Z', shop: '7-Eleven' });
        const b = legacyReceiptKey({ createdAt: '2026-10-01T10:00:00.000Z', shop: 'Makro' });
        expect(legacyReceiptId(a)).toBe(legacyReceiptId(a));
        expect(legacyReceiptId(a)).not.toBe(legacyReceiptId(b));
        expect(legacyReceiptId(a)).toMatch(/^legacy_[a-z0-9]+_\d+$/);
    });
});

import { draftFromAi, draftFromReceipt, emptyDraft, summarizeDraft, buildItemsFromDraft } from './receipts.js';
import { authErrorMessage, selectedKeys, formatDuration } from './utils.js';

const cats = ['Еда', 'Кафе'];

describe('receipt drafts', () => {
    it('AI draft shows prices before adjustments and allocates them on save', () => {
        const normalized = normalizeAiResult({
            items: [{ name: 'Пад-тай', price: 120, category: 'Кафе' }, { name: 'Кола', price: 30, category: 'Кафе' }],
            adjustments: [{ type: 'service', name: 'SC', amount: 15 }],
            total: 165,
        }, opts);
        const draft = draftFromAi(normalized, 'data:image/jpeg;base64,x');
        expect(draft.items.map(i => i.price)).toEqual([120, 30]);
        expect(summarizeDraft(draft)).toMatchObject({ itemsTotal: 165, mismatch: false });

        const { items } = buildItemsFromDraft(draft, cats);
        expect(items.map(i => i.originalPrice)).toEqual([132, 33]);
        expect(items[0].basePrice).toBe(120);
    });

    it('flags a mismatch when the user deletes a line', () => {
        const draft = draftFromAi(normalizeAiResult({ items: [{ name: 'A', price: 50 }, { name: 'B', price: 50 }], total: 100 }, opts));
        draft.items.splice(1, 1);
        expect(summarizeDraft(draft).mismatch).toBe(true);
    });

    it('manual drafts validate names and prices', () => {
        const draft = emptyDraft({ currency: 'THB', category: 'Еда', todayStr: '2026-11-04' });
        expect(() => buildItemsFromDraft(draft, cats)).toThrow('Добавьте хотя бы одну позицию');
        draft.items[0].name = 'Кофе';
        expect(() => buildItemsFromDraft(draft, cats)).toThrow('укажите цену');
        draft.items[0].price = 80;
        expect(buildItemsFromDraft(draft, cats).items[0]).toMatchObject({ name: 'Кофе', originalPrice: 80, currency: 'THB', basePrice: 80 });
    });

    it('editing keeps item ids, final prices and deleted categories', () => {
        const draft = draftFromReceipt({
            key: 'r1', receiptId: 'r1', shop: 'Cafe', receiptDate: '2026-10-01',
            stored: { currency: 'THB', total: 165, source: 'receipt' },
            items: [
                { id: 'a', name: 'Пад-тай', originalPrice: 132, currency: 'THB', category: 'Старая' },
                { id: 'b', name: 'Кола', originalPrice: 33, currency: 'THB', category: 'Кафе' },
            ],
        });
        draft.items[1].price = 40;
        const { items } = buildItemsFromDraft(draft, cats);
        expect(items[0]).toMatchObject({ id: 'a', originalPrice: 132, category: 'Старая' });
        expect(items[0].basePrice).toBeUndefined();
        expect(items[1]).toMatchObject({ id: 'b', originalPrice: 40, basePrice: 40 });
    });
});

describe('ui helpers', () => {
    it('maps Firebase auth errors to clear messages', () => {
        expect(authErrorMessage({ code: 'auth/invalid-credential' })).toBe('Неверный email или пароль');
        expect(authErrorMessage({ code: 'auth/email-already-in-use' })).toContain('уже зарегистрирован');
        expect(authErrorMessage({ code: 'auth/other', message: 'boom' })).toContain('boom');
    });
    it('keeps user-deselected filters while new keys appear selected', () => {
        expect([...selectedKeys(['Еда', 'Кафе', 'Новая'], new Set(['Кафе']))]).toEqual(['Еда', 'Новая']);
    });
    it('formats recording time', () => {
        expect(formatDuration(0)).toBe('0:00');
        expect(formatDuration(75.6)).toBe('1:15');
    });
});

import { getCachedRates, approximateRub } from './rates.js';

describe('offline rates', () => {
    function fakeStorage(entries) {
        const keys = Object.keys(entries);
        return { length: keys.length, key: i => keys[i], getItem: k => JSON.stringify(entries[k]) };
    }

    it('picks the most recent cached rates', () => {
        const storage = fakeStorage({
            'rates:2026-03-10': { date: '2026-03-10', rates: { RUB: 1, THB: 0.4 } },
            'rates:latest:2026-11-01': { date: '2026-11-01', rates: { RUB: 1, THB: 0.45 } },
            'countme:prefs': { x: 1 },
        });
        expect(getCachedRates(storage).date).toBe('2026-11-01');
    });

    it('approximates RUB from the cache and stays exact for rubles', () => {
        const cached = { rates: { RUB: 1, THB: 0.5 } };
        expect(approximateRub(100, 'THB', cached)).toBe(200);
        expect(approximateRub(100, 'RUB', null)).toBe(100);
        expect(approximateRub(100, 'VND', cached)).toBeNull();
        expect(approximateRub(100, 'THB', null)).toBeNull();
    });
});
