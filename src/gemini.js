import { getTodayDateStr } from './utils.js';

// ==================== МОДЕЛИ GEMINI И УМНАЯ РОТАЦИЯ ====================
export const GEMINI_MODELS = [
    { id: 'gemini-3.6-flash', label: 'flash 3.6' },
    { id: 'gemini-3.5-flash-lite', label: 'flash 3.5 lite' }
];

// Запоминаем рабочую модель до конца дня, чтобы не тратить время на исчерпанную
function readSavedModelIndex() {
    try {
        const savedDate = localStorage.getItem('geminiModelDate2');
        const savedIdx = Number(localStorage.getItem('geminiModelIdx2')) || 0;
        return (savedDate === getTodayDateStr() && savedIdx < GEMINI_MODELS.length) ? savedIdx : 0;
    } catch {
        return 0;
    }
}

let currentModelIndex = readSavedModelIndex();
let onModelChange = () => {};

export function getCurrentModel() {
    return GEMINI_MODELS[currentModelIndex];
}

export function setOnModelChange(fn) {
    onModelChange = fn;
}

export function setAndSaveModelIndex(idx) {
    currentModelIndex = idx % GEMINI_MODELS.length;
    try {
        localStorage.setItem('geminiModelDate2', getTodayDateStr());
        localStorage.setItem('geminiModelIdx2', String(currentModelIndex));
    } catch { /* хранилище недоступно — модель просто не запомнится */ }
    onModelChange(getCurrentModel());
}

// Извлечение JSON из ответа любой модели
export function extractJsonObject(rawText) {
    if (!rawText) throw new Error("Пустой ответ от ИИ");
    const firstBrace = rawText.indexOf('{');
    const lastBrace = rawText.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        return JSON.parse(rawText.substring(firstBrace, lastBrace + 1));
    }
    const cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned);
}

export function getResponseText(data) {
    const parts = data?.candidates?.[0]?.content?.parts || [];
    return parts.filter(p => p.text && !p.thought).map(p => p.text).join('\n');
}

// ==================== ВЫЗОВ GEMINI С АВТОСМЕНОЙ МОДЕЛИ ====================
async function requestGemini(model, body, apiKey) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);
    try {
        // Ключ передаётся в заголовке, а не в URL — так он не попадает в историю и логи
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        const data = await res.json();
        if (data.error) {
            const e = new Error(`[${model.label}] ${data.error.message || 'Ошибка API'}`);
            e.code = data.error.code || res.status;
            throw e;
        }
        return data;
    } catch (e) {
        if (e.name === 'AbortError') {
            const te = new Error(`[${model.label}] нет ответа за 60 сек`);
            te.code = 'timeout';
            throw te;
        }
        throw e;
    } finally {
        clearTimeout(timeoutId);
    }
}

function buildVariants(modelId, basePayload) {
    const gc = (extra) => ({ ...basePayload, generationConfig: { responseMimeType: 'application/json', ...extra } });
    const low = { thinkingConfig: { thinkingLevel: 'low' } };
    const off = { thinkingConfig: { thinkingBudget: 0 } };

    if (modelId === 'gemini-3.6-flash') return [gc(off), gc(low), gc({}), basePayload];
    return [gc(low), gc({}), basePayload];
}

// onStatus(model) — перед запросом к модели; onSwitch(from, to) — после автосмены
export async function callGeminiWithModelFallback(basePayload, apiKey, { onStatus = () => {}, onSwitch = () => {} } = {}) {
    const total = GEMINI_MODELS.length;

    for (let attempt = 0; attempt < total; attempt++) {
        const model = getCurrentModel();
        onStatus(model);

        const variants = buildVariants(model.id, basePayload);
        const errors = [];
        let lastErr = null;

        for (let v = 0; v < variants.length; v++) {
            try {
                return await requestGemini(model, variants[v], apiKey);
            } catch (e) {
                lastErr = e;
                errors.push(`#${v + 1}: ${e.message}`);
                if (e.code === 400 && v < variants.length - 1) continue; // пробуем следующий конфиг
                break;
            }
        }

        lastErr.message = errors.join(' | ');

        const switchable =
            lastErr.code === 'timeout' ||
            !lastErr.code ||
            [400, 404, 429, 500, 503].includes(lastErr.code) ||
            /quota|rate limit|exhausted|limit|overloaded/i.test(lastErr.message);

        if (switchable && attempt < total - 1) {
            setAndSaveModelIndex(currentModelIndex + 1);
            onSwitch(model, getCurrentModel());
            continue;
        }
        throw lastErr;
    }
    throw new Error('Не удалось получить ответ от ИИ');
}
