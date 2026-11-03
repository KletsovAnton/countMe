// ==================== ДАННЫЕ ДЛЯ ИИ-ЧАТА И ИТОГОВ МЕСЯЦА ====================
// ИИ получает компактную выгрузку трат и готовые агрегаты, чтобы не считать суммы самому.

const round2 = (n) => Math.round(n * 100) / 100;

function itemDate(item) {
    return item.receiptDate || (item.createdAt || '').split('T')[0];
}

function shiftMonth(todayStr, delta) {
    const [y, m] = todayStr.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function sumBy(items, keyFn) {
    const totals = {};
    for (const item of items) {
        const key = keyFn(item);
        totals[key] = round2((totals[key] || 0) + (Number(item.priceRub) || 0));
    }
    return totals;
}

function sortedEntries(totals) {
    return Object.entries(totals).sort((a, b) => b[1] - a[1]);
}

// Траты за последние 12 месяцев: построчно (не больше maxItems самых свежих) и итоги по месяцам и категориям
export function buildSpendingContext(items, todayStr, maxItems = 1500) {
    const fromMonth = shiftMonth(todayStr, -11);
    const recent = items
        .filter(i => itemDate(i).slice(0, 7) >= fromMonth)
        .sort((a, b) => itemDate(b).localeCompare(itemDate(a)));

    const byMonth = sumBy(recent, i => itemDate(i).slice(0, 7));
    const byCategory = sumBy(recent, i => i.category || 'Без категории');

    const lines = recent.slice(0, maxItems).map(i => [
        itemDate(i),
        i.shop || '',
        i.name || '',
        i.category || '',
        `${round2(Number(i.originalPrice) || 0)} ${i.currency || ''}`,
        `${round2(Number(i.priceRub) || 0)} RUB`,
    ].join(' | '));

    return {
        itemCount: recent.length,
        truncated: recent.length > maxItems,
        text: [
            `Сегодня: ${todayStr}. Траты за 12 месяцев (с ${fromMonth}-01): ${recent.length} позиций.`,
            '',
            'Итого по месяцам, RUB:',
            ...Object.keys(byMonth).sort().map(m => `${m}: ${byMonth[m]}`),
            '',
            'Итого по категориям за 12 месяцев, RUB:',
            ...sortedEntries(byCategory).map(([c, v]) => `${c}: ${v}`),
            '',
            `Позиции (дата | магазин | название | категория | сумма в валюте | сумма в RUB)${recent.length > maxItems ? `, показаны ${maxItems} самых свежих` : ''}:`,
            ...lines,
        ].join('\n'),
    };
}

// Сравнение текущего месяца с прошлым: по категориям, топ магазинов и самые крупные траты
export function buildMonthlySummary(items, todayStr) {
    const thisMonth = todayStr.slice(0, 7);
    const prevMonth = shiftMonth(todayStr, -1);
    const current = items.filter(i => itemDate(i).startsWith(thisMonth));
    const previous = items.filter(i => itemDate(i).startsWith(prevMonth));

    const curByCat = sumBy(current, i => i.category || 'Без категории');
    const prevByCat = sumBy(previous, i => i.category || 'Без категории');
    const categories = [...new Set([...Object.keys(curByCat), ...Object.keys(prevByCat)])];

    const total = (list) => round2(list.reduce((s, i) => s + (Number(i.priceRub) || 0), 0));
    const dayOfMonth = Number(todayStr.slice(8, 10));

    return {
        thisMonth,
        prevMonth,
        currentTotal: total(current),
        previousTotal: total(previous),
        dayOfMonth,
        categories: categories
            .map(c => ({ category: c, current: curByCat[c] || 0, previous: prevByCat[c] || 0 }))
            .sort((a, b) => b.current - a.current),
        topShops: sortedEntries(sumBy(current, i => i.shop || 'Не указано')).slice(0, 5),
        biggest: [...current].sort((a, b) => (Number(b.priceRub) || 0) - (Number(a.priceRub) || 0)).slice(0, 5)
            .map(i => ({ name: i.name, shop: i.shop, date: itemDate(i), rub: round2(Number(i.priceRub) || 0) })),
    };
}

export function monthlySummaryToText(summary) {
    return [
        `Текущий месяц ${summary.thisMonth} (прошло дней: ${summary.dayOfMonth}): ${summary.currentTotal} RUB.`,
        `Прошлый месяц ${summary.prevMonth} целиком: ${summary.previousTotal} RUB.`,
        '',
        'По категориям (текущий / прошлый), RUB:',
        ...summary.categories.map(c => `${c.category}: ${c.current} / ${c.previous}`),
        '',
        'Топ магазинов в текущем месяце, RUB:',
        ...summary.topShops.map(([shop, v]) => `${shop}: ${v}`),
        '',
        'Крупнейшие траты текущего месяца:',
        ...summary.biggest.map(b => `${b.date} ${b.name} (${b.shop}): ${b.rub} RUB`),
    ].join('\n');
}

// Ответ ИИ — простой текст; разрешаем только **жирный** и переносы строк, остальное экранируется
export function renderAnswerHtml(text, escapeHtml) {
    return escapeHtml(text)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/^\s*[-*•]\s+/gm, '• ')
        .replace(/\n/g, '<br>');
}
