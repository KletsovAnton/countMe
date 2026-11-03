// Настройки интерфейса на этом устройстве: валюты, периоды, вид графика, фильтры
const STORAGE_KEY = 'countme:prefs';

let prefs = {};
try {
    prefs = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
} catch {
    prefs = {};
}

export function getPref(key, fallback) {
    return prefs[key] ?? fallback;
}

export function setPref(key, value) {
    prefs[key] = value;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch { /* приватный режим или хранилище недоступно — настройка не запомнится */ }
}
