// Всплывающие уведомления; закрываются свайпом вверх или по таймеру
const TOAST_STYLES = {
    info: { bg: 'bg-slate-900 text-white', icon: 'fa-circle-check text-emerald-400' },
    warning: { bg: 'bg-amber-500 text-white', icon: 'fa-bolt text-white' },
    model: { bg: 'bg-indigo-600 text-white', icon: 'fa-microchip text-indigo-200' },
    error: { bg: 'bg-red-600 text-white', icon: 'fa-circle-exclamation text-white' },
};

export function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    const style = TOAST_STYLES[type] || TOAST_STYLES.info;

    toast.className = `toast-animate ${style.bg} px-4 py-3 rounded-2xl shadow-xl flex items-center gap-3 text-xs font-bold pointer-events-auto border border-white/15`;
    toast.style.touchAction = 'none';

    const icon = document.createElement('i');
    icon.className = `fa-solid ${style.icon} text-sm shrink-0`;
    const text = document.createElement('div');
    text.className = 'flex-1 leading-snug';
    text.textContent = message;
    toast.append(icon, text);
    container.appendChild(toast);

    let hideTimer = null;
    let startY = null;
    let dy = 0;

    const dismiss = () => {
        toast.style.transition = 'transform 0.2s ease, opacity 0.2s ease';
        toast.style.transform = 'translateY(-150%)';
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 220);
    };
    const startTimer = () => { hideTimer = setTimeout(dismiss, type === 'error' ? 6000 : 3500); };

    toast.addEventListener('pointerdown', (e) => {
        clearTimeout(hideTimer);
        startY = e.clientY;
        dy = 0;
        toast.setPointerCapture(e.pointerId);
        toast.style.animation = 'none';
        toast.style.transition = 'none';
    });
    toast.addEventListener('pointermove', (e) => {
        if (startY === null) return;
        dy = Math.min(0, e.clientY - startY);
        toast.style.transform = `translateY(${dy}px)`;
        toast.style.opacity = String(Math.max(0.2, 1 + dy / 120));
    });
    const endDrag = () => {
        if (startY === null) return;
        startY = null;
        if (dy < -30) {
            dismiss();
        } else {
            toast.style.transition = 'transform 0.15s ease, opacity 0.15s ease';
            toast.style.transform = 'translateY(0)';
            toast.style.opacity = '1';
            startTimer();
        }
    };
    toast.addEventListener('pointerup', endDrag);
    toast.addEventListener('pointercancel', endDrag);

    startTimer();
}
