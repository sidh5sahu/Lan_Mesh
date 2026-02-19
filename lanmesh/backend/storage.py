import os
import json
from cryptography.fernet import Fernet

class StorageManager:
    def __init__(self, data_file="user_data.enc", key_file="app.key"):
        self.data_file = data_file
        self.key_file = key_file
        self.key = self._load_or_generate_key()
        self.cipher = Fernet(self.key)
        
        # Chat history & received files directories
        self.chat_dir = os.path.join(os.path.dirname(data_file), "chat_history")
        self.files_dir = os.path.join(os.path.dirname(data_file), "received_files")
        os.makedirs(self.chat_dir, exist_ok=True)
        os.makedirs(self.files_dir, exist_ok=True)

    def _load_or_generate_key(self):
        if os.path.exists(self.key_file):
            with open(self.key_file, "rb") as f:
                return f.read()
        else:
            key = Fernet.generate_key()
            with open(self.key_file, "wb") as f:
                f.write(key)
            return key

    def save_user(self, username, uuid):
        data = json.dumps({"username": username, "uuid": uuid})
        encrypted_data = self.cipher.encrypt(data.encode())
        with open(self.data_file, "wb") as f:
            f.write(encrypted_data)

    def load_user(self):
        if not os.path.exists(self.data_file):
            return None
        
        try:
            with open(self.data_file, "rb") as f:
                encrypted_data = f.read()
            
            decrypted_data = self.cipher.decrypt(encrypted_data).decode()
            return json.loads(decrypted_data)
        except Exception as e:
            print(f"Error loading user data: {e}")
            return None

    # ── Chat History ──────────────────────────────────────────
    def _chat_file(self, peer_id):
        safe_id = peer_id.replace("/", "_").replace("\\", "_")
        return os.path.join(self.chat_dir, f"{safe_id}.enc")

    def save_chat(self, peer_id, messages_json):
        """Save chat messages (JSON string) encrypted for a given peer."""
        try:
            encrypted = self.cipher.encrypt(messages_json.encode())
            with open(self._chat_file(peer_id), "wb") as f:
                f.write(encrypted)
        except Exception as e:
            print(f"Error saving chat for {peer_id}: {e}")

    def load_chat(self, peer_id):
        """Load and decrypt chat messages for a given peer. Returns JSON string."""
        path = self._chat_file(peer_id)
        if not os.path.exists(path):
            return "[]"
        try:
            with open(path, "rb") as f:
                encrypted = f.read()
            return self.cipher.decrypt(encrypted).decode()
        except Exception as e:
            print(f"Error loading chat for {peer_id}: {e}")
            return "[]"

    # ── File Storage ──────────────────────────────────────────
    def save_received_file(self, filename, data_bytes):
        """Save a received file to the received_files directory. Returns saved path."""
        # Avoid overwrites by adding counter
        base, ext = os.path.splitext(filename)
        dest = os.path.join(self.files_dir, filename)
        counter = 1
        while os.path.exists(dest):
            dest = os.path.join(self.files_dir, f"{base}_{counter}{ext}")
            counter += 1
        with open(dest, "wb") as f:
            f.write(data_bytes)
        return dest
