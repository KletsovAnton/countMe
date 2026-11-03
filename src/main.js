import './style.css';
import Chart from 'chart.js/auto';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged } from 'firebase/auth';
import { collection, doc, updateDoc, getDoc, setDoc, query, orderBy, writeBatch, onSnapshot } from 'firebase/firestore';

import { auth, db } from './firebase.js';
import { getTodayDateStr, escapeHtml, formatMoney, formatDateReadable, buildReceiptDateRules, authErrorMessage, formatDuration, selectedKeys } from './utils.js';
import { getLatestRates, getRatesForDate, convertToRub, getCachedRates, approximateRub, SUPPORTED_CURRENCIES } from './rates.js';
import { normalizeAiResult, receiptTotalInCurrency, isTotalMismatch, legacyReceiptKey, ADJUSTMENT_LABELS, draftFromAi, draftFromReceipt, emptyDraft, buildItemsFromDraft, filterReceipts, mergeSavedItems } from './receipts.js';
import { initEditor, openEditor } from './editor.js';
import { buildExportRows, toCsv, toXlsx, deliverFile } from './export.js';
import { buildSpendingContext, buildMonthlySummary, monthlySummaryToText, renderAnswerHtml } from './insights.js';
import { getPref, setPref } from './prefs.js';
import { getSchemaVersion, migrateToV2, SCHEMA_VERSION } from './migration.js';
import { getCurrentModel, setAndSaveModelIndex, setOnModelChange, callGeminiWithModelFallback, extractJsonObject, getResponseText, GEMINI_MODELS } from './gemini.js';
import { showToast } from './toast.js';

// Глобальное состояние
let currentUser = null;
let currentUserApiKey = "";
let chartInstance = null;
let allItems = [];
let allReceipts = new Map();
let userCategories = [];

// Файлы чека перед отправкой ИИ: несколько фото длинного чека и/или PDF
let pendingFiles = [];
const MAX_RECEIPT_FILES = 5;
const MAX_PDF_BYTES = 15 * 1024 * 1024;

let dashboardMode = getPref('dashboardMode', 'category');
let dashboardPeriod = getPref('dashboardPeriod', 'month');
// Снятые пользователем фильтры, отдельно для категорий и магазинов
let deselectedFilterKeys = {
    category: new Set(getPref('deselectedCategories', [])),
    shop: new Set(getPref('deselectedShops', [])),
};
let selectedFilterKeys = new Set();

let historyPeriod = getPref('historyPeriod', 'all');
// История рисуется страницами, раскрытые чеки остаются раскрытыми при обновлении данных
const HISTORY_PAGE_SIZE = 30;
let historyLimit = HISTORY_PAGE_SIZE;
const expandedReceipts = new Set();
let historySort = getPref('historySort', 'receiptDate');

let lastAiJob = null;
let aiBusy = false;

let mediaRecorder = null;
let audioChunks = [];
let isRecordingVoiceExpense = false;
let recordingTimer = null;
const MAX_RECORDING_SECONDS = 120;

let authMode = 'login';

const CHART_COLORS = ['#4f46e5', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2', '#e11d48', '#2563eb', '#65a30d', '#475569'];

// Сколько ждать подтверждения сервера, прежде чем считать запись поставленной в очередь
const WRITE_ACK_TIMEOUT_MS = 4000;
let queuedNoticeShown = false;

// Запись в Firestore с понятной ошибкой вместо молчаливого сбоя.
// Без сети Firestore не отклоняет запись, а держит её в очереди — промис не завершается,
// пока не появится связь. Поэтому ждём не дольше таймаута и считаем запись сохранённой на устройстве.
async function runWrite(action, errorText) {
    const write = Promise.resolve().then(action);
    write.catch(err => {
        console.error(errorText, err);
        showToast(`${errorText}: ${err.message}`, 'error');
    });

    const timeout = navigator.onLine ? WRITE_ACK_TIMEOUT_MS : 300;
    try {
        const outcome = await Promise.race([
            write.then(() => 'saved'),
            new Promise(resolve => setTimeout(() => resolve('queued'), timeout)),
        ]);
        if (outcome === 'queued' && !queuedNoticeShown) {
            queuedNoticeShown = true;
            showToast('Нет связи с сервером — изменения сохранены на устройстве и отправятся при подключении', 'warning');
        }
        return true;
    } catch {
        return false;
    }
}

function updateModelBadgeUI() {
    const badgeText = document.getElementById('active-model-text');
    if (badgeText) {
        badgeText.innerText = getCurrentModel().label;
    }
}
setOnModelChange(updateModelBadgeUI);

window.cycleModelManually = function() {
    const prevModel = getCurrentModel();
    setAndSaveModelIndex(GEMINI_MODELS.indexOf(prevModel) + 1);
    showToast(`Модель переключена: ${prevModel.label} ➔ ${getCurrentModel().label}`, 'model');
};

// Навигация между экранами
window.switchSection = function(sectionName) {
    const sections = ['home', 'dashboard', 'history', 'categories'];
    sections.forEach(s => {
        const secEl = document.getElementById(`section-${s}`);
        const btnEl = document.getElementById(`nav-btn-${s}`);
        if (s === sectionName) {
            secEl.classList.remove('hidden');
            btnEl.className = "flex flex-col items-center justify-center py-1.5 text-indigo-600 transition";
            btnEl.querySelector('span').classList.replace('font-medium', 'font-extrabold');
        } else {
            secEl.classList.add('hidden');
            btnEl.className = "flex flex-col items-center justify-center py-1.5 text-slate-400 hover:text-slate-600 transition";
            btnEl.querySelector('span').classList.replace('font-extrabold', 'font-medium');
        }
    });

    if (sectionName === 'dashboard') {
        renderDashboard();
    } else if (sectionName === 'history') {
        renderList();
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

// ==================== АВТОРИЗАЦИЯ И НАСТРОЙКИ ====================
window.setAuthMode = function(mode) {
    authMode = mode;
    const active = "flex-1 h-9 text-xs font-bold rounded-xl bg-white text-slate-900 shadow-sm transition";
    const inactive = "flex-1 h-9 text-xs font-semibold rounded-xl text-slate-500 transition";
    document.getElementById('auth-tab-login').className = mode === 'login' ? active : inactive;
    document.getElementById('auth-tab-register').className = mode === 'register' ? active : inactive;
    document.getElementById('auth-submit-btn').innerText = mode === 'login' ? 'Войти' : 'Зарегистрироваться';
    document.getElementById('auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    document.getElementById('auth-password-hint').classList.toggle('hidden', mode === 'login');
    document.getElementById('auth-error').classList.add('hidden');
};

window.handleAuth = async function() {
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const errBox = document.getElementById('auth-error');
    const submitBtn = document.getElementById('auth-submit-btn');
    errBox.classList.add('hidden');

    // Вход и регистрация разделены: опечатка в email больше не создаёт новый пустой аккаунт
    submitBtn.disabled = true;
    try {
        if (authMode === 'login') {
            await signInWithEmailAndPassword(auth, email, password);
        } else {
            await createUserWithEmailAndPassword(auth, email, password);
        }
    } catch (err) {
        errBox.innerText = authErrorMessage(err);
        errBox.classList.remove('hidden');
    } finally {
        submitBtn.disabled = false;
    }
};

window.logout = function() {
    signOut(auth);
};

onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    if (user) {
        document.getElementById('auth-screen').classList.add('hidden');
        document.getElementById('user-email-display').innerText = user.email;
        updateModelBadgeUI();

        try {
            const userDocRef = doc(db, `users/${user.uid}`);
            const userDoc = await getDoc(userDocRef);

            if (userDoc.exists() && userDoc.data().geminiApiKey) {
                currentUserApiKey = userDoc.data().geminiApiKey;
                document.getElementById('apikey-screen').classList.add('hidden');
                document.getElementById('app-screen').classList.remove('hidden');
                document.getElementById('bottom-nav').classList.remove('hidden');
                loadData();
            } else {
                document.getElementById('apikey-screen').classList.remove('hidden');
            }
        } catch (err) {
            showToast(`Ошибка загрузки профиля: ${err.message}`, 'error');
            document.getElementById('auth-screen').classList.remove('hidden');
        }
    } else {
        // Выход: отписываемся от синхронизации и не держим чужие данные в памяти
        stopListeners();
        allItems = [];
        allReceipts = new Map();
        userCategories = [];
        currentUserApiKey = "";
        chatHistory = [];
        document.getElementById('loading-overlay').classList.add('hidden');
        document.getElementById('auth-screen').classList.remove('hidden');
        document.getElementById('apikey-screen').classList.add('hidden');
        document.getElementById('app-screen').classList.add('hidden');
        document.getElementById('bottom-nav').classList.add('hidden');
    }
});

window.saveUserApiKey = async function() {
    const keyInput = document.getElementById('user-gemini-key').value.trim();
    if (!keyInput) { showToast('Введите ключ', 'warning'); return; }

    const saved = await runWrite(
        () => setDoc(doc(db, `users/${currentUser.uid}`), { geminiApiKey: keyInput }, { merge: true }),
        'Не удалось сохранить ключ'
    );
    if (!saved) return;
    currentUserApiKey = keyInput;

    document.getElementById('apikey-screen').classList.add('hidden');
    document.getElementById('app-screen').classList.remove('hidden');
    document.getElementById('bottom-nav').classList.remove('hidden');
    showToast('API-ключ сохранен');
    loadData();
};

window.openSettings = function() {
    document.getElementById('user-gemini-key').value = currentUserApiKey;
    document.getElementById('apikey-screen').classList.remove('hidden');
};

// ==================== УПРАВЛЕНИЕ ПАНЕЛЬЮ ИИ-ЗАПРОСА ====================
function showAiJobPanel(job) {
    const panel = document.getElementById('ai-job-panel');
    const imgBox = document.getElementById('ai-job-image-box');
    const imgEl = document.getElementById('ai-job-img');
    const audioBox = document.getElementById('ai-job-audio-box');
    const audioEl = document.getElementById('ai-job-audio');
    const textBox = document.getElementById('ai-job-text-box');
    const userTextEl = document.getElementById('ai-job-user-text');
    const promptEl = document.getElementById('ai-job-prompt');

    panel.classList.remove('hidden');
    document.getElementById('ai-job-spinner').classList.remove('hidden');
    document.getElementById('ai-job-error-icon').classList.add('hidden');
    document.getElementById('ai-job-close-btn').classList.add('hidden');
    document.getElementById('ai-job-error-box').classList.add('hidden');

    imgBox.classList.add('hidden');
    audioBox.classList.add('hidden');
    textBox.classList.add('hidden');

    if (job.type === 'receipt' && job.imagePreviewUrl) {
        imgEl.src = job.imagePreviewUrl;
        imgBox.classList.remove('hidden');
    } else if (job.type === 'voice' && job.audioUrl) {
        audioEl.src = job.audioUrl;
        audioBox.classList.remove('hidden');
    } else if (job.type === 'text' && job.rawText) {
        userTextEl.innerText = job.rawText;
        textBox.classList.remove('hidden');
    }

    promptEl.innerText = job.prompt;
}

function showAiJobError(errMsg) {
    document.getElementById('ai-job-spinner').classList.add('hidden');
    document.getElementById('ai-job-error-icon').classList.remove('hidden');
    document.getElementById('ai-job-close-btn').classList.remove('hidden');
    document.getElementById('ai-job-status-title').innerText = 'Ошибка обработки';
    document.getElementById('ai-job-error-msg').innerText = errMsg;
    document.getElementById('ai-job-error-box').classList.remove('hidden');
}

window.closeAiJobPanel = function() {
    document.getElementById('ai-job-panel').classList.add('hidden');
    lastAiJob = null;
};

window.retryAiJob = async function() {
    if (!lastAiJob) return;
    await executeAiJob(lastAiJob);
};

// Одновременно идёт только один запрос к ИИ — иначе ответы перепутаются в общей панели
function ensureCanStartAi() {
    if (!navigator.onLine) {
        showToast('Нет интернета — распознавание ИИ недоступно. Используйте «Добавить вручную»', 'warning');
        return false;
    }
    if (aiBusy) {
        showToast('Дождитесь, пока ИИ закончит текущий запрос', 'warning');
        return false;
    }
    if (userCategories.length === 0) {
        showToast('Сначала добавьте хотя бы одну категорию трат в разделе «Категории»', 'warning');
        return false;
    }
    return true;
}

async function executeAiJob(job) {
    lastAiJob = job;
    aiBusy = true;
    showAiJobPanel(job);

    try {
        const data = await callGeminiWithModelFallback(job.payload, currentUserApiKey, {
            onStatus: (model) => {
                document.getElementById('ai-job-status-title').innerText = `ИИ (${model.label}) обрабатывает...`;
            },
            onSwitch: (from, to) => {
                showToast(`${from.label} недоступна. Переключено на ${to.label}`, 'warning');
            }
        });
        const rawText = getResponseText(data);
        const parsedData = extractJsonObject(rawText);

        const defaultShop = job.type === 'voice' ? "Голосовой ввод" : (job.type === 'text' ? "Текстовый ввод" : "Не указано");
        const normalized = normalizeAiResult(parsedData, {
            source: job.type,
            categories: userCategories,
            fallbackCurrency: job.selectedCurrency,
            todayStr: getTodayDateStr(),
            defaultShop,
        });

        if (normalized.items.length === 0) {
            throw new Error('ИИ не обнаружил ни одной финансовой позиции в запросе.');
        }

        // Ничего не сохраняем сразу: пользователь проверяет результат в редакторе
        closeAiJobPanel();
        openEditor(draftFromAi(normalized, job.imagePreviewUrl || null), userCategories);
    } catch (err) {
        showAiJobError(err.message || 'Сбой соединения или перегрузка сервера ИИ.');
    } finally {
        aiBusy = false;
    }
}

window.openManualEntry = function() {
    if (userCategories.length === 0) {
        showToast('Сначала добавьте хотя бы одну категорию трат в разделе «Категории»', 'warning');
        return;
    }
    openEditor(emptyDraft({
        currency: document.getElementById('receipt-currency').value,
        category: userCategories[0],
        todayStr: getTodayDateStr(),
    }), userCategories);
};

function refreshAll() {
    refreshFilters();
    renderDashboard();
    renderList();
    renderCategories();
}

const DEFAULT_SHOPS = { voice: 'Голосовой ввод', text: 'Текстовый ввод', manual: 'Ручной ввод' };

// Сохранение черновика из редактора: новый чек или правка существующего
async function saveDraft(draft) {
    let built;
    try {
        built = buildItemsFromDraft(draft, userCategories);
    } catch (err) {
        showToast(err.message, 'warning');
        return false;
    }

    // Без сети курс на дату чека недоступен: сохраняем с пометкой ratePending и приблизительной
    // суммой по кэшу, а точный пересчёт сделает fillPendingRates при подключении
    let rateInfo = null;
    try {
        rateInfo = await getRatesForDate(draft.receiptDate, getTodayDateStr());
    } catch (err) {
        if (navigator.onLine) console.warn('Курсы недоступны, сохраняем с отложенным пересчётом', err);
    }
    const cachedRates = rateInfo ? null : getCachedRates();

    const { items, adjustments, singleCurrency } = built;
    const itemsTotal = Math.round(items.reduce((s, i) => s + i.originalPrice, 0) * 100) / 100;
    const statedTotal = Number(draft.total);
    const receiptFields = {
        shop: String(draft.shop || '').trim() || DEFAULT_SHOPS[draft.source] || 'Не указано',
        receiptDate: draft.receiptDate,
        currency: singleCurrency,
        total: singleCurrency ? (statedTotal > 0 ? statedTotal : itemsTotal) : null,
    };

    const uid = currentUser.uid;
    const batch = writeBatch(db);
    const existingItems = draft.mode === 'edit' ? getReceiptItems(draft.key) : [];
    const storedReceipt = draft.receiptId ? allReceipts.get(draft.receiptId) : null;
    const receiptRef = draft.receiptId
        ? doc(db, `users/${uid}/receipts`, draft.receiptId)
        : doc(collection(db, `users/${uid}/receipts`));
    const createdAt = storedReceipt?.createdAt || existingItems[0]?.createdAt || new Date().toISOString();

    const receiptObj = draft.mode === 'new'
        ? { ...receiptFields, subtotal: singleCurrency ? Math.round(items.reduce((s, i) => s + i.basePrice, 0) * 100) / 100 : null, adjustments, source: draft.source, createdAt }
        : { ...(storedReceipt || { adjustments: [], subtotal: null, source: 'legacy' }), ...receiptFields, createdAt };
    delete receiptObj.id;
    batch.set(receiptRef, receiptObj);

    const savedItems = [];
    try {
        for (const item of items) {
            const { id, ...fields } = item;
            const existing = existingItems.find(e => e.id === id);
            let rateFields;
            if (rateInfo) {
                rateFields = {
                    priceRub: convertToRub(item.originalPrice, item.currency, rateInfo.rates),
                    rate: rateInfo.rates[item.currency],
                    rateDate: rateInfo.date,
                    ratePending: false,
                };
            } else if (existing?.rate && !existing.ratePending && existing.currency === item.currency && existing.receiptDate === draft.receiptDate) {
                // Дата и валюта не менялись — сохранённый курс по-прежнему верный
                rateFields = { priceRub: item.originalPrice / existing.rate, rate: existing.rate, rateDate: existing.rateDate, ratePending: false };
            } else {
                rateFields = { priceRub: approximateRub(item.originalPrice, item.currency, cachedRates), rate: null, rateDate: null, ratePending: item.currency !== 'RUB' };
                if (item.currency === 'RUB') rateFields.rate = 1;
            }
            const itemObj = {
                ...fields,
                receiptId: receiptRef.id,
                ...rateFields,
                shop: receiptFields.shop,
                receiptDate: receiptFields.receiptDate,
                createdAt,
            };
            const ref = id ? doc(db, `users/${uid}/items`, id) : doc(collection(db, `users/${uid}/items`));
            if (id) batch.update(ref, itemObj);
            else batch.set(ref, itemObj);
            savedItems.push({ ...(existing || {}), ...itemObj, id: ref.id });
        }
    } catch (err) {
        showToast(err.message, 'error');
        return false;
    }

    const keptIds = new Set(savedItems.map(i => i.id));
    const removedItems = existingItems.filter(i => !keptIds.has(i.id));
    removedItems.forEach(i => batch.delete(doc(db, `users/${uid}/items`, i.id)));

    if (!await runWrite(() => batch.commit(), 'Не удалось сохранить чек')) return false;

    allItems = mergeSavedItems(allItems, savedItems, removedItems.map(i => i.id));
    allReceipts.set(receiptRef.id, { id: receiptRef.id, ...receiptObj });
    refreshAll();
    showToast(draft.mode === 'new'
        ? `Сохранено позиций: ${savedItems.length} (${receiptFields.shop})`
        : 'Чек обновлён');
    return true;
}

// Восстановление удалённых позиций и чека по кнопке «Отменить»
async function restoreDeleted(items, receipt) {
    const uid = currentUser.uid;
    const batch = writeBatch(db);
    items.forEach(({ id, ...data }) => batch.set(doc(db, `users/${uid}/items`, id), data));
    if (receipt) {
        const { id, ...data } = receipt;
        batch.set(doc(db, `users/${uid}/receipts`, id), data);
    }
    if (!await runWrite(() => batch.commit(), 'Не удалось восстановить')) return;

    const ids = new Set(items.map(i => i.id));
    allItems = [...items, ...allItems.filter(i => !ids.has(i.id))];
    if (receipt) allReceipts.set(receipt.id, receipt);
    refreshAll();
    showToast('Восстановлено');
}

async function deleteReceiptDraft(draft) {
    const uid = currentUser.uid;
    const items = getReceiptItems(draft.key);
    const receipt = draft.receiptId ? allReceipts.get(draft.receiptId) : null;

    const batch = writeBatch(db);
    items.forEach(i => batch.delete(doc(db, `users/${uid}/items`, i.id)));
    if (receipt) batch.delete(doc(db, `users/${uid}/receipts`, receipt.id));
    if (!await runWrite(() => batch.commit(), 'Не удалось удалить чек')) return false;

    const ids = new Set(items.map(i => i.id));
    allItems = allItems.filter(i => !ids.has(i.id));
    if (receipt) allReceipts.delete(receipt.id);
    refreshAll();
    showToast(`Чек «${draft.shop || 'без названия'}» удалён`, 'info', {
        actionLabel: 'Отменить',
        onAction: () => restoreDeleted(items, receipt),
    });
    return true;
}

initEditor({ onSave: saveDraft, onDelete: deleteReceiptDraft });

// ==================== ТЕКСТОВЫЙ ВВОД ====================
window.submitTextExpense = async function() {
    const inputEl = document.getElementById('text-expense-input');
    const userText = inputEl.value.trim();
    if (!userText) return;
    if (!ensureCanStartAi()) return;

    const defaultCurrency = document.getElementById('receipt-currency').value;
    const todayStr = getTodayDateStr();
    const currentYear = new Date().getFullYear();

    const prompt = `Сегодняшняя дата: ${todayStr} (текущий год — ${currentYear}).
Проанализируй текстовую запись пользователя о расходах: "${userText}".
Правила:
1. Если пользователь не указал год, обязательно используй ${currentYear} год (или рассчитай дату относительно ${todayStr}).
2. Если валюта не названа явно в тексте, используй валюту по умолчанию: "${defaultCurrency}". Допустимые коды валют: RUB, THB, VND, IDR, USD, EUR, KZT.
3. Если в тексте перечислено несколько покупок, создай отдельный элемент в массиве items для каждой.
4. Распредели каждую покупку строго по одной из доступных категорий: ${JSON.stringify(userCategories)}.

Верни ТОЛЬКО валидный JSON-объект без пояснений:
{
  "shopName": "Название магазина/места из текста или 'Текстовый ввод'",
  "receiptDate": "YYYY-MM-DD",
  "items": [
    {"originalName": "Описание из текста", "name": "Краткое название на русском", "price": 100, "currency": "${defaultCurrency}", "category": "${userCategories[0]}"}
  ]
}`;

    const payload = {
        contents: [{ parts: [{ text: prompt }] }]
    };

    inputEl.value = '';
    inputEl.blur();

    await executeAiJob({
        type: 'text',
        prompt: prompt,
        payload: payload,
        rawText: userText,
        selectedCurrency: defaultCurrency
    });
};

// ==================== ГОЛОСОВОЙ ВВОД ====================
async function startAudioRecording() {
    audioChunks = [];
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = event => {
        if (event.data.size > 0) audioChunks.push(event.data);
    };
    mediaRecorder.start();
}

async function stopAudioRecording() {
    return new Promise((resolve) => {
        if (!mediaRecorder) {
            resolve(null);
            return;
        }
        mediaRecorder.onstop = async () => {
            const rawMimeType = mediaRecorder.mimeType || 'audio/mp4';
            const cleanMimeType = rawMimeType.split(';')[0];

            mediaRecorder.stream.getTracks().forEach(track => track.stop());
            const audioBlob = new Blob(audioChunks, { type: cleanMimeType });
            const audioUrl = URL.createObjectURL(audioBlob);
            const reader = new FileReader();
            reader.onloadend = () => {
                const base64Audio = reader.result.split(',')[1];
                resolve({ base64: base64Audio, mimeType: cleanMimeType, audioUrl: audioUrl });
            };
            reader.readAsDataURL(audioBlob);
        };
        mediaRecorder.stop();
    });
}

window.toggleVoiceExpenseRecording = async function() {
    const btn = document.getElementById('voice-expense-btn');
    const textSpan = document.getElementById('voice-expense-text');
    const iconEl = document.getElementById('voice-expense-icon');

    if (!isRecordingVoiceExpense) {
        if (!ensureCanStartAi()) return;
        try {
            await startAudioRecording();
            isRecordingVoiceExpense = true;
            btn.className = "w-[118px] h-11 bg-red-600 hover:bg-red-700 text-white rounded-2xl text-xs font-bold transition flex items-center justify-center gap-1.5 animate-pulse shrink-0 shadow-sm";
            iconEl.className = "fa-solid fa-stop";
            // Таймер на кнопке; запись останавливается сама через MAX_RECORDING_SECONDS
            const startedAt = Date.now();
            textSpan.innerText = `Стоп ${formatDuration(0)}`;
            recordingTimer = setInterval(() => {
                const elapsed = (Date.now() - startedAt) / 1000;
                textSpan.innerText = `Стоп ${formatDuration(elapsed)}`;
                if (elapsed >= MAX_RECORDING_SECONDS) {
                    showToast(`Запись ограничена ${formatDuration(MAX_RECORDING_SECONDS)} — отправляем то, что записано`, 'warning');
                    window.toggleVoiceExpenseRecording();
                }
            }, 250);
        } catch (err) {
            showToast(`Не удалось получить доступ к микрофону: ${err.message}`, 'error');
        }
    } else {
        isRecordingVoiceExpense = false;
        clearInterval(recordingTimer);
        recordingTimer = null;
        btn.className = "w-[118px] h-11 bg-indigo-600 hover:bg-indigo-700 active:scale-[0.98] text-white rounded-2xl text-xs font-bold transition flex items-center justify-center gap-1.5 shrink-0 shadow-sm shadow-indigo-600/15";
        iconEl.className = "fa-solid fa-microphone";
        textSpan.innerText = 'Записать';

        const audioData = await stopAudioRecording();
        if (audioData) {
            const defaultCurrency = document.getElementById('receipt-currency').value;
            const todayStr = getTodayDateStr();
            const currentYear = new Date().getFullYear();

            const prompt = `Сегодняшняя дата: ${todayStr} (текущий год — ${currentYear}).
Прослушай голосовое сообщение пользователя с описанием финансовой траты.
Если пользователь не назвал год, используй ${currentYear} год (или рассчитай дату относительно ${todayStr}).
Если валюта не озвучена, используй валюту по умолчанию: "${defaultCurrency}".
Доступные категории: ${JSON.stringify(userCategories)}.
Верни ТОЛЬКО валидный JSON-объект:
{
  "shopName": "Название магазина/места из речи или 'Голосовой ввод'",
  "receiptDate": "YYYY-MM-DD",
  "items": [
    {"originalName": "Описание из речи", "name": "Название на русском", "price": 100, "currency": "RUB или THB или VND или IDR или USD или EUR или KZT", "category": "подходящая категория из списка"}
  ]
}`;

            const payload = {
                contents: [{
                    parts: [
                        { text: prompt },
                        { inlineData: { mimeType: audioData.mimeType, data: audioData.base64 } }
                    ]
                }]
            };

            await executeAiJob({
                type: 'voice',
                prompt: prompt,
                payload: payload,
                audioUrl: audioData.audioUrl,
                selectedCurrency: defaultCurrency
            });
        }
    }
};

// Приложение свернули во время записи (на iPhone микрофон при этом отключается) — отправляем записанное
document.addEventListener('visibilitychange', () => {
    if (document.hidden && isRecordingVoiceExpense) {
        window.toggleVoiceExpenseRecording();
    }
});

// ==================== СКАНИРОВАНИЕ ЧЕКА ====================
function compressAndConvertToBase64(file, maxDimension = 1200, quality = 0.75) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (event) => {
            const img = new Image();
            img.src = event.target.result;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;

                if (width > height && width > maxDimension) {
                    height = Math.round((height * maxDimension) / width);
                    width = maxDimension;
                } else if (height >= width && height > maxDimension) {
                    width = Math.round((width * maxDimension) / height);
                    height = maxDimension;
                }

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                const dataUrl = canvas.toDataURL('image/jpeg', quality);
                resolve({
                    base64: dataUrl.split(',')[1],
                    mimeType: 'image/jpeg'
                });
            };
            img.onerror = (err) => reject(err);
        };
        reader.onerror = (err) => reject(err);
    });
}

function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

function renderPendingFiles() {
    document.getElementById('modal-files').innerHTML = pendingFiles.map((f, idx) => `
        <div class="relative aspect-[3/4] bg-slate-100 rounded-2xl overflow-hidden border border-slate-200/80 flex items-center justify-center">
            ${f.isPdf
                ? `<div class="text-center px-1"><i class="fa-solid fa-file-pdf text-red-500 text-2xl"></i><p class="text-[10px] font-bold text-slate-500 mt-1 break-all line-clamp-2">${escapeHtml(f.file.name)}</p></div>`
                : `<img src="${f.dataUrl}" alt="Фото ${idx + 1}" class="w-full h-full object-cover">`}
            <span class="absolute left-1.5 top-1.5 bg-slate-900/70 text-white text-[10px] font-bold rounded-lg px-1.5">${idx + 1}</span>
            <button onclick="removePendingFile(${idx})" class="absolute right-1.5 top-1.5 w-6 h-6 rounded-full bg-slate-900/70 text-white flex items-center justify-center" title="Убрать">
                <i class="fa-solid fa-xmark text-[10px]"></i>
            </button>
        </div>
    `).join('');
}

window.handleFileSelected = async function(event, append = false) {
    const files = [...event.target.files];
    event.target.value = '';
    if (files.length === 0) return;
    if (!append && !ensureCanStartAi()) return;
    if (!append) pendingFiles = [];

    for (const file of files) {
        const isPdf = file.type === 'application/pdf';
        if (!isPdf && !file.type.startsWith('image/')) {
            showToast(`«${file.name}» — не фото и не PDF`, 'warning');
            continue;
        }
        if (isPdf && file.size > MAX_PDF_BYTES) {
            showToast(`PDF «${file.name}» больше 15 МБ`, 'warning');
            continue;
        }
        if (pendingFiles.length >= MAX_RECEIPT_FILES) {
            showToast(`Не больше ${MAX_RECEIPT_FILES} файлов на один чек`, 'warning');
            break;
        }
        try {
            pendingFiles.push({ file, isPdf, dataUrl: await readAsDataUrl(file) });
        } catch {
            showToast(`Не удалось прочитать «${file.name}»`, 'error');
        }
    }
    if (pendingFiles.length === 0) return;

    if (!append) document.getElementById('modal-prompt-note').value = '';
    renderPendingFiles();
    document.getElementById('receipt-modal').classList.remove('hidden');
};

window.removePendingFile = function(idx) {
    pendingFiles.splice(idx, 1);
    if (pendingFiles.length === 0) {
        cancelReceiptUpload();
        return;
    }
    renderPendingFiles();
};

window.cancelReceiptUpload = function() {
    pendingFiles = [];
    document.getElementById('receipt-modal').classList.add('hidden');
};

window.confirmReceiptUpload = async function() {
    if (pendingFiles.length === 0) return;
    const files = pendingFiles;
    const previewUrl = files.find(f => !f.isPdf)?.dataUrl || null;
    const userNote = document.getElementById('modal-prompt-note').value.trim();
    const selectedCurrency = document.getElementById('receipt-currency').value;

    document.getElementById('receipt-modal').classList.add('hidden');

    // Фото сжимаем, PDF отправляем как есть — Gemini читает PDF напрямую
    const fileParts = [];
    try {
        for (const f of files) {
            if (f.isPdf) {
                fileParts.push({ inlineData: { mimeType: 'application/pdf', data: f.dataUrl.split(',')[1] } });
            } else {
                const { base64, mimeType } = await compressAndConvertToBase64(f.file);
                fileParts.push({ inlineData: { mimeType, data: base64 } });
            }
        }
    } catch (err) {
        showToast('Не удалось прочитать файл. Попробуйте другое фото.', 'error');
        return;
    }
    const todayStr = getTodayDateStr();
    const currentYear = new Date().getFullYear();

    let prompt = `Сегодняшняя дата: ${todayStr} (текущий год — ${currentYear}).
Распознай чек.${files.length > 1 ? ` Это ОДИН чек, снятый на ${files.length} фото/файлах по частям (по порядку сверху вниз). Части могут перекрываться — не дублируй одинаковые позиции на стыках; итог и сборы бери из той части, где они напечатаны.` : ''} Строго соблюдай правила для даты (receiptDate):
${buildReceiptDateRules(todayStr)}

Определи название магазина (если неизвестно — "Не указано").

Валюта (currency): определи по символам (฿, ₫, Rp, ₸, ₽, $, €), языку, стране и адресу на чеке. Допустимые коды: ${SUPPORTED_CURRENCIES.join(', ')}. Если определить невозможно — "${selectedCurrency}".

Для каждого товара укажи:
1. originalName: название с чека на исходном языке.
2. name: понятный перевод на русский язык.
3. price: цена позиции с учётом количества и скидки на эту строку, но БЕЗ общих сборов чека (число).
4. category: строго одна из категорий: ${JSON.stringify(userCategories)}.

Сборы и скидки на весь чек (adjustments) — только то, что ДОБАВЛЯЕТСЯ к сумме товаров или ВЫЧИТАЕТСЯ из неё:
- type: "service" (сервисный сбор), "tax" (налог сверх цен), "tip" (чаевые), "discount" (скидка на чек), "other".
- amount: положительное число для надбавок, отрицательное для скидок.
- Строки вида «VAT included» / «в т.ч. НДС», уже входящие в цены, НЕ добавляй.

total: итоговая сумма к оплате, напечатанная на чеке (число), или null, если её нет.`;

    if (userNote) {
        prompt += `\n\nВАЖНОЕ УКАЗАНИЕ ПОЛЬЗОВАТЕЛЯ: "${userNote}". Обязательно учти при разборе! Если указание исключает позиции или делит счёт, total должен отражать сумму после применения указания.`;
    }

    prompt += `\n\nВерни ответ ТОЛЬКО в формате валидного JSON-объекта:
{
  "shopName": "Название магазина",
  "receiptDate": "YYYY-MM-DD",
  "currency": "${selectedCurrency}",
  "items": [
    {"originalName": "...", "name": "...", "price": 45.00, "category": "${userCategories[0]}"}
  ],
  "adjustments": [
    {"type": "service", "name": "Service charge 10%", "amount": 4.50}
  ],
  "total": 49.50
}`;

    const payload = {
        contents: [{
            parts: [
                { text: prompt },
                ...fileParts
            ]
        }]
    };

    pendingFiles = [];

    await executeAiJob({
        type: 'receipt',
        prompt: prompt,
        payload: payload,
        imagePreviewUrl: previewUrl,
        selectedCurrency: selectedCurrency
    });
};

// ==================== КАТЕГОРИИ ====================
function saveCategories(list) {
    return setDoc(doc(db, `users/${currentUser.uid}/settings`, 'categories'), { list });
}

window.addCategory = async function() {
    const input = document.getElementById('new-category-input');
    const catName = input.value.trim();
    if (!catName || userCategories.includes(catName)) return;

    // Сначала запись в базу, потом локальное состояние — чтобы они не расходились при ошибке
    const nextList = [...userCategories, catName];
    if (!await runWrite(() => saveCategories(nextList), 'Не удалось добавить категорию')) return;

    userCategories = nextList;
    input.value = '';
    renderCategories();
    refreshFilters();
    renderList();
    showToast(`Категория «${catName}» добавлена`);
};

// Пакетная запись с разбиением: в один batch Firestore помещается до 500 операций
async function commitInBatches(updates) {
    for (let i = 0; i < updates.length; i += 450) {
        const batch = writeBatch(db);
        updates.slice(i, i + 450).forEach(fn => fn(batch));
        await batch.commit();
    }
}

// Переносит траты из категорий fromCats в toCat и сохраняет новый список категорий
async function moveItemsAndSaveCategories(fromCats, toCat, nextList, errorText) {
    const affected = allItems.filter(i => fromCats.includes(i.category));
    const ops = affected.map(item => batch => batch.update(doc(db, `users/${currentUser.uid}/items`, item.id), { category: toCat }));
    const ok = await runWrite(async () => {
        await commitInBatches(ops);
        await saveCategories(nextList);
    }, errorText);
    if (!ok) return false;

    affected.forEach(item => { item.category = toCat; });
    userCategories = nextList;
    renderCategories();
    refreshFilters();
    renderDashboard();
    renderList();
    return affected.length;
}

function countItemsInCategory(cat) {
    return allItems.filter(i => i.category === cat).length;
}

function getOrphanCategories() {
    return [...new Set(allItems.map(i => i.category).filter(c => !userCategories.includes(c)))];
}

function categoryOptions(exclude) {
    return userCategories.filter(c => c !== exclude).map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
}

function openCategoryModal(cat) {
    const count = countItemsInCategory(cat);
    document.getElementById('category-modal-original').value = cat;
    document.getElementById('category-modal-name').value = cat;
    document.getElementById('category-modal-count').innerText = count > 0 ? `Трат в категории: ${count}` : 'В категории пока нет трат';
    document.getElementById('category-modal-target').innerHTML = categoryOptions(cat);
    document.getElementById('category-modal-move-label').innerText = count > 0
        ? `При удалении перенести ${count} трат(ы) в:`
        : 'Категорию можно удалить без переноса трат';
    document.getElementById('category-modal-target').classList.toggle('hidden', count === 0);
    document.getElementById('category-modal').classList.remove('hidden');
}

window.closeCategoryModal = function() {
    document.getElementById('category-modal').classList.add('hidden');
};

window.saveCategoryRename = async function() {
    const oldName = document.getElementById('category-modal-original').value;
    const newName = document.getElementById('category-modal-name').value.trim();
    if (!newName || newName === oldName) { closeCategoryModal(); return; }
    if (userCategories.includes(newName)) {
        showToast(`Категория «${newName}» уже есть`, 'warning');
        return;
    }
    const nextList = userCategories.map(c => c === oldName ? newName : c);
    const moved = await moveItemsAndSaveCategories([oldName], newName, nextList, 'Не удалось переименовать категорию');
    if (moved === false) return;
    closeCategoryModal();
    showToast(`Категория переименована: «${oldName}» → «${newName}»`);
};

window.deleteCategoryFromModal = async function() {
    const catName = document.getElementById('category-modal-original').value;
    if (userCategories.length <= 1) {
        showToast('Должна остаться хотя бы одна категория', 'warning');
        return;
    }
    const target = document.getElementById('category-modal-target').value || userCategories.find(c => c !== catName);
    const nextList = userCategories.filter(c => c !== catName);
    const moved = await moveItemsAndSaveCategories([catName], target, nextList, 'Не удалось удалить категорию');
    if (moved === false) return;
    closeCategoryModal();
    showToast(moved > 0 ? `Категория удалена, ${moved} трат(ы) перенесены в «${target}»` : 'Категория удалена');
};

window.reassignOrphans = async function() {
    const target = document.getElementById('orphans-target').value;
    const orphans = getOrphanCategories();
    if (!target || orphans.length === 0) return;
    const moved = await moveItemsAndSaveCategories(orphans, target, userCategories, 'Не удалось перенести траты');
    if (moved === false) return;
    showToast(`Перенесено трат: ${moved} → «${target}»`);
};

function renderCategories() {
    const container = document.getElementById('categories-container');
    const orphansBox = document.getElementById('orphans-box');

    const orphans = getOrphanCategories();
    const orphanCount = allItems.filter(i => orphans.includes(i.category)).length;
    if (orphanCount > 0) {
        document.getElementById('orphans-text').innerText =
            `${orphanCount} трат(ы) из удалённых категорий (${orphans.join(', ')}). В аналитике они попадают в «Другое».`;
        document.getElementById('orphans-target').innerHTML = categoryOptions(null);
        orphansBox.classList.remove('hidden');
    } else {
        orphansBox.classList.add('hidden');
    }

    if (userCategories.length === 0) {
        container.innerHTML = `<p class="text-xs text-slate-400">Список пуст. Добавьте свою первую категорию выше.</p>`;
        return;
    }
    container.innerHTML = userCategories.map(cat => `
        <button data-action="edit-category" data-cat="${escapeHtml(cat)}" class="inline-flex items-center gap-2 bg-slate-100 hover:bg-indigo-50 text-slate-800 text-xs px-3.5 py-2 rounded-2xl font-bold transition">
            <span>${escapeHtml(cat)}</span>
            <span class="text-[10px] font-semibold text-slate-400">${countItemsInCategory(cat)}</span>
            <i class="fa-solid fa-pen text-[9px] text-slate-400"></i>
        </button>
    `).join('');
}

// ==================== ЗАГРУЗКА ДАННЫХ ====================
const DEFAULT_CATEGORIES = ['Еда и супермаркеты', 'Кафе и рестораны', 'Транспорт', 'Жилье и быт', 'Развлечения'];
let unsubscribers = [];
let renderScheduled = false;

function stopListeners() {
    unsubscribers.forEach(unsubscribe => unsubscribe());
    unsubscribers = [];
}

// Несколько снимков подряд (позиции, чеки, категории) — одна перерисовка
function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
        renderScheduled = false;
        refreshAll();
    });
}

function listenError(what) {
    return (err) => {
        console.error(`Ошибка синхронизации: ${what}`, err);
        showToast(`Не удалось синхронизировать ${what}: ${err.message}`, 'error');
    };
}

// Живая синхронизация: изменения с другого устройства этого аккаунта появляются без перезагрузки.
// Первый снимок приходит из локального кэша, поэтому без сети приложение тоже открывается.
async function loadData() {
    const overlay = document.getElementById('loading-overlay');
    overlay.classList.remove('hidden');
    stopListeners();
    const uid = currentUser.uid;

    let resolveItems, resolveReceipts, resolveCategories;
    const firstSnapshots = Promise.all([
        new Promise(r => { resolveItems = r; }),
        new Promise(r => { resolveReceipts = r; }),
        new Promise(r => { resolveCategories = r; }),
    ]);

    unsubscribers.push(onSnapshot(doc(db, `users/${uid}/settings`, 'categories'), (snap) => {
        if (snap.exists() && snap.data().list) {
            userCategories = snap.data().list;
        } else {
            userCategories = [...DEFAULT_CATEGORIES];
            // Создаём список по умолчанию только по ответу сервера — пустой кэш ещё не значит, что списка нет
            if (!snap.metadata.fromCache) saveCategories(userCategories).catch(listenError('категории'));
        }
        resolveCategories();
        scheduleRender();
    }, listenError('категории')));

    const itemsQuery = query(collection(db, `users/${uid}/items`), orderBy('createdAt', 'desc'));
    unsubscribers.push(onSnapshot(itemsQuery, (snap) => {
        allItems = snap.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
        resolveItems();
        scheduleRender();
    }, listenError('траты')));

    unsubscribers.push(onSnapshot(collection(db, `users/${uid}/receipts`), (snap) => {
        allReceipts = new Map(snap.docs.map(docSnap => [docSnap.id, { id: docSnap.id, ...docSnap.data() }]));
        resolveReceipts();
        scheduleRender();
    }, listenError('чеки')));

    await firstSnapshots;
    overlay.classList.add('hidden');
    refreshAll();

    await runMigrationIfNeeded();
    fillPendingRates();
}

// Однократный перевод старых записей на схему с отдельными чеками (с резервной копией)
async function runMigrationIfNeeded() {
    // Без сети миграция не запускается: записи встали бы в очередь, а резервная копия — нет
    if (!navigator.onLine) return;
    try {
        if (await getSchemaVersion(currentUser.uid) >= SCHEMA_VERSION) return;
        const hasLegacy = allItems.some(item => !item.receiptId);
        if (hasLegacy) showToast('Обновляем формат данных… Не закрывайте приложение', 'model');

        await migrateToV2(currentUser.uid, allItems, getTodayDateStr());

        if (hasLegacy) {
            showToast('Данные обновлены: суммы пересчитаны по курсу на дату чека, резервная копия сохранена');
        }
    } catch (err) {
        console.error('Ошибка миграции', err);
        showToast(`Не удалось обновить формат данных, попробуем при следующем входе: ${err.message}`, 'warning');
    }
}

// Траты, сохранённые без сети, получают точный курс на дату чека, как только он доступен
let fillingRates = false;
async function fillPendingRates() {
    if (fillingRates || !navigator.onLine || !currentUser) return;
    const pending = allItems.filter(i => i.ratePending);
    if (pending.length === 0) return;
    fillingRates = true;
    try {
        const updates = [];
        for (const item of pending) {
            const { date, rates } = await getRatesForDate(item.receiptDate, getTodayDateStr());
            updates.push(batch => batch.update(doc(db, `users/${currentUser.uid}/items`, item.id), {
                priceRub: convertToRub(Number(item.originalPrice) || 0, item.currency, rates),
                rate: rates[item.currency],
                rateDate: date,
                ratePending: false,
            }));
        }
        if (await runWrite(() => commitInBatches(updates), 'Не удалось пересчитать суммы')) {
            showToast(`Пересчитано по курсу на дату чека: ${pending.length} трат(ы)`);
        }
    } catch (err) {
        console.warn('Курсы пока недоступны, пересчёт позже', err);
    } finally {
        fillingRates = false;
    }
}

// ==================== ДАШБОРД И ФИЛЬТРЫ ====================
window.setDashboardPeriod = function(period) {
    dashboardPeriod = period;
    setPref('dashboardPeriod', period);
    document.querySelectorAll('.dash-period-btn').forEach(btn => {
        if (btn.dataset.period === period) {
            btn.className = "dash-period-btn shrink-0 px-3.5 h-8 rounded-xl text-xs font-bold bg-indigo-600 text-white transition";
        } else {
            btn.className = "dash-period-btn shrink-0 px-3.5 h-8 rounded-xl text-xs font-semibold bg-slate-100 text-slate-600 transition";
        }
    });
    renderDashboard();
};

window.setDashboardMode = function(mode) {
    dashboardMode = mode;
    setPref('dashboardMode', mode);
    const btnCat = document.getElementById('tab-mode-category');
    const btnShop = document.getElementById('tab-mode-shop');

    if (mode === 'category') {
        btnCat.className = "flex-1 h-7 text-xs font-bold rounded-lg bg-white text-slate-900 shadow-sm transition";
        btnShop.className = "flex-1 h-7 text-xs font-semibold rounded-lg text-slate-500 transition";
    } else {
        btnShop.className = "flex-1 h-7 text-xs font-bold rounded-lg bg-white text-slate-900 shadow-sm transition";
        btnCat.className = "flex-1 h-7 text-xs font-semibold rounded-lg text-slate-500 transition";
    }
    refreshFilters();
    renderDashboard();
};

function getAvailableFilterKeys() {
    if (dashboardMode === 'category') {
        return [...userCategories, 'Другое'];
    } else {
        let shopsSet = new Set();
        allItems.forEach(i => shopsSet.add(i.shop || 'Не указано'));
        let keys = Array.from(shopsSet);
        return keys.length > 0 ? keys : ['Не указано'];
    }
}

// Пересчитывает выбранные фильтры, сохраняя то, что пользователь снял вручную
function refreshFilters() {
    selectedFilterKeys = selectedKeys(getAvailableFilterKeys(), deselectedFilterKeys[dashboardMode]);
    renderFilterChips();
}

function saveDeselectedFilters() {
    setPref('deselectedCategories', [...deselectedFilterKeys.category]);
    setPref('deselectedShops', [...deselectedFilterKeys.shop]);
}

function renderFilterChips() {
    const container = document.getElementById('filter-chips');
    const keys = getAvailableFilterKeys();
    container.innerHTML = keys.map(k => {
        const isSelected = selectedFilterKeys.has(k);
        return `
            <button data-action="toggle-filter" data-key="${escapeHtml(k)}" class="shrink-0 px-3 h-8 rounded-xl text-xs font-bold transition flex items-center gap-1.5 ${isSelected ? 'bg-indigo-600 text-white shadow-sm' : 'bg-slate-100 text-slate-500'}">
                <i class="fa-solid ${isSelected ? 'fa-check text-[10px]' : 'fa-plus text-[10px] opacity-60'}"></i>
                <span>${escapeHtml(k)}</span>
            </button>
        `;
    }).join('');
}

function toggleFilterChip(key) {
    const deselected = deselectedFilterKeys[dashboardMode];
    if (deselected.has(key)) deselected.delete(key);
    else deselected.add(key);
    saveDeselectedFilters();
    refreshFilters();
    renderDashboard();
}

window.toggleAllFilters = function(selectAll) {
    deselectedFilterKeys[dashboardMode] = selectAll ? new Set() : new Set(getAvailableFilterKeys());
    saveDeselectedFilters();
    refreshFilters();
    renderDashboard();
};

function filterItemsByPeriodGeneric(items, period) {
    if (period === 'all') return items;

    const todayStr = getTodayDateStr();
    const now = new Date(todayStr + 'T12:00:00');

    return items.filter(item => {
        const rawDate = item.receiptDate || (item.createdAt ? item.createdAt.split('T')[0] : todayStr);
        const itemDate = new Date(rawDate + 'T12:00:00');
        if (isNaN(itemDate)) return true;

        if (period === 'today') {
            return rawDate === todayStr;
        }
        const dow = now.getDay() || 7;
        const monday = new Date(now);
        monday.setDate(now.getDate() - dow + 1);
        monday.setHours(0, 0, 0, 0);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        sunday.setHours(23, 59, 59, 999);

        if (period === 'week') {
            return itemDate >= monday && itemDate <= sunday;
        }
        if (period === 'prev_week') {
            const prevMonday = new Date(monday);
            prevMonday.setDate(monday.getDate() - 7);
            const prevSunday = new Date(monday);
            prevSunday.setMilliseconds(-1);
            return itemDate >= prevMonday && itemDate <= prevSunday;
        }
        if (period === 'month') {
            return itemDate.getMonth() === now.getMonth() && itemDate.getFullYear() === now.getFullYear();
        }
        if (period === 'prev_month') {
            const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            return itemDate.getMonth() === prevMonthDate.getMonth() && itemDate.getFullYear() === prevMonthDate.getFullYear();
        }
        if (period === 'days30') {
            const diffTime = now - itemDate;
            const diffDays = diffTime / (1000 * 60 * 60 * 24);
            return diffDays >= 0 && diffDays <= 30;
        }
        if (period === 'year') {
            return itemDate.getFullYear() === now.getFullYear();
        }
        return true;
    });
}

window.renderDashboard = async function() {
    const filteredByPeriod = filterItemsByPeriodGeneric(allItems, dashboardPeriod);
    const currencySelect = document.getElementById('dashboard-currency');
    let targetCurrency = currencySelect.value;
    const chartType = document.getElementById('chart-type').value;

    // Без курсов показываем суммы в рублях, а не неверно пересчитанные
    let rubToTargetRate = 1;
    if (targetCurrency !== 'RUB') {
        try {
            const { rates } = await getLatestRates(getTodayDateStr());
            if (!rates[targetCurrency]) throw new Error(`нет курса ${targetCurrency}`);
            rubToTargetRate = rates[targetCurrency];
        } catch (err) {
            showToast('Курсы валют недоступны — суммы показаны в RUB', 'warning');
            targetCurrency = 'RUB';
            currencySelect.value = 'RUB';
        }
    }
    // Траты в валюте отображения берутся как есть, без двойной конвертации через рубль
    // У трат, сохранённых без сети и без кэша курсов, суммы в рублях пока нет (priceRub = null)
    const amountInTarget = (item) => item.currency === targetCurrency
        ? (Number(item.originalPrice) || 0)
        : (Number(item.priceRub) || 0) * rubToTargetRate;
    const pendingCount = filteredByPeriod.filter(i => i.ratePending).length;
    const pendingNote = document.getElementById('dashboard-pending-note');
    pendingNote.classList.toggle('hidden', pendingCount === 0);
    pendingNote.innerText = `${pendingCount} трат(ы) сохранены без сети — суммы приблизительные и уточнятся при подключении`;

    const filteredItems = filteredByPeriod.filter(item => {
        const key = dashboardMode === 'category'
            ? (userCategories.includes(item.category) ? item.category : 'Другое')
            : (item.shop || 'Не указано');
        return selectedFilterKeys.has(key);
    });

    let totalInTarget = filteredItems.reduce((sum, item) => sum + amountInTarget(item), 0);

    document.getElementById('total-sum').innerText = `${formatMoney(totalInTarget)} ${targetCurrency}`;
    document.getElementById('total-count-badge').innerText = `Операций: ${filteredItems.length}`;

    let statsData = {};
    filteredItems.forEach(item => {
        const key = dashboardMode === 'category'
            ? (userCategories.includes(item.category) ? item.category : 'Другое')
            : (item.shop || 'Не указано');
        statsData[key] = (statsData[key] || 0) + amountInTarget(item);
    });

    const sortedGroupKeys = Object.keys(statsData).filter(k => statsData[k] > 0).sort((a, b) => statsData[b] - statsData[a]);

    const breakdownEl = document.getElementById('dashboard-breakdown');
    if (sortedGroupKeys.length === 0) {
        breakdownEl.innerHTML = `<p class="text-xs text-slate-400 text-center py-4">Нет расходов за выбранный период</p>`;
    } else {
        breakdownEl.innerHTML = sortedGroupKeys.map((key, idx) => {
            const val = statsData[key];
            const percent = totalInTarget > 0 ? Math.round((val / totalInTarget) * 100) : 0;
            const color = CHART_COLORS[idx % CHART_COLORS.length];
            return `
                <div>
                    <div class="flex justify-between items-center text-xs mb-1.5">
                        <div class="flex items-center gap-2 font-bold text-slate-800">
                            <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background-color: ${color}"></span>
                            <span>${escapeHtml(key)}</span>
                        </div>
                        <div class="text-right">
                            <span class="font-extrabold text-slate-900">${formatMoney(val)} ${targetCurrency}</span>
                            <span class="text-[11px] font-semibold text-slate-400 ml-1">${percent}%</span>
                        </div>
                    </div>
                    <div class="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                        <div class="h-full rounded-full transition-all duration-300" style="width: ${percent}%; background-color: ${color}"></div>
                    </div>
                </div>
            `;
        }).join('');
    }

    const ctx = document.getElementById('expensesChart').getContext('2d');
    if (chartInstance) chartInstance.destroy();

    if (chartType === 'doughnut') {
        const labels = sortedGroupKeys.length > 0 ? sortedGroupKeys : ['Нет данных'];
        const dataVals = sortedGroupKeys.length > 0 ? sortedGroupKeys.map(k => statsData[k]) : [1];
        const bgColors = sortedGroupKeys.length > 0 ? sortedGroupKeys.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]) : ['#f1f5f9'];

        chartInstance = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: dataVals,
                    backgroundColor: bgColors,
                    borderWidth: 2,
                    borderColor: '#ffffff'
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '68%',
                plugins: { legend: { display: false } }
            }
        });
    } else {
        let timeGrouped = {};

        filteredItems.forEach(item => {
            const dateStr = item.receiptDate || item.createdAt.split('T')[0];
            const dateObj = new Date(dateStr + 'T12:00:00');
            if (isNaN(dateObj)) return;

            let groupKey = dateStr;
            if (chartType === 'bar_week') {
                const d = new Date(dateObj);
                const day = d.getDay() || 7;
                d.setDate(d.getDate() - day + 1);
                const y = d.getFullYear();
                const m = String(d.getMonth() + 1).padStart(2, '0');
                const dd = String(d.getDate()).padStart(2, '0');
                groupKey = `${y}-${m}-${dd}_week`;
            } else if (chartType === 'bar_month') {
                groupKey = dateStr.substring(0, 7) + '-01';
            }

            timeGrouped[groupKey] = (timeGrouped[groupKey] || 0) + amountInTarget(item);
        });

        const sortedKeys = Object.keys(timeGrouped).sort();
        const values = sortedKeys.map(k => timeGrouped[k]);

        const labels = sortedKeys.map(k => {
            if (chartType === 'bar_week') {
                const cleanDate = k.replace('_week', '');
                return formatDateReadable(cleanDate).slice(0, 5);
            } else if (chartType === 'bar_month') {
                const parts = k.split('-');
                return `${parts[1]}.${parts[0]}`;
            }
            return formatDateReadable(k).slice(0, 5);
        });

        chartInstance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: `Сумма (${targetCurrency})`,
                    data: values,
                    backgroundColor: '#4f46e5',
                    borderRadius: 8
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { grid: { display: false }, ticks: { font: { size: 10 } } },
                    y: { border: { display: false }, ticks: { font: { size: 10 } } }
                }
            }
        });
    }
};

// ==================== ИСТОРИЯ ЧЕКОВ И МОДАЛЬНОЕ РЕДАКТИРОВАНИЕ ====================
window.setHistoryPeriod = function(period) {
    historyPeriod = period;
    historyLimit = HISTORY_PAGE_SIZE;
    setPref('historyPeriod', period);
    document.querySelectorAll('.hist-period-btn').forEach(btn => {
        if (btn.dataset.hperiod === period) {
            btn.className = "hist-period-btn shrink-0 px-3.5 h-8 rounded-xl text-xs font-bold bg-indigo-600 text-white transition";
        } else {
            btn.className = "hist-period-btn shrink-0 px-3.5 h-8 rounded-xl text-xs font-semibold bg-slate-100 text-slate-600 transition";
        }
    });
    renderList();
};

window.setHistorySort = function(sortMode) {
    historySort = sortMode;
    setPref('historySort', sortMode);
    const btnReceipt = document.getElementById('sort-by-receipt-date');
    const btnCreated = document.getElementById('sort-by-created-at');

    if (sortMode === 'receiptDate') {
        btnReceipt.className = "px-2.5 py-1 text-xs font-bold rounded-lg bg-white text-slate-900 shadow-sm transition";
        btnCreated.className = "px-2.5 py-1 text-xs font-semibold rounded-lg text-slate-500 transition";
    } else {
        btnCreated.className = "px-2.5 py-1 text-xs font-bold rounded-lg bg-white text-slate-900 shadow-sm transition";
        btnReceipt.className = "px-2.5 py-1 text-xs font-semibold rounded-lg text-slate-500 transition";
    }
    renderList();
};

// Группировка по receiptId; старые записи без receiptId (если миграция ещё не прошла) — по времени загрузки и магазину
function groupItemsIntoReceipts(items) {
    let receiptsMap = new Map();
    items.forEach(item => {
        const groupKey = item.receiptId || `legacy:${legacyReceiptKey(item)}`;
        if (!receiptsMap.has(groupKey)) {
            const stored = item.receiptId ? allReceipts.get(item.receiptId) : null;
            receiptsMap.set(groupKey, {
                key: groupKey,
                receiptId: item.receiptId || null,
                receiptDate: stored?.receiptDate || item.receiptDate,
                shop: stored?.shop || item.shop || 'Не указано',
                createdAt: stored?.createdAt || item.createdAt || '',
                stored,
                items: []
            });
        }
        receiptsMap.get(groupKey).items.push(item);
    });
    return [...receiptsMap.values()];
}

function categorySelectOptions(current) {
    const options = userCategories.map(cat => `<option value="${escapeHtml(cat)}" ${cat === current ? 'selected' : ''}>${escapeHtml(cat)}</option>`);
    // Категория удалена — показываем её честно, а не подставляем первую из списка
    if (current && !userCategories.includes(current)) {
        options.unshift(`<option value="${escapeHtml(current)}" selected disabled>${escapeHtml(current)} (удалена)</option>`);
    }
    return options.join('');
}

function renderAdjustments(receipt) {
    const adjustments = receipt.stored?.adjustments || [];
    if (adjustments.length === 0) return '';
    const currency = receipt.stored.currency || '';
    return `
        <div class="bg-amber-50/60 border border-amber-100 rounded-2xl p-3 text-[11px] text-slate-600 space-y-1">
            <p class="font-bold text-slate-700">Распределено по позициям:</p>
            ${adjustments.map(adj => `
                <div class="flex justify-between gap-2">
                    <span>${escapeHtml(ADJUSTMENT_LABELS[adj.type] || adj.type)} — ${escapeHtml(adj.name)}</span>
                    <span class="font-bold shrink-0">${adj.amount > 0 ? '+' : ''}${formatMoney(adj.amount)} ${escapeHtml(currency)}</span>
                </div>
            `).join('')}
        </div>
    `;
}

function parseAmountInput(id) {
    const raw = document.getElementById(id).value.replace(/\s/g, '').replace(',', '.');
    const n = Number(raw);
    return raw !== '' && Number.isFinite(n) ? n : null;
}

function getHistoryFilters() {
    return {
        query: document.getElementById('history-search').value,
        category: document.getElementById('history-category').value,
        minRub: parseAmountInput('history-min'),
        maxRub: parseAmountInput('history-max'),
    };
}

function hasActiveHistoryFilters(f) {
    return Boolean(f.query.trim() || f.category || f.minRub !== null || f.maxRub !== null);
}

window.onHistoryFilterChange = function() {
    historyLimit = HISTORY_PAGE_SIZE;
    renderList();
};

window.resetHistoryFilters = function() {
    ['history-search', 'history-category', 'history-min', 'history-max'].forEach(id => { document.getElementById(id).value = ''; });
    window.onHistoryFilterChange();
};

function renderHistoryCategoryOptions() {
    const select = document.getElementById('history-category');
    const current = select.value;
    select.innerHTML = `<option value="">Все категории</option>` +
        userCategories.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    select.value = userCategories.includes(current) ? current : '';
}

// Чеки за выбранный период с учётом поиска и фильтров — для списка и для экспорта
function getFilteredHistoryReceipts() {
    const filteredItems = filterItemsByPeriodGeneric(allItems, historyPeriod);
    return filterReceipts(groupItemsIntoReceipts(filteredItems), getHistoryFilters());
}

function renderList() {
    const listEl = document.getElementById('receipts-list');
    const countEl = document.getElementById('history-receipts-count');

    renderHistoryCategoryOptions();
    const filtersActive = hasActiveHistoryFilters(getHistoryFilters());
    document.getElementById('history-filters-reset').classList.toggle('hidden', !filtersActive);
    let receipts = getFilteredHistoryReceipts();

    // Номер чека — порядковый по времени добавления среди всех чеков, а не позиция в отфильтрованном списке
    const receiptNumbers = new Map(
        groupItemsIntoReceipts(allItems)
            .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || a.key.localeCompare(b.key))
            .map((r, idx) => [r.key, idx + 1])
    );

    receipts.sort((a, b) => {
        if (historySort === 'receiptDate') {
            const cmp = (b.receiptDate || '').localeCompare(a.receiptDate || '');
            if (cmp !== 0) return cmp;
            return (b.createdAt || '').localeCompare(a.createdAt || '');
        } else {
            return (b.createdAt || '').localeCompare(a.createdAt || '');
        }
    });

    countEl.innerText = `${receipts.length} чек(ов)`;
    const hiddenCount = Math.max(0, receipts.length - historyLimit);
    receipts = receipts.slice(0, historyLimit);

    if (receipts.length === 0) {
        listEl.innerHTML = `<div class="bg-white rounded-3xl p-8 text-center text-xs text-slate-400 border border-slate-200/70">${filtersActive ? 'Ничего не найдено — измените поиск или фильтры' : 'За выбранный период записей не найдено'}</div>`;
        return;
    }

    // Найденные позиции сразу видны: чек с совпадениями раскрывается
    const isExpanded = (receipt) => expandedReceipts.has(receipt.key) || receipt.matchedIds !== null && receipt.matchedIds !== undefined;

    listEl.innerHTML = receipts.map((receipt, index) => {
        const receiptNum = receiptNumbers.get(receipt.key);
        const totalRub = receipt.items.reduce((s, i) => s + (Number(i.priceRub) || 0), 0);
        const totalOriginal = receiptTotalInCurrency(receipt.items);
        const mismatch = totalOriginal && receipt.stored?.currency === totalOriginal.currency
            && isTotalMismatch(totalOriginal.amount, receipt.stored.total);
        const mainAmount = totalOriginal
            ? `${formatMoney(totalOriginal.amount)} ${escapeHtml(totalOriginal.currency)}`
            : `${formatMoney(totalRub)} ₽`;
        const subAmount = totalOriginal
            ? (totalOriginal.currency === 'RUB' ? '' : `${formatMoney(totalRub)} ₽`)
            : 'разные валюты';

        return `
            <div class="bg-white rounded-3xl p-4 border border-slate-200/70 shadow-sm">
                <div data-action="toggle-receipt" data-index="${index}" data-key="${escapeHtml(receipt.key)}" class="flex justify-between items-center cursor-pointer select-none gap-2">
                    <div class="flex items-center gap-3 min-w-0">
                        <span class="bg-indigo-50 text-indigo-600 text-xs font-extrabold px-2.5 py-1.5 rounded-xl shrink-0">#${receiptNum}</span>
                        <div class="min-w-0">
                            <p class="font-extrabold text-slate-900 text-sm truncate">${escapeHtml(receipt.shop)}</p>
                            <div class="flex items-center gap-2 mt-0.5 text-[11px] font-semibold text-slate-400">
                                <span><i class="fa-regular fa-calendar mr-1"></i>${escapeHtml(formatDateReadable(receipt.receiptDate))}</span>
                                <span>• ${receipt.items.length} поз.</span>
                                ${mismatch ? '<span class="text-amber-600" title="Сумма позиций не совпадает с итогом чека"><i class="fa-solid fa-triangle-exclamation"></i></span>' : ''}
                            </div>
                        </div>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <div class="text-right">
                            <p class="font-black text-slate-900 text-sm">${mainAmount}</p>
                            <p class="text-[11px] font-semibold text-slate-400">${subAmount}</p>
                        </div>
                        <button data-action="edit-receipt" data-key="${escapeHtml(receipt.key)}" class="w-8 h-8 rounded-xl bg-slate-100 hover:bg-indigo-50 text-slate-500 hover:text-indigo-600 flex items-center justify-center transition" title="Редактировать чек">
                            <i class="fa-solid fa-pen text-[11px]"></i>
                        </button>
                        <div class="w-6 flex justify-center">
                            <i class="fa-solid fa-chevron-down text-slate-400 text-xs transition-transform duration-200" id="icon-${index}" style="transform: rotate(${isExpanded(receipt) ? 180 : 0}deg)"></i>
                        </div>
                    </div>
                </div>

                <div id="receipt-body-${index}" class="${isExpanded(receipt) ? '' : 'hidden'} mt-3.5 pt-3 border-t border-slate-100 space-y-2">
                    ${mismatch ? `
                        <div class="bg-amber-50 border border-amber-200 text-amber-800 rounded-2xl p-3 text-[11px] font-semibold">
                            <i class="fa-solid fa-triangle-exclamation mr-1"></i>
                            Сумма позиций (${formatMoney(totalOriginal.amount)}) не совпадает с итогом чека (${formatMoney(receipt.stored.total)} ${escapeHtml(receipt.stored.currency)}). Возможно, ИИ пропустил или неверно прочитал позицию.
                        </div>` : ''}
                    ${receipt.items.map(item => `
                        <div class="flex items-center justify-between ${receipt.matchedIds?.has(item.id) ? 'bg-amber-50 border-amber-300' : 'bg-slate-50 border-slate-200/60'} p-3 rounded-2xl text-xs border">
                            <div class="flex-1 pr-2 min-w-0">
                                <p class="font-bold text-slate-800 break-words">${escapeHtml(item.name)} <span class="text-[11px] text-slate-400 font-normal">(${escapeHtml(item.originalName || item.name)})</span></p>
                                <div class="flex items-center flex-wrap gap-2 mt-2">
                                    <span class="font-extrabold text-slate-900">${formatMoney(item.originalPrice)} ${escapeHtml(item.currency)}</span>
                                    ${item.basePrice !== undefined && item.basePrice !== item.originalPrice ? `<span class="text-[11px] text-slate-400 line-through">${formatMoney(item.basePrice)}</span>` : ''}
                                    ${item.currency !== 'RUB' ? `<span class="text-[11px] text-slate-400">(${formatMoney(item.priceRub)} ₽)</span>` : ''}
                                    <select data-action="update-category" data-id="${escapeHtml(item.id)}" class="h-7 text-xs font-bold bg-white border border-slate-200 rounded-xl px-2.5 text-slate-700 focus:outline-none">
                                        ${categorySelectOptions(item.category)}
                                    </select>
                                </div>
                            </div>
                            <button data-action="delete-item" data-id="${escapeHtml(item.id)}" class="w-8 h-8 rounded-xl text-slate-400 hover:text-red-600 hover:bg-red-50 flex items-center justify-center shrink-0 transition">
                                <i class="fa-solid fa-trash-can text-xs"></i>
                            </button>
                        </div>
                    `).join('')}
                    ${renderAdjustments(receipt)}
                    ${receipt.items.some(i => i.ratePending)
                        ? `<p class="text-[10px] text-amber-600 text-right"><i class="fa-solid fa-clock mr-1"></i>Сумма в рублях пересчитается по курсу на дату чека при подключении к сети</p>`
                        : (receipt.items[0]?.rateDate ? `<p class="text-[10px] text-slate-400 text-right">Курс на ${escapeHtml(formatDateReadable(receipt.items[0].rateDate))}</p>` : '')}
                </div>
            </div>
        `;
    }).join('') + (hiddenCount > 0 ? `
        <button data-action="show-more" class="w-full h-11 bg-white hover:bg-slate-50 border border-slate-200/70 text-slate-600 rounded-2xl text-xs font-bold transition">
            Показать ещё (${hiddenCount})
        </button>` : '');
}

function toggleReceipt(index, key) {
    const bodyEl = document.getElementById(`receipt-body-${index}`);
    const iconEl = document.getElementById(`icon-${index}`);
    if (bodyEl.classList.contains('hidden')) {
        bodyEl.classList.remove('hidden');
        iconEl.style.transform = 'rotate(180deg)';
        expandedReceipts.add(key);
    } else {
        bodyEl.classList.add('hidden');
        iconEl.style.transform = 'rotate(0deg)';
        expandedReceipts.delete(key);
    }
}

function getReceiptItems(key) {
    return allItems.filter(item => (item.receiptId || `legacy:${legacyReceiptKey(item)}`) === key);
}

// Карандаш в истории открывает тот же редактор, что и проверка ответа ИИ
function openReceiptEditor(key) {
    const receiptItems = getReceiptItems(key);
    if (receiptItems.length === 0) return;
    const [receipt] = groupItemsIntoReceipts(receiptItems);
    openEditor(draftFromReceipt(receipt), userCategories);
}

async function updateCategory(id, newCat, selectEl) {
    const target = allItems.find(i => i.id === id);
    const ok = await runWrite(
        () => updateDoc(doc(db, `users/${currentUser.uid}/items`, id), { category: newCat }),
        'Не удалось изменить категорию'
    );
    if (!ok) {
        if (target) selectEl.value = target.category;
        return;
    }
    if (target) target.category = newCat;
    renderDashboard();
    renderCategories();
    showToast('Категория изменена');
}

async function deleteItem(id) {
    const item = allItems.find(i => i.id === id);
    if (!item) return;
    // Последняя позиция чека — удаляем и сам чек, чтобы не оставались пустые записи
    const isLastInReceipt = item.receiptId && allItems.filter(i => i.receiptId === item.receiptId).length === 1;
    const receipt = isLastInReceipt ? allReceipts.get(item.receiptId) : null;

    const batch = writeBatch(db);
    batch.delete(doc(db, `users/${currentUser.uid}/items`, id));
    if (receipt) batch.delete(doc(db, `users/${currentUser.uid}/receipts`, receipt.id));
    if (!await runWrite(() => batch.commit(), 'Не удалось удалить позицию')) return;

    allItems = allItems.filter(i => i.id !== id);
    if (receipt) allReceipts.delete(receipt.id);
    refreshAll();
    showToast(`«${item.name}» удалена`, 'info', {
        actionLabel: 'Отменить',
        onAction: () => restoreDeleted([item], receipt),
    });
}

// ==================== ИИ-ЧАТ ПО ТРАТАМ ====================
let chatHistory = [];
let chatBusy = false;

const CHAT_RULES = `Ты — помощник по личным финансам в приложении учёта расходов. Отвечай по-русски, коротко и по делу, простым текстом без таблиц и заголовков; списки — строками с «- », важные числа можно выделить **так**.
Опирайся только на данные ниже. Готовые итоги по месяцам и категориям уже посчитаны — используй их, а не пересчитывай вручную. Суммы называй в рублях, если пользователь не просит другую валюту. Если данных не хватает для ответа — честно скажи об этом.`;

function renderChat() {
    const log = document.getElementById('chat-log');
    log.innerHTML = chatHistory.map(msg => msg.role === 'user'
        ? `<div class="flex justify-end"><div class="max-w-[85%] bg-indigo-600 text-white text-xs font-semibold rounded-2xl rounded-br-md px-3.5 py-2.5">${escapeHtml(msg.label || msg.text)}</div></div>`
        : `<div class="flex"><div class="max-w-[92%] ${msg.error ? 'bg-red-50 text-red-700 border-red-100' : 'bg-slate-50 text-slate-800 border-slate-200/70'} border text-xs leading-relaxed rounded-2xl rounded-bl-md px-3.5 py-2.5">${renderAnswerHtml(msg.text, escapeHtml)}</div></div>`
    ).join('') + (chatBusy ? `<div class="flex"><div class="bg-slate-50 border border-slate-200/70 text-slate-400 text-xs rounded-2xl px-3.5 py-2.5"><i class="fa-solid fa-ellipsis fa-fade"></i> ИИ думает…</div></div>` : '');
    document.getElementById('chat-clear-btn').classList.toggle('hidden', chatHistory.length === 0);
    document.getElementById('chat-send-btn').disabled = chatBusy;
    document.getElementById('insights-btn').disabled = chatBusy;
}

// label — что показать в чате вместо полного текста запроса (для «Итогов месяца»)
async function askAi(text, label) {
    if (chatBusy) return;
    if (!navigator.onLine) {
        showToast('Нет интернета — ИИ недоступен', 'warning');
        return;
    }
    if (allItems.length === 0) {
        showToast('Пока нет трат, по которым можно что-то сказать', 'warning');
        return;
    }

    const userMessage = { role: 'user', text, label };
    chatHistory.push(userMessage);
    chatBusy = true;
    renderChat();

    const context = buildSpendingContext(allItems, getTodayDateStr());
    const payload = {
        systemInstruction: { parts: [{ text: `${CHAT_RULES}\n\n${context.text}` }] },
        // Роли должны чередоваться: неудачные вопросы и ошибки в историю для ИИ не попадают
        contents: chatHistory.filter(m => !m.error && !m.failed).map(m => ({ role: m.role, parts: [{ text: m.text }] })),
    };

    try {
        const data = await callGeminiWithModelFallback(payload, currentUserApiKey, {
            json: false,
            onSwitch: (from, to) => showToast(`${from.label} недоступна. Переключено на ${to.label}`, 'warning'),
        });
        const answer = getResponseText(data).trim();
        chatHistory.push({ role: 'model', text: answer || 'ИИ вернул пустой ответ. Попробуйте переформулировать вопрос.' });
    } catch (err) {
        userMessage.failed = true;
        chatHistory.push({ role: 'model', text: `Не удалось получить ответ: ${err.message}`, error: true });
    } finally {
        chatBusy = false;
        renderChat();
    }
}

window.sendChatMessage = function() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text || chatBusy) return;
    input.value = '';
    askAi(text);
};

window.requestMonthlyInsights = function() {
    const summary = buildMonthlySummary(allItems, getTodayDateStr());
    const prompt = `Подведи итоги текущего месяца по этим цифрам и дай 3–5 конкретных наблюдений и советов: что выросло или снизилось по сравнению с прошлым месяцем (учитывай, что текущий месяц ещё не закончился — сравнивай темп), на что уходит больше всего, какие траты выделяются. В конце — одна короткая рекомендация.

${monthlySummaryToText(summary)}`;
    askAi(prompt, 'Итоги месяца и советы');
};

window.clearChat = function() {
    if (chatBusy) return;
    chatHistory = [];
    renderChat();
};

// ==================== ЭКСПОРТ ====================
let exportScope = 'filtered';

function getExportItems() {
    if (exportScope === 'all') return allItems;
    return getFilteredHistoryReceipts().flatMap(r => r.matchedIds ? r.items.filter(i => r.matchedIds.has(i.id)) : r.items);
}

window.setExportScope = function(scope) {
    exportScope = scope;
    const active = "flex-1 h-8 text-xs font-bold rounded-lg bg-white text-slate-900 shadow-sm transition";
    const inactive = "flex-1 h-8 text-xs font-semibold rounded-lg text-slate-500 transition";
    document.getElementById('export-scope-filtered').className = scope === 'filtered' ? active : inactive;
    document.getElementById('export-scope-all').className = scope === 'all' ? active : inactive;
    document.getElementById('export-count').innerText = `Позиций в файле: ${getExportItems().length}`;
};

window.openExportModal = function() {
    setExportScope('filtered');
    document.getElementById('export-modal').classList.remove('hidden');
};

window.closeExportModal = function() {
    document.getElementById('export-modal').classList.add('hidden');
};

window.runExport = async function(format) {
    const items = getExportItems();
    if (items.length === 0) {
        showToast('Нет трат для экспорта', 'warning');
        return;
    }
    const rows = buildExportRows(items);
    const stamp = getTodayDateStr();
    const result = format === 'csv'
        ? await deliverFile(toCsv(rows), `countme-${stamp}.csv`, 'text/csv')
        : await deliverFile(toXlsx(rows), `countme-${stamp}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    if (result !== 'cancelled') {
        closeExportModal();
        showToast(`Экспортировано позиций: ${items.length}`);
    }
};

// ==================== ДЕЛЕГИРОВАНИЕ СОБЫТИЙ ДЛЯ ДИНАМИЧЕСКИХ СПИСКОВ ====================
// Данные передаются через data-атрибуты, а не через строки в onclick — так их нельзя «сломать» кавычками
document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action } = el.dataset;

    if (action === 'edit-category') {
        openCategoryModal(el.dataset.cat);
    } else if (action === 'toggle-filter') {
        toggleFilterChip(el.dataset.key);
    } else if (action === 'toggle-receipt') {
        toggleReceipt(el.dataset.index, el.dataset.key);
    } else if (action === 'edit-receipt') {
        openReceiptEditor(el.dataset.key);
    } else if (action === 'show-more') {
        historyLimit += HISTORY_PAGE_SIZE;
        renderList();
    } else if (action === 'delete-item') {
        deleteItem(el.dataset.id);
    }
});

document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-action="update-category"]');
    if (el) updateCategory(el.dataset.id, el.value, el);
});

// ==================== СЕТЬ ====================
function updateOnlineState() {
    document.getElementById('offline-banner').classList.toggle('hidden', navigator.onLine);
}

window.addEventListener('offline', updateOnlineState);
window.addEventListener('online', () => {
    updateOnlineState();
    queuedNoticeShown = false;
    if (currentUser) {
        showToast('Соединение восстановлено — синхронизируем изменения');
        fillPendingRates();
        runMigrationIfNeeded();
    }
});
updateOnlineState();

// ==================== ВОССТАНОВЛЕНИЕ НАСТРОЕК ИНТЕРФЕЙСА ====================
function applySavedPrefs() {
    [['receipt-currency', 'inputCurrency'], ['dashboard-currency', 'dashboardCurrency'], ['chart-type', 'chartType']].forEach(([id, key]) => {
        const select = document.getElementById(id);
        const saved = getPref(key, null);
        if (saved && [...select.options].some(o => o.value === saved)) select.value = saved;
        select.addEventListener('change', () => setPref(key, select.value));
    });
    setDashboardPeriod(dashboardPeriod);
    setDashboardMode(dashboardMode);
    setHistoryPeriod(historyPeriod);
    setHistorySort(historySort);
}

applySavedPrefs();
