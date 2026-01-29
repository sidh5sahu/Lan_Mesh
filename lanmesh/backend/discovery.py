import socket
from zeroconf import Zeroconf, ServiceInfo, ServiceBrowser, ServiceStateChange
from typing import Callable, Optional
import time
import json

class DiscoveryService:
    def __init__(self, username: str, port: int, on_peer_update: Callable):
        self.username = username
        self.port = port
        self.on_peer_update = on_peer_update
        self.zeroconf = Zeroconf()
        self.service_type = "_lanmesh._tcp.local."
        self.peers = {} # uuid -> {ip, port, username}
        self.my_uuid = f"{username}_{int(time.time())}"
        self.local_ip = self.get_local_ip()

    def get_local_ip(self):
        try:
            # Connect to a public DNS to find the interface used for routing
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            s.close()
            return ip
        except (socket.error, OSError) as e:
            print(f"Could not determine local IP: {e}")
            return "127.0.0.1"

    def start(self):
        # Register Service
        info = ServiceInfo(
            self.service_type,
            f"{self.my_uuid}.{self.service_type}",
            addresses=[socket.inet_aton(self.local_ip)],
            port=self.port,
            properties={"username": self.username, "uuid": self.my_uuid},
        )
        self.zeroconf.register_service(info)
        print(f"Registered service: {self.username} at {self.local_ip}:{self.port}")

        # Browse for others (including self, we'll filter later)
        self.browser = ServiceBrowser(self.zeroconf, self.service_type, handlers=[self.on_service_state_change])

    def on_service_state_change(self, zeroconf, service_type, name, state_change):
        if state_change is ServiceStateChange.Added:
            zeroconf.get_service_info(service_type, name) # Request info
            # The async nature of zeroconf means we might process info later. 
            # We can use a synchronous get_service_info here or a listener.
            info = zeroconf.get_service_info(service_type, name)
            if info:
                self.add_peer(info)
        elif state_change is ServiceStateChange.Removed:
            # name includes local suffix
            uuid = name.split('.')[0]
            if uuid in self.peers:
                del self.peers[uuid]
                print(f"Peer removed: {uuid}")
                self.on_peer_update(self.get_active_peers())

    def add_peer(self, info: ServiceInfo):
        # Decode properties
        props = {k.decode('utf-8') if isinstance(k, bytes) else k: 
                 v.decode('utf-8') if isinstance(v, bytes) else v 
                 for k,v in info.properties.items()}
        
        uuid = props.get("uuid")
        if not uuid or uuid == self.my_uuid:
            return

        address = socket.inet_ntoa(info.addresses[0])
        
        self.peers[uuid] = {
            "id": uuid,
            "username": props.get("username", "Unknown"),
            "ip": address,
            "port": info.port
        }
        print(f"Peer detected: {self.peers[uuid]}")
        self.on_peer_update(self.get_active_peers())

    def get_active_peers(self):
        return list(self.peers.values())

    def stop(self):
        self.zeroconf.close()
