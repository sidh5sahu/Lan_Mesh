import sys
import threading
import os
from PyQt5.QtWidgets import QApplication, QMainWindow
from PyQt5.QtWebEngineWidgets import QWebEngineView, QWebEnginePage
from PyQt5.QtWebChannel import QWebChannel
from PyQt5.QtCore import QUrl, QFileInfo

from backend.bridge import BackendBridge
from backend.p2p import start_p2p_listener

PORT = 8000

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("LanMesh - Standalone P2P")
        self.setGeometry(100, 100, 1200, 800)

        # Bridge Setup
        self.bridge = BackendBridge(os.path.dirname(os.path.abspath(__file__)))
        
        # Start P2P Listener (Background)
        self.p2p_thread = threading.Thread(
            target=start_p2p_listener, 
            args=(self.bridge, PORT), 
            daemon=True
        )
        self.p2p_thread.start()

        # Web View
        self.browser = QWebEngineView()
        self.browser.page().featurePermissionRequested.connect(self.on_feature_permission_requested)
        
        # Web Channel Setup
        self.channel = QWebChannel()
        self.channel.registerObject("backend", self.bridge)
        self.browser.page().setWebChannel(self.channel)

        # Load Local File
        html_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "frontend", "index.html"))
        self.browser.setUrl(QUrl.fromLocalFile(html_path))

        self.setCentralWidget(self.browser)

    def on_feature_permission_requested(self, url, feature):
        # Auto grant permissions for local file/app
        self.browser.page().setFeaturePermission(url, feature, QWebEnginePage.PermissionGrantedByUser)

if __name__ == "__main__":
    app = QApplication(sys.argv)
    window = MainWindow()
    window.show()
    sys.exit(app.exec_())
