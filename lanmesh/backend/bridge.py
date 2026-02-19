from PyQt5.QtCore import QObject, pyqtSlot, pyqtSignal
import json
import threading
import base64
import os
from .storage import StorageManager
from .discovery import DiscoveryService
import requests

class BackendBridge(QObject):
    # Signals to JS
    authStatus = pyqtSignal(bool, str, arguments=['authenticated', 'username'])
    peerUpdate = pyqtSignal(str, arguments=['peers_json'])       # list of peers
    chatMessage = pyqtSignal(str, str, arguments=['from_uuid', 'text'])
    signalReceived = pyqtSignal(str, str, arguments=['from_uuid', 'signal_json'])
    fileReceived = pyqtSignal(str, str, str, int, arguments=['from_uuid', 'filename', 'saved_path', 'size'])
    typingUpdate = pyqtSignal(str, bool, arguments=['from_uuid', 'is_typing'])
    chatHistoryLoaded = pyqtSignal(str, str, arguments=['peer_id', 'messages_json'])
    
    def __init__(self, app_root):
        super().__init__()
        self.app_root = app_root
        self.storage = StorageManager(
             data_file=os.path.join(app_root, "backend", "user_data.enc"),
             key_file=os.path.join(app_root, "backend", "app.key")
        )
        self.current_user = None
        self.discovery_service = None
        self.port = 8000  # P2P Port

    # ── Authentication ────────────────────────────────────────
    @pyqtSlot()
    def checkAuth(self):
        loaded = self.storage.load_user()
        if loaded:
            self.current_user = loaded
            self.startDiscovery()
            self.authStatus.emit(True, loaded['username'])
        else:
            self.authStatus.emit(False, "")

    @pyqtSlot(str)
    def registerUser(self, username):
        import uuid
        new_uuid = f"{username}_{str(uuid.uuid4())[:8]}"
        self.storage.save_user(username, new_uuid)
        self.current_user = {"username": username, "uuid": new_uuid}
        self.startDiscovery()
        self.authStatus.emit(True, username)

    # ── Discovery ─────────────────────────────────────────────
    def startDiscovery(self):
        if self.discovery_service: 
            return
        
        if not self.current_user:
            print("Cannot start discovery: no current user")
            return
        
        self.discovery_service = DiscoveryService(
            self.current_user['username'], 
            self.port, 
            self.on_peers_found
        )
        self.discovery_service.my_uuid = self.current_user['uuid']
        threading.Thread(target=self.discovery_service.start, daemon=True).start()

    def on_peers_found(self, peers):
        self.peerUpdate.emit(json.dumps(peers))

    # ── Chat ──────────────────────────────────────────────────
    @pyqtSlot(str, str)
    def sendChatMessage(self, target_uuid, text):
        if not self.discovery_service: return
        target = self.discovery_service.peers.get(target_uuid)
        if target:
            threading.Thread(target=self._post_http, args=(target, "message", {"text": text})).start()

    # ── Signaling (WebRTC) ────────────────────────────────────
    @pyqtSlot(str, str)
    def sendSignal(self, target_uuid, signal_json):
        if not self.discovery_service: return
        target = self.discovery_service.peers.get(target_uuid)
        if target:
             threading.Thread(target=self._post_http, args=(target, "signal", {"signal": json.loads(signal_json)})).start()

    # ── File Transfer ─────────────────────────────────────────
    @pyqtSlot(str, str)
    def sendFile(self, target_uuid, file_path):
        """Read a local file, base64-encode it, and POST to the peer."""
        if not self.discovery_service: return
        target = self.discovery_service.peers.get(target_uuid)
        if not target: return

        def _send():
            try:
                with open(file_path, "rb") as f:
                    data = f.read()
                payload = {
                    "filename": os.path.basename(file_path),
                    "data_b64": base64.b64encode(data).decode("utf-8"),
                    "size": len(data),
                }
                self._post_http(target, "file", payload)
            except Exception as e:
                print(f"File send error: {e}")

        threading.Thread(target=_send, daemon=True).start()

    def handle_incoming_file(self, from_uuid, filename, data_b64, size):
        """Called by p2p.py when a file arrives."""
        try:
            data_bytes = base64.b64decode(data_b64)
            saved_path = self.storage.save_received_file(filename, data_bytes)
            self.fileReceived.emit(from_uuid, filename, saved_path, size)
        except Exception as e:
            print(f"File receive error: {e}")

    # ── Typing Indicator ──────────────────────────────────────
    @pyqtSlot(str, bool)
    def sendTypingIndicator(self, target_uuid, is_typing):
        if not self.discovery_service: return
        target = self.discovery_service.peers.get(target_uuid)
        if target:
            threading.Thread(
                target=self._post_http,
                args=(target, "typing", {"is_typing": is_typing}),
                daemon=True
            ).start()

    def handle_incoming_typing(self, from_uuid, is_typing):
        self.typingUpdate.emit(from_uuid, is_typing)

    # ── Chat History ──────────────────────────────────────────
    @pyqtSlot(str, str)
    def saveChatHistory(self, peer_id, messages_json):
        threading.Thread(
            target=self.storage.save_chat,
            args=(peer_id, messages_json),
            daemon=True
        ).start()

    @pyqtSlot(str)
    def loadChatHistory(self, peer_id):
        def _load():
            data = self.storage.load_chat(peer_id)
            self.chatHistoryLoaded.emit(peer_id, data)
        threading.Thread(target=_load, daemon=True).start()

    # ── HTTP Helper ───────────────────────────────────────────
    def _post_http(self, target, type, payload):
        try:
            url = f"http://{target['ip']}:{target['port']}/internal/{type}"
            full_payload = {"from_uuid": self.current_user['uuid'], **payload}
            requests.post(url, json=full_payload, timeout=10)
        except Exception as e:
            print(f"P2P Send Error: {e}")

    # ── Incoming Hooks (called by P2P listener) ───────────────
    def handle_incoming_message(self, from_uuid, text):
        self.chatMessage.emit(from_uuid, text)

    def handle_incoming_signal(self, from_uuid, signal_dict):
        self.signalReceived.emit(from_uuid, json.dumps(signal_dict))
