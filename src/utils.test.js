import { describe, it, expect } from 'vitest';
import { escapeHtml, getTodayDateStr, formatDateReadable, buildReceiptDateRules } from './utils.js';
import { convertToRub, getLatestRates, resetRatesCache, RatesUnavailableError } from './rates.js';
import { extractJsonObject } from './gemini.js';

describe('escapeHtml', () => {
    it('neutralizes markup from AI output', () => {
        expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    });
    it('escapes quotes used in data attributes', () => {
        expect(escapeHtml(`Кафе "У Тони" & 'бар'`)).toBe('Кафе &quot;У Тони&quot; &amp; &#39;бар&#39;');
    });
    it('handles null and numbers', () => {
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(42)).toBe('42');
    });
});

describe('dates', () => {
    it('formats local date', () => {
        expect(getTodayDateStr(new Date(2027, 0, 5))).toBe('2027-01-05');
        expect(formatDateReadable('2027-01-05')).toBe('05.01.2027');
    });
    it('builds year rules from the current year, not a hardcoded one', () => {
        const rules = buildReceiptDateRules('2027-03-10');
        expect(rules).toContain('Сейчас 2027 год');
        expect(rules).toContain("'27'");
        expect(rules).toContain('2570 → 2027');
        expect(rules).not.toContain('2569');
    });
});

describe('rates', () => {
    const rates = { RUB: 1, THB: 0.4, USD: 0.0125 };

    it('converts to RUB', () => {
        expect(convertToRub(140, 'THB', rates)).toBeCloseTo(350);
        expect(convertToRub(10, 'USD', rates)).toBeCloseTo(800);
        expect(convertToRub(500, 'RUB', rates)).toBe(500);
    });
    it('refuses to guess a missing rate', () => {
        expect(() => convertToRub(100, 'VND', rates)).toThrow(RatesUnavailableError);
    });
    it('throws instead of falling back to 1:1 when the service is down', async () => {
        resetRatesCache();
        const failingFetch = () => Promise.reject(new Error('offline'));
        await expect(getLatestRates('2026-11-04', failingFetch)).rejects.toThrow(RatesUnavailableError);
    });
});

describe('extractJsonObject', () => {
    it('pulls JSON out of fenced or chatty replies', () => {
        expect(extractJsonObject('Вот: ```json\n{"a":1}\n```')).toEqual({ a: 1 });
    });
});
