// State
let bridge = null;
let myId = null;
let currentPeer = null;
let peerConnection = null;
let localStream = null;

// UI Elements
const peerListEl = document.getElementById('peer-list');
const chatArea = document.getElementById('chat-area');
const msgInput = document.getElementById('msg-input');
const sendBtn = document.getElementById('btn-send');
const chatTitle = document.getElementById('chat-title');
const videoOverlay = document.getElementById('video-overlay');
const localVideo = document.getElementById('localstream');
const remoteVideo = document.getElementById('remotestream');
const loginOverlay = document.getElementById('login-overlay');
const usernameInput = document.getElementById('login-username');
const loginBtn = document.getElementById('btn-login');

// WebRTC
const rtcConfig = {
    iceServers: []
};

// Initialize QWebChannel
document.addEventListener("DOMContentLoaded", () => {
    new QWebChannel(qt.webChannelTransport, function (channel) {
        bridge = channel.objects.backend;

        // Connect Signals
        bridge.authStatus.connect(handleAuthStatus);
        bridge.peerUpdate.connect(handlePeerUpdate);
        bridge.chatMessage.connect(handleIncomingMessage);
        bridge.signalReceived.connect(handleIncomingSignal);

        // Initial Auth Check
        bridge.checkAuth();
    });
});

// Auth Handlers
function handleAuthStatus(authenticated, username) {
    if (authenticated) {
        loginOverlay.style.display = 'none';
        myId = username;
        document.getElementById('my-username').textContent = username;
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
    // Call Python
    bridge.registerUser(username);
};

// Peer Logic
function handlePeerUpdate(peersJson) {
    const peers = JSON.parse(peersJson);
    renderPeers(peers);
}

function renderPeers(peers) {
    peerListEl.innerHTML = '';
    peers.forEach(peer => {
        const el = document.createElement('div');
        el.id = `peer-${peer.id}`;
        el.className = `peer-item ${currentPeer === peer.id ? 'active' : ''}`;
        el.innerHTML = `
            <div class="avatar">${peer.username.substring(0, 2).toUpperCase()}</div>
            <div class="peer-data" style="width: 100%;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div class="peer-name">${peer.username}</div>
                    <div class="status-dot"></div>
                </div>
                <div class="peer-ip" style="font-size: 0.75rem; color: var(--text-muted); padding-top: 2px;">${peer.ip}</div>
            </div>
        `;
        el.onclick = () => selectPeer(peer);
        peerListEl.appendChild(el);
    });
}

function selectPeer(peer) {
    currentPeer = peer.id;
    chatTitle.textContent = `Chat with ${peer.username}`;
    msgInput.disabled = false;
    sendBtn.disabled = false;
    chatArea.innerHTML = '';
    document.querySelectorAll('.peer-item').forEach(e => e.classList.remove('active'));
    document.getElementById(`peer-${peer.id}`)?.classList.add('active');
}

// Chat Logic
sendBtn.onclick = () => {
    const text = msgInput.value;
    if (!text || !currentPeer) return;

    bridge.sendChatMessage(currentPeer, text);
    appendMessage(text, 'sent');
    msgInput.value = '';
};

// Enter key to send message
msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendBtn.click();
    }
});

function handleIncomingMessage(fromUuid, text) {
    if (fromUuid === currentPeer) {
        appendMessage(text, 'received');
    } else {
        // Notification logic could go here, e.g. badge update
    }
}

function appendMessage(text, type) {
    const div = document.createElement('div');
    div.className = `message ${type}`;
    div.textContent = text;
    chatArea.appendChild(div);
    chatArea.scrollTop = chatArea.scrollHeight;
}

// Signaling & Video
document.getElementById('btn-video').onclick = () => {
    if (!currentPeer) return;
    startCall(true);
};

document.getElementById('btn-hangup').onclick = () => endCall();

function handleIncomingSignal(fromUuid, signalJson) {
    const signal = JSON.parse(signalJson);
    if (signal.type === 'offer') {
        if (confirm(`Incoming call... Accept?`)) {
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
        alert('Could not access camera/microphone. Please check permissions.');
    }
}

async function startCallResponse(offerSignal) {
    try {
        videoOverlay.style.display = 'flex';
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
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
        alert('Could not access camera/microphone. Please check permissions.');
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
    videoOverlay.style.display = 'none';
}
