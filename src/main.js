import './style.css';
import Chart from 'chart.js/auto';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged } from 'firebase/auth';
import { collection, getDocs, deleteDoc, doc, updateDoc, getDoc, setDoc, query, orderBy, writeBatch } from 'firebase/firestore';

import { auth, db } from './firebase.js';
import { getTodayDateStr, escapeHtml, formatMoney, formatDateReadable, buildReceiptDateRules } from './utils.js';
import { getLatestRates, getRatesForDate, convertToRub, SUPPORTED_CURRENCIES } from './rates.js';
import { normalizeAiResult, receiptTotalInCurrency, isTotalMismatch, legacyReceiptKey, ADJUSTMENT_LABELS } from './receipts.js';
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

let pendingFile = null;
let pendingFileDataUrl = null;

let dashboardMode = 'category';
let dashboardPeriod = 'month';
let selectedFilterKeys = new Set();

let historyPeriod = 'all';
let historySort = 'receiptDate';

let lastAiJob = null;

let mediaRecorder = null;
let audioChunks = [];
let isRecordingVoiceExpense = false;

const CHART_COLORS = ['#4f46e5', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2', '#e11d48', '#2563eb', '#65a30d', '#475569'];

// Запись в Firestore с понятной ошибкой вместо молчаливого сбоя
async function runWrite(action, errorText) {
    try {
        await action();
        return true;
    } catch (err) {
        console.error(errorText, err);
        showToast(`${errorText}: ${err.message}`, 'error');
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
window.handleAuth = async function() {
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const errBox = document.getElementById('auth-error');
    errBox.classList.add('hidden');

    try {
        await signInWithEmailAndPassword(auth, email, password);
    } catch (e) {
        try {
            await createUserWithEmailAndPassword(auth, email, password);
        } catch (err) {
            errBox.innerText = err.message;
            errBox.classList.remove('hidden');
        }
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
            alert("Ошибка загрузки профиля: " + err.message);
            document.getElementById('auth-screen').classList.remove('hidden');
        }
    } else {
        document.getElementById('auth-screen').classList.remove('hidden');
        document.getElementById('apikey-screen').classList.add('hidden');
        document.getElementById('app-screen').classList.add('hidden');
        document.getElementById('bottom-nav').classList.add('hidden');
    }
});

window.saveUserApiKey = async function() {
    const keyInput = document.getElementById('user-gemini-key').value.trim();
    if (!keyInput) { alert('Введите ключ!'); return; }

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

async function executeAiJob(job) {
    lastAiJob = job;
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

        const todayStr = getTodayDateStr();
        const defaultShop = job.type === 'voice' ? "Голосовой ввод" : (job.type === 'text' ? "Текстовый ввод" : "Не указано");
        const { receipt, items } = normalizeAiResult(parsedData, {
            source: job.type,
            categories: userCategories,
            fallbackCurrency: job.selectedCurrency,
            todayStr,
            defaultShop,
        });

        if (items.length === 0) {
            throw new Error('ИИ не обнаружил ни одной финансовой позиции в запросе.');
        }

        // Курс на дату чека; без него ничего не сохраняем — иначе суммы в рублях будут неверными
        const { date: rateDate, rates } = await getRatesForDate(receipt.receiptDate, todayStr);
        const createdAt = new Date().toISOString();

        const batch = writeBatch(db);
        const receiptRef = doc(collection(db, `users/${currentUser.uid}/receipts`));
        const receiptObj = { ...receipt, createdAt };
        batch.set(receiptRef, receiptObj);

        const itemsColRef = collection(db, `users/${currentUser.uid}/items`);
        const newlyAddedItems = [];

        for (const item of items) {
            const newDocRef = doc(itemsColRef);
            const itemObj = {
                ...item,
                receiptId: receiptRef.id,
                priceRub: convertToRub(item.originalPrice, item.currency, rates),
                rate: rates[item.currency],
                rateDate,
                shop: receipt.shop,
                receiptDate: receipt.receiptDate,
                createdAt
            };

            batch.set(newDocRef, itemObj);
            newlyAddedItems.push({ id: newDocRef.id, ...itemObj });
        }

        await batch.commit();

        allReceipts.set(receiptRef.id, { id: receiptRef.id, ...receiptObj });
        allItems = [...newlyAddedItems, ...allItems];
        initFilters();
        renderDashboard();
        renderList();

        closeAiJobPanel();
        const mismatch = isTotalMismatch(receiptTotalInCurrency(newlyAddedItems)?.amount, receipt.total);
        showToast(`Добавлено позиций: ${newlyAddedItems.length} (${receipt.shop})`);
        if (mismatch) {
            showToast(`Сумма позиций не совпадает с итогом чека (${formatMoney(receipt.total)} ${receipt.currency}). Проверьте чек в истории.`, 'warning');
        }
    } catch (err) {
        showAiJobError(err.message || 'Сбой соединения или перегрузка сервера ИИ.');
    }
}

// ==================== ТЕКСТОВЫЙ ВВОД ====================
window.submitTextExpense = async function() {
    const inputEl = document.getElementById('text-expense-input');
    const userText = inputEl.value.trim();
    if (!userText) return;

    if (userCategories.length === 0) {
        alert('Сначала добавьте хотя бы одну категорию трат в разделе «Категории»!');
        return;
    }

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
        if (userCategories.length === 0) {
            alert('Сначала добавьте хотя бы одну категорию трат!');
            return;
        }
        try {
            await startAudioRecording();
            isRecordingVoiceExpense = true;
            btn.className = "w-[118px] h-11 bg-red-600 hover:bg-red-700 text-white rounded-2xl text-xs font-bold transition flex items-center justify-center gap-1.5 animate-pulse shrink-0 shadow-sm";
            iconEl.className = "fa-solid fa-stop";
            textSpan.innerText = 'Стоп';
        } catch (err) {
            alert('Не удалось получить доступ к микрофону: ' + err.message);
        }
    } else {
        isRecordingVoiceExpense = false;
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

window.handleFileSelected = function(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (userCategories.length === 0) {
        alert('Сначала добавьте хотя бы одну категорию трат в разделе «Категории»!');
        event.target.value = '';
        return;
    }

    pendingFile = file;
    const reader = new FileReader();
    reader.onload = function(e) {
        pendingFileDataUrl = e.target.result;
        document.getElementById('modal-img-preview').src = pendingFileDataUrl;
        document.getElementById('modal-prompt-note').value = '';
        document.getElementById('receipt-modal').classList.remove('hidden');
    };
    reader.readAsDataURL(file);
    event.target.value = '';
};

window.cancelReceiptUpload = function() {
    pendingFile = null;
    pendingFileDataUrl = null;
    document.getElementById('receipt-modal').classList.add('hidden');
};

window.confirmReceiptUpload = async function() {
    if (!pendingFile) return;
    const file = pendingFile;
    const previewUrl = pendingFileDataUrl;
    const userNote = document.getElementById('modal-prompt-note').value.trim();
    const selectedCurrency = document.getElementById('receipt-currency').value;

    document.getElementById('receipt-modal').classList.add('hidden');

    let base64, mimeType;
    try {
        ({ base64, mimeType } = await compressAndConvertToBase64(file));
    } catch (err) {
        showToast('Не удалось прочитать фото. Попробуйте другое изображение.', 'error');
        return;
    }
    const todayStr = getTodayDateStr();
    const currentYear = new Date().getFullYear();

    let prompt = `Сегодняшняя дата: ${todayStr} (текущий год — ${currentYear}).
Распознай чек. Строго соблюдай правила для даты (receiptDate):
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
                { inlineData: { mimeType: mimeType, data: base64 } }
            ]
        }]
    };

    pendingFile = null;
    pendingFileDataUrl = null;

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
    initFilters();
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
    initFilters();
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
async function loadData() {
    try {
        const catDoc = await getDoc(doc(db, `users/${currentUser.uid}/settings`, 'categories'));
        if (catDoc.exists() && catDoc.data().list) {
            userCategories = catDoc.data().list;
        } else {
            userCategories = ['Еда и супермаркеты', 'Кафе и рестораны', 'Транспорт', 'Жилье и быт', 'Развлечения'];
            await saveCategories(userCategories);
        }
        const q = query(collection(db, `users/${currentUser.uid}/items`), orderBy('createdAt', 'desc'));
        const [itemsSnapshot, receiptsSnapshot] = await Promise.all([
            getDocs(q),
            getDocs(collection(db, `users/${currentUser.uid}/receipts`)),
        ]);
        allItems = itemsSnapshot.docs.map(docSnap => ({ id: docSnap.id, ...docSnap.data() }));
        allReceipts = new Map(receiptsSnapshot.docs.map(docSnap => [docSnap.id, { id: docSnap.id, ...docSnap.data() }]));
    } catch (err) {
        console.error('Ошибка загрузки данных', err);
        showToast(`Не удалось загрузить данные: ${err.message}`, 'error');
    }

    await runMigrationIfNeeded();

    renderCategories();
    initFilters();
    renderDashboard();
    renderList();
}

// Однократный перевод старых записей на схему с отдельными чеками (с резервной копией)
async function runMigrationIfNeeded() {
    try {
        if (await getSchemaVersion(currentUser.uid) >= SCHEMA_VERSION) return;
        const hasLegacy = allItems.some(item => !item.receiptId);
        if (hasLegacy) showToast('Обновляем формат данных… Не закрывайте приложение', 'model');

        await migrateToV2(currentUser.uid, allItems, getTodayDateStr());

        if (hasLegacy) {
            const receiptsSnapshot = await getDocs(collection(db, `users/${currentUser.uid}/receipts`));
            allReceipts = new Map(receiptsSnapshot.docs.map(docSnap => [docSnap.id, { id: docSnap.id, ...docSnap.data() }]));
            showToast('Данные обновлены: суммы пересчитаны по курсу на дату чека, резервная копия сохранена');
        }
    } catch (err) {
        console.error('Ошибка миграции', err);
        showToast(`Не удалось обновить формат данных, попробуем при следующем входе: ${err.message}`, 'warning');
    }
}

// ==================== ДАШБОРД И ФИЛЬТРЫ ====================
window.setDashboardPeriod = function(period) {
    dashboardPeriod = period;
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
    const btnCat = document.getElementById('tab-mode-category');
    const btnShop = document.getElementById('tab-mode-shop');

    if (mode === 'category') {
        btnCat.className = "flex-1 h-7 text-xs font-bold rounded-lg bg-white text-slate-900 shadow-sm transition";
        btnShop.className = "flex-1 h-7 text-xs font-semibold rounded-lg text-slate-500 transition";
    } else {
        btnShop.className = "flex-1 h-7 text-xs font-bold rounded-lg bg-white text-slate-900 shadow-sm transition";
        btnCat.className = "flex-1 h-7 text-xs font-semibold rounded-lg text-slate-500 transition";
    }
    initFilters();
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

function initFilters() {
    const keys = getAvailableFilterKeys();
    selectedFilterKeys = new Set(keys);
    renderFilterChips();
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
    if (selectedFilterKeys.has(key)) {
        selectedFilterKeys.delete(key);
    } else {
        selectedFilterKeys.add(key);
    }
    renderFilterChips();
    renderDashboard();
}

window.toggleAllFilters = function(selectAll) {
    const keys = getAvailableFilterKeys();
    selectedFilterKeys = selectAll ? new Set(keys) : new Set();
    renderFilterChips();
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
    const amountInTarget = (item) => item.currency === targetCurrency
        ? (Number(item.originalPrice) || 0)
        : (Number(item.priceRub) || 0) * rubToTargetRate;

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

function renderList() {
    const listEl = document.getElementById('receipts-list');
    const countEl = document.getElementById('history-receipts-count');

    const filteredItems = filterItemsByPeriodGeneric(allItems, historyPeriod);
    let receipts = groupItemsIntoReceipts(filteredItems);

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

    if (receipts.length === 0) {
        listEl.innerHTML = `<div class="bg-white rounded-3xl p-8 text-center text-xs text-slate-400 border border-slate-200/70">За выбранный период записей не найдено</div>`;
        return;
    }

    listEl.innerHTML = receipts.map((receipt, index) => {
        const receiptNum = receipts.length - index;
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
                <div data-action="toggle-receipt" data-index="${index}" class="flex justify-between items-center cursor-pointer select-none gap-2">
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
                        <button data-action="edit-receipt" data-key="${escapeHtml(receipt.key)}" class="w-8 h-8 rounded-xl bg-slate-100 hover:bg-indigo-50 text-slate-500 hover:text-indigo-600 flex items-center justify-center transition" title="Изменить магазин или дату">
                            <i class="fa-solid fa-pen text-[11px]"></i>
                        </button>
                        <div class="w-6 flex justify-center">
                            <i class="fa-solid fa-chevron-down text-slate-400 text-xs transition-transform duration-200" id="icon-${index}"></i>
                        </div>
                    </div>
                </div>

                <div id="receipt-body-${index}" class="hidden mt-3.5 pt-3 border-t border-slate-100 space-y-2">
                    ${mismatch ? `
                        <div class="bg-amber-50 border border-amber-200 text-amber-800 rounded-2xl p-3 text-[11px] font-semibold">
                            <i class="fa-solid fa-triangle-exclamation mr-1"></i>
                            Сумма позиций (${formatMoney(totalOriginal.amount)}) не совпадает с итогом чека (${formatMoney(receipt.stored.total)} ${escapeHtml(receipt.stored.currency)}). Возможно, ИИ пропустил или неверно прочитал позицию.
                        </div>` : ''}
                    ${receipt.items.map(item => `
                        <div class="flex items-center justify-between bg-slate-50 p-3 rounded-2xl text-xs border border-slate-200/60">
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
                    ${receipt.items[0]?.rateDate ? `<p class="text-[10px] text-slate-400 text-right">Курс на ${escapeHtml(formatDateReadable(receipt.items[0].rateDate))}</p>` : ''}
                </div>
            </div>
        `;
    }).join('');
}

function toggleReceipt(index) {
    const bodyEl = document.getElementById(`receipt-body-${index}`);
    const iconEl = document.getElementById(`icon-${index}`);
    if (bodyEl.classList.contains('hidden')) {
        bodyEl.classList.remove('hidden');
        iconEl.style.transform = 'rotate(180deg)';
    } else {
        bodyEl.classList.add('hidden');
        iconEl.style.transform = 'rotate(0deg)';
    }
}

function getReceiptItems(key) {
    return allItems.filter(item => (item.receiptId || `legacy:${legacyReceiptKey(item)}`) === key);
}

// Модальное окно редактирования метаданных чека
function openEditReceiptModal(key) {
    const receiptItems = getReceiptItems(key);
    if (receiptItems.length === 0) return;
    const [receipt] = groupItemsIntoReceipts(receiptItems);
    document.getElementById('edit-receipt-key').value = key;
    document.getElementById('edit-receipt-shop').value = receipt.shop;
    document.getElementById('edit-receipt-date').value = receipt.receiptDate;
    document.getElementById('edit-receipt-modal').classList.remove('hidden');
}

window.closeEditReceiptModal = function() {
    document.getElementById('edit-receipt-modal').classList.add('hidden');
};

window.saveReceiptMetadata = async function() {
    const key = document.getElementById('edit-receipt-key').value;
    const newShop = document.getElementById('edit-receipt-shop').value.trim() || "Не указано";
    const newDate = document.getElementById('edit-receipt-date').value;
    if (!newDate) return;

    const targetItems = getReceiptItems(key);
    if (targetItems.length === 0) return;
    const receiptId = targetItems[0].receiptId;
    const dateChanged = targetItems[0].receiptDate !== newDate;

    // Правка магазина не трогает суммы; при исправлении даты берётся курс на новую дату чека
    let rateInfo = null;
    if (dateChanged) {
        try {
            rateInfo = await getRatesForDate(newDate, getTodayDateStr());
        } catch (err) {
            showToast(err.message, 'error');
            return;
        }
    }

    const itemUpdates = new Map();
    try {
        for (const item of targetItems) {
            const fields = { shop: newShop, receiptDate: newDate };
            if (rateInfo) {
                fields.priceRub = convertToRub(Number(item.originalPrice) || 0, item.currency, rateInfo.rates);
                fields.rate = rateInfo.rates[item.currency];
                fields.rateDate = rateInfo.date;
            }
            itemUpdates.set(item, fields);
        }
    } catch (err) {
        showToast(err.message, 'error');
        return;
    }

    const batch = writeBatch(db);
    for (const [item, fields] of itemUpdates) {
        batch.update(doc(db, `users/${currentUser.uid}/items`, item.id), fields);
    }
    if (receiptId && allReceipts.has(receiptId)) {
        batch.update(doc(db, `users/${currentUser.uid}/receipts`, receiptId), { shop: newShop, receiptDate: newDate });
    }

    if (!await runWrite(() => batch.commit(), 'Не удалось обновить чек')) return;

    for (const [item, fields] of itemUpdates) Object.assign(item, fields);
    if (receiptId && allReceipts.has(receiptId)) {
        Object.assign(allReceipts.get(receiptId), { shop: newShop, receiptDate: newDate });
    }
    closeEditReceiptModal();
    initFilters();
    renderDashboard();
    renderList();
    showToast(dateChanged ? 'Чек обновлён, суммы пересчитаны по курсу на новую дату' : 'Данные чека обновлены');
};

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

    const batch = writeBatch(db);
    batch.delete(doc(db, `users/${currentUser.uid}/items`, id));
    if (isLastInReceipt && allReceipts.has(item.receiptId)) {
        batch.delete(doc(db, `users/${currentUser.uid}/receipts`, item.receiptId));
    }
    if (!await runWrite(() => batch.commit(), 'Не удалось удалить позицию')) return;

    allItems = allItems.filter(i => i.id !== id);
    if (isLastInReceipt) allReceipts.delete(item.receiptId);
    initFilters();
    renderDashboard();
    renderList();
    renderCategories();
    showToast('Позиция удалена');
}

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
        toggleReceipt(el.dataset.index);
    } else if (action === 'edit-receipt') {
        openEditReceiptModal(el.dataset.key);
    } else if (action === 'delete-item') {
        deleteItem(el.dataset.id);
    }
});

document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-action="update-category"]');
    if (el) updateCategory(el.dataset.id, el.value, el);
});
