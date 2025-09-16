# facecall
this is a face call app which is similar to zoom allpwes 4 people to hold a video conference
Instructions to Run/Deploy
1. Requirements

Node.js ≥ 16

npm or yarn

coturn server running on your EC2 (for NAT traversal)

AWS EC2 instance (Ubuntu recommended)

2. Setup
Clone repository
git clone <your-private-repo-url>
cd facecall

Install dependencies
npm install

3. Environment

Create .env in project root:

PORT=3000
TURN_URL=turn:turn.call.malton.uz:3478
TURN_USER=webrtcuser
TURN_PASS=webrtcpass

4. Run locally
npm run dev


Open http://localhost:3000
 in your browser.

5. Deploy on EC2


Frontend

WebRTC - Peer-to-peer real-time communication
Socket.IO - Signaling server for connection establishment
TensorFlow.js BlazeFace - Real-time face detection
Vanilla JavaScript - No framework dependencies

Backend

Node.js - Server runtime
Express.js - Web framework
Socket.IO - WebSocket communication
TURN Server - NAT traversal for reliable connections

Infrastructure

AWS EC2 - Cloud hosting
HTTPS/WSS - Secure connections required for WebRTC



Prerequisites

Node.js 14+
Modern web browser with WebRTC support
HTTPS domain (required for camera access)

Installation

Clone the repository

bashgit clone https://github.com/yourusername/facecall-webrtc.git
cd facecall-webrtc

Install dependencies

bash npm install

WebRTC is chosen for peer-to-peer video/audio, low latency, and cross-browser support.

Socket.io handles room signaling (join, offer/answer exchange, ICE candidates).

Face Detection

Integrated TensorFlow.js BlazeFace to run lightweight, real-time face detection directly in the browser.

Bounding boxes are drawn on a transparent canvas overlay above the <video> element.

TURN/STUN

Self-hosted coturn on the EC2 instance ensures NAT traversal (critical for mobile & cross-network calls).

Configured with both UDP + TCP transports for reliability.

Scaling Considerations

Mesh topology (each peer connects to each other) is used — simple, good for ≤4 users.

For larger rooms, migrating to SFU (Selective Forwarding Unit) like Jitsi or mediasoup would be needed.

TURN server load can be horizontally scaled by running multiple coturn instances behind a load balancer.

Deliverables

Live demo: https://call.malton.uz/?room=demo

Source code (private GitHub repo)

This README
