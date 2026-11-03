import './style.css';
import Chart from 'chart.js/auto';
import { signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged } from 'firebase/auth';
import { collection, getDocs, deleteDoc, doc, updateDoc, getDoc, setDoc, query, orderBy, writeBatch } from 'firebase/firestore';

import { auth, db } from './firebase.js';
import { getTodayDateStr, escapeHtml, formatMoney, formatDateReadable, buildReceiptDateRules } from './utils.js';
import { getLatestRates, convertToRub } from './rates.js';
import { getCurrentModel, setAndSaveModelIndex, setOnModelChange, callGeminiWithModelFallback, extractJsonObject, getResponseText, GEMINI_MODELS } from './gemini.js';
import { showToast } from './toast.js';

// Глобальное состояние
let currentUser = null;
let currentUserApiKey = "";
let chartInstance = null;
let allItems = [];
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
        const shopName = parsedData.shopName || defaultShop;
        const receiptDate = parsedData.receiptDate || todayStr;
        const items = parsedData.items || [];
        const createdAt = new Date().toISOString();

        if (items.length === 0) {
            throw new Error('ИИ не обнаружил ни одной финансовой позиции в запросе.');
        }

        // Без курса валют ничего не сохраняем — иначе суммы в рублях будут неверными
        const rates = await getLatestRates();

        const batch = writeBatch(db);
        const itemsColRef = collection(db, `users/${currentUser.uid}/items`);
        const newlyAddedItems = [];

        for (let item of items) {
            const originalPrice = Number(item.price) || 0;
            const currency = job.type === 'receipt' ? job.selectedCurrency : (item.currency || job.selectedCurrency || 'THB');
            const priceInRub = convertToRub(originalPrice, currency, rates);

            const newDocRef = doc(itemsColRef);
            const itemObj = {
                name: item.name || item.originalName,
                originalName: item.originalName || item.name,
                originalPrice: originalPrice,
                currency: currency,
                priceRub: priceInRub,
                category: userCategories.includes(item.category) ? item.category : userCategories[0],
                shop: shopName,
                receiptDate: receiptDate,
                createdAt: createdAt
            };

            batch.set(newDocRef, itemObj);
            newlyAddedItems.push({ id: newDocRef.id, ...itemObj });
        }

        await batch.commit();

        allItems = [...newlyAddedItems, ...allItems];
        initFilters();
        renderDashboard();
        renderList();

        closeAiJobPanel();
        showToast(`Добавлено позиций: ${newlyAddedItems.length} (${shopName})`);
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
Для каждого товара укажи:
1. originalName: название с чека на исходном языке.
2. name: понятный перевод на русский язык.
3. price: итоговая цена позиции (число).
4. category: строго одна из категорий: ${JSON.stringify(userCategories)}.`;

    if (userNote) {
        prompt += `\n\nВАЖНОЕ УКАЗАНИЕ ПОЛЬЗОВАТЕЛЯ: "${userNote}". Обязательно учти при разборе!`;
    }

    prompt += `\n\nВерни ответ ТОЛЬКО в формате валидного JSON-объекта:
{
  "shopName": "Название магазина",
  "receiptDate": "YYYY-MM-DD",
  "items": [
    {"originalName": "...", "name": "...", "price": 45.00, "category": "${userCategories[0]}"}
  ]
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

async function deleteCategory(catName) {
    if (userCategories.length <= 1) {
        alert('Должна остаться хотя бы одна категория');
        return;
    }
    const nextList = userCategories.filter(c => c !== catName);
    if (!await runWrite(() => saveCategories(nextList), 'Не удалось удалить категорию')) return;

    userCategories = nextList;
    renderCategories();
    initFilters();
    renderList();
}

function renderCategories() {
    const container = document.getElementById('categories-container');
    if (userCategories.length === 0) {
        container.innerHTML = `<p class="text-xs text-slate-400">Список пуст. Добавьте свою первую категорию выше.</p>`;
        return;
    }
    container.innerHTML = userCategories.map(cat => `
        <span class="inline-flex items-center gap-2 bg-slate-100 text-slate-800 text-xs px-3.5 py-2 rounded-2xl font-bold">
            <span>${escapeHtml(cat)}</span>
            <button data-action="delete-category" data-cat="${escapeHtml(cat)}" class="w-5 h-5 rounded-full bg-slate-200/80 text-slate-500 hover:bg-red-100 hover:text-red-600 flex items-center justify-center transition">
                <i class="fa-solid fa-xmark text-[10px]"></i>
            </button>
        </span>
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
        renderCategories();

        const q = query(collection(db, `users/${currentUser.uid}/items`), orderBy('createdAt', 'desc'));
        const querySnapshot = await getDocs(q);
        allItems = [];
        querySnapshot.forEach((docSnap) => {
            allItems.push({ id: docSnap.id, ...docSnap.data() });
        });
    } catch (err) {
        console.error('Ошибка загрузки данных', err);
        showToast(`Не удалось загрузить данные: ${err.message}`, 'error');
    }

    initFilters();
    renderDashboard();
    renderList();
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
            const rates = await getLatestRates();
            if (!rates[targetCurrency]) throw new Error(`нет курса ${targetCurrency}`);
            rubToTargetRate = rates[targetCurrency];
        } catch (err) {
            showToast('Курсы валют недоступны — суммы показаны в RUB', 'warning');
            targetCurrency = 'RUB';
            currencySelect.value = 'RUB';
        }
    }

    const filteredItems = filteredByPeriod.filter(item => {
        const key = dashboardMode === 'category'
            ? (userCategories.includes(item.category) ? item.category : 'Другое')
            : (item.shop || 'Не указано');
        return selectedFilterKeys.has(key);
    });

    let totalInTarget = filteredItems.reduce((sum, item) => {
        const priceRub = Number(item.priceRub) || 0;
        return sum + (priceRub * rubToTargetRate);
    }, 0);

    document.getElementById('total-sum').innerText = `${formatMoney(totalInTarget)} ${targetCurrency}`;
    document.getElementById('total-count-badge').innerText = `Операций: ${filteredItems.length}`;

    let statsData = {};
    filteredItems.forEach(item => {
        const key = dashboardMode === 'category'
            ? (userCategories.includes(item.category) ? item.category : 'Другое')
            : (item.shop || 'Не указано');
        const priceInTarget = (Number(item.priceRub) || 0) * rubToTargetRate;
        statsData[key] = (statsData[key] || 0) + priceInTarget;
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

            const priceInTarget = (Number(item.priceRub) || 0) * rubToTargetRate;
            timeGrouped[groupKey] = (timeGrouped[groupKey] || 0) + priceInTarget;
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

function groupItemsIntoReceipts(items) {
    let receiptsMap = {};
    items.forEach(item => {
        const groupKey = `${item.createdAt || item.receiptDate}_${item.shop || 'Не указано'}`;
        if (!receiptsMap[groupKey]) {
            receiptsMap[groupKey] = {
                receiptDate: item.receiptDate,
                shop: item.shop || 'Не указано',
                createdAt: item.createdAt || '',
                items: []
            };
        }
        receiptsMap[groupKey].items.push(item);
    });
    return Object.values(receiptsMap);
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
        const currency = receipt.items[0] ? receipt.items[0].currency : 'RUB';
        const totalOriginal = receipt.items.reduce((s, i) => s + (Number(i.originalPrice) || 0), 0);

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
                            </div>
                        </div>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <div class="text-right">
                            <p class="font-black text-slate-900 text-sm">${formatMoney(totalOriginal)} ${escapeHtml(currency)}</p>
                            <p class="text-[11px] font-semibold text-slate-400">${formatMoney(totalRub)} ₽</p>
                        </div>
                        <button data-action="edit-receipt" data-created-at="${escapeHtml(receipt.createdAt)}" data-shop="${escapeHtml(receipt.shop)}" data-date="${escapeHtml(receipt.receiptDate)}" class="w-8 h-8 rounded-xl bg-slate-100 hover:bg-indigo-50 text-slate-500 hover:text-indigo-600 flex items-center justify-center transition" title="Изменить магазин или дату">
                            <i class="fa-solid fa-pen text-[11px]"></i>
                        </button>
                        <div class="w-6 flex justify-center">
                            <i class="fa-solid fa-chevron-down text-slate-400 text-xs transition-transform duration-200" id="icon-${index}"></i>
                        </div>
                    </div>
                </div>

                <div id="receipt-body-${index}" class="hidden mt-3.5 pt-3 border-t border-slate-100 space-y-2">
                    ${receipt.items.map(item => `
                        <div class="flex items-center justify-between bg-slate-50 p-3 rounded-2xl text-xs border border-slate-200/60">
                            <div class="flex-1 pr-2 min-w-0">
                                <p class="font-bold text-slate-800 break-words">${escapeHtml(item.name)} <span class="text-[11px] text-slate-400 font-normal">(${escapeHtml(item.originalName || item.name)})</span></p>
                                <div class="flex items-center flex-wrap gap-2 mt-2">
                                    <span class="font-extrabold text-slate-900">${formatMoney(item.originalPrice)} ${escapeHtml(item.currency)}</span>
                                    <span class="text-[11px] text-slate-400">(${formatMoney(item.priceRub)} ₽)</span>
                                    <select data-action="update-category" data-id="${escapeHtml(item.id)}" class="h-7 text-xs font-bold bg-white border border-slate-200 rounded-xl px-2.5 text-slate-700 focus:outline-none">
                                        ${userCategories.map(cat => `<option value="${escapeHtml(cat)}" ${cat === item.category ? 'selected' : ''}>${escapeHtml(cat)}</option>`).join('')}
                                    </select>
                                </div>
                            </div>
                            <button data-action="delete-item" data-id="${escapeHtml(item.id)}" class="w-8 h-8 rounded-xl text-slate-400 hover:text-red-600 hover:bg-red-50 flex items-center justify-center shrink-0 transition">
                                <i class="fa-solid fa-trash-can text-xs"></i>
                            </button>
                        </div>
                    `).join('')}
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

// Модальное окно редактирования метаданных чека
function openEditReceiptModal(createdAt, currentShop, currentDate) {
    document.getElementById('edit-receipt-created-at').value = createdAt;
    document.getElementById('edit-receipt-shop').value = currentShop;
    document.getElementById('edit-receipt-date').value = currentDate;
    document.getElementById('edit-receipt-modal').classList.remove('hidden');
}

window.closeEditReceiptModal = function() {
    document.getElementById('edit-receipt-modal').classList.add('hidden');
};

window.saveReceiptMetadata = async function() {
    const createdAt = document.getElementById('edit-receipt-created-at').value;
    const newShop = document.getElementById('edit-receipt-shop').value.trim() || "Не указано";
    const newDate = document.getElementById('edit-receipt-date').value;
    if (!newDate) return;

    const targetItems = allItems.filter(item => item.createdAt === createdAt);
    const batch = writeBatch(db);

    // Суммы не пересчитываются: правка магазина или даты не должна менять расходы
    for (let item of targetItems) {
        batch.update(doc(db, `users/${currentUser.uid}/items`, item.id), {
            shop: newShop,
            receiptDate: newDate
        });
    }

    if (!await runWrite(() => batch.commit(), 'Не удалось обновить чек')) return;

    for (let item of targetItems) {
        item.shop = newShop;
        item.receiptDate = newDate;
    }
    closeEditReceiptModal();
    initFilters();
    renderDashboard();
    renderList();
    showToast('Данные чека обновлены');
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
    showToast('Категория изменена');
}

async function deleteItem(id) {
    if (!await runWrite(() => deleteDoc(doc(db, `users/${currentUser.uid}/items`, id)), 'Не удалось удалить позицию')) return;
    allItems = allItems.filter(i => i.id !== id);
    initFilters();
    renderDashboard();
    renderList();
    showToast('Позиция удалена');
}

// ==================== ДЕЛЕГИРОВАНИЕ СОБЫТИЙ ДЛЯ ДИНАМИЧЕСКИХ СПИСКОВ ====================
// Данные передаются через data-атрибуты, а не через строки в onclick — так их нельзя «сломать» кавычками
document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action } = el.dataset;

    if (action === 'delete-category') {
        deleteCategory(el.dataset.cat);
    } else if (action === 'toggle-filter') {
        toggleFilterChip(el.dataset.key);
    } else if (action === 'toggle-receipt') {
        toggleReceipt(el.dataset.index);
    } else if (action === 'edit-receipt') {
        e.stopPropagation();
        openEditReceiptModal(el.dataset.createdAt, el.dataset.shop, el.dataset.date);
    } else if (action === 'delete-item') {
        deleteItem(el.dataset.id);
    }
});

document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-action="update-category"]');
    if (el) updateCategory(el.dataset.id, el.value, el);
});
