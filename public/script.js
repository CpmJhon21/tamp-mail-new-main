// ========== DATA STORAGE ==========
let currentEmail = localStorage.getItem('tempmail_email') || '';
let messages = JSON.parse(localStorage.getItem('tempmail_messages') || '[]');
let currentMessageId = null;
let currentFilter = 'all';
let refreshInterval;
let timeLeft = 10;

// ========== DOM ELEMENTS ==========
const emailDisplay = document.getElementById('emailAddress');
const unreadList = document.getElementById('unreadList');
const readList = document.getElementById('readList');
const badgeCount = document.getElementById('badge-count');
const navDot = document.getElementById('nav-dot');
const timerText = document.getElementById('timerText');
const totalMessages = document.getElementById('totalMessages');
const unreadMessages = document.getElementById('unreadMessages');
const recentActivity = document.getElementById('recentActivityList');

// ========== INITIALIZATION ==========
document.addEventListener('DOMContentLoaded', () => {
    console.log('TempMail Started');
    
    // Load dark mode
    if (localStorage.getItem('darkMode') === 'true') {
        document.body.classList.add('dark-mode');
        document.querySelector('#darkModeToggle i').className = 'bi bi-sun';
    }
    
    // Load email
    if (currentEmail) {
        emailDisplay.textContent = currentEmail;
    } else {
        generateEmail();
    }
    
    // Render messages
    renderMessages();
    updateStats();
    updateRecentActivity();
    
    // Start timer
    startTimer();
    
    // Setup keyboard shortcuts
    setupKeyboardShortcuts();
});

// ========== EMAIL FUNCTIONS ==========
function generateEmail() {
    emailDisplay.textContent = 'Membuat email...';
    
    setTimeout(() => {
        // Generate random email
        const randomNum = Math.floor(Math.random() * 10000);
        const domains = ['tempmail.com', 'tmpmail.net', '10minute.email'];
        const domain = domains[Math.floor(Math.random() * domains.length)];
        const newEmail = `user${randomNum}@${domain}`;
        
        currentEmail = newEmail;
        localStorage.setItem('tempmail_email', newEmail);
        emailDisplay.textContent = newEmail;
        
        showToast('Email baru dibuat', 'success');
    }, 500);
}

function copyEmail() {
    if (!currentEmail) return;
    
    navigator.clipboard.writeText(currentEmail).then(() => {
        showToast('Email disalin!', 'success');
    }).catch(() => {
        showToast('Gagal menyalin', 'error');
    });
}

function confirmNewEmail() {
    if (confirm('Buat email baru? Semua pesan akan dihapus.')) {
        messages = [];
        saveMessages();
        generateEmail();
        renderMessages();
        updateStats();
        showToast('Email baru siap', 'success');
    }
}

// ========== MESSAGE FUNCTIONS ==========
function saveMessages() {
    localStorage.setItem('tempmail_messages', JSON.stringify(messages));
}

// Simulasi fetch inbox (ganti dengan API real nanti)
function fetchInbox() {
    // Random chance to get new message
    if (Math.random() > 0.5) {
        const subjects = ['Verifikasi Akun', 'Promo Spesial', 'Pemberitahuan', 'Reset Password', 'Konfirmasi'];
        const froms = ['noreply@gmail.com', 'info@tokopedia.com', 'admin@shopee.com', 'support@lazada.com'];
        
        const newMsg = {
            id: Date.now().toString(),
            from: froms[Math.floor(Math.random() * froms.length)],
            subject: subjects[Math.floor(Math.random() * subjects.length)] + ' ' + new Date().toLocaleTimeString(),
            message: 'Ini adalah contoh pesan untuk testing. Klik untuk membaca selengkapnya.',
            created: new Date().toISOString(),
            isRead: false,
            starred: false
        };
        
        messages.unshift(newMsg);
        saveMessages();
        renderMessages();
        updateStats();
        updateRecentActivity();
        
        showToast('Pesan baru diterima!', 'success');
        
        // Notifikasi
        if (navigator.vibrate) navigator.vibrate(200);
        document.title = '(!) TempMail';
        setTimeout(() => document.title = 'TempMail', 2000);
    }
    
    timeLeft = 10;
}

function renderMessages() {
    // Filter berdasarkan tab
    let filteredMessages = messages;
    
    if (currentFilter === 'unread') {
        filteredMessages = messages.filter(m => !m.isRead);
    }
    
    const unread = filteredMessages.filter(m => !m.isRead);
    const read = filteredMessages.filter(m => m.isRead);
    
    // Update unread list
    if (unread.length === 0) {
        unreadList.innerHTML = '<div class="empty-placeholder"><i class="bi bi-inbox"></i><p>Tidak ada pesan baru</p></div>';
    } else {
        unreadList.innerHTML = unread.map(msg => createMessageHTML(msg)).join('');
    }
    
    // Update read list
    if (read.length === 0) {
        readList.innerHTML = '<div class="empty-placeholder"><i class="bi bi-archive"></i><p>Inbox kosong</p></div>';
    } else {
        readList.innerHTML = read.map(msg => createMessageHTML(msg)).join('');
    }
    
    // Update badge
    const unreadCount = messages.filter(m => !m.isRead).length;
    if (unreadCount > 0) {
        badgeCount.textContent = unreadCount;
        badgeCount.style.display = 'inline-block';
        navDot.style.display = 'block';
    } else {
        badgeCount.style.display = 'none';
        navDot.style.display = 'none';
    }
}

function createMessageHTML(msg) {
    const initial = msg.from ? msg.from.charAt(0).toUpperCase() : '?';
    const time = msg.created ? new Date(msg.created).toLocaleTimeString() : '';
    const statusClass = msg.isRead ? 'read' : 'unread';
    const starredClass = msg.starred ? 'starred' : '';
    
    return `
        <div class="message-card ${statusClass} ${starredClass}" onclick="openMessage('${msg.id}')">
            <div class="msg-avatar">${escapeHTML(initial)}</div>
            <div class="msg-content">
                <div class="msg-header">
                    <span class="msg-from">${escapeHTML(msg.from || 'Unknown')}</span>
                    <span class="msg-time">${time}</span>
                </div>
                <div class="msg-subject">${escapeHTML(msg.subject || 'Tanpa Subjek')}</div>
                <div class="msg-snippet">${escapeHTML((msg.message || '').substring(0, 60))}...</div>
            </div>
        </div>
    `;
}

function escapeHTML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ========== OPEN MESSAGE ==========
function openMessage(id) {
    const msg = messages.find(m => m.id === id);
    if (!msg) return;
    
    currentMessageId = id;
    
    // Set modal content
    document.getElementById('modalSubject').textContent = msg.subject || 'Tanpa Subjek';
    document.getElementById('modalBody').textContent = msg.message || 'Kosong';
    
    document.getElementById('modalMeta').innerHTML = `
        <div class="meta-avatar">${msg.from ? msg.from.charAt(0).toUpperCase() : '?'}</div>
        <div class="meta-info">
            <span class="meta-from">${escapeHTML(msg.from || 'Unknown')}</span>
            <span class="meta-time">${msg.created || ''}</span>
        </div>
    `;
    
    // Update star button
    const starBtn = document.getElementById('starCurrentBtn');
    const starIcon = starBtn.querySelector('i');
    if (msg.starred) {
        starIcon.className = 'bi bi-star-fill';
        starIcon.style.color = '#F59E0B';
    } else {
        starIcon.className = 'bi bi-star';
        starIcon.style.color = '';
    }
    
    // Mark as read if unread
    if (!msg.isRead) {
        msg.isRead = true;
        saveMessages();
        renderMessages();
        updateStats();
        updateRecentActivity();
    }
    
    // Show modal
    document.getElementById('msgModal').classList.add('show');
    document.body.classList.add('modal-open');
}

function closeModal(modalId = 'msgModal') {
    document.getElementById(modalId).classList.remove('show');
    document.body.classList.remove('modal-open');
}

// ========== STAR FUNCTIONS ==========
function toggleStarCurrentMessage() {
    const msg = messages.find(m => m.id === currentMessageId);
    if (!msg) return;
    
    msg.starred = !msg.starred;
    saveMessages();
    renderMessages();
    
    const starBtn = document.getElementById('starCurrentBtn');
    const starIcon = starBtn.querySelector('i');
    if (msg.starred) {
        starIcon.className = 'bi bi-star-fill';
        starIcon.style.color = '#F59E0B';
        showToast('Ditandai penting');
    } else {
        starIcon.className = 'bi bi-star';
        starIcon.style.color = '';
        showToast('Tidak penting');
    }
}

// ========== SHARE FUNCTIONS ==========
function openShareModal() {
    closeModal('msgModal');
    setTimeout(() => {
        document.getElementById('shareMsgModal').classList.add('show');
        document.body.classList.add('modal-open');
    }, 300);
}

function shareToWA() {
    const msg = messages.find(m => m.id === currentMessageId);
    if (!msg) return;
    
    const text = `*${msg.subject}*\n\n📧 *Dari:* ${msg.from}\n\n📝 *Pesan:*\n${msg.message}\n\n━━━━━━━━━━━━━━\n_Dikirim via TempMail_`;
    const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank');
    closeModal('shareMsgModal');
}

function copyMessageText() {
    const msg = messages.find(m => m.id === currentMessageId);
    if (!msg) return;
    
    const text = `${msg.subject}\nDari: ${msg.from}\n\n${msg.message}`;
    navigator.clipboard.writeText(text).then(() => {
        showToast('Teks disalin!', 'success');
        closeModal('shareMsgModal');
    });
}

// ========== INBOX MANAGEMENT ==========
function clearInbox() {
    if (confirm('Hapus semua pesan di inbox?')) {
        messages = messages.filter(m => !m.isRead);
        saveMessages();
        renderMessages();
        updateStats();
        updateRecentActivity();
        showToast('Inbox dibersihkan', 'success');
    }
}

function markAllAsRead() {
    const unread = messages.filter(m => !m.isRead);
    if (unread.length === 0) {
        showToast('Tidak ada pesan baru');
        return;
    }
    
    unread.forEach(m => m.isRead = true);
    saveMessages();
    renderMessages();
    updateStats();
    updateRecentActivity();
    showToast(`${unread.length} pesan ditandai dibaca`, 'success');
}

function setFilter(filter) {
    currentFilter = filter;
    
    // Update active tab
    document.querySelectorAll('.filter-tab').forEach(tab => {
        tab.classList.remove('active');
    });
    
    if (filter === 'all') {
        document.getElementById('filterAll').classList.add('active');
        if (document.getElementById('filterAllUpdates')) {
            document.getElementById('filterAllUpdates').classList.add('active');
        }
    } else {
        document.getElementById('filterUnread').classList.add('active');
    }
    
    renderMessages();
}

// ========== STATS FUNCTIONS ==========
function updateStats() {
    const total = messages.length;
    const unread = messages.filter(m => !m.isRead).length;
    
    if (totalMessages) totalMessages.textContent = total;
    if (unreadMessages) unreadMessages.textContent = unread;
}

function updateRecentActivity() {
    if (!recentActivity) return;
    
    const recent = messages.slice(0, 3);
    
    if (recent.length === 0) {
        recentActivity.innerHTML = '<div class="activity-item loading">Belum ada aktivitas</div>';
        return;
    }
    
    recentActivity.innerHTML = recent.map(msg => {
        const time = msg.created ? new Date(msg.created).toLocaleTimeString() : '';
        const icon = msg.isRead ? 'bi-envelope-open' : 'bi-envelope';
        const iconColor = msg.isRead ? '#9CA3AF' : '#F59E0B';
        
        return `
            <div class="activity-item" onclick="openMessage('${msg.id}')">
                <div class="activity-icon" style="color: ${iconColor};">
                    <i class="bi ${icon}"></i>
                </div>
                <div class="activity-content">
                    <div class="activity-title">${escapeHTML(msg.from || 'Unknown')}</div>
                    <div class="activity-time">${escapeHTML(msg.subject || '')} • ${time}</div>
                </div>
                ${msg.starred ? '<i class="bi bi-star-fill" style="color: #F59E0B;"></i>' : ''}
            </div>
        `;
    }).join('');
}

// ========== SEARCH FUNCTIONS ==========
function toggleSearch() {
    const container = document.getElementById('searchContainer');
    container.style.display = container.style.display === 'none' ? 'block' : 'none';
    if (container.style.display === 'block') {
        document.getElementById('searchInput').focus();
    }
}

function clearSearch() {
    document.getElementById('searchInput').value = '';
    document.getElementById('clearSearchBtn').style.display = 'none';
    renderMessages();
}

function filterMessages() {
    const searchText = document.getElementById('searchInput').value.toLowerCase();
    const clearBtn = document.getElementById('clearSearchBtn');
    
    if (searchText) {
        clearBtn.style.display = 'block';
        
        const filtered = messages.filter(msg => 
            (msg.from && msg.from.toLowerCase().includes(searchText)) ||
            (msg.subject && msg.subject.toLowerCase().includes(searchText)) ||
            (msg.message && msg.message.toLowerCase().includes(searchText))
        );
        
        const unread = filtered.filter(m => !m.isRead);
        const read = filtered.filter(m => m.isRead);
        
        unreadList.innerHTML = unread.length ? unread.map(msg => createMessageHTML(msg)).join('') : 
            '<div class="empty-placeholder"><i class="bi bi-search"></i><p>Tidak ditemukan</p></div>';
        
        readList.innerHTML = read.length ? read.map(msg => createMessageHTML(msg)).join('') : 
            '<div class="empty-placeholder"><i class="bi bi-search"></i><p>Tidak ditemukan</p></div>';
    } else {
        clearBtn.style.display = 'none';
        renderMessages();
    }
}

// ========== BACKUP & RESTORE ==========
function exportData() {
    const data = {
        email: currentEmail,
        messages: messages,
        exportDate: new Date().toISOString()
    };
    
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tempmail-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    
    showToast('Backup berhasil', 'success');
}

function importData() {
    document.getElementById('fileImport').click();
}

document.getElementById('fileImport').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const data = JSON.parse(event.target.result);
            
            if (data.messages && Array.isArray(data.messages)) {
                messages = data.messages;
                if (data.email) {
                    currentEmail = data.email;
                    localStorage.setItem('tempmail_email', currentEmail);
                    emailDisplay.textContent = currentEmail;
                }
                
                saveMessages();
                renderMessages();
                updateStats();
                updateRecentActivity();
                showToast('Restore berhasil', 'success');
            } else {
                throw new Error('Format tidak valid');
            }
        } catch (err) {
            showToast('File backup tidak valid', 'error');
        }
    };
    reader.readAsText(file);
    e.target.value = '';
});

// ========== TIMER ==========
function startTimer() {
    if (refreshInterval) clearInterval(refreshInterval);
    
    refreshInterval = setInterval(() => {
        timeLeft--;
        timerText.textContent = `Auto-refresh: ${timeLeft}s`;
        
        if (timeLeft <= 0) {
            fetchInbox();
            timeLeft = 10;
        }
    }, 1000);
}

// ========== TAB SWITCHING ==========
function switchTab(tabId, element) {
    document.querySelectorAll('.tab-view').forEach(tab => {
        tab.classList.remove('active');
    });
    
    document.getElementById(tabId).classList.add('active');
    
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
    });
    element.classList.add('active');
}

// ========== DARK MODE ==========
function toggleDarkMode() {
    document.body.classList.toggle('dark-mode');
    const isDark = document.body.classList.contains('dark-mode');
    localStorage.setItem('darkMode', isDark);
    
    const icon = document.querySelector('#darkModeToggle i');
    icon.className = isDark ? 'bi bi-sun' : 'bi bi-moon-stars';
    
    // Update theme color
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    metaTheme.setAttribute('content', isDark ? '#1a1a1a' : '#F2F4F8');
}

// ========== KEYBOARD SHORTCUTS ==========
function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Ctrl/Cmd + N
        if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
            e.preventDefault();
            confirmNewEmail();
        }
        
        // Ctrl/Cmd + F
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
            e.preventDefault();
            toggleSearch();
        }
        
        // Ctrl/Cmd + D
        if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
            e.preventDefault();
            toggleDarkMode();
        }
        
        // Ctrl/Cmd + A
        if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
            e.preventDefault();
            markAllAsRead();
        }
        
        // Alt + 1-4
        if (e.altKey && !isNaN(e.key) && parseInt(e.key) >= 1 && parseInt(e.key) <= 4) {
            e.preventDefault();
            const tabIndex = parseInt(e.key) - 1;
            const tabs = ['view-home', 'view-inbox', 'view-updates', 'view-docs'];
            const navItems = document.querySelectorAll('.nav-item');
            
            if (tabIndex < tabs.length) {
                switchTab(tabs[tabIndex], navItems[tabIndex]);
            }
        }
        
        // Esc
        if (e.key === 'Escape') {
            const modals = ['msgModal', 'shareMsgModal', 'shortcutsModal'];
            modals.forEach(modalId => {
                const modal = document.getElementById(modalId);
                if (modal && modal.classList.contains('show')) {
                    closeModal(modalId);
                }
            });
        }
    });
}

function showShortcutsHelp() {
    document.getElementById('shortcutsModal').classList.add('show');
    document.body.classList.add('modal-open');
}

// ========== TOAST ==========
function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = 'toast ' + type;
    toast.classList.add('show');
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 2000);
}

// ========== CLICK OUTSIDE MODAL ==========
document.getElementById('msgModal').addEventListener('click', (e) => {
    if (e.target.id === 'msgModal') closeModal();
});

document.getElementById('shareMsgModal').addEventListener('click', (e) => {
    if (e.target.id === 'shareMsgModal') closeModal('shareMsgModal');
});

document.getElementById('shortcutsModal').addEventListener('click', (e) => {
    if (e.target.id === 'shortcutsModal') closeModal('shortcutsModal');
});

// ========== EXPOSE GLOBALLY ==========
window.switchTab = switchTab;
window.generateEmail = generateEmail;
window.confirmNewEmail = confirmNewEmail;
window.copyEmail = copyEmail;
window.openMessage = openMessage;
window.closeModal = closeModal;
window.openShareModal = openShareModal;
window.shareToWA = shareToWA;
window.copyMessageText = copyMessageText;
window.toggleStarCurrentMessage = toggleStarCurrentMessage;
window.clearInbox = clearInbox;
window.markAllAsRead = markAllAsRead;
window.toggleDarkMode = toggleDarkMode;
window.toggleSearch = toggleSearch;
window.clearSearch = clearSearch;
window.filterMessages = filterMessages;
window.setFilter = setFilter;
window.showShortcutsHelp = showShortcutsHelp;
window.exportData = exportData;
window.importData = importData;