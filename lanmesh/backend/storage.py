import os
import json
from cryptography.fernet import Fernet

class StorageManager:
    def __init__(self, data_file="user_data.enc", key_file="app.key"):
        self.data_file = data_file
        self.key_file = key_file
        self.key = self._load_or_generate_key()
        self.cipher = Fernet(self.key)

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
