let currentEmail = localStorage.getItem('JHON_mail') || null;
let db; 
let currentOpenMsgData = null;

const DB_NAME = 'SannMailDB';
const DB_VERSION = 2; // NAIKKAN VERSION KARENA STRUKTUR DB BERUBAH
const STORE_MSG = 'messages';
const STORE_DELETED = 'deleted_ids'; // Store baru untuk blacklist ID

document.addEventListener('DOMContentLoaded', async () => {
    await initDB();
    
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(err => console.log('SW Fail:', err));
    }

    if (currentEmail) {
        document.getElementById('emailAddress').innerText = currentEmail;
        await loadCachedMessages(); 
        fetchInbox(); 
    } else {
        generateNewEmail();
    }
    
    startAutoRefresh();
});

// FIX BUG: Update InitDB untuk buat tabel 'deleted_ids'
function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onupgradeneeded = (e) => {
            db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_MSG)) {
                db.createObjectStore(STORE_MSG, { keyPath: 'id' });
            }
            // Buat tabel blacklist jika belum ada
            if (!db.objectStoreNames.contains(STORE_DELETED)) {
                db.createObjectStore(STORE_DELETED, { keyPath: 'id' });
            }
        };

        request.onsuccess = (e) => { db = e.target.result; resolve(db); };
        request.onerror = (e) => reject(e);
    });
}

// Helper: Simpan ke DB Pesan
function saveMessageToDB(msg) {
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_MSG, 'readwrite');
        tx.objectStore(STORE_MSG).put(msg); 
        tx.oncomplete = () => resolve();
    });
}

// Helper: Ambil semua pesan
function getAllMessagesFromDB() {
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_MSG, 'readonly');
        const request = tx.objectStore(STORE_MSG).getAll();
        request.onsuccess = () => resolve(request.result || []);
    });
}

// Helper: Ambil semua ID yang dihapus (Blacklist)
function getAllDeletedIDs() {
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_DELETED, 'readonly');
        const request = tx.objectStore(STORE_DELETED).getAll();
        request.onsuccess = () => resolve(request.result || []);
    });
}

// Helper: Tambah ID ke Blacklist (Deleted Store)
function markAsDeleted(msgId) {
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_DELETED, 'readwrite');
        tx.objectStore(STORE_DELETED).put({ id: msgId });
        tx.oncomplete = () => resolve();
    });
}

// FIX BUG: Hapus semua pesan di inbox + Masukkan ke Blacklist
async function clearInbox() {
    if(confirm('Hapus semua pesan dari penyimpanan?')) {
        const msgs = await getAllMessagesFromDB();
        
        // Masukkan semua ID pesan saat ini ke blacklist agar tidak ditarik server lagi
        const tx = db.transaction([STORE_MSG, STORE_DELETED], 'readwrite');
        const storeMsg = tx.objectStore(STORE_MSG);
        const storeDel = tx.objectStore(STORE_DELETED);

        msgs.forEach(m => {
            storeDel.put({ id: m.id }); // Add to blacklist
            storeMsg.delete(m.id);      // Remove from inbox
        });

        tx.oncomplete = () => {
            renderMessages([]); 
            document.getElementById('badge-count').style.display = 'none';
        };
    }
}

// Fungsi generate email baru (Reset semua DB termasuk blacklist)
async function generateNewEmail() {
    const emailDisplay = document.getElementById('emailAddress');
    emailDisplay.innerText = "Membuat ID baru...";
    
    // Clear kedua tabel saat ganti email
    const tx = db.transaction([STORE_MSG, STORE_DELETED], 'readwrite');
    tx.objectStore(STORE_MSG).clear();
    tx.objectStore(STORE_DELETED).clear();
    
    updateBadge(0);
    
    try {
        const res = await fetch('/api?action=generate');
        const data = await res.json();
        
        if (data.success) {
            currentEmail = data.result.email;
            localStorage.setItem('jhon_mail', currentEmail);
            emailDisplay.innerText = currentEmail;
            
            document.getElementById('unreadList').innerHTML = emptyState('updates');
            document.getElementById('readList').innerHTML = emptyState('inbox');
            
            switchTab('view-home', document.querySelector('.nav-item:first-child'));
        } else {
            alert('Gagal: ' + data.result);
        }
    } catch (e) {
        emailDisplay.innerText = "Error Jaringan";
    }
}

// FIX BUG: Fetch Inbox dengan Pengecekan Blacklist
async function fetchInbox() {
    if (!currentEmail) return;

    try {
        const res = await fetch(`/api?action=inbox&email=${currentEmail}`);
        const data = await res.json();

        if (data.success && data.result.inbox) {
            const serverMessages = data.result.inbox;
            const existingMessages = await getAllMessagesFromDB();
            const deletedIDs = await getAllDeletedIDs(); // Ambil daftar blacklist

            // Ubah array blacklist jadi Set biar pencarian cepat
            const deletedSet = new Set(deletedIDs.map(d => d.id));
            
            let hasNew = false;
            for (const msg of serverMessages) {
                const msgId = `${msg.created}_${msg.from}`.replace(/\s/g, '');
                
                // Cek: Apakah sudah ada? DAN Apakah TIDAK ada di blacklist?
                const exists = existingMessages.find(m => m.id === msgId);
                const isDeleted = deletedSet.has(msgId);
                
                if (!exists && !isDeleted) {
                    await saveMessageToDB({ ...msg, id: msgId, isRead: false });
                    hasNew = true;
                }
            }
            if(hasNew) await loadCachedMessages();
        }
    } catch (e) {
        console.log("Offline/Error Fetch");
    }
}

async function loadCachedMessages() {
    const messages = await getAllMessagesFromDB();
    renderMessages(messages);
}

function renderMessages(messages) {
    const unreadContainer = document.getElementById('unreadList');
    const readContainer = document.getElementById('readList');
    
    let unreadHTML = '';
    let readHTML = '';
    let unreadCount = 0;

    messages.sort((a, b) => new Date(b.created) - new Date(a.created));

    messages.forEach((msg) => {
        const initial = msg.from ? msg.from.charAt(0).toUpperCase() : '?';
        const timeDisplay = msg.created.split(' ')[1] || msg.created;

        const html = `
            <div class="message-card ${msg.isRead ? 'read' : 'unread'}" onclick="openMessage('${msg.id}')">
                <div class="msg-avatar">${initial}</div>
                <div class="msg-content">
                    <div class="msg-header">
                        <span class="msg-from">${msg.from}</span>
                        <span class="msg-time">${timeDisplay}</span>
                    </div>
                    <div class="msg-subject">${msg.subject || '(Tanpa Subjek)'}</div>
                    <div class="msg-snippet">${msg.message}</div>
                </div>
            </div>
        `;

        if (msg.isRead) {
            readHTML += html;
        } else {
            unreadHTML += html;
            unreadCount++;
        }
    });

    unreadContainer.innerHTML = unreadHTML || emptyState('updates');
    readContainer.innerHTML = readHTML || emptyState('inbox');
    updateBadge(unreadCount);
}

async function openMessage(msgId) {
    const messages = await getAllMessagesFromDB();
    const msg = messages.find(m => m.id === msgId);
    if (!msg) return;

    currentOpenMsgData = msg; // Simpan untuk share

    const initial = msg.from ? msg.from.charAt(0).toUpperCase() : '?';
    document.getElementById('modalSubject').innerText = msg.subject || '(No Subject)';
    document.getElementById('modalBody').innerText = msg.message;
    
    document.getElementById('modalMeta').innerHTML = `
        <div class="meta-avatar">${initial}</div>
        <div class="meta-info">
            <span class="meta-from">${msg.from}</span>
            <span class="meta-time">${msg.created}</span>
        </div>
    `;
    
    document.getElementById('msgModal').classList.add('show');

    if (!msg.isRead) {
        msg.isRead = true;
        await saveMessageToDB(msg); 
        await loadCachedMessages(); 
    }
}

// --- FITUR SHARE GAMBAR (HTML2CANVAS) ---
function openMessageShare() {
    if(!currentOpenMsgData) return;
    document.getElementById('shareMsgModal').classList.add('show');
}

function shareAsImage() {
    if(!currentOpenMsgData) return;
    
    // 1. Siapkan Data ke Elemen Rahasia
    const msg = currentOpenMsgData;
    const body = msg.message;
    
    // Mask Email Pengirim
    const sender = msg.from;
    const [user, domain] = sender.split('@');
    const visiblePart = user.length > 3 ? user.substring(0, 3) : user.substring(0, 1);
    const maskedEmail = `${visiblePart}***@${domain}`;

    document.getElementById('capEmail').innerText = maskedEmail;
    document.getElementById('capMsg').innerText = body;

    // 2. Generate Image
    const captureEl = document.getElementById('capture-card');
    
    html2canvas(captureEl, { scale: 2, backgroundColor: null }).then(canvas => {
        canvas.toBlob(async blob => {
            const file = new File([blob], "message-jhon.png", { type: "image/png" });
            
            // Coba Web Share API Level 2 (Android/iOS terbaru)
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                try {
                    await navigator.share({
                        files: [file],
                        title: 'Pesan Rahasia',
                        text: 'Dapat pesan baru di JHON Mail!'
                    });
                } catch (err) {
                    console.log('Share cancel/error', err);
                }
            } else {
                // Fallback: Download gambar
                const link = document.createElement('a');
                link.download = 'message-jhon.png';
                link.href = canvas.toDataURL();
                link.click();
            }
        });
    });
}

function shareToWaText() {
    if(!currentOpenMsgData) return;
    const text = `"${currentOpenMsgData.message}"\n\n- via JHON Temp Mail`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
}

// --- Utils Lainnya ---
function closeModal(modalId) {
    document.getElementById(modalId).classList.remove('show');
}

function switchTab(viewId, element) {
    document.querySelectorAll('.tab-view').forEach(el => el.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
    if(element) { 
        document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
        element.classList.add('active');
    }
}
async function confirmNewEmail() {
    if(confirm('Buat email baru? Inbox lama akan dihapus permanen.')) {
        generateNewEmail();
    }
}
function updateBadge(count) {
    const badge = document.getElementById('badge-count');
    const dot = document.getElementById('nav-dot');
    if (count > 0) {
        badge.innerText = count; badge.style.display = 'inline-block'; dot.style.display = 'block';
    } else {
        badge.style.display = 'none'; dot.style.display = 'none';
    }
}
function emptyState(type) {
    const icon = type === 'updates' ? 'bi-bell-slash' : 'bi-inbox';
    const text = type === 'updates' ? 'Belum ada pesan baru.' : 'Belum ada pesan terbaca.';
    return `<div class="empty-placeholder"><i class="bi ${icon}"></i><p>${text}</p></div>`;
}
function copyEmail() {
    if (!currentEmail) return;
    navigator.clipboard.writeText(currentEmail);
    const toast = document.getElementById('toast');
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
}
function startAutoRefresh() {
    let timeLeft = 10;
    const timerText = document.getElementById('timerText');
    setInterval(() => {
        timeLeft--;
        timerText.innerText = `Auto-refresh: ${timeLeft}s`;
        if (timeLeft <= 0) { fetchInbox(); timeLeft = 10; }
    }, 1000);
}
