from fastapi import FastAPI, Body
from pydantic import BaseModel
import uvicorn
import threading
from typing import Dict, Any

# We use FastAPI ONLY for the background P2P listener (Machine-to-Machine).
# It does NOT serve the UI. 
# It runs on port 8000 (fixed for this MVP, effectively acting as the "Serverless" node).

app = FastAPI()
bridge_instance = None # Injected from main.py

class MessageModel(BaseModel):
    from_uuid: str
    text: str

class SignalModel(BaseModel):
    from_uuid: str
    signal: Dict[str, Any]

@app.post("/internal/message")
async def receive_message(msg: MessageModel):
    if bridge_instance:
        bridge_instance.handle_incoming_message(msg.from_uuid, msg.text)
    return {"status": "ok"}

@app.post("/internal/signal")
async def receive_signal(sig: SignalModel):
    if bridge_instance:
        bridge_instance.handle_incoming_signal(sig.from_uuid, sig.signal)
    return {"status": "ok"}

def start_p2p_listener(bridge, port=8000):
    global bridge_instance
    bridge_instance = bridge
    # Run uvicorn efficiently for data only
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="error")
