let currentEmail = localStorage.getItem('jhon_mail') || null;
let db; 
let autoRefreshInterval;

const DB_NAME = 'jhonMailDB';
const DB_VERSION = 1;
const STORE_NAME = 'messages';

// Inisialisasi saat dokumen dimuat
document.addEventListener('DOMContentLoaded', async () => {
    await initDB();
    
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js')
            .catch(err => console.log('SW Fail:', err));
    }

    if (currentEmail) {
        document.getElementById('emailAddress').innerText = currentEmail;
        await loadCachedMessages(); 
        fetchInbox(); 
    } else {
        generateNewEmail();
    }
    
    startAutoRefresh();
    
    // Event listener untuk klik di luar modal
    setupModalClickHandlers();
});

// Setup modal click handlers
function setupModalClickHandlers() {
    const msgModal = document.getElementById('msgModal');
    const shareModal = document.getElementById('shareMsgModal');
    
    msgModal.addEventListener('click', function(event) {
        if (event.target === msgModal) {
            closeModal('msgModal');
        }
    });
    
    shareModal.addEventListener('click', function(event) {
        if (event.target === shareModal) {
            closeModal('shareMsgModal');
        }
    });
}

// Inisialisasi IndexedDB
function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
            db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
        request.onsuccess = (e) => { 
            db = e.target.result; 
            resolve(db); 
        };
        request.onerror = (e) => reject(e);
    });
}

// Simpan pesan ke DB
function saveMessageToDB(msg) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.put(msg);
        request.onsuccess = () => resolve();
        request.onerror = () => reject();
    });
}

// Ambil semua pesan dari DB
function getAllMessagesFromDB() {
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
    });
}

// Hapus semua pesan dari DB
function clearAllMessagesDB() {
    return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.clear();
        tx.oncomplete = () => resolve();
    });
}

// Switch tab navigasi
function switchTab(viewId, element) {
    document.querySelectorAll('.tab-view').forEach(el => el.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
    
    if(element) { 
        document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
        element.classList.add('active');
    }
}

// Konfirmasi buat email baru
async function confirmNewEmail() {
    if(confirm('Buat email baru? Inbox lama akan dihapus permanen.')) {
        generateNewEmail();
    }
}

// Generate email baru
async function generateNewEmail() {
    const emailDisplay = document.getElementById('emailAddress');
    emailDisplay.innerText = "Membuat ID baru...";
    
    await clearAllMessagesDB(); 
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
            
            showToast('Email baru berhasil dibuat');
        } else {
            alert('Gagal: ' + data.result);
        }
    } catch (e) {
        emailDisplay.innerText = "Error Jaringan";
        showToast('Gagal terhubung ke server');
    }
}

// Load pesan dari cache
async function loadCachedMessages() {
    const messages = await getAllMessagesFromDB();
    renderMessages(messages);
}

// Fetch inbox dari server
async function fetchInbox() {
    if (!currentEmail) return;

    try {
        const res = await fetch(`/api?action=inbox&email=${currentEmail}`);
        const data = await res.json();

        if (data.success && data.result.inbox) {
            const serverMessages = data.result.inbox;
            const existingMessages = await getAllMessagesFromDB();
            let newMessagesCount = 0;
            
            for (const msg of serverMessages) {
                const msgId = `${msg.created}_${msg.from}`.replace(/\s/g, '');
                const exists = existingMessages.find(m => m.id === msgId);
                
                if (!exists) {
                    await saveMessageToDB({ ...msg, id: msgId, isRead: false });
                    newMessagesCount++;
                }
            }
            
            if (newMessagesCount > 0) {
                showToast(`${newMessagesCount} pesan baru diterima`);
            }
            
            await loadCachedMessages();
        }
    } catch (e) {
        console.log("Offline/Error Fetch");
    }
}

// Render semua pesan
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
                    <div class="msg-snippet">${msg.message.substring(0, 60)}${msg.message.length > 60 ? '...' : ''}</div>
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

// Buka pesan
async function openMessage(msgId) {
    const messages = await getAllMessagesFromDB();
    const msg = messages.find(m => m.id === msgId);
    
    if (!msg) return;

    // Data untuk Modal
    const initial = msg.from ? msg.from.charAt(0).toUpperCase() : '?';
    document.getElementById('modalSubject').innerText = msg.subject || '(Tanpa Subjek)';
    document.getElementById('modalBody').innerText = msg.message;
    
    document.getElementById('modalMeta').innerHTML = `
        <div class="meta-avatar">${initial}</div>
        <div class="meta-info">
            <span class="meta-from">${msg.from}</span>
            <span class="meta-time">${msg.created}</span>
        </div>
    `;
    
    const modal = document.getElementById('msgModal');
    modal.classList.add('show');
    document.body.classList.add('modal-open');

    if (!msg.isRead) {
        msg.isRead = true;
        await saveMessageToDB(msg); 
        await loadCachedMessages(); 
    }
}

// Tutup modal
function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    modal.classList.remove('show');
    document.body.classList.remove('modal-open');
}

// Update badge notifikasi
function updateBadge(count) {
    const badge = document.getElementById('badge-count');
    const dot = document.getElementById('nav-dot');
    
    if (count > 0) {
        badge.innerText = count;
        badge.style.display = 'inline-block';
        dot.style.display = 'block';
    } else {
        badge.style.display = 'none';
        dot.style.display = 'none';
    }
}

// Empty state placeholder
function emptyState(type) {
    const icon = type === 'updates' ? 'bi-bell-slash' : 'bi-inbox';
    const text = type === 'updates' ? 'Belum ada pesan baru.' : 'Belum ada pesan terbaca.';
    return `
        <div class="empty-placeholder">
            <i class="bi ${icon}"></i>
            <p>${text}</p>
        </div>
    `;
}

// Copy email ke clipboard
function copyEmail() {
    if (!currentEmail) return;
    navigator.clipboard.writeText(currentEmail);
    showToast('Email disalin ke clipboard!');
}

// Show toast notification
function showToast(message) {
    const toast = document.getElementById('toast');
    toast.innerText = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
}

// Auto refresh timer
function startAutoRefresh() {
    let timeLeft = 10;
    const timerText = document.getElementById('timerText');
    
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
    }
    
    autoRefreshInterval = setInterval(() => {
        timeLeft--;
        timerText.innerText = `Auto-refresh: ${timeLeft}s`;
        if (timeLeft <= 0) {
            fetchInbox();
            timeLeft = 10;
        }
    }, 1000);
}

// ========== FUNGSI UNTUK FITUR SHARE DAN CLEAR ==========

// Hapus semua pesan di inbox (yang sudah dibaca)
async function clearInbox() {
    if (confirm('Hapus semua pesan di inbox?')) {
        const messages = await getAllMessagesFromDB();
        const readMessages = messages.filter(m => m.isRead);
        
        for (const msg of readMessages) {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            store.delete(msg.id);
        }
        
        await loadCachedMessages();
        showToast('Inbox telah dibersihkan');
    }
}

// Buka modal share
function openShareModal() {
    // Update data capture
    const capEmail = document.getElementById('capEmail');
    const capSubject = document.getElementById('capSubject');
    const capMsg = document.getElementById('capMsg');
    
    const fromElement = document.querySelector('.meta-from');
    const subjectElement = document.getElementById('modalSubject');
    const bodyElement = document.getElementById('modalBody');
    
    if (fromElement) capEmail.innerText = fromElement.innerText;
    if (subjectElement) capSubject.innerText = subjectElement.innerText;
    if (bodyElement) capMsg.innerText = bodyElement.innerText;
    
    // Tutup modal pesan dulu
    closeModal('msgModal');
    
    // Buka modal share setelah animasi tutup
    setTimeout(() => {
        const modal = document.getElementById('shareMsgModal');
        modal.classList.add('show');
        document.body.classList.add('modal-open');
    }, 300);
}

// Share sebagai gambar
async function shareAsImage() {
    const captureCard = document.getElementById('capture-card');
    
    showToast('Membuat gambar...');
    
    try {
        // Clone card untuk menghindari gangguan
        const canvas = await html2canvas(captureCard, {
            scale: 2,
            backgroundColor: '#ffffff',
            logging: false,
            allowTaint: false,
            useCORS: true
        });
        
        const image = canvas.toDataURL('image/png');
        
        // Cek support Web Share API
        if (navigator.share && navigator.canShare) {
            try {
                const blob = await (await fetch(image)).blob();
                const file = new File([blob], `tempmail-${Date.now()}.png`, { type: 'image/png' });
                
                if (navigator.canShare({ files: [file] })) {
                    await navigator.share({
                        title: 'Pesan TempMail',
                        files: [file]
                    });
                    showToast('Berhasil dibagikan!');
                } else {
                    downloadImage(image);
                }
            } catch (shareErr) {
                downloadImage(image);
            }
        } else {
            downloadImage(image);
        }
    } catch (error) {
        console.error('HTML2Canvas error:', error);
        showToast('Gagal membuat gambar');
    }
    
    closeModal('shareMsgModal');
}

// Download image
function downloadImage(imageData) {
    const link = document.createElement('a');
    link.download = `tempmail-${Date.now()}.png`;
    link.href = imageData;
    link.click();
    showToast('Gambar tersimpan');
}

// Share ke WhatsApp
function shareToWaText() {
    const modalSubject = document.getElementById('modalSubject').innerText;
    const modalBody = document.getElementById('modalBody').innerText;
    const modalFrom = document.querySelector('.meta-from')?.innerText || 'Unknown';
    const modalTime = document.querySelector('.meta-time')?.innerText || '';
    
    const text = `📝 *subjeck:* ${modalSubject}\n\n📧 *Dari:* ${modalFrom}\n⏰ *Waktu:* ${modalTime}\n\n📝 *Pesan:*\n${modalBody}\n\n━━━━━━━━━━━━━━\n_Dikirim via TempMail - JHON FORUM_`;
    
    const waUrl = `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(waUrl, '_blank');
    
    closeModal('shareMsgModal');
}

// Copy teks pesan
function copyMessageText() {
    const modalSubject = document.getElementById('modalSubject').innerText;
    const modalBody = document.getElementById('modalBody').innerText;
    const modalFrom = document.querySelector('.meta-from')?.innerText || 'Unknown';
    const modalTime = document.querySelector('.meta-time')?.innerText || '';
    
    const text = `📝 *Subjeck:* ${modalSubject}\n\n📧 *Dari:* ${modalFrom}\n⏰ *Waktu:* ${modalTime}\n\n📝 *Pesan:*\n${modalBody}\n\n━━━━━━━━━━━━━━\n_Dikirim via TempMail - JHON FORUM_`;
    
    navigator.clipboard.writeText(text).then(() => {
        showToast('Teks disalin!');
        closeModal('shareMsgModal');
    }).catch(() => {
        showToast('Gagal menyalin teks');
    });
}

// Cleanup interval saat page unload
window.addEventListener('beforeunload', function() {
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
    }
});
