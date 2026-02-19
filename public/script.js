// ========== KONFIGURASI ==========
const CONFIG = {
    DB_NAME: 'jhonMailDB',
    DB_VERSION: 3,
    STORE_NAME: 'messages',
    REFRESH_INTERVAL: 10,
    REQUEST_TIMEOUT: 10000,
    MAX_RETRY: 3,
    DEBUG: true,
    VIRTUAL_SCROLL_ITEM_HEIGHT: 110,
    VIRTUAL_SCROLL_BUFFER: 5,
    PAGINATION_LIMIT: 20
};

// ========== STATE MANAGEMENT ==========
let currentEmail = localStorage.getItem('jhon_mail') || null;
let db = null;
let autoRefreshInterval = null;
let refreshTimeLeft = CONFIG.REFRESH_INTERVAL;
let pendingConfirmation = null;
let currentMessageId = null;
let virtualScrollManagers = {};
let searchEngine = null;
let accountManager = null;
let broadcastChannel = null;
let lastSyncTimestamp = 0;
let sortOrder = 'desc'; // 'asc' atau 'desc'

// Filter state untuk inbox dan updates
const filterState = {
    inbox: {
        status: 'all',
        dateFrom: '',
        dateTo: '',
        sender: '',
        keyword: '',
        active: false
    },
    updates: {
        status: 'all',
        dateFrom: '',
        dateTo: '',
        sender: '',
        keyword: '',
        active: false
    }
};

// ========== CLASS: MessageDB dengan Pagination ==========
class MessageDB {
    constructor(dbName, storeName) {
        this.dbName = dbName;
        this.storeName = storeName;
        this.db = null;
    }

    async init() {
        return new Promise((resolve, reject) => {
            try {
                const request = indexedDB.open(this.dbName, CONFIG.DB_VERSION);
                
                request.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains(this.storeName)) {
                        const store = db.createObjectStore(this.storeName, { keyPath: 'id' });
                        
                        // Buat indexes untuk pencarian
                        store.createIndex('from', 'from', { unique: false });
                        store.createIndex('created', 'created', { unique: false });
                        store.createIndex('starred', 'starred', { unique: false });
                        store.createIndex('isRead', 'isRead', { unique: false });
                        store.createIndex('hasAttachments', 'hasAttachments', { unique: false });
                        
                        log('Database store created with indexes');
                    }
                };
                
                request.onsuccess = (e) => { 
                    this.db = e.target.result;
                    
                    // Handle connection closed unexpectedly
                    this.db.onclose = () => {
                        log('Database connection closed');
                        this.db = null;
                    };
                    
                    this.db.onerror = (e) => {
                        log('Database error:', e.target.error);
                    };
                    
                    log('Database initialized successfully');
                    resolve(this.db);
                };
                
                request.onerror = (e) => { 
                    log('Database initialization failed:', e.target.error);
                    reject(new Error('Failed to open database: ' + e.target.error));
                };
            } catch (e) {
                reject(e);
            }
        });
    }

    async ensureConnection() {
        if (!this.db) {
            await this.init();
        }
        return this.db;
    }

    // Pagination: Ambil pesan dengan limit dan offset
    async getMessagesPaginated(limit = 20, offset = 0, filter = null, section = null) {
        try {
            await this.ensureConnection();
            
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(this.storeName, 'readonly');
                const store = tx.objectStore(this.storeName);
                const request = store.openCursor(null, 'prev'); // Sort descending by default
                let count = 0;
                const results = [];
                
                request.onsuccess = (event) => {
                    const cursor = event.target.result;
                    
                    if (!cursor) {
                        resolve(results);
                        return;
                    }
                    
                    // Filter berdasarkan section (read/unread)
                    if (section === 'inbox' && cursor.value.isRead === false) {
                        cursor.continue();
                        return;
                    }
                    if (section === 'updates' && cursor.value.isRead === true) {
                        cursor.continue();
                        return;
                    }
                    
                    // Apply filter jika ada
                    if (!filter || this.matchesFilter(cursor.value, filter)) {
                        if (count >= offset) {
                            results.push(cursor.value);
                        }
                        count++;
                    }
                    
                    if (results.length < limit) {
                        cursor.continue();
                    } else {
                        resolve(results);
                    }
                };
                
                request.onerror = () => reject(new Error('Failed to get messages'));
                tx.oncomplete = () => resolve(results);
            });
        } catch (e) {
            log('Get messages error:', e);
            return [];
        }
    }

    // Hitung total pesan dengan filter
    async getTotalCount(filter = null, section = null) {
        try {
            await this.ensureConnection();
            
            return new Promise((resolve) => {
                const tx = this.db.transaction(this.storeName, 'readonly');
                const store = tx.objectStore(this.storeName);
                const request = store.openCursor();
                let count = 0;
                
                request.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor) {
                        // Filter berdasarkan section
                        if (section === 'inbox' && cursor.value.isRead === false) {
                            cursor.continue();
                            return;
                        }
                        if (section === 'updates' && cursor.value.isRead === true) {
                            cursor.continue();
                            return;
                        }
                        
                        // Apply filter
                        if (!filter || this.matchesFilter(cursor.value, filter)) {
                            count++;
                        }
                        cursor.continue();
                    } else {
                        resolve(count);
                    }
                };
                
                request.onerror = () => resolve(0);
            });
        } catch (e) {
            return 0;
        }
    }

    matchesFilter(msg, filter) {
        if (!filter) return true;
        
        if (filter.status === 'read' && !msg.isRead) return false;
        if (filter.status === 'unread' && msg.isRead) return false;
        if (filter.status === 'starred' && !msg.starred) return false;
        if (filter.status === 'unstarred' && msg.starred) return false;
        if (filter.status === 'attachments' && !msg.hasAttachments) return false;
        
        if (filter.dateFrom || filter.dateTo) {
            try {
                const msgDate = new Date(msg.created);
                msgDate.setHours(0, 0, 0, 0);
                
                if (filter.dateFrom) {
                    const fromDate = new Date(filter.dateFrom);
                    fromDate.setHours(0, 0, 0, 0);
                    if (msgDate < fromDate) return false;
                }
                
                if (filter.dateTo) {
                    const toDate = new Date(filter.dateTo);
                    toDate.setHours(23, 59, 59, 999);
                    if (msgDate > toDate) return false;
                }
            } catch (e) {
                log('Date filter error:', e);
            }
        }
        
        if (filter.sender && msg.from && !msg.from.toLowerCase().includes(filter.sender.toLowerCase())) {
            return false;
        }
        
        if (filter.keyword) {
            const searchText = `${msg.subject || ''} ${msg.message || ''}`.toLowerCase();
            if (!searchText.includes(filter.keyword.toLowerCase())) {
                return false;
            }
        }
        
        return true;
    }

    async save(message) {
        try {
            await this.ensureConnection();
            
            // Deteksi attachment
            message.hasAttachments = this.detectAttachments(message.message || '').length > 0;
            message.updatedAt = new Date().toISOString();
            
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(this.storeName, 'readwrite');
                const store = tx.objectStore(this.storeName);
                const request = store.put(message);
                
                request.onsuccess = () => {
                    log('Message saved:', message.id);
                    resolve();
                };
                
                request.onerror = (e) => {
                    log('Save failed:', e.target.error);
                    reject(new Error('Failed to save message: ' + e.target.error));
                };
                
                tx.oncomplete = () => resolve();
                tx.onerror = (e) => reject(new Error('Transaction failed: ' + e.target.error));
            });
        } catch (e) {
            log('Save error:', e);
            throw e;
        }
    }

    detectAttachments(message) {
        if (!message) return [];
        
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const imageRegex = /\.(jpg|jpeg|png|gif|webp|svg)$/i;
        const links = message.match(urlRegex) || [];
        
        return links.map(link => ({
            url: link,
            type: imageRegex.test(link) ? 'image' : 'link',
            filename: link.split('/').pop() || 'file'
        }));
    }

    async getAll() {
        try {
            await this.ensureConnection();
            
            return new Promise((resolve) => {
                const tx = this.db.transaction(this.storeName, 'readonly');
                const store = tx.objectStore(this.storeName);
                const request = store.getAll();
                
                request.onsuccess = () => {
                    resolve(request.result || []);
                };
                
                request.onerror = () => resolve([]);
            });
        } catch (e) {
            log('Get all error:', e);
            return [];
        }
    }

    async clear() {
        try {
            await this.ensureConnection();
            
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(this.storeName, 'readwrite');
                const store = tx.objectStore(this.storeName);
                const request = store.clear();
                
                request.onsuccess = () => {
                    log('Database cleared');
                    resolve();
                };
                
                request.onerror = (e) => {
                    log('Clear failed:', e.target.error);
                    reject(new Error('Failed to clear database: ' + e.target.error));
                };
            });
        } catch (e) {
            log('Clear error:', e);
            throw e;
        }
    }

    async delete(id) {
        try {
            await this.ensureConnection();
            
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(this.storeName, 'readwrite');
                const store = tx.objectStore(this.storeName);
                const request = store.delete(id);
                
                request.onsuccess = () => {
                    log('Message deleted:', id);
                    resolve();
                };
                
                request.onerror = (e) => {
                    log('Delete failed:', e.target.error);
                    reject(new Error('Failed to delete message: ' + e.target.error));
                };
            });
        } catch (e) {
            log('Delete error:', e);
            throw e;
        }
    }
}

// ========== CLASS: VirtualScrollManager ==========
class VirtualScrollManager {
    constructor(containerId, itemRenderer, itemHeight = CONFIG.VIRTUAL_SCROLL_ITEM_HEIGHT) {
        this.container = document.getElementById(containerId);
        this.itemRenderer = itemRenderer;
        this.itemHeight = itemHeight;
        this.items = [];
        this.totalItems = 0;
        this.visibleRange = { start: 0, end: 0 };
        this.scrollTop = 0;
        this.isLoading = false;
        this.filter = null;
        this.section = containerId === 'readList' ? 'inbox' : 'updates';
        
        if (!this.container) {
            log('Container not found:', containerId);
            return;
        }
        
        this.init();
    }
    
    init() {
        this.container.style.position = 'relative';
        this.container.style.overflowY = 'auto';
        
        // Buat content container
        this.contentContainer = document.createElement('div');
        this.contentContainer.style.position = 'relative';
        this.contentContainer.style.width = '100%';
        this.container.appendChild(this.contentContainer);
        
        // Event listener untuk scroll
        this.container.addEventListener('scroll', () => {
            this.scrollTop = this.container.scrollTop;
            this.updateVisibleRange();
        });
        
        // Event listener untuk resize window
        window.addEventListener('resize', () => {
            this.updateVisibleRange();
        });
        
        // Initial update
        setTimeout(() => this.updateVisibleRange(), 100);
    }
    
    async setItems(items, totalItems) {
        this.items = items || [];
        this.totalItems = totalItems || this.items.length;
        this.updateTotalHeight();
        this.updateVisibleRange();
    }
    
    updateTotalHeight() {
        this.contentContainer.style.height = `${this.totalItems * this.itemHeight}px`;
    }
    
    updateVisibleRange() {
        const containerHeight = this.container.clientHeight;
        if (containerHeight === 0) return;
        
        const start = Math.max(0, Math.floor(this.scrollTop / this.itemHeight) - CONFIG.VIRTUAL_SCROLL_BUFFER);
        const end = Math.min(
            this.totalItems,
            start + Math.ceil(containerHeight / this.itemHeight) + CONFIG.VIRTUAL_SCROLL_BUFFER * 2
        );
        
        if (start !== this.visibleRange.start || end !== this.visibleRange.end) {
            this.visibleRange = { start, end };
            this.renderVisibleItems();
            
            // Load more jika mendekati akhir
            if (end >= this.totalItems - CONFIG.PAGINATION_LIMIT && !this.isLoading && this.items.length < this.totalItems) {
                this.loadMore();
            }
        }
    }
    
    renderVisibleItems() {
        const fragment = document.createDocumentFragment();
        this.contentContainer.innerHTML = '';
        
        for (let i = this.visibleRange.start; i < this.visibleRange.end; i++) {
            const item = this.items[i];
            if (!item) continue;
            
            try {
                const itemElement = this.itemRenderer(item, i);
                itemElement.style.position = 'absolute';
                itemElement.style.top = `${i * this.itemHeight}px`;
                itemElement.style.width = '100%';
                itemElement.style.padding = '0 4px';
                itemElement.style.left = '0';
                
                fragment.appendChild(itemElement);
            } catch (e) {
                log('Error rendering item:', e);
            }
        }
        
        this.contentContainer.appendChild(fragment);
    }
    
    async loadMore() {
        if (this.isLoading) return;
        
        this.isLoading = true;
        const loader = document.getElementById(`${this.container.id}Loader`);
        if (loader) loader.style.display = 'flex';
        
        try {
            const offset = this.items.length;
            const filter = filterState[this.section].active ? filterState[this.section] : null;
            
            const newItems = await window.messageDB.getMessagesPaginated(
                CONFIG.PAGINATION_LIMIT,
                offset,
                filter,
                this.section
            );
            
            if (newItems && newItems.length > 0) {
                // Sort items
                const sortedNewItems = sortMessagesByDate(newItems);
                this.items = [...this.items, ...sortedNewItems];
                this.updateTotalHeight();
                this.updateVisibleRange();
            }
        } catch (e) {
            log('Load more error:', e);
        } finally {
            this.isLoading = false;
            if (loader) loader.style.display = 'none';
        }
    }
    
    async refresh(filter = null) {
        this.filter = filter;
        this.items = [];
        this.scrollTop = 0;
        if (this.container) this.container.scrollTop = 0;
        
        const loader = document.getElementById(`${this.container.id}Loader`);
        if (loader) loader.style.display = 'flex';
        
        try {
            const activeFilter = filter || (filterState[this.section].active ? filterState[this.section] : null);
            
            this.totalItems = await window.messageDB.getTotalCount(activeFilter, this.section);
            
            const newItems = await window.messageDB.getMessagesPaginated(
                CONFIG.PAGINATION_LIMIT,
                0,
                activeFilter,
                this.section
            );
            
            // Sort items
            this.items = sortMessagesByDate(newItems || []);
            this.updateTotalHeight();
            this.updateVisibleRange();
            
        } catch (e) {
            log('Refresh error:', e);
        } finally {
            if (loader) loader.style.display = 'none';
        }
    }
}

// ========== CLASS: SearchEngine ==========
class SearchEngine {
    constructor() {
        this.searchIndex = {};
        this.messages = [];
    }
    
    async buildIndex(messages) {
        this.messages = messages || [];
        this.searchIndex = {};
        
        messages.forEach(msg => {
            if (!msg.id) return;
            
            const text = `${msg.from || ''} ${msg.subject || ''} ${msg.message || ''}`.toLowerCase();
            const words = text.split(/\W+/).filter(w => w.length > 2);
            
            words.forEach(word => {
                if (!this.searchIndex[word]) {
                    this.searchIndex[word] = [];
                }
                if (!this.searchIndex[word].includes(msg.id)) {
                    this.searchIndex[word].push(msg.id);
                }
            });
        });
        
        log('Search index built with', Object.keys(this.searchIndex).length, 'keywords');
    }
    
    search(query) {
        if (!query || query.length < 2) return [];
        
        query = query.toLowerCase();
        const words = query.split(/\W+/).filter(w => w.length > 1);
        const results = new Set();
        
        words.forEach(word => {
            // Exact match
            if (this.searchIndex[word]) {
                this.searchIndex[word].forEach(id => results.add(id));
            }
            
            // Partial match
            Object.keys(this.searchIndex).forEach(key => {
                if (key.includes(word)) {
                    this.searchIndex[key].forEach(id => results.add(id));
                }
            });
        });
        
        return Array.from(results);
    }
}

// ========== CLASS: AccountManager ==========
class AccountManager {
    constructor() {
        this.accounts = JSON.parse(localStorage.getItem('tempmail_accounts') || '[]');
        this.currentAccount = localStorage.getItem('current_account') || null;
    }
    
    addAccount(email) {
        if (email && !this.accounts.includes(email)) {
            this.accounts.push(email);
            this.saveAccounts();
            return true;
        }
        return false;
    }
    
    switchAccount(email) {
        if (email && this.accounts.includes(email)) {
            this.currentAccount = email;
            localStorage.setItem('current_account', email);
            localStorage.setItem('jhon_mail', email);
            return true;
        }
        return false;
    }
    
    removeAccount(email) {
        this.accounts = this.accounts.filter(a => a !== email);
        this.saveAccounts();
        
        if (this.currentAccount === email) {
            this.currentAccount = this.accounts[0] || null;
            if (this.currentAccount) {
                localStorage.setItem('current_account', this.currentAccount);
                localStorage.setItem('jhon_mail', this.currentAccount);
            } else {
                localStorage.removeItem('current_account');
                localStorage.removeItem('jhon_mail');
            }
        }
    }
    
    saveAccounts() {
        localStorage.setItem('tempmail_accounts', JSON.stringify(this.accounts));
        this.updateAccountSelect();
    }
    
    updateAccountSelect() {
        const select = document.getElementById('accountSelect');
        if (!select) return;
        
        select.innerHTML = '<option value="">Pilih Akun</option>';
        
        this.accounts.forEach(account => {
            const option = document.createElement('option');
            option.value = account;
            option.textContent = account.length > 20 ? account.substring(0, 20) + '...' : account;
            option.selected = account === this.currentAccount;
            select.appendChild(option);
        });
    }
}

// ========== CLASS: Analytics ==========
class Analytics {
    static async trackEvent(category, action, label = '', value = null) {
        const event = {
            id: `${Date.now()}_${Math.random()}`,
            category,
            action,
            label,
            value,
            timestamp: Date.now(),
            url: window.location.href,
            userAgent: navigator.userAgent,
            screenSize: `${window.innerWidth}x${window.innerHeight}`,
            darkMode: document.body.classList.contains('dark-mode')
        };
        
        // Simpan di localStorage untuk statistik
        const events = JSON.parse(localStorage.getItem('analytics_events') || '[]');
        events.push(event);
        
        // Hanya simpan 100 event terakhir
        if (events.length > 100) events.shift();
        
        localStorage.setItem('analytics_events', JSON.stringify(events));
        
        // Update stats
        this.updateStats();
        
        if (CONFIG.DEBUG) {
            console.log('[Analytics]', event);
        }
    }
    
    static async trackError(error, context = '') {
        await this.trackEvent('error', error.name || 'Error', `${context}: ${error.message || 'Unknown error'}`);
    }
    
    static updateStats() {
        const totalMessages = document.querySelectorAll('.message-card').length;
        const unreadMessages = document.querySelectorAll('.message-card.unread').length;
        const starredMessages = document.querySelectorAll('.message-card.starred').length;
        
        const totalEl = document.getElementById('totalMessages');
        const unreadEl = document.getElementById('unreadMessages');
        const starredEl = document.getElementById('starredMessages');
        
        if (totalEl) totalEl.textContent = totalMessages;
        if (unreadEl) unreadEl.textContent = unreadMessages;
        if (starredEl) starredEl.textContent = starredMessages;
    }
}

// ========== INISIALISASI ==========
document.addEventListener('DOMContentLoaded', async () => {
    try {
        showGlobalLoading(true);
        
        // Inisialisasi database
        window.messageDB = new MessageDB(CONFIG.DB_NAME, CONFIG.STORE_NAME);
        await window.messageDB.init();
        
        // Inisialisasi account manager
        accountManager = new AccountManager();
        accountManager.updateAccountSelect();
        
        // Inisialisasi search engine
        searchEngine = new SearchEngine();
        const allMessages = await window.messageDB.getAll();
        await searchEngine.buildIndex(allMessages);
        
        // Setup multi-tab sync
        setupBroadcastChannel();
        
        // Setup keyboard shortcuts
        setupKeyboardShortcuts();
        
        // Load dark mode preference
        loadDarkModePreference();
        
        // Setup search input listener
        setupSearchListener();
        
        // Load messages
        if (currentEmail) {
            document.getElementById('emailAddress').innerText = currentEmail;
            await initializeVirtualScroll();
            fetchInbox();
        } else {
            generateNewEmail();
        }
        
        startAutoRefresh();
        setupModalClickHandlers();
        
        // Track page view
        Analytics.trackEvent('page', 'view', 'home');
        
        log('Application initialized successfully');
        
    } catch (e) {
        log('Initialization error:', e);
        showToast('Gagal inisialisasi aplikasi', 'error');
        Analytics.trackError(e, 'init');
    } finally {
        showGlobalLoading(false);
    }
});

// ========== UTILITY FUNCTIONS ==========
function log(...args) {
    if (CONFIG.DEBUG) {
        console.log('[TempMail]', ...args);
    }
}

function showToast(message, type = 'info', duration = 2000) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    
    toast.innerText = message;
    toast.className = 'toast';
    
    if (type === 'error') toast.classList.add('error');
    if (type === 'success') toast.classList.add('success');
    if (type === 'info') toast.classList.add('info');
    
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), duration);
}

function showGlobalLoading(show = true) {
    const loader = document.getElementById('globalLoading');
    if (loader) {
        loader.style.display = show ? 'flex' : 'none';
    }
}

function showSkeleton(type, show = true) {
    const skeletonId = type === 'read' ? 'readListSkeleton' : 'unreadListSkeleton';
    const listId = type === 'read' ? 'readList' : 'unreadList';
    
    const skeleton = document.getElementById(skeletonId);
    const list = document.getElementById(listId);
    
    if (skeleton && list) {
        skeleton.style.display = show ? 'block' : 'none';
        list.style.display = show ? 'none' : 'block';
    }
}

function setButtonLoading(buttonId, loading = true) {
    const btn = document.getElementById(buttonId);
    if (btn) {
        if (loading) {
            btn.classList.add('button-loading');
            btn.disabled = true;
        } else {
            btn.classList.remove('button-loading');
            btn.disabled = false;
        }
    }
}

function showConfirm(title, message, onConfirm) {
    const modal = document.getElementById('confirmModal');
    if (!modal) return;
    
    document.getElementById('confirmTitle').innerText = title;
    document.getElementById('confirmMessage').innerText = message;
    
    pendingConfirmation = onConfirm;
    
    modal.classList.add('show');
    document.body.classList.add('modal-open');
}

function confirmAction(confirmed) {
    const modal = document.getElementById('confirmModal');
    if (!modal) return;
    
    modal.classList.remove('show');
    document.body.classList.remove('modal-open');
    
    if (confirmed && pendingConfirmation) {
        pendingConfirmation();
    }
    pendingConfirmation = null;
}

function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return email && typeof email === 'string' && emailRegex.test(email);
}

function isValidMessageId(id) {
    return id && typeof id === 'string' && id.length > 0;
}

function escapeString(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ========== MULTI-TAB SYNC ==========
function setupBroadcastChannel() {
    try {
        broadcastChannel = new BroadcastChannel('tempmail-sync');
        
        broadcastChannel.onmessage = async (event) => {
            const { type, data, timestamp } = event.data;
            
            // Abaikan pesan dari diri sendiri
            if (timestamp === lastSyncTimestamp) return;
            
            log('Sync received:', type);
            
            switch(type) {
                case 'MESSAGES_UPDATED':
                    await refreshAllViews();
                    break;
                case 'ACCOUNT_SWITCHED':
                    if (data && data.email !== currentEmail) {
                        currentEmail = data.email;
                        localStorage.setItem('jhon_mail', currentEmail);
                        await refreshAllViews();
                    }
                    break;
                case 'DARK_MODE_TOGGLED':
                    if (data && data.enabled !== document.body.classList.contains('dark-mode')) {
                        document.body.classList.toggle('dark-mode', data.enabled);
                        updateThemeColor();
                    }
                    break;
            }
        };
    } catch (e) {
        log('BroadcastChannel not supported');
    }
}

function broadcastUpdate(type, data) {
    if (!broadcastChannel) return;
    
    lastSyncTimestamp = Date.now();
    broadcastChannel.postMessage({
        type,
        data,
        timestamp: lastSyncTimestamp
    });
}

// ========== KEYBOARD SHORTCUTS ==========
function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        // Ctrl/Cmd + N = New email
        if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
            e.preventDefault();
            confirmNewEmail();
            Analytics.trackEvent('keyboard', 'shortcut', 'new_email');
        }
        
        // Esc = Close modal
        if (e.key === 'Escape') {
            closeAllModals();
        }
        
        // Ctrl/Cmd + F = Search
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
            e.preventDefault();
            toggleSearch();
            Analytics.trackEvent('keyboard', 'shortcut', 'search');
        }
        
        // Alt + 1-4 = Switch tabs
        if (e.altKey && !isNaN(e.key) && parseInt(e.key) >= 1 && parseInt(e.key) <= 4) {
            e.preventDefault();
            const tabIndex = parseInt(e.key) - 1;
            const tabs = ['view-home', 'view-inbox', 'view-updates', 'view-docs'];
            const navItems = document.querySelectorAll('.nav-item');
            
            if (tabIndex >= 0 && tabIndex < tabs.length) {
                switchTab(tabs[tabIndex], navItems[tabIndex]);
                Analytics.trackEvent('keyboard', 'shortcut', `tab_${tabIndex + 1}`);
            }
        }
        
        // Ctrl/Cmd + D = Toggle dark mode
        if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
            e.preventDefault();
            toggleDarkMode();
        }
        
        // ? = Show shortcuts help
        if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
            showShortcutsHelp();
        }
    });
}

function closeAllModals() {
    const modals = ['msgModal', 'shareMsgModal', 'addAccountModal', 'backupModal', 'confirmModal', 'shortcutsModal'];
    modals.forEach(id => closeModal(id));
}

function showShortcutsHelp() {
    const modal = document.getElementById('shortcutsModal');
    if (!modal) return;
    
    modal.classList.add('show');
    document.body.classList.add('modal-open');
}

// ========== SORTING ==========
function toggleSortOrder() {
    sortOrder = sortOrder === 'desc' ? 'asc' : 'desc';
    
    // Update icons
    const sortBtn = document.getElementById('sortBtn');
    const sortBtnUpdates = document.getElementById('sortBtnUpdates');
    
    if (sortBtn) {
        sortBtn.innerHTML = `<i class="bi bi-sort-${sortOrder === 'desc' ? 'down' : 'up'}"></i>`;
    }
    if (sortBtnUpdates) {
        sortBtnUpdates.innerHTML = `<i class="bi bi-sort-${sortOrder === 'desc' ? 'down' : 'up'}"></i>`;
    }
    
    // Re-render
    refreshAllViews();
    
    Analytics.trackEvent('sort', 'toggle', sortOrder);
}

function sortMessagesByDate(messages) {
    if (!messages || !Array.isArray(messages)) return [];
    
    return messages.sort((a, b) => {
        try {
            const dateA = new Date(a.created || 0);
            const dateB = new Date(b.created || 0);
            return sortOrder === 'desc' ? dateB - dateA : dateA - dateB;
        } catch (e) {
            return 0;
        }
    });
}

// ========== VIRTUAL SCROLL INIT ==========
async function initializeVirtualScroll() {
    // Inbox virtual scroll
    virtualScrollManagers.inbox = new VirtualScrollManager(
        'readList',
        (msg, index) => createMessageElement(msg, index),
        CONFIG.VIRTUAL_SCROLL_ITEM_HEIGHT
    );
    
    // Updates virtual scroll
    virtualScrollManagers.updates = new VirtualScrollManager(
        'unreadList',
        (msg, index) => createMessageElement(msg, index),
        CONFIG.VIRTUAL_SCROLL_ITEM_HEIGHT
    );
    
    await refreshAllViews();
}

function createMessageElement(msg, index) {
    const div = document.createElement('div');
    div.className = `message-card ${msg.isRead ? 'read' : 'unread'} ${msg.starred ? 'starred' : ''}`;
    div.onclick = () => openMessage(msg.id);
    
    const initial = msg.from ? msg.from.charAt(0).toUpperCase() : '?';
    const timeDisplay = msg.created ? (msg.created.split(' ')[1] || msg.created) : '';
    const isEmailLong = msg.from && msg.from.length > 20;
    const emailClass = isEmailLong ? 'email-long' : '';
    
    let attachmentsHtml = '';
    if (msg.hasAttachments) {
        attachmentsHtml = `
            <div class="msg-attachment-indicator">
                <i class="bi bi-paperclip"></i>
                <span>Lampiran</span>
            </div>
        `;
    }
    
    div.innerHTML = `
        <div class="msg-avatar">${escapeString(initial)}</div>
        <div class="msg-content">
            <div class="msg-header">
                <span class="msg-from ${emailClass}" title="${escapeString(msg.from || 'Unknown')}">
                    ${escapeString(msg.from || 'Unknown')}
                </span>
                <span class="msg-time">${escapeString(timeDisplay)}</span>
            </div>
            <div class="msg-subject" title="${escapeString(msg.subject || 'Tanpa Subjek')}">
                ${escapeString(msg.subject || '(Tanpa Subjek)')}
            </div>
            <div class="msg-snippet">
                ${escapeString((msg.message || '').substring(0, 60))}${(msg.message || '').length > 60 ? '...' : ''}
            </div>
            ${attachmentsHtml}
        </div>
    `;
    
    // Star button
    const starBtn = document.createElement('i');
    starBtn.className = `bi ${msg.starred ? 'bi-star-fill' : 'bi-star'}`;
    starBtn.style.cssText = 'position: absolute; top: 8px; right: 8px; cursor: pointer; z-index: 10;';
    if (msg.starred) starBtn.style.color = 'var(--accent)';
    
    starBtn.onclick = (e) => {
        e.stopPropagation();
        toggleStarred(msg.id);
    };
    
    div.appendChild(starBtn);
    
    return div;
}

async function refreshAllViews() {
    await Promise.all([
        virtualScrollManagers.inbox?.refresh(),
        virtualScrollManagers.updates?.refresh()
    ]);
    
    Analytics.updateStats();
}

// ========== SEARCH ==========
function setupSearchListener() {
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('input', applyGlobalSearch);
    }
}

let searchTimeout;

function toggleSearch() {
    const container = document.getElementById('searchContainer');
    if (!container) return;
    
    container.style.display = container.style.display === 'none' ? 'block' : 'none';
    
    if (container.style.display === 'block') {
        const input = document.getElementById('searchInput');
        if (input) input.focus();
        Analytics.trackEvent('ui', 'search', 'open');
    }
}

function clearSearch() {
    const input = document.getElementById('searchInput');
    const clearBtn = document.getElementById('clearSearchBtn');
    
    if (input) input.value = '';
    if (clearBtn) clearBtn.style.display = 'none';
    
    applyGlobalSearch();
}

function applyGlobalSearch() {
    const input = document.getElementById('searchInput');
    const clearBtn = document.getElementById('clearSearchBtn');
    
    if (!input) return;
    
    const query = input.value;
    if (clearBtn) clearBtn.style.display = query ? 'block' : 'none';
    
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(async () => {
        if (query.length < 2) {
            await refreshAllViews();
            return;
        }
        
        try {
            const messageIds = searchEngine.search(query);
            const allMessages = await window.messageDB.getAll();
            const filteredMessages = allMessages.filter(msg => messageIds.includes(msg.id));
            
            // Update virtual scroll dengan hasil pencarian
            const inboxMessages = filteredMessages.filter(msg => msg.isRead);
            const updatesMessages = filteredMessages.filter(msg => !msg.isRead);
            
            if (virtualScrollManagers.inbox) {
                virtualScrollManagers.inbox.items = sortMessagesByDate(inboxMessages);
                virtualScrollManagers.inbox.totalItems = inboxMessages.length;
                virtualScrollManagers.inbox.updateTotalHeight();
                virtualScrollManagers.inbox.updateVisibleRange();
            }
            
            if (virtualScrollManagers.updates) {
                virtualScrollManagers.updates.items = sortMessagesByDate(updatesMessages);
                virtualScrollManagers.updates.totalItems = updatesMessages.length;
                virtualScrollManagers.updates.updateTotalHeight();
                virtualScrollManagers.updates.updateVisibleRange();
            }
            
            Analytics.trackEvent('search', 'query', query, filteredMessages.length);
            
        } catch (e) {
            log('Search error:', e);
        }
    }, 300);
}

// ========== FILTER FUNCTIONS ==========
function toggleFilterPanel(section) {
    const panel = document.getElementById(`${section}FilterPanel`);
    if (!panel) return;
    
    const isVisible = panel.style.display === 'block';
    
    // Tutup panel lain
    if (section === 'inbox') {
        const updatesPanel = document.getElementById('updatesFilterPanel');
        if (updatesPanel) updatesPanel.style.display = 'none';
    } else {
        const inboxPanel = document.getElementById('inboxFilterPanel');
        if (inboxPanel) inboxPanel.style.display = 'none';
    }
    
    panel.style.display = isVisible ? 'none' : 'block';
    
    if (!isVisible) {
        Analytics.trackEvent('filter', 'open', section);
    }
}

let filterTimeout;

function debounceFilter(section) {
    if (filterTimeout) clearTimeout(filterTimeout);
    filterTimeout = setTimeout(() => applyFilters(section), 500);
}

async function applyFilters(section) {
    // Update filter state
    filterState[section] = {
        status: document.getElementById(`${section}StatusFilter`)?.value || 'all',
        dateFrom: document.getElementById(`${section}DateFrom`)?.value || '',
        dateTo: document.getElementById(`${section}DateTo`)?.value || '',
        sender: document.getElementById(`${section}SenderFilter`)?.value || '',
        keyword: document.getElementById(`${section}KeywordFilter`)?.value || '',
        active: true
    };
    
    // Cek apakah ada filter aktif
    const hasActiveFilter = checkActiveFilters(section);
    updateFilterBadge(section, hasActiveFilter);
    
    // Update filter chips
    updateFilterChips(section);
    
    // Refresh view dengan filter
    await virtualScrollManagers[section]?.refresh(filterState[section]);
    
    // Update stats
    try {
        const total = await window.messageDB.getTotalCount(null, section);
        const filtered = await window.messageDB.getTotalCount(filterState[section], section);
        updateFilterStats(section, filtered, total);
    } catch (e) {
        log('Error updating filter stats:', e);
    }
    
    Analytics.trackEvent('filter', 'apply', section, filtered);
}

function checkActiveFilters(section) {
    const filters = filterState[section];
    return filters.status !== 'all' || 
           filters.dateFrom || 
           filters.dateTo || 
           filters.sender || 
           filters.keyword;
}

function updateFilterBadge(section, hasFilter) {
    const badge = document.getElementById(`${section}FilterBadge`);
    const toggleBtn = document.getElementById(section === 'inbox' ? 'filterToggleBtn' : 'updatesFilterToggleBtn');
    
    if (!badge || !toggleBtn) return;
    
    if (hasFilter) {
        badge.style.display = 'flex';
        toggleBtn.style.background = 'var(--accent)';
        toggleBtn.style.color = 'white';
    } else {
        badge.style.display = 'none';
        toggleBtn.style.background = '';
        toggleBtn.style.color = '';
    }
}

function updateFilterChips(section) {
    const chipsContainer = document.getElementById(`${section}FilterChips`);
    if (!chipsContainer) return;
    
    const filters = filterState[section];
    let chips = [];
    
    if (filters.status !== 'all') {
        let statusText = '';
        switch(filters.status) {
            case 'read': statusText = 'Sudah dibaca'; break;
            case 'unread': statusText = 'Belum dibaca'; break;
            case 'starred': statusText = 'Penting'; break;
            case 'unstarred': statusText = 'Tidak penting'; break;
            case 'attachments': statusText = 'Ada lampiran'; break;
        }
        chips.push({ type: 'status', text: statusText });
    }
    
    if (filters.dateFrom && filters.dateTo) {
        chips.push({ type: 'date', text: `${filters.dateFrom} s/d ${filters.dateTo}` });
    } else if (filters.dateFrom) {
        chips.push({ type: 'date', text: `Dari ${filters.dateFrom}` });
    } else if (filters.dateTo) {
        chips.push({ type: 'date', text: `Sampai ${filters.dateTo}` });
    }
    
    if (filters.sender) {
        chips.push({ type: 'sender', text: `Pengirim: ${filters.sender}` });
    }
    
    if (filters.keyword) {
        chips.push({ type: 'keyword', text: `"${filters.keyword}"` });
    }
    
    if (chips.length === 0) {
        chipsContainer.innerHTML = '';
        return;
    }
    
    chipsContainer.innerHTML = chips.map(chip => `
        <div class="filter-chip active" onclick="removeFilter('${section}', '${chip.type}')">
            <i class="bi bi-x-lg"></i>
            <span>${chip.text}</span>
        </div>
    `).join('');
}

function removeFilter(section, filterType) {
    switch(filterType) {
        case 'status':
            const statusEl = document.getElementById(`${section}StatusFilter`);
            if (statusEl) statusEl.value = 'all';
            filterState[section].status = 'all';
            break;
        case 'date':
            const fromEl = document.getElementById(`${section}DateFrom`);
            const toEl = document.getElementById(`${section}DateTo`);
            if (fromEl) fromEl.value = '';
            if (toEl) toEl.value = '';
            filterState[section].dateFrom = '';
            filterState[section].dateTo = '';
            break;
        case 'sender':
            const senderEl = document.getElementById(`${section}SenderFilter`);
            if (senderEl) senderEl.value = '';
            filterState[section].sender = '';
            break;
        case 'keyword':
            const keywordEl = document.getElementById(`${section}KeywordFilter`);
            if (keywordEl) keywordEl.value = '';
            filterState[section].keyword = '';
            break;
    }
    
    applyFilters(section);
}

async function resetFilters(section) {
    // Reset form inputs
    const statusEl = document.getElementById(`${section}StatusFilter`);
    const fromEl = document.getElementById(`${section}DateFrom`);
    const toEl = document.getElementById(`${section}DateTo`);
    const senderEl = document.getElementById(`${section}SenderFilter`);
    const keywordEl = document.getElementById(`${section}KeywordFilter`);
    
    if (statusEl) statusEl.value = 'all';
    if (fromEl) fromEl.value = '';
    if (toEl) toEl.value = '';
    if (senderEl) senderEl.value = '';
    if (keywordEl) keywordEl.value = '';
    
    // Reset state
    filterState[section] = {
        status: 'all',
        dateFrom: '',
        dateTo: '',
        sender: '',
        keyword: '',
        active: false
    };
    
    // Update UI
    updateFilterBadge(section, false);
    const chipsContainer = document.getElementById(`${section}FilterChips`);
    if (chipsContainer) chipsContainer.innerHTML = '';
    
    // Refresh view
    await virtualScrollManagers[section]?.refresh();
    
    // Update stats
    try {
        const total = await window.messageDB.getTotalCount(null, section);
        updateFilterStats(section, total, total);
    } catch (e) {
        log('Error updating filter stats:', e);
    }
    
    Analytics.trackEvent('filter', 'reset', section);
}

function updateFilterStats(section, filtered, total) {
    const statsEl = document.getElementById(`${section}FilterStats`);
    if (!statsEl) return;
    
    if (filtered === total) {
        statsEl.textContent = `Menampilkan semua pesan (${total})`;
    } else {
        statsEl.textContent = `Menampilkan ${filtered} dari ${total} pesan`;
    }
}

// Quick Filters
async function filterToday(section) {
    const today = new Date().toISOString().split('T')[0];
    
    const fromEl = document.getElementById(`${section}DateFrom`);
    const toEl = document.getElementById(`${section}DateTo`);
    
    if (fromEl) fromEl.value = today;
    if (toEl) toEl.value = today;
    
    await applyFilters(section);
    Analytics.trackEvent('filter', 'quick', 'today');
}

async function filterThisWeek(section) {
    const today = new Date();
    const firstDay = new Date(today);
    firstDay.setDate(today.getDate() - today.getDay());
    const lastDay = new Date(firstDay);
    lastDay.setDate(firstDay.getDate() + 6);
    
    const fromEl = document.getElementById(`${section}DateFrom`);
    const toEl = document.getElementById(`${section}DateTo`);
    
    if (fromEl) fromEl.value = firstDay.toISOString().split('T')[0];
    if (toEl) toEl.value = lastDay.toISOString().split('T')[0];
    
    await applyFilters(section);
    Analytics.trackEvent('filter', 'quick', 'this_week');
}

async function filterThisMonth(section) {
    const today = new Date();
    const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
    const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    
    const fromEl = document.getElementById(`${section}DateFrom`);
    const toEl = document.getElementById(`${section}DateTo`);
    
    if (fromEl) fromEl.value = firstDay.toISOString().split('T')[0];
    if (toEl) toEl.value = lastDay.toISOString().split('T')[0];
    
    await applyFilters(section);
    Analytics.trackEvent('filter', 'quick', 'this_month');
}

// ========== EXPORT FILTERED RESULTS ==========
async function exportFilteredResults(section) {
    try {
        showGlobalLoading(true);
        
        const filter = filterState[section].active ? filterState[section] : null;
        const messages = await window.messageDB.getAll();
        
        let filteredMessages = messages;
        if (section === 'inbox') {
            filteredMessages = messages.filter(m => m.isRead);
        } else {
            filteredMessages = messages.filter(m => !m.isRead);
        }
        
        if (filter) {
            filteredMessages = filteredMessages.filter(m => {
                const msgFilter = { ...filter };
                return window.messageDB.matchesFilter(m, msgFilter);
            });
        }
        
        const exportData = {
            version: CONFIG.DB_VERSION,
            timestamp: Date.now(),
            section: section,
            filter: filter || 'none',
            totalMessages: filteredMessages.length,
            messages: filteredMessages.map(m => ({
                id: m.id,
                from: m.from,
                subject: m.subject,
                message: m.message,
                created: m.created,
                isRead: m.isRead,
                starred: m.starred,
                hasAttachments: m.hasAttachments
            }))
        };
        
        const data = JSON.stringify(exportData, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `tempmail-${section}-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        
        URL.revokeObjectURL(url);
        showToast(`Export ${filteredMessages.length} pesan berhasil`, 'success');
        Analytics.trackEvent('export', 'filtered', section, filteredMessages.length);
        
    } catch (e) {
        log('Export error:', e);
        showToast('Gagal export', 'error');
        Analytics.trackError(e, 'export');
    } finally {
        showGlobalLoading(false);
    }
}

// ========== MARK ALL AS READ ==========
async function markAllAsRead() {
    showConfirm(
        'Tandai Semua Dibaca',
        'Apakah Anda yakin ingin menandai semua pesan sebagai sudah dibaca?',
        async () => {
            try {
                showGlobalLoading(true);
                
                const messages = await window.messageDB.getAll();
                const unreadMessages = messages.filter(m => !m.isRead);
                
                if (unreadMessages.length === 0) {
                    showToast('Tidak ada pesan baru', 'info');
                    return;
                }
                
                let updated = 0;
                for (const msg of unreadMessages) {
                    msg.isRead = true;
                    await window.messageDB.save(msg);
                    updated++;
                    
                    if (updated % 10 === 0) {
                        showToast(`Memproses ${updated}/${unreadMessages.length}...`, 'info');
                    }
                }
                
                // Rebuild search index
                const allMessages = await window.messageDB.getAll();
                await searchEngine.buildIndex(allMessages);
                
                await refreshAllViews();
                broadcastUpdate('MESSAGES_UPDATED', {});
                
                showToast(`${updated} pesan ditandai sudah dibaca`, 'success');
                Analytics.trackEvent('message', 'mark_all_read', 'success', updated);
                
                // Close filter panel
                const updatesPanel = document.getElementById('updatesFilterPanel');
                if (updatesPanel) updatesPanel.style.display = 'none';
                
            } catch (e) {
                log('Mark all as read error:', e);
                showToast('Gagal menandai pesan', 'error');
                Analytics.trackError(e, 'markAllAsRead');
            } finally {
                showGlobalLoading(false);
            }
        }
    );
}

// ========== TAB NAVIGATION ==========
function switchTab(viewId, element) {
    document.querySelectorAll('.tab-view').forEach(el => el.classList.remove('active'));
    const targetTab = document.getElementById(viewId);
    if (targetTab) targetTab.classList.add('active');
    
    if (element) { 
        document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
        element.classList.add('active');
    }
    
    // Close filter panels when switching tabs
    const inboxPanel = document.getElementById('inboxFilterPanel');
    const updatesPanel = document.getElementById('updatesFilterPanel');
    if (inboxPanel) inboxPanel.style.display = 'none';
    if (updatesPanel) updatesPanel.style.display = 'none';
}

// ========== AUTO REFRESH ==========
function startAutoRefresh() {
    stopAutoRefresh();
    
    refreshTimeLeft = CONFIG.REFRESH_INTERVAL;
    updateTimerDisplay();
    
    autoRefreshInterval = setInterval(() => {
        refreshTimeLeft--;
        updateTimerDisplay();
        
        if (refreshTimeLeft <= 0) {
            fetchInbox();
            refreshTimeLeft = CONFIG.REFRESH_INTERVAL;
        }
    }, 1000);
    
    log('Auto refresh started');
}

function stopAutoRefresh() {
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
    }
}

function updateTimerDisplay() {
    const timerText = document.getElementById('timerText');
    if (timerText) {
        timerText.innerText = `Auto-refresh: ${refreshTimeLeft}s`;
    }
}

// ========== EMAIL GENERATION ==========
async function confirmNewEmail() {
    showConfirm(
        'Buat Email Baru',
        'Email baru akan dibuat dan inbox lama akan dihapus permanen. Lanjutkan?',
        generateNewEmail
    );
}

async function generateNewEmail() {
    const emailDisplay = document.getElementById('emailAddress');
    if (!emailDisplay) return;
    
    const originalEmail = emailDisplay.innerText;
    
    emailDisplay.innerText = "Membuat ID baru...";
    setButtonLoading('newEmailFab', true);
    
    try {
        stopAutoRefresh();
        
        const response = await fetch('/api?action=generate');
        if (!response.ok) throw new Error('Network response failed');
        
        const data = await response.json();
        
        if (data.success && data.result && data.result.email) {
            await window.messageDB.clear();
            
            currentEmail = data.result.email;
            localStorage.setItem('jhon_mail', currentEmail);
            emailDisplay.innerText = currentEmail;
            
            // Tambahkan ke account manager
            if (accountManager && !accountManager.accounts.includes(currentEmail)) {
                accountManager.addAccount(currentEmail);
                accountManager.switchAccount(currentEmail);
            }
            
            // Rebuild search index
            await searchEngine.buildIndex([]);
            
            await refreshAllViews();
            updateBadge(0);
            
            switchTab('view-home', document.querySelector('.nav-item:first-child'));
            
            showToast('Email baru berhasil dibuat', 'success');
            
            refreshTimeLeft = CONFIG.REFRESH_INTERVAL;
            startAutoRefresh();
            
            Analytics.trackEvent('email', 'generate', 'success');
        } else {
            throw new Error(data.result || 'Gagal generate email');
        }
    } catch (e) {
        log('Generate email error:', e);
        emailDisplay.innerText = originalEmail;
        showToast('Gagal: ' + e.message, 'error');
        Analytics.trackError(e, 'generateEmail');
    } finally {
        setButtonLoading('newEmailFab', false);
    }
}

// ========== FETCH INBOX ==========
async function fetchInbox() {
    if (!currentEmail) return;

    try {
        showSkeleton('read', true);
        showSkeleton('unread', true);
        
        const response = await fetch(`/api?action=inbox&email=${encodeURIComponent(currentEmail)}`);
        if (!response.ok) throw new Error('Network response failed');
        
        const data = await response.json();

        if (data.success && data.result && Array.isArray(data.result.inbox)) {
            const serverMessages = data.result.inbox;
            const existingMessages = await window.messageDB.getAll();
            let newMessagesCount = 0;
            
            for (const msg of serverMessages) {
                if (!msg.from || !msg.created) continue;
                
                const msgId = `${msg.created}_${msg.from}`.replace(/\s/g, '');
                const exists = existingMessages.find(m => m.id === msgId);
                
                if (!exists) {
                    await window.messageDB.save({ 
                        ...msg, 
                        id: msgId, 
                        isRead: false,
                        starred: false,
                        message: msg.message || '(Kosong)',
                        subject: msg.subject || '(Tanpa Subjek)'
                    });
                    newMessagesCount++;
                }
            }
            
            if (newMessagesCount > 0) {
                showToast(`${newMessagesCount} pesan baru diterima`, 'success');
                if (navigator.vibrate) navigator.vibrate(200);
            }
            
            // Rebuild search index
            const allMessages = await window.messageDB.getAll();
            await searchEngine.buildIndex(allMessages);
            
            await refreshAllViews();
            
            Analytics.trackEvent('inbox', 'fetch', 'success', newMessagesCount);
        }
    } catch (e) {
        log('Fetch inbox error:', e);
        if (e.message !== 'Request timeout') {
            showToast('Gagal mengambil pesan', 'error');
        }
    } finally {
        showSkeleton('read', false);
        showSkeleton('unread', false);
    }
}

// ========== OPEN MESSAGE ==========
async function openMessage(msgId) {
    if (!isValidMessageId(msgId)) return;
    
    try {
        const messages = await window.messageDB.getAll();
        const msg = messages.find(m => m.id === msgId);
        
        if (!msg) {
            showToast('Pesan tidak ditemukan', 'error');
            return;
        }
        
        currentMessageId = msgId;
        
        // Render attachments
        const attachments = window.messageDB.detectAttachments(msg.message || '');
        const attachmentsContainer = document.getElementById('modalAttachments');
        
        if (attachmentsContainer) {
            if (attachments.length > 0) {
                attachmentsContainer.innerHTML = `
                    <div class="attachments-label">Lampiran:</div>
                    <div class="attachments-list">
                        ${attachments.map(att => `
                            <div class="attachment-item" onclick="window.open('${att.url}', '_blank')">
                                <i class="bi ${att.type === 'image' ? 'bi-file-image' : 'bi-link'}"></i>
                                <span>${escapeString(att.filename)}</span>
                            </div>
                        `).join('')}
                    </div>
                `;
                attachmentsContainer.style.display = 'block';
            } else {
                attachmentsContainer.style.display = 'none';
            }
        }
        
        // Update star button
        const starBtn = document.getElementById('starCurrentBtn');
        if (starBtn) {
            const starIcon = starBtn.querySelector('i');
            if (starIcon) {
                starIcon.className = msg.starred ? 'bi bi-star-fill' : 'bi bi-star';
                if (msg.starred) starIcon.style.color = 'var(--accent)';
                else starIcon.style.color = '';
            }
        }
        
        // Set modal content
        const initial = msg.from ? msg.from.charAt(0).toUpperCase() : '?';
        const subjectEl = document.getElementById('modalSubject');
        const bodyEl = document.getElementById('modalBody');
        const metaEl = document.getElementById('modalMeta');
        
        if (subjectEl) subjectEl.innerText = msg.subject || '(Tanpa Subjek)';
        if (bodyEl) bodyEl.innerText = msg.message || '(Kosong)';
        
        if (metaEl) {
            metaEl.innerHTML = `
                <div class="meta-avatar">${escapeString(initial)}</div>
                <div class="meta-info">
                    <div class="meta-from" title="${escapeString(msg.from || 'Unknown')}">
                        ${escapeString(msg.from || 'Unknown')}
                    </div>
                    <div class="meta-time">${escapeString(msg.created || '')}</div>
                </div>
            `;
        }
        
        const modal = document.getElementById('msgModal');
        if (modal) {
            modal.classList.add('show');
            document.body.classList.add('modal-open');
        }

        // Tandai sebagai sudah dibaca
        if (!msg.isRead) {
            msg.isRead = true;
            await window.messageDB.save(msg);
            await refreshAllViews();
            broadcastUpdate('MESSAGES_UPDATED', {});
        }
        
        Analytics.trackEvent('message', 'open', msg.isRead ? 'read' : 'unread');
        
    } catch (e) {
        log('Open message error:', e);
        showToast('Gagal membuka pesan', 'error');
        Analytics.trackError(e, 'openMessage');
    }
}

// ========== TOGGLE STARRED ==========
async function toggleStarred(msgId) {
    try {
        const messages = await window.messageDB.getAll();
        const msg = messages.find(m => m.id === msgId);
        
        if (msg) {
            msg.starred = !msg.starred;
            await window.messageDB.save(msg);
            
            // Rebuild search index
            const allMessages = await window.messageDB.getAll();
            await searchEngine.buildIndex(allMessages);
            
            await refreshAllViews();
            broadcastUpdate('MESSAGES_UPDATED', {});
            
            showToast(msg.starred ? 'Ditandai penting' : 'Tidak penting', 'success');
            Analytics.trackEvent('message', 'star', msg.starred ? 'add' : 'remove');
        }
    } catch (e) {
        log('Toggle starred error:', e);
        showToast('Gagal menandai pesan', 'error');
    }
}

function toggleStarCurrentMessage() {
    if (currentMessageId) {
        toggleStarred(currentMessageId);
    }
}

// ========== CLOSE MODAL ==========
function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
        modal.classList.remove('show');
        document.body.classList.remove('modal-open');
    }
}

// ========== UPDATE BADGE ==========
function updateBadge(count) {
    const badge = document.getElementById('badge-count');
    const dot = document.getElementById('nav-dot');
    
    if (badge && dot) {
        if (count > 0) {
            badge.innerText = count;
            badge.style.display = 'inline-block';
            dot.style.display = 'block';
            document.title = `(${count}) TempMail`;
        } else {
            badge.style.display = 'none';
            dot.style.display = 'none';
            document.title = 'TempMail';
        }
    }
}

// ========== COPY EMAIL ==========
function copyEmail() {
    if (!currentEmail) {
        showToast('Tidak ada email', 'error');
        return;
    }
    
    navigator.clipboard.writeText(currentEmail).then(() => {
        showToast('Email disalin!', 'success');
        Analytics.trackEvent('email', 'copy', 'success');
    }).catch(() => {
        showToast('Gagal menyalin', 'error');
    });
}

// ========== CLEAR INBOX ==========
async function clearInbox() {
    showConfirm(
        'Hapus Inbox',
        'Semua pesan yang sudah dibaca akan dihapus permanen. Lanjutkan?',
        async () => {
            try {
                setButtonLoading('clearInboxBtn', true);
                
                const messages = await window.messageDB.getAll();
                const readMessages = messages.filter(m => m.isRead);
                
                for (const msg of readMessages) {
                    await window.messageDB.delete(msg.id);
                }
                
                // Rebuild search index
                const allMessages = await window.messageDB.getAll();
                await searchEngine.buildIndex(allMessages);
                
                await refreshAllViews();
                broadcastUpdate('MESSAGES_UPDATED', {});
                
                showToast('Inbox telah dibersihkan', 'success');
                Analytics.trackEvent('inbox', 'clear', 'success', readMessages.length);
                
            } catch (e) {
                log('Clear inbox error:', e);
                showToast('Gagal membersihkan inbox', 'error');
                Analytics.trackError(e, 'clearInbox');
            } finally {
                setButtonLoading('clearInboxBtn', false);
            }
        }
    );
}

// ========== SHARE FUNCTIONS ==========
function openShareModal() {
    // Update data capture
    const capEmail = document.getElementById('capEmail');
    const capSubject = document.getElementById('capSubject');
    const capMsg = document.getElementById('capMsg');
    
    const fromElement = document.querySelector('.meta-from');
    const subjectElement = document.getElementById('modalSubject');
    const bodyElement = document.getElementById('modalBody');
    
    if (capEmail && fromElement) capEmail.innerText = fromElement.innerText;
    if (capSubject && subjectElement) capSubject.innerText = subjectElement.innerText;
    if (capMsg && bodyElement) capMsg.innerText = bodyElement.innerText;
    
    closeModal('msgModal');
    
    setTimeout(() => {
        const modal = document.getElementById('shareMsgModal');
        if (modal) {
            modal.classList.add('show');
            document.body.classList.add('modal-open');
        }
    }, 300);
}

async function shareAsImage() {
    const captureCard = document.getElementById('capture-card');
    const shareBtn = document.getElementById('shareImageBtn');
    
    setButtonLoading('shareImageBtn', true);
    showToast('Membuat gambar...', 'info');
    
    try {
        if (!captureCard) throw new Error('Capture card not found');
        
        captureCard.style.position = 'fixed';
        captureCard.style.left = '50%';
        captureCard.style.top = '50%';
        captureCard.style.transform = 'translate(-50%, -50%)';
        captureCard.style.zIndex = '-1';
        
        const canvas = await html2canvas(captureCard, {
            scale: 2,
            backgroundColor: '#ffffff',
            logging: false,
            allowTaint: false,
            useCORS: true
        });
        
        captureCard.style.position = '';
        captureCard.style.left = '';
        captureCard.style.top = '';
        captureCard.style.transform = '';
        captureCard.style.zIndex = '';
        
        const image = canvas.toDataURL('image/png');
        
        if (navigator.share && navigator.canShare) {
            try {
                const blob = await (await fetch(image)).blob();
                const file = new File([blob], `tempmail-${Date.now()}.png`, { type: 'image/png' });
                
                if (navigator.canShare({ files: [file] })) {
                    await navigator.share({
                        title: 'Pesan TempMail',
                        files: [file]
                    });
                    showToast('Berhasil dibagikan!', 'success');
                } else {
                    downloadImage(image);
                }
            } catch (shareErr) {
                downloadImage(image);
            }
        } else {
            downloadImage(image);
        }
        
        Analytics.trackEvent('share', 'image', 'success');
        
    } catch (error) {
        log('HTML2Canvas error:', error);
        showToast('Gagal membuat gambar', 'error');
        Analytics.trackError(error, 'shareImage');
    } finally {
        setButtonLoading('shareImageBtn', false);
        closeModal('shareMsgModal');
    }
}

function downloadImage(imageData) {
    try {
        const link = document.createElement('a');
        link.download = `tempmail-${Date.now()}.png`;
        link.href = imageData;
        link.click();
        showToast('Gambar tersimpan', 'success');
    } catch (e) {
        log('Download error:', e);
        showToast('Gagal menyimpan gambar', 'error');
    }
}

function shareToWaText() {
    try {
        const modalSubject = document.getElementById('modalSubject')?.innerText || '';
        const modalBody = document.getElementById('modalBody')?.innerText || '';
        const modalFrom = document.querySelector('.meta-from')?.innerText || 'Unknown';
        const modalTime = document.querySelector('.meta-time')?.innerText || '';
        
        const text = `*${modalSubject}*\n\n📧 *Dari:* ${modalFrom}\n⏰ *Waktu:* ${modalTime}\n\n📝 *Pesan:*\n${modalBody}\n\n━━━━━━━━━━━━━━\n_Dikirim via TempMail_`;
        
        const waUrl = `https://wa.me/?text=${encodeURIComponent(text)}`;
        window.open(waUrl, '_blank');
        
        closeModal('shareMsgModal');
        Analytics.trackEvent('share', 'whatsapp', 'success');
        
    } catch (e) {
        log('WA share error:', e);
        showToast('Gagal membuka WhatsApp', 'error');
    }
}

function copyMessageText() {
    try {
        const modalSubject = document.getElementById('modalSubject')?.innerText || '';
        const modalBody = document.getElementById('modalBody')?.innerText || '';
        const modalFrom = document.querySelector('.meta-from')?.innerText || 'Unknown';
        const modalTime = document.querySelector('.meta-time')?.innerText || '';
        
        const text = `*${modalSubject}*\nDari: ${modalFrom}\nWaktu: ${modalTime}\n\n${modalBody}`;
        
        navigator.clipboard.writeText(text).then(() => {
            showToast('Teks disalin!', 'success');
            closeModal('shareMsgModal');
            Analytics.trackEvent('share', 'copy', 'success');
        }).catch(() => {
            showToast('Gagal menyalin teks', 'error');
        });
    } catch (e) {
        log('Copy error:', e);
        showToast('Gagal menyalin teks', 'error');
    }
}

// ========== ACCOUNT MANAGEMENT ==========
function showAddAccountModal() {
    const modal = document.getElementById('addAccountModal');
    if (!modal) return;
    
    modal.classList.add('show');
    document.body.classList.add('modal-open');
    
    const input = document.getElementById('newAccountEmail');
    if (input) {
        input.value = '';
        input.focus();
    }
}

async function addNewAccount() {
    const emailInput = document.getElementById('newAccountEmail');
    if (!emailInput) return;
    
    const email = emailInput.value.trim();
    
    if (!email || !isValidEmail(email)) {
        showToast('Email tidak valid', 'error');
        return;
    }
    
    if (accountManager.addAccount(email)) {
        accountManager.switchAccount(email);
        showToast('Akun ditambahkan', 'success');
        closeModal('addAccountModal');
        
        await generateNewEmail();
        
        Analytics.trackEvent('account', 'add', email);
    } else {
        showToast('Akun sudah ada', 'error');
    }
}

function switchAccount(email) {
    if (!email) return;
    
    if (accountManager.switchAccount(email)) {
        currentEmail = email;
        location.reload();
        Analytics.trackEvent('account', 'switch', email);
    }
}

// ========== DARK MODE ==========
function toggleDarkMode() {
    document.body.classList.toggle('dark-mode');
    const isDark = document.body.classList.contains('dark-mode');
    
    localStorage.setItem('darkMode', isDark);
    updateThemeColor();
    
    const icon = document.querySelector('#darkModeToggle i');
    if (icon) {
        icon.className = isDark ? 'bi bi-sun' : 'bi bi-moon-stars';
    }
    
    broadcastUpdate('DARK_MODE_TOGGLED', { enabled: isDark });
    
    Analytics.trackEvent('ui', 'dark_mode', isDark ? 'on' : 'off');
}

function loadDarkModePreference() {
    const isDark = localStorage.getItem('darkMode') === 'true';
    if (isDark) {
        document.body.classList.add('dark-mode');
        const icon = document.querySelector('#darkModeToggle i');
        if (icon) icon.className = 'bi bi-sun';
    }
}

function updateThemeColor() {
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
        if (document.body.classList.contains('dark-mode')) {
            metaTheme.setAttribute('content', '#1a1a1a');
        } else {
            metaTheme.setAttribute('content', '#F2F4F8');
        }
    }
}

// ========== BACKUP & RESTORE ==========
async function exportInbox() {
    try {
        showGlobalLoading(true);
        
        const messages = await window.messageDB.getAll();
        const backup = {
            version: CONFIG.DB_VERSION,
            timestamp: Date.now(),
            email: currentEmail,
            accounts: accountManager?.accounts || [],
            messages: messages.map(m => ({
                ...m
            })),
            stats: {
                total: messages.length,
                unread: messages.filter(m => !m.isRead).length,
                starred: messages.filter(m => m.starred).length
            }
        };
        
        const data = JSON.stringify(backup, null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `tempmail-backup-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        
        URL.revokeObjectURL(url);
        showToast('Backup berhasil dibuat', 'success');
        Analytics.trackEvent('data', 'export', 'success', messages.length);
        
    } catch (e) {
        log('Export error:', e);
        showToast('Gagal membuat backup', 'error');
        Analytics.trackError(e, 'export');
    } finally {
        showGlobalLoading(false);
    }
}

function importInbox() {
    const modal = document.getElementById('backupModal');
    if (modal) {
        modal.classList.add('show');
        document.body.classList.add('modal-open');
    }
}

function selectBackupFile() {
    const fileInput = document.getElementById('backupFile');
    if (fileInput) fileInput.click();
}

// Setup file input listener
document.addEventListener('DOMContentLoaded', () => {
    const fileInput = document.getElementById('backupFile');
    if (fileInput) {
        fileInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            closeModal('backupModal');
            showGlobalLoading(true);
            
            const reader = new FileReader();
            reader.onload = async (event) => {
                try {
                    const backup = JSON.parse(event.target.result);
                    
                    if (!backup.messages || !Array.isArray(backup.messages)) {
                        throw new Error('Format backup tidak valid');
                    }
                    
                    await window.messageDB.clear();
                    
                    for (const msg of backup.messages) {
                        if (msg.id) {
                            await window.messageDB.save(msg);
                        }
                    }
                    
                    if (backup.accounts && Array.isArray(backup.accounts)) {
                        backup.accounts.forEach(email => {
                            if (email && accountManager && !accountManager.accounts.includes(email)) {
                                accountManager.addAccount(email);
                            }
                        });
                    }
                    
                    if (backup.email && backup.email !== currentEmail && accountManager) {
                        accountManager.addAccount(backup.email);
                        accountManager.switchAccount(backup.email);
                    }
                    
                    // Rebuild search index
                    const allMessages = await window.messageDB.getAll();
                    await searchEngine.buildIndex(allMessages);
                    
                    await refreshAllViews();
                    broadcastUpdate('MESSAGES_UPDATED', {});
                    
                    showToast(`Restore berhasil: ${backup.messages.length} pesan`, 'success');
                    Analytics.trackEvent('data', 'import', 'success', backup.messages.length);
                    
                } catch (e) {
                    log('Import error:', e);
                    showToast('File backup tidak valid', 'error');
                    Analytics.trackError(e, 'import');
                } finally {
                    showGlobalLoading(false);
                    e.target.value = '';
                }
            };
            
            reader.readAsText(file);
        });
    }
});

// ========== MODAL CLICK HANDLERS ==========
function setupModalClickHandlers() {
    const modals = ['msgModal', 'shareMsgModal', 'addAccountModal', 'backupModal', 'confirmModal', 'shortcutsModal'];
    
    modals.forEach(modalId => {
        const modal = document.getElementById(modalId);
        if (modal) {
            modal.addEventListener('click', function(event) {
                if (event.target === modal) {
                    closeModal(modalId);
                }
            });
        }
    });
}

// ========== CLEANUP ==========
window.addEventListener('beforeunload', function() {
    stopAutoRefresh();
    if (window.messageDB && window.messageDB.db) {
        window.messageDB.db.close();
    }
});

window.addEventListener('error', (event) => {
    log('Global error:', event.error);
    showToast('Terjadi kesalahan', 'error');
    if (Analytics) Analytics.trackError(event.error, 'global');
});

window.addEventListener('unhandledrejection', (event) => {
    log('Unhandled rejection:', event.reason);
    showToast('Terjadi kesalahan', 'error');
    if (Analytics) Analytics.trackError(event.reason, 'unhandled');
});