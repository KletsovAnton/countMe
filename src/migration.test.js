import { describe, it, expect, vi, beforeEach } from 'vitest';

// Простая имитация Firestore: пути документов и журнал записей по батчам
const store = { writes: [], commits: [], meta: null, failOnCommit: false };

vi.mock('./firebase.js', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({
    collection: (_db, path) => ({ path }),
    doc: (parent, path, id) => {
        if (typeof parent === 'object' && parent.path && path === undefined) return { path: `${parent.path}/auto` };
        if (typeof parent === 'object' && parent.path) return { path: `${parent.path}/${path}` };
        return { path: id ? `${path}/${id}` : path };
    },
    getDoc: async () => ({ exists: () => !!store.meta, data: () => store.meta }),
    setDoc: async (ref, data) => { store.writes.push({ type: 'set', path: ref.path, data }); store.meta = data; },
    writeBatch: () => {
        const ops = [];
        return {
            set: (ref, data) => ops.push({ type: 'set', path: ref.path, data }),
            update: (ref, data) => ops.push({ type: 'update', path: ref.path, data }),
            commit: async () => {
                if (store.failOnCommit) throw new Error('network');
                store.commits.push(ops.length);
                store.writes.push(...ops);
            },
        };
    },
}));
vi.mock('./rates.js', async (importOriginal) => {
    const real = await importOriginal();
    return {
        ...real,
        // THB: 0.4 за рубль в марте, 0.5 в октябре — суммы должны браться по дате чека
        getRatesForDate: async (date) => ({ date, rates: { RUB: 1, THB: date.startsWith('2026-03') ? 0.4 : 0.5 } }),
    };
});

const { migrateToV2, getSchemaVersion } = await import('./migration.js');

function legacyItems() {
    return [
        { id: 'a', name: 'Кофе', originalPrice: 80, currency: 'THB', priceRub: 999, shop: '7-Eleven', receiptDate: '2026-03-10', createdAt: '2026-03-10T08:00:00.000Z' },
        { id: 'b', name: 'Круассан', originalPrice: 40, currency: 'THB', priceRub: 999, shop: '7-Eleven', receiptDate: '2026-03-10', createdAt: '2026-03-10T08:00:00.000Z' },
        { id: 'c', name: 'Такси', originalPrice: 100, currency: 'THB', priceRub: 999, shop: 'Grab', receiptDate: '2026-10-01', createdAt: '2026-10-01T09:00:00.000Z' },
        { id: 'd', name: 'Хлеб', originalPrice: 60, currency: 'RUB', priceRub: 60, shop: 'Пятёрочка', receiptDate: '2026-10-02', createdAt: '2026-10-02T09:00:00.000Z', receiptId: 'already' },
    ];
}

describe('migrateToV2', () => {
    beforeEach(() => {
        store.writes = [];
        store.commits = [];
        store.meta = null;
        store.failOnCommit = false;
    });

    it('backs up every item before changing anything', async () => {
        await migrateToV2('u1', legacyItems(), '2026-11-04');
        const firstWrite = store.writes[0];
        expect(firstWrite.path).toMatch(/^users\/u1\/backups\//);
        expect(firstWrite.data.items).toHaveLength(4);
    });

    it('creates one receipt per legacy group and links items to it', async () => {
        const items = legacyItems();
        const created = await migrateToV2('u1', items, '2026-11-04');
        expect(created).toBe(2);

        const receipts = store.writes.filter(w => w.path.startsWith('users/u1/receipts/'));
        expect(receipts).toHaveLength(2);
        const eleven = receipts.find(r => r.data.shop === '7-Eleven');
        expect(eleven.data).toMatchObject({ currency: 'THB', total: 120, receiptDate: '2026-03-10', source: 'legacy' });

        expect(items[0].receiptId).toBe(items[1].receiptId);
        expect(items[0].receiptId).not.toBe(items[2].receiptId);
        expect(items[3].receiptId).toBe('already');
    });

    it('recalculates RUB amounts with the rate on the receipt date', async () => {
        const items = legacyItems();
        await migrateToV2('u1', items, '2026-11-04');
        expect(items[0].priceRub).toBeCloseTo(200); // 80 THB / 0.4
        expect(items[2].priceRub).toBeCloseTo(200); // 100 THB / 0.5
        expect(items[0].rateDate).toBe('2026-03-10');
        expect(items[3].priceRub).toBe(60); // уже мигрированная запись не трогается
    });

    it('marks the schema version only after all writes succeed', async () => {
        await migrateToV2('u1', legacyItems(), '2026-11-04');
        expect(await getSchemaVersion('u1')).toBe(2);
    });

    it('leaves local data and schema version untouched when a write fails', async () => {
        const items = legacyItems();
        store.failOnCommit = true;
        await expect(migrateToV2('u1', items, '2026-11-04')).rejects.toThrow('network');
        expect(items[0].receiptId).toBeUndefined();
        expect(items[0].priceRub).toBe(999);
        expect(await getSchemaVersion('u1')).toBe(1);
    });

    it('splits large histories into batches under the Firestore limit', async () => {
        const many = Array.from({ length: 700 }, (_, i) => ({
            id: `i${i}`, name: 'x', originalPrice: 10, currency: 'THB', shop: `S${i % 50}`,
            receiptDate: '2026-10-01', createdAt: `2026-10-01T00:00:${String(i % 50).padStart(2, '0')}.000Z`,
        }));
        await migrateToV2('u1', many, '2026-11-04');
        expect(Math.max(...store.commits)).toBeLessThanOrEqual(450);
        expect(store.writes.filter(w => w.type === 'update')).toHaveLength(700);
    });
});
