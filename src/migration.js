import { collection, doc, getDoc, setDoc, writeBatch } from 'firebase/firestore';
import { db } from './firebase.js';
import { getRatesForDate, convertToRub } from './rates.js';
import { legacyReceiptKey, legacyReceiptId, receiptTotalInCurrency } from './receipts.js';

// ==================== МИГРАЦИЯ ДАННЫХ НА СХЕМУ v2 ====================
// v1: только позиции (items), чек «собирался» из createdAt + магазин, сумма в рублях — по курсу на день ввода.
// v2: отдельные документы чеков (receipts), у позиций receiptId и курс на дату чека.

export const SCHEMA_VERSION = 2;
const BATCH_LIMIT = 450;
const BACKUP_CHUNK = 300;

async function commitInChunks(operations) {
    for (let i = 0; i < operations.length; i += BATCH_LIMIT) {
        const batch = writeBatch(db);
        operations.slice(i, i + BATCH_LIMIT).forEach(op => op(batch));
        await batch.commit();
    }
}

// Резервная копия всех позиций до любых изменений: users/{uid}/backups/{время}_{часть}
async function backupItems(uid, items) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const ops = [];
    for (let i = 0; i < items.length; i += BACKUP_CHUNK) {
        const part = i / BACKUP_CHUNK;
        const ref = doc(db, `users/${uid}/backups`, `${stamp}_${part}`);
        const chunk = items.slice(i, i + BACKUP_CHUNK);
        ops.push(batch => batch.set(ref, { createdAt: new Date().toISOString(), schemaVersion: 1, part, items: chunk }));
    }
    await commitInChunks(ops);
}

export async function getSchemaVersion(uid) {
    const metaDoc = await getDoc(doc(db, `users/${uid}/settings`, 'meta'));
    return metaDoc.exists() ? (metaDoc.data().schemaVersion || 1) : 1;
}

// Возвращает число созданных чеков. При ошибке ничего не помечает — миграция повторится при следующем входе
export async function migrateToV2(uid, items, todayStr) {
    const legacy = items.filter(item => !item.receiptId);
    if (legacy.length > 0) {
        await backupItems(uid, items);
    }

    const groups = new Map();
    for (const item of legacy) {
        const key = legacyReceiptKey(item);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }

    const ops = [];
    const updates = [];
    for (const [key, groupItems] of groups) {
        const first = groupItems[0];
        const receiptId = legacyReceiptId(key);
        const receiptDate = first.receiptDate || (first.createdAt || '').split('T')[0] || todayStr;
        const { date: rateDate, rates } = await getRatesForDate(receiptDate, todayStr);

        const total = receiptTotalInCurrency(groupItems);
        const receipt = {
            shop: first.shop || 'Не указано',
            receiptDate,
            createdAt: first.createdAt || new Date().toISOString(),
            currency: total ? total.currency : null,
            subtotal: null,
            adjustments: [],
            total: total ? total.amount : null,
            source: 'legacy',
        };
        ops.push(batch => batch.set(doc(db, `users/${uid}/receipts`, receiptId), receipt));

        for (const item of groupItems) {
            const currency = item.currency || 'RUB';
            const fields = {
                receiptId,
                currency,
                rate: rates[currency] || 1,
                rateDate,
                priceRub: convertToRub(Number(item.originalPrice) || 0, currency, rates),
            };
            ops.push(batch => batch.update(doc(collection(db, `users/${uid}/items`), item.id), fields));
            updates.push([item, fields]);
        }
    }

    await commitInChunks(ops);
    await setDoc(doc(db, `users/${uid}/settings`, 'meta'), { schemaVersion: SCHEMA_VERSION, migratedAt: new Date().toISOString() }, { merge: true });

    // Локальные объекты обновляем только после успешной записи
    for (const [item, fields] of updates) Object.assign(item, fields);
    return groups.size;
}
