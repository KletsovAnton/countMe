// Локальная дата устройства в формате YYYY-MM-DD
export function getTodayDateStr(now = new Date()) {
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Экранирование текста перед вставкой в innerHTML (данные от ИИ и пользователя)
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

export function formatMoney(amount) {
    return (Number(amount) || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatDateReadable(dateStr) {
    if (!dateStr) return '';
    const parts = dateStr.split('-');
    if (parts.length === 3) {
        return `${parts[2]}.${parts[1]}.${parts[0]}`;
    }
    return dateStr;
}

// Правила распознавания года на чеке — вычисляются от текущей даты, а не захардкожены
export function buildReceiptDateRules(todayStr) {
    const currentYear = Number(todayStr.slice(0, 4));
    const shortYear = String(currentYear).slice(-2);
    const buddhistYear = currentYear + 543;
    const buddhistShort = String(buddhistYear).slice(-2);
    const prevYear = currentYear - 1;
    return `1. Сейчас ${currentYear} год! Если на чеке указан ${currentYear} год (или '${shortYear}'), не меняй его на ${prevYear} или более ранний.
2. Если указан год по буддийскому календарю (например, ${buddhistYear} или '${buddhistShort}') — вычти 543 (${buddhistYear} → ${currentYear}).
3. Если год отсутствует, подставь ${currentYear} год.
4. Приведи дату к формату YYYY-MM-DD. Если дату найти невозможно, верни "${todayStr}".`;
}
