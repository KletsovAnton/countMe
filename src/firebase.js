import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from 'firebase/firestore';

// Конфиг Firebase публичен по задумке; доступ к данным защищают правила firestore.rules
const firebaseConfig = {
    apiKey: "AIzaSyBtzjFba5Ho2jORrSi5GKvucaDNzCCAh5g",
    authDomain: "countme-a0e8a.firebaseapp.com",
    projectId: "countme-a0e8a",
    storageBucket: "countme-a0e8a.firebasestorage.app",
    messagingSenderId: "900011386839",
    appId: "1:900011386839:web:be2e211eaccfdee5d60d92",
    measurementId: "G-8D4V6HF347"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
// Локальный кэш в IndexedDB: приложение открывается без сети, а записи без сети
// ставятся в очередь и уходят на сервер при подключении
export const db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
