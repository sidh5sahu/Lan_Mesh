// ═══════════════════════════════════════════════════════════
// LanMesh — Frontend Application v2
// ═══════════════════════════════════════════════════════════

// ── State ────────────────────────────────────────────────
let bridge = null;
let myId = null;
let currentPeer = null;
let peerConnection = null;
let localStream = null;
let peerMap = {};          // uuid -> peer object (username, ip, etc.)
let chatMessages = {};     // uuid -> [{text, type, time, fileInfo?}]
let unreadCounts = {};     // uuid -> count
let typingTimers = {};     // uuid -> timeout
let myTypingTimer = null;
let isMuted = false;

// ── UI Elements ──────────────────────────────────────────
const peerListEl = document.getElementById('peer-list');
const chatArea = document.getElementById('chat-area');
const msgInput = document.getElementById('msg-input');
const sendBtn = document.getElementById('btn-send');
const chatTitle = document.getElementById('chat-title');
const typingLabel = document.getElementById('typing-label');
const videoOverlay = document.getElementById('video-overlay');
const localVideo = document.getElementById('localstream');
const remoteVideo = document.getElementById('remotestream');
const loginOverlay = document.getElementById('login-overlay');
const usernameInput = document.getElementById('login-username');
const loginBtn = document.getElementById('btn-login');
const dropOverlay = document.getElementById('drop-overlay');
const emojiPicker = document.getElementById('emoji-picker');
const emojiGrid = document.getElementById('emoji-grid');
const fileInputHidden = document.getElementById('file-input-hidden');
const peerCountEl = document.getElementById('peer-count');
const toastContainer = document.getElementById('toast-container');

// ── WebRTC Config ────────────────────────────────────────
const rtcConfig = { iceServers: [] };

// ── Emoji Data ───────────────────────────────────────────
const emojis = [
    '😀','😂','😍','🥰','😎','🤩','😢','😡',
    '👍','👎','👏','🙌','🤝','💪','🎉','🔥',
    '❤️','💙','💚','💜','🖤','🤍','💯','✨',
    '🚀','⭐','🌟','💡','🎯','🏆','📁','📎',
    '✅','❌','⚠️','ℹ️','🔔','🔒','🌐','💬',
];

// ── Initialize QWebChannel ───────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
    initEmojiGrid();

    new QWebChannel(qt.webChannelTransport, function (channel) {
        bridge = channel.objects.backend;

        // Connect Signals
        bridge.authStatus.connect(handleAuthStatus);
        bridge.peerUpdate.connect(handlePeerUpdate);
        bridge.chatMessage.connect(handleIncomingMessage);
        bridge.signalReceived.connect(handleIncomingSignal);
        bridge.fileReceived.connect(handleFileReceived);
        bridge.typingUpdate.connect(handleTypingUpdate);
        bridge.chatHistoryLoaded.connect(handleChatHistoryLoaded);

        // Initial Auth Check
        bridge.checkAuth();
    });
});

// ═══════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════
function handleAuthStatus(authenticated, username) {
    if (authenticated) {
        loginOverlay.style.display = 'none';
        myId = username;
        document.getElementById('my-username').textContent = username;
        document.getElementById('my-avatar').textContent = username.substring(0, 2).toUpperCase();
        document.getElementById('my-ip').textContent = "P2P Node Active";
    } else {
        loginOverlay.style.display = 'flex';
    }
}

loginBtn.onclick = () => {
    const username = usernameInput.value.trim();
    if (!username) return;
    loginBtn.disabled = true;
    loginBtn.textContent = 'Securing...';
    bridge.registerUser(username);
};

usernameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loginBtn.click();
});

// ═══════════════════════════════════════════════════════════
// PEER MANAGEMENT
// ═══════════════════════════════════════════════════════════
function handlePeerUpdate(peersJson) {
    const peers = JSON.parse(peersJson);
    const oldIds = Object.keys(peerMap);
    const newIds = peers.map(p => p.id);

    // Detect new peers & show toast
    peers.forEach(p => {
        if (!peerMap[p.id]) {
            showToast(`${p.username} joined the mesh`, 'info');
        }
        peerMap[p.id] = p;
    });

    // Detect departed peers
    oldIds.forEach(id => {
        if (!newIds.includes(id)) {
            showToast(`${peerMap[id]?.username || 'Peer'} left the mesh`, 'info');
            delete peerMap[id];
        }
    });

    peerCountEl.textContent = `${peers.length} peer${peers.length !== 1 ? 's' : ''}`;
    renderPeers(peers);
}

function renderPeers(peers) {
    peerListEl.innerHTML = '';
    peers.forEach(peer => {
        const el = document.createElement('div');
        el.id = `peer-${peer.id}`;
        el.className = `peer-item ${currentPeer === peer.id ? 'active' : ''}`;

        const badge = unreadCounts[peer.id] > 0
            ? `<div class="badge">${unreadCounts[peer.id]}</div>`
            : '';

        el.innerHTML = `
            <div class="avatar">${peer.username.substring(0, 2).toUpperCase()}</div>
            <div class="peer-data" style="width: 100%;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div class="peer-name">${peer.username}</div>
                    <div class="status-dot"></div>
                </div>
                <div class="peer-ip" style="font-size: 0.73rem; color: var(--text-muted); padding-top: 2px;">${peer.ip}</div>
            </div>
            ${badge}
        `;
        el.onclick = () => selectPeer(peer);
        peerListEl.appendChild(el);
    });
}

function selectPeer(peer) {
    currentPeer = peer.id;
    chatTitle.textContent = `Chat with ${peer.username}`;
    typingLabel.textContent = '';
    msgInput.disabled = false;
    sendBtn.disabled = false;

    // Clear unread
    unreadCounts[peer.id] = 0;

    // Highlight active
    document.querySelectorAll('.peer-item').forEach(e => e.classList.remove('active'));
    document.getElementById(`peer-${peer.id}`)?.classList.add('active');

    // Load chat history — show cached first, then request from storage
    if (chatMessages[peer.id]) {
        renderChatMessages(peer.id);
    } else {
        chatArea.innerHTML = '';
        bridge.loadChatHistory(peer.id);
    }
}

// ═══════════════════════════════════════════════════════════
// CHAT
// ═══════════════════════════════════════════════════════════
sendBtn.onclick = () => {
    const text = msgInput.value.trim();
    if (!text || !currentPeer) return;

    bridge.sendChatMessage(currentPeer, text);
    addMessage(currentPeer, text, 'sent');
    msgInput.value = '';

    // Stop typing indicator
    clearMyTyping();
};

msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendBtn.click();
    }
});

// Typing indicator — debounced
msgInput.addEventListener('input', () => {
    if (!currentPeer || !bridge) return;

    bridge.sendTypingIndicator(currentPeer, true);

    clearTimeout(myTypingTimer);
    myTypingTimer = setTimeout(() => {
        clearMyTyping();
    }, 2000);
});

function clearMyTyping() {
    if (currentPeer && bridge) {
        bridge.sendTypingIndicator(currentPeer, false);
    }
    clearTimeout(myTypingTimer);
    myTypingTimer = null;
}

function handleIncomingMessage(fromUuid, text) {
    addMessage(fromUuid, text, 'received');

    if (fromUuid !== currentPeer) {
        // Increment unread badge
        unreadCounts[fromUuid] = (unreadCounts[fromUuid] || 0) + 1;
        const peerInfo = peerMap[fromUuid];
        showToast(`${peerInfo?.username || 'Peer'}: ${text.substring(0, 50)}`, 'info');
        refreshPeerList();
    }
}

function addMessage(peerId, text, type, fileInfo = null) {
    if (!chatMessages[peerId]) chatMessages[peerId] = [];

    const msg = {
        text: text,
        type: type,
        time: new Date().toISOString(),
        fileInfo: fileInfo
    };

    chatMessages[peerId].push(msg);

    // Save to persistent storage
    bridge.saveChatHistory(peerId, JSON.stringify(chatMessages[peerId]));

    // If this peer is currently active, render the message
    if (peerId === currentPeer) {
        appendMessageEl(msg);
    }
}

function renderChatMessages(peerId) {
    chatArea.innerHTML = '';
    const msgs = chatMessages[peerId] || [];
    let lastDate = '';

    msgs.forEach(msg => {
        const msgDate = formatDate(msg.time);
        if (msgDate !== lastDate) {
            appendDateSeparator(msgDate);
            lastDate = msgDate;
        }
        appendMessageEl(msg);
    });
}

function appendMessageEl(msg) {
    const div = document.createElement('div');
    div.className = `message ${msg.type}`;

    if (msg.fileInfo) {
        const sizeStr = formatFileSize(msg.fileInfo.size);
        div.innerHTML = `
            <div class="file-card" onclick="openFile('${escapeHtml(msg.fileInfo.path || '')}')">
                <div class="file-icon">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                    </svg>
                </div>
                <div class="file-info">
                    <div class="file-name">${escapeHtml(msg.fileInfo.name)}</div>
                    <div class="file-size">${sizeStr}</div>
                </div>
            </div>
            <div class="msg-time">${formatTime(msg.time)}</div>
        `;
    } else {
        div.innerHTML = `
            <div class="msg-content">${escapeHtml(msg.text)}</div>
            <div class="msg-time">${formatTime(msg.time)}</div>
        `;
    }

    chatArea.appendChild(div);
    chatArea.scrollTop = chatArea.scrollHeight;
}

function appendDateSeparator(dateStr) {
    const sep = document.createElement('div');
    sep.className = 'date-separator';
    sep.innerHTML = `<span>${dateStr}</span>`;
    chatArea.appendChild(sep);
}

// ═══════════════════════════════════════════════════════════
// CHAT HISTORY
// ═══════════════════════════════════════════════════════════
function handleChatHistoryLoaded(peerId, messagesJson) {
    try {
        const msgs = JSON.parse(messagesJson);
        if (msgs.length > 0) {
            chatMessages[peerId] = msgs;
        }
    } catch (e) {
        console.error('Failed to parse chat history:', e);
    }

    if (peerId === currentPeer) {
        renderChatMessages(peerId);
    }
}

// ═══════════════════════════════════════════════════════════
// TYPING INDICATOR
// ═══════════════════════════════════════════════════════════
function handleTypingUpdate(fromUuid, isTyping) {
    if (fromUuid !== currentPeer) return;

    if (isTyping) {
        const peerInfo = peerMap[fromUuid];
        typingLabel.textContent = `${peerInfo?.username || 'Peer'} is typing...`;

        // Auto-clear after 3s in case stop signal is lost
        clearTimeout(typingTimers[fromUuid]);
        typingTimers[fromUuid] = setTimeout(() => {
            typingLabel.textContent = '';
        }, 3000);
    } else {
        typingLabel.textContent = '';
        clearTimeout(typingTimers[fromUuid]);
    }
}

// ═══════════════════════════════════════════════════════════
// FILE TRANSFER
// ═══════════════════════════════════════════════════════════
document.getElementById('btn-file').onclick = () => {
    if (!currentPeer) return;
    fileInputHidden.click();
};

fileInputHidden.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file || !currentPeer) return;

    // Use the file path from input — in Qt WebEngine this gives real path
    const path = fileInputHidden.value;
    if (path) {
        bridge.sendFile(currentPeer, path);
        addMessage(currentPeer, '', 'sent', {
            name: file.name,
            size: file.size,
            path: ''
        });
        showToast(`Sending ${file.name}...`, 'file');
    }

    fileInputHidden.value = '';  // Reset
});

// Drag and Drop
const mainEl = document.querySelector('main');

mainEl.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (currentPeer) dropOverlay.classList.add('active');
});

mainEl.addEventListener('dragover', (e) => {
    e.preventDefault();
});

mainEl.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null || !mainEl.contains(e.relatedTarget)) {
        dropOverlay.classList.remove('active');
    }
});

mainEl.addEventListener('drop', (e) => {
    e.preventDefault();
    dropOverlay.classList.remove('active');

    if (!currentPeer) return;

    const files = e.dataTransfer.files;
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        // For drag-and-drop in Qt WebEngine, path may not be available
        // We'll use the file path if available
        if (file.path) {
            bridge.sendFile(currentPeer, file.path);
            addMessage(currentPeer, '', 'sent', {
                name: file.name,
                size: file.size,
                path: ''
            });
            showToast(`Sending ${file.name}...`, 'file');
        }
    }
});

function handleFileReceived(fromUuid, filename, savedPath, size) {
    addMessage(fromUuid, '', 'received', {
        name: filename,
        size: size,
        path: savedPath
    });

    if (fromUuid !== currentPeer) {
        unreadCounts[fromUuid] = (unreadCounts[fromUuid] || 0) + 1;
        refreshPeerList();
    }

    showToast(`File received: ${filename}`, 'file');
}

function openFile(path) {
    if (path) {
        // Try to open in system file explorer — limited in Qt WebEngine
        console.log('Open file:', path);
    }
}

// ═══════════════════════════════════════════════════════════
// EMOJI PICKER
// ═══════════════════════════════════════════════════════════
function initEmojiGrid() {
    emojis.forEach(emoji => {
        const span = document.createElement('span');
        span.textContent = emoji;
        span.onclick = () => {
            msgInput.value += emoji;
            msgInput.focus();
            emojiPicker.classList.remove('active');
        };
        emojiGrid.appendChild(span);
    });
}

document.getElementById('btn-emoji').onclick = (e) => {
    e.stopPropagation();
    emojiPicker.classList.toggle('active');
};

// Close emoji picker on outside click
document.addEventListener('click', (e) => {
    if (!emojiPicker.contains(e.target) && e.target.id !== 'btn-emoji') {
        emojiPicker.classList.remove('active');
    }
});

// ═══════════════════════════════════════════════════════════
// TOAST NOTIFICATIONS
// ═══════════════════════════════════════════════════════════
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = 'toast';

    let iconSvg = '';
    if (type === 'info') {
        iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
        </svg>`;
    } else if (type === 'file') {
        iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
        </svg>`;
    } else if (type === 'success') {
        iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>
        </svg>`;
    }

    toast.innerHTML = `
        <div class="toast-icon ${type}">${iconSvg}</div>
        <span>${escapeHtml(message)}</span>
    `;

    toastContainer.appendChild(toast);

    // Remove after animation
    setTimeout(() => toast.remove(), 3500);
}

// ═══════════════════════════════════════════════════════════
// VOICE & VIDEO CALLS
// ═══════════════════════════════════════════════════════════
document.getElementById('btn-call').onclick = () => {
    if (!currentPeer) return;
    startCall(false);  // Audio-only
};

document.getElementById('btn-video').onclick = () => {
    if (!currentPeer) return;
    startCall(true);  // Video + Audio
};

document.getElementById('btn-hangup').onclick = () => endCall();

document.getElementById('btn-mute-call').onclick = () => {
    if (!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(track => track.enabled = !isMuted);
    document.getElementById('btn-mute-call').classList.toggle('active', isMuted);
};

function handleIncomingSignal(fromUuid, signalJson) {
    const signal = JSON.parse(signalJson);
    if (signal.type === 'offer') {
        const peerInfo = peerMap[fromUuid];
        if (confirm(`Incoming call from ${peerInfo?.username || 'Unknown'}. Accept?`)) {
            currentPeer = fromUuid;
            startCallResponse(signal);
        }
    } else {
        handleSignalStep(signal);
    }
}

async function startCall(video) {
    try {
        videoOverlay.style.display = 'flex';
        localStream = await navigator.mediaDevices.getUserMedia({ video: video, audio: true });
        localVideo.srcObject = localStream;

        peerConnection = new RTCPeerConnection(rtcConfig);
        localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                bridge.sendSignal(currentPeer, JSON.stringify({ type: 'candidate', candidate: event.candidate }));
            }
        };

        peerConnection.ontrack = (event) => remoteVideo.srcObject = event.streams[0];

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        bridge.sendSignal(currentPeer, JSON.stringify({ type: 'offer', sdp: offer }));
    } catch (err) {
        console.error('Failed to start call:', err);
        videoOverlay.style.display = 'none';
        showToast('Could not access camera/microphone.', 'info');
    }
}

async function startCallResponse(offerSignal) {
    try {
        videoOverlay.style.display = 'flex';
        // Determine if offer has video
        const hasVideo = offerSignal.sdp?.sdp?.includes('m=video') || true;
        localStream = await navigator.mediaDevices.getUserMedia({ video: hasVideo, audio: true });
        localVideo.srcObject = localStream;

        peerConnection = new RTCPeerConnection(rtcConfig);
        localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                bridge.sendSignal(currentPeer, JSON.stringify({ type: 'candidate', candidate: event.candidate }));
            }
        };
        peerConnection.ontrack = (event) => remoteVideo.srcObject = event.streams[0];

        await peerConnection.setRemoteDescription(new RTCSessionDescription(offerSignal.sdp));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        bridge.sendSignal(currentPeer, JSON.stringify({ type: 'answer', sdp: answer }));
    } catch (err) {
        console.error('Failed to respond to call:', err);
        videoOverlay.style.display = 'none';
        showToast('Could not access camera/microphone.', 'info');
    }
}

async function handleSignalStep(signal) {
    if (!peerConnection) return;
    if (signal.type === 'answer') {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    } else if (signal.type === 'candidate') {
        await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
    }
}

function endCall() {
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }
    isMuted = false;
    videoOverlay.style.display = 'none';
}

// ═══════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════
function refreshPeerList() {
    renderPeers(Object.values(peerMap));
}

function formatTime(isoString) {
    try {
        const d = new Date(isoString);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
        return '';
    }
}

function formatDate(isoString) {
    try {
        const d = new Date(isoString);
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        if (d.toDateString() === today.toDateString()) return 'Today';
        if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
        return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
    } catch {
        return '';
    }
}

function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
