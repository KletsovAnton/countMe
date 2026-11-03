// ==================== КУРСЫ ВАЛЮТ С КЭШИРОВАНИЕМ ====================
// Курсы: сколько единиц валюты за 1 RUB (как в ответе open.er-api.com)

export class RatesUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RatesUnavailableError';
    }
}

let latestRates = null;

export async function getLatestRates(fetchImpl = fetch) {
    if (latestRates) return latestRates;
    let data;
    try {
        const res = await fetchImpl('https://open.er-api.com/v6/latest/RUB');
        data = await res.json();
    } catch (err) {
        throw new RatesUnavailableError('Не удалось загрузить курсы валют. Проверьте интернет и повторите.');
    }
    if (!data || !data.rates) {
        throw new RatesUnavailableError('Сервис курсов валют вернул пустой ответ. Повторите позже.');
    }
    latestRates = data.rates;
    return latestRates;
}

// Цена в рублях; без курса для валюты — ошибка, а не молчаливый курс 1:1
export function convertToRub(amount, currency, rates) {
    if (currency === 'RUB') return amount;
    const rate = rates[currency];
    if (!rate) throw new RatesUnavailableError(`Нет курса для валюты ${currency}`);
    return amount / rate;
}

export function resetRatesCache() {
    latestRates = null;
}
