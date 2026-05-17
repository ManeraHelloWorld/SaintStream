// client.js — весь функционал клиента (поиск, WebSocket, загрузка, localStorage, просмотр)

(function() {
    // DOM элементы
    const keywordInput = document.getElementById('keywordInput');
    const searchBtn = document.getElementById('searchBtn');
    const messageArea = document.getElementById('messageArea');
    const resultsContainer = document.getElementById('resultsContainer');
    const urlListDiv = document.getElementById('urlList');
    const downloadBtn = document.getElementById('downloadBtn');
    const progressPanel = document.getElementById('progressPanel');
    const progressBar = document.getElementById('progressBar');
    const statusText = document.getElementById('statusText');
    const cancelBtn = document.getElementById('cancelBtn');
    const savedList = document.getElementById('savedList');
    const viewer = document.getElementById('viewer');

    // Состояние
    let currentUrls = [];           // массив { url, label }
    let selectedUrl = null;
    let ws = null;
    let reconnectAttempts = 0;
    const MAX_RECONNECT = 5;
    let currentDownloadUrl = null;   // для отмены

    // --- Вспомогательные функции ---
    function showMessage(msg, isError = false) {
        messageArea.textContent = msg;
        messageArea.className = 'message-area ' + (isError ? 'error-message' : 'success-message');
        setTimeout(() => {
            if (messageArea.textContent === msg) {
                messageArea.textContent = '';
                messageArea.className = 'message-area';
            }
        }, 5000);
    }

    // Отрисовка списка URL
    function renderUrlList(urls) {
        if (!urls.length) {
            urlListDiv.innerHTML = '<div class="placeholder">No URLs found for this keyword.</div>';
            downloadBtn.disabled = true;
            return;
        }
        const html = urls.map((item, idx) => `
            <div class="url-item">
                <input type="radio" name="urlRadio" value="${idx}" id="url_${idx}">
                <label for="url_${idx}">${item.label || item.url}</label>
            </div>
        `).join('');
        urlListDiv.innerHTML = html;
        // Добавляем слушатели на радио
        document.querySelectorAll('input[name="urlRadio"]').forEach(radio => {
            radio.addEventListener('change', (e) => {
                const idx = parseInt(e.target.value);
                selectedUrl = currentUrls[idx].url;
                downloadBtn.disabled = false;
            });
        });
        downloadBtn.disabled = true;
        selectedUrl = null;
    }

    // Загрузка сохранённых элементов из localStorage
    function loadSavedItems() {
        const saved = localStorage.getItem('savedItems');
        if (!saved) {
            savedList.innerHTML = '<li class="placeholder">No saved content yet. Download something!</li>';
            return;
        }
        try {
            const items = JSON.parse(saved);
            if (!items.length) throw new Error();
            savedList.innerHTML = items.map((item, idx) => `
                <li data-url="${item.url}" data-index="${idx}">
                    <strong>${item.title || item.url}</strong><br>
                    <small>Saved: ${new Date(item.timestamp).toLocaleString()}</small>
                </li>
            `).join('');
            // Добавляем обработчики кликов для просмотра
            document.querySelectorAll('#savedList li').forEach(li => {
                li.addEventListener('click', () => {
                    const url = li.getAttribute('data-url');
                    viewContent(url);
                });
            });
        } catch(e) {
            savedList.innerHTML = '<li class="placeholder">Error loading saved items.</li>';
        }
    }

    // Просмотр сохранённого контента
    function viewContent(url) {
        const key = 'content:' + url;
        const content = localStorage.getItem(key);
        if (!content) {
            viewer.innerHTML = '<p class="placeholder">Content not found in storage.</p>';
            return;
        }
        // Определяем тип по URL или пробуем угадать
        let contentType = 'text/plain';
        if (url.endsWith('.html') || url.endsWith('.htm')) contentType = 'text/html';
        else if (url.match(/\.(css|js|json|xml)$/)) contentType = 'text/plain';
        else contentType = 'text/html'; // по умолчанию

        if (contentType === 'text/html') {
            viewer.innerHTML = `<iframe srcdoc="${escapeHtml(content)}" style="width:100%; height:100%; border:none;"></iframe>`;
        } else {
            viewer.innerHTML = `<pre>${escapeHtml(content)}</pre>`;
        }
    }

    function escapeHtml(str) {
        return str.replace(/[&<>]/g, function(m) {
            if (m === '&') return '&amp;';
            if (m === '<') return '&lt;';
            if (m === '>') return '&gt;';
            return m;
        });
    }

    // Сохранение контента в localStorage
    function saveContentToLocalStorage(url, data, contentType) {
        try {
            const contentKey = 'content:' + url;
            localStorage.setItem(contentKey, data);
            // Обновляем список метаданных
            let savedItems = JSON.parse(localStorage.getItem('savedItems') || '[]');
            // Избегаем дублирования
            if (!savedItems.some(item => item.url === url)) {
                savedItems.unshift({
                    url: url,
                    title: url.split('/').pop() || url,
                    timestamp: Date.now(),
                    contentType: contentType
                });
                localStorage.setItem('savedItems', JSON.stringify(savedItems));
            }
            loadSavedItems();
            showMessage(`Saved: ${url}`, false);
        } catch(e) {
            if (e.name === 'QuotaExceededError') {
                showMessage('Storage full. Delete some items.', true);
            } else {
                showMessage('Failed to save: ' + e.message, true);
            }
        }
    }

    // --- WebSocket ---
    function connectWebSocket() {
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${protocol}//${location.host}`);
        
        ws.onopen = () => {
            console.log('WebSocket connected');
            reconnectAttempts = 0;
            showMessage('Connected to server.', false);
        };
        
        ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data);
                handleWebSocketMessage(msg);
            } catch(e) {
                console.error('Invalid message', e);
            }
        };
        
        ws.onerror = (err) => {
            console.error('WebSocket error', err);
            showMessage('WebSocket error', true);
        };
        
        ws.onclose = () => {
            console.log('WebSocket closed');
            if (reconnectAttempts < MAX_RECONNECT) {
                reconnectAttempts++;
                showMessage(`Connection lost. Reconnecting (${reconnectAttempts}/${MAX_RECONNECT})...`, true);
                setTimeout(connectWebSocket, 2000);
            } else {
                showMessage('Failed to reconnect. Please refresh the page.', true);
            }
        };
    }

    function handleWebSocketMessage(msg) {
        switch(msg.type) {
            case 'progress':
                if (progressBar && msg.total) {
                    const percent = (msg.loaded / msg.total) * 100;
                    progressBar.value = percent;
                    statusText.textContent = `Loading: ${Math.round(percent)}% (${msg.loaded}/${msg.total} bytes)`;
                } else if (msg.loaded) {
                    progressBar.value = msg.loaded;
                    statusText.textContent = `Loading: ${msg.loaded} bytes...`;
                }
                break;
            case 'complete':
                progressPanel.classList.add('hidden');
                statusText.textContent = '';
                progressBar.value = 0;
                saveContentToLocalStorage(msg.url, msg.data, msg.contentType);
                showMessage(`Download complete: ${msg.url}`, false);
                currentDownloadUrl = null;
                break;
            case 'error':
                progressPanel.classList.add('hidden');
                showMessage(`Error: ${msg.error}`, true);
                currentDownloadUrl = null;
                break;
            default:
                console.log('Unknown message type', msg);
        }
    }

    // Отправка запроса на загрузку через WebSocket
    function startDownload(url) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            showMessage('WebSocket not connected. Please wait.', true);
            return;
        }
        currentDownloadUrl = url;
        progressPanel.classList.remove('hidden');
        progressBar.value = 0;
        statusText.textContent = 'Starting download...';
        ws.send(JSON.stringify({ type: 'download', url: url }));
    }

    // Отмена загрузки
    function cancelDownload() {
        if (ws && ws.readyState === WebSocket.OPEN && currentDownloadUrl) {
            ws.send(JSON.stringify({ type: 'cancel' }));
            progressPanel.classList.add('hidden');
            statusText.textContent = '';
            progressBar.value = 0;
            showMessage('Download cancelled', false);
            currentDownloadUrl = null;
        }
    }

    // --- Поиск (API) ---
    async function searchKeyword(keyword) {
        if (!keyword.trim()) {
            showMessage('Please enter a keyword', true);
            return;
        }
        try {
            const response = await fetch('/api/keywords', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ keyword: keyword.trim().toLowerCase() })
            });
            if (!response.ok) {
                if (response.status === 404) {
                    showMessage('No URLs found for this keyword.', true);
                    resultsContainer.classList.add('hidden');
                } else {
                    throw new Error(`Server error: ${response.status}`);
                }
                return;
            }
            const data = await response.json();
            if (data.urls && data.urls.length) {
                currentUrls = data.urls.map(url => ({ url, label: url }));
                renderUrlList(currentUrls);
                resultsContainer.classList.remove('hidden');
                showMessage(`Found ${data.urls.length} link(s).`, false);
            } else {
                resultsContainer.classList.add('hidden');
                showMessage('No results.', true);
            }
        } catch(err) {
            console.error(err);
            showMessage('Search failed: ' + err.message, true);
            resultsContainer.classList.add('hidden');
        }
    }

    // --- Инициализация ---
    function init() {
        connectWebSocket();
        loadSavedItems();
        
        searchBtn.addEventListener('click', () => searchKeyword(keywordInput.value));
        keywordInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') searchKeyword(keywordInput.value);
        });
        
        downloadBtn.addEventListener('click', () => {
            if (selectedUrl) startDownload(selectedUrl);
            else showMessage('Select a link first', true);
        });
        
        cancelBtn.addEventListener('click', cancelDownload);
        
        // Для демонстрации: пример заполнения (позже убрать)
        // keywordInput.value = 'example';
    }
    
    init();
})();