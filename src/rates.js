// ==================== КУРСЫ ВАЛЮТ ====================
// Курсы: сколько единиц валюты за 1 RUB. Источник — бесплатный fawazahmed0/currency-api
// с дневной историей; для каждой траты берётся курс на дату чека.

export const SUPPORTED_CURRENCIES = ['RUB', 'THB', 'VND', 'IDR', 'USD', 'EUR', 'KZT'];

// Самая ранняя дата, за которую у API есть история
const FIRST_HISTORY_DATE = '2024-03-02';

export class RatesUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RatesUnavailableError';
    }
}

const memoryCache = new Map();

function rateUrls(tag) {
    const pagesTag = tag === 'latest' ? 'latest' : tag;
    return [
        `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${tag}/v1/currencies/rub.json`,
        `https://${pagesTag}.currency-api.pages.dev/v1/currencies/rub.json`,
    ];
}

// Ответ API: { date, rub: { thb: 0.39, ... } } → { RUB: 1, THB: 0.39, ... }
export function parseRatesResponse(data) {
    if (!data || !data.rub) return null;
    const rates = { RUB: 1 };
    for (const code of SUPPORTED_CURRENCIES) {
        const value = data.rub[code.toLowerCase()];
        if (typeof value === 'number' && value > 0) rates[code] = value;
    }
    return { date: data.date, rates };
}

function readStoredRates(key) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function storeRates(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch { /* хранилище недоступно — обойдёмся кэшем в памяти */ }
}

// Дата запроса: история есть с FIRST_HISTORY_DATE; будущие и сегодняшние даты — по последнему курсу
export function resolveRateTag(dateStr, todayStr) {
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || dateStr >= todayStr) return 'latest';
    if (dateStr < FIRST_HISTORY_DATE) return FIRST_HISTORY_DATE;
    return dateStr;
}

async function fetchRates(tag, fetchImpl) {
    for (const url of rateUrls(tag)) {
        try {
            const res = await fetchImpl(url);
            if (!res.ok) continue;
            const parsed = parseRatesResponse(await res.json());
            if (parsed) return parsed;
        } catch { /* пробуем запасной адрес */ }
    }
    throw new RatesUnavailableError('Не удалось загрузить курсы валют. Проверьте интернет и повторите.');
}

// Возвращает { date, rates } на дату чека (YYYY-MM-DD)
export async function getRatesForDate(dateStr, todayStr, fetchImpl = fetch) {
    const tag = resolveRateTag(dateStr, todayStr);
    const cacheKey = tag === 'latest' ? `latest:${todayStr}` : tag;
    if (memoryCache.has(cacheKey)) return memoryCache.get(cacheKey);

    // Исторические курсы не меняются — их можно хранить на устройстве бессрочно
    const storageKey = `rates:${cacheKey}`;
    const stored = readStoredRates(storageKey);
    if (stored) {
        memoryCache.set(cacheKey, stored);
        return stored;
    }

    const result = await fetchRates(tag, fetchImpl);
    memoryCache.set(cacheKey, result);
    storeRates(storageKey, result);
    return result;
}

export function getLatestRates(todayStr, fetchImpl = fetch) {
    return getRatesForDate(null, todayStr, fetchImpl);
}

// Цена в рублях; без курса для валюты — ошибка, а не молчаливый курс 1:1
export function convertToRub(amount, currency, rates) {
    if (currency === 'RUB') return amount;
    const rate = rates[currency];
    if (!rate) throw new RatesUnavailableError(`Нет курса для валюты ${currency}`);
    return amount / rate;
}

export function resetRatesCache() {
    memoryCache.clear();
}

// Последние известные курсы из кэша устройства — для приблизительной суммы без сети
export function getCachedRates(storage = globalThis.localStorage) {
    let best = null;
    try {
        for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i);
            if (!key || !key.startsWith('rates:')) continue;
            const value = JSON.parse(storage.getItem(key));
            if (value?.rates && (!best || (value.date || '') > (best.date || ''))) best = value;
        }
    } catch {
        return null;
    }
    return best;
}

// Сумма в рублях для траты, сохранённой без сети: по кэшу, если есть, иначе null (только в рублях — точно)
export function approximateRub(amount, currency, cached) {
    if (currency === 'RUB') return amount;
    const rate = cached?.rates?.[currency];
    return rate ? amount / rate : null;
}
