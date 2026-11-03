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

// Понятные сообщения для ошибок Firebase Auth
const AUTH_ERRORS = {
    'auth/invalid-credential': 'Неверный email или пароль',
    'auth/wrong-password': 'Неверный email или пароль',
    'auth/user-not-found': 'Аккаунт с таким email не найден. Зарегистрируйтесь на вкладке «Регистрация»',
    'auth/email-already-in-use': 'Этот email уже зарегистрирован — войдите на вкладке «Вход»',
    'auth/weak-password': 'Слишком простой пароль: нужно не меньше 6 символов',
    'auth/invalid-email': 'Некорректный email',
    'auth/missing-password': 'Введите пароль',
    'auth/too-many-requests': 'Слишком много попыток. Подождите пару минут и попробуйте снова',
    'auth/network-request-failed': 'Нет соединения с интернетом',
};

export function authErrorMessage(err) {
    return AUTH_ERRORS[err?.code] || `Не удалось войти: ${err?.message || 'неизвестная ошибка'}`;
}

// Длительность записи в формате м:сс
export function formatDuration(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Выбранные фильтры = доступные минус снятые пользователем. Новые ключи (новый магазин,
// новая категория) появляются включёнными, а снятые пользователем остаются снятыми
export function selectedKeys(available, deselected) {
    return new Set(available.filter(k => !deselected.has(k)));
}
