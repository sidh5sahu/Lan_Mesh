from PyQt5.QtCore import QObject, pyqtSlot, pyqtSignal
import json
import threading
from .storage import StorageManager
from .discovery import DiscoveryService
import os
import requests

class BackendBridge(QObject):
    # Signals to JS
    authStatus = pyqtSignal(bool, str, arguments=['authenticated', 'username'])
    peerUpdate = pyqtSignal(str, arguments=['peers_json']) # Sends list of peers
    chatMessage = pyqtSignal(str, str, arguments=['from_uuid', 'text'])
    signalReceived = pyqtSignal(str, str, arguments=['from_uuid', 'signal_json'])
    
    def __init__(self, app_root):
        super().__init__()
        self.app_root = app_root
        self.storage = StorageManager(
             data_file=os.path.join(app_root, "backend", "user_data.enc"),
             key_file=os.path.join(app_root, "backend", "app.key")
        )
        self.current_user = None
        self.discovery_service = None
        self.port = 8000 # P2P Port

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

    def startDiscovery(self):
        if self.discovery_service: 
            return
        
        if not self.current_user:
            print("Cannot start discovery: no current user")
            return
        
        # Create discovery service with proper user identity
        self.discovery_service = DiscoveryService(
            self.current_user['username'], 
            self.port, 
            self.on_peers_found
        )
        # Set UUID before starting to avoid race condition
        self.discovery_service.my_uuid = self.current_user['uuid']
        
        # Run in thread
        threading.Thread(target=self.discovery_service.start, daemon=True).start()

    def on_peers_found(self, peers):
        # Called from Discovery Thread
        self.peerUpdate.emit(json.dumps(peers))

    @pyqtSlot(str, str)
    def sendChatMessage(self, target_uuid, text):
        if not self.discovery_service: return
        target = self.discovery_service.peers.get(target_uuid)
        if target:
            threading.Thread(target=self._post_http, args=(target, "message", {"text": text})).start()

    @pyqtSlot(str, str)
    def sendSignal(self, target_uuid, signal_json):
        if not self.discovery_service: return
        target = self.discovery_service.peers.get(target_uuid)
        if target:
             threading.Thread(target=self._post_http, args=(target, "signal", {"signal": json.loads(signal_json)})).start()

    def _post_http(self, target, type, payload):
        try:
            url = f"http://{target['ip']}:{target['port']}/internal/{type}"
            full_payload = {"from_uuid": self.current_user['uuid'], **payload}
            requests.post(url, json=full_payload)
        except Exception as e:
            print(f"P2P Send Error: {e}")

    # Hook for incoming P2P traffic (called by the P2P HTTP Listener)
    def handle_incoming_message(self, from_uuid, text):
        self.chatMessage.emit(from_uuid, text)

    def handle_incoming_signal(self, from_uuid, signal_dict):
        self.signalReceived.emit(from_uuid, json.dumps(signal_dict))
