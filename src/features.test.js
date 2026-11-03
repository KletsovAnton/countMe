import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { filterReceipts } from './receipts.js';
import { buildExportRows, toCsv, toXlsx } from './export.js';
import { buildSpendingContext, buildMonthlySummary, renderAnswerHtml } from './insights.js';
import { escapeHtml } from './utils.js';

const receipts = [
    { key: 'r1', shop: '7-Eleven', items: [
        { id: 'a', name: 'Кофе', originalName: 'Coffee', category: 'Кафе', priceRub: 200 },
        { id: 'b', name: 'Хлеб', originalName: 'Bread', category: 'Еда', priceRub: 100 },
    ] },
    { key: 'r2', shop: 'Grab', items: [{ id: 'c', name: 'Такси', category: 'Транспорт', priceRub: 900 }] },
];

describe('filterReceipts', () => {
    it('finds receipts by item name and highlights the match', () => {
        const res = filterReceipts(receipts, { query: 'coff' });
        expect(res.map(r => r.key)).toEqual(['r1']);
        expect([...res[0].matchedIds]).toEqual(['a']);
    });
    it('matches by shop without highlighting items', () => {
        const res = filterReceipts(receipts, { query: 'grab' });
        expect(res.map(r => r.key)).toEqual(['r2']);
        expect(res[0].matchedIds).toBeNull();
    });
    it('filters by category and receipt total in RUB', () => {
        expect(filterReceipts(receipts, { category: 'Еда' }).map(r => r.key)).toEqual(['r1']);
        expect(filterReceipts(receipts, { minRub: 500 }).map(r => r.key)).toEqual(['r2']);
        expect(filterReceipts(receipts, { maxRub: 300 }).map(r => r.key)).toEqual(['r1']);
    });
    it('returns everything without filters', () => {
        const res = filterReceipts(receipts, {});
        expect(res).toHaveLength(2);
        expect(res[0].matchedIds).toBeNull();
    });
});

const items = [
    { name: 'Кофе; "большой"', originalName: 'Coffee', shop: 'Cafe', category: 'Кафе', originalPrice: 80, currency: 'THB', priceRub: 200.456, receiptDate: '2026-11-02', rateDate: '2026-11-02' },
    { name: 'Такси', shop: 'Grab', category: 'Транспорт', originalPrice: 5, currency: 'USD', priceRub: null, receiptDate: '2026-10-15' },
];

describe('export', () => {
    it('writes Excel-friendly CSV with BOM, semicolons and decimal commas', () => {
        const csv = toCsv(buildExportRows(items));
        expect(csv.startsWith('﻿Дата;Магазин;')).toBe(true);
        const lines = csv.split('\r\n');
        expect(lines[1]).toContain('"Кофе; ""большой"""');
        expect(lines[1]).toContain(';200,46;');
        expect(lines[2]).toContain(';USD;;');
    });
    it('builds a valid xlsx zip with numbers as numbers and escaped text', () => {
        const files = unzipSync(toXlsx(buildExportRows(items)));
        expect(Object.keys(files)).toContain('xl/worksheets/sheet1.xml');
        const sheet = strFromU8(files['xl/worksheets/sheet1.xml']);
        expect(sheet).toContain('Кофе; &quot;большой&quot;');
        expect(sheet).toContain('<v>200.46</v>');
        expect(sheet).toContain('<autoFilter ref="A1:I3"/>');
        expect(strFromU8(files['[Content_Types].xml'])).toContain('spreadsheetml.sheet.main+xml');
    });
});

describe('insights', () => {
    const data = [
        { name: 'Кофе', shop: 'Cafe', category: 'Кафе', originalPrice: 80, currency: 'THB', priceRub: 200, receiptDate: '2026-11-02' },
        { name: 'Ужин', shop: 'Cafe', category: 'Кафе', originalPrice: 400, currency: 'THB', priceRub: 1000, receiptDate: '2026-10-20' },
        { name: 'Старое', shop: 'X', category: 'Еда', originalPrice: 1, currency: 'RUB', priceRub: 1, receiptDate: '2025-01-01' },
    ];
    it('includes only the last 12 months with precomputed totals', () => {
        const ctx = buildSpendingContext(data, '2026-11-04');
        expect(ctx.itemCount).toBe(2);
        expect(ctx.text).toContain('2026-10: 1000');
        expect(ctx.text).toContain('Кафе: 1200');
        expect(ctx.text).not.toContain('Старое');
    });
    it('caps the number of item lines', () => {
        const many = Array.from({ length: 10 }, (_, i) => ({ ...data[0], name: `p${i}` }));
        const ctx = buildSpendingContext(many, '2026-11-04', 3);
        expect(ctx.truncated).toBe(true);
        expect(ctx.text.match(/\| Cafe \|/g)).toHaveLength(3);
    });
    it('compares this month with the previous one', () => {
        const summary = buildMonthlySummary(data, '2026-11-04');
        expect(summary).toMatchObject({ thisMonth: '2026-11', prevMonth: '2026-10', currentTotal: 200, previousTotal: 1000, dayOfMonth: 4 });
        expect(summary.categories[0]).toEqual({ category: 'Кафе', current: 200, previous: 1000 });
    });
    it('renders answers safely with bold and line breaks only', () => {
        const html = renderAnswerHtml('**Итого** 500\n- кафе <script>', escapeHtml);
        expect(html).toBe('<strong>Итого</strong> 500<br>• кафе &lt;script&gt;');
    });
});
