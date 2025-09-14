
// app.js — FaceCall (mesh ≤4 users) - FIXED VERSION
// Fixes: proper peer state management, face detection optimization, better video track handling

/* ====================== Socket.IO ====================== */
const socket = io();

/* ====================== ICE / STUN-TURN CONFIG ====================== */
const DEFAULT_ICE_CONFIG = {
  iceServers: [{
    urls: [
      "turn:turn.call.malton.uz:3478?transport=udp",
      "turn:turn.call.malton.uz:3478?transport=tcp",
    ],
    username: "webrtcuser",
    credential: "webrtcpass",
  }],
  iceTransportPolicy: "relay",
};

window.ICE_CONFIG = window.ICE_CONFIG || DEFAULT_ICE_CONFIG;

/* ====================== Global State ====================== */
const peers = new Map();
const candidateBuffer = new Map();
const faceDetectors = new Map(); // Track face detection loops
let localStream = null;
let roomId = null;

/* ====================== UI Elements ====================== */
const $videos   = document.getElementById("videos");
const $room     = document.getElementById("room-input");
const $join     = document.getElementById("join-btn");
const $share    = document.getElementById("share-link");

/* ====================== Utilities ====================== */
function log(...a){ console.log("[FaceCall]", ...a); }
function warn(...a){ console.warn("[FaceCall]", ...a); }
function err(...a){ console.error("[FaceCall]", ...a); }

/* ====================== Video Card (FIXED) ====================== */
function addVideoCard(id, stream, isLocal = false) {
  let card = document.querySelector(`.video-card[data-id="${id}"]`);
  if (card) card.remove();

  card = document.createElement("div");
  card.className = "video-card";
  card.dataset.id = id;

  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = isLocal; // Only mute local video
  
  // IMPORTANT: Set srcObject immediately and properly
  video.srcObject = stream;

  const canvas = document.createElement("canvas");
  canvas.className = "overlay";
  canvas.style.pointerEvents = "none";
  canvas.style.position = "absolute";
  canvas.style.top = "0";
  canvas.style.left = "0";
  canvas.style.zIndex = "10";

  const badge = document.createElement("div");
  badge.className = "badge";
  badge.textContent = isLocal ? "You" : (id || "").slice(0,6);

  let unmuteBtn = null;
  if (!isLocal) {
    unmuteBtn = document.createElement("button");
    unmuteBtn.className = "unmute-btn";
    unmuteBtn.textContent = "🔊 Click to Unmute";
    unmuteBtn.onclick = async () => {
      try {
        video.muted = false;
        await video.play();
        unmuteBtn.style.display = "none";
        log("Unmuted video for", id);
      } catch (e) { 
        warn("unmute play blocked:", e); 
      }
    };
  }

  card.appendChild(video);
  card.appendChild(canvas);
  card.appendChild(badge);
  if (unmuteBtn) card.appendChild(unmuteBtn);
  $videos.appendChild(card);

  // FIXED: Better video loading handling
  video.addEventListener("loadedmetadata", async () => {
    log("Video metadata loaded for", id, "dimensions:", video.videoWidth, "x", video.videoHeight);
    canvas.width = video.videoWidth || 320;
    canvas.height = video.videoHeight || 240;
    
    try { 
      await video.play(); 
      log("Video playing for", id);
      // Start face detection after video is actually playing
      if (!faceDetectors.has(id)) {
        startFaceDetectorFor(id);
      }
    } catch (e) {
      warn("Video play failed for", id, e);
    }
  });

  // Additional event listeners for debugging
  video.addEventListener("canplay", () => log("Video can play:", id));
  video.addEventListener("playing", () => log("Video started playing:", id));
  video.addEventListener("error", (e) => err("Video error for", id, e));

  return card;
}

function removePeer(id) {
  log("Removing peer:", id);
  
  // Stop face detection
  if (faceDetectors.has(id)) {
    clearInterval(faceDetectors.get(id));
    faceDetectors.delete(id);
  }
  
  // Clean up peer connection
  const state = peers.get(id);
  if (state && state.pc) { 
    try { 
      state.pc.close(); 
      log("Closed peer connection for", id);
    } catch (e) {
      warn("Error closing peer connection:", e);
    }
  }
  
  peers.delete(id);
  candidateBuffer.delete(id);
  
  const card = document.querySelector(`.video-card[data-id="${id}"]`);
  if (card) {
    card.remove();
    log("Removed video card for", id);
  }
}

/* ====================== Face Detection (OPTIMIZED) ====================== */
async function startFaceDetectorFor(id) {
  if (faceDetectors.has(id)) {
    return; // Already running
  }

  const card = document.querySelector(`.video-card[data-id="${id}"]`);
  if (!card) {
    warn("No card found for face detection:", id);
    return;
  }
  
  const video = card.querySelector("video");
  const canvas = card.querySelector("canvas.overlay");
  const ctx = canvas.getContext("2d");

  if (typeof blazeface === "undefined") {
    warn("BlazeFace not found; skipping face detection for", id);
    return;
  }

  try {
    log("Loading BlazeFace model for", id);
    const model = await blazeface.load();
    let isDetecting = false;

    const detectLoop = async () => {
      if (isDetecting) return; // Prevent overlapping detections
      
      if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        isDetecting = true;
        
        try {
          // Ensure canvas matches video dimensions
          if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
          }
          
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          
          // Face detection with error handling
          const predictions = await model.estimateFaces(video, false);
          
          // Draw bounding boxes
          for (const prediction of predictions) {
            const [x, y] = prediction.topLeft;
            const [x2, y2] = prediction.bottomRight;
            
            ctx.lineWidth = 3;
            ctx.strokeStyle = "#00FFAA";
            ctx.strokeRect(x, y, x2 - x, y2 - y);
            
            // Optional: Add confidence score
            if (prediction.probability) {
              ctx.fillStyle = "#00FFAA";
              ctx.font = "14px Arial";
              ctx.fillText(`${Math.round(prediction.probability * 100)}%`, x, y - 5);
            }
          }
        } catch (e) {
          warn("Face detection error for", id, e);
        } finally {
          isDetecting = false;
        }
      }
    };

    // Use interval instead of requestAnimationFrame to reduce CPU load
    const intervalId = setInterval(detectLoop, 200); // 5 FPS for face detection
    faceDetectors.set(id, intervalId);
    
    log("Face detection started for", id);
  } catch (e) {
    err("Failed to start face detection for", id, e);
  }
}

/* ====================== Peer Management (FIXED) ====================== */
function getOrCreatePeerState(peerId) {
  if (peers.has(peerId)) {
    return peers.get(peerId);
  }

  log("Creating new peer state for", peerId);

  const pc = new RTCPeerConnection(window.ICE_CONFIG);

  const state = {
    pc,
    makingOffer: false,
    isSettingRemoteAnswerPending: false,
    polite: false,
    senders: { audio: null, video: null },
  };

  // Store immediately to prevent race conditions
  peers.set(peerId, state);

  // --- Enhanced Diagnostics ---
  pc.onicegatheringstatechange = () => log(peerId, "iceGatheringState:", pc.iceGatheringState);
  pc.oniceconnectionstatechange = () => {
    log(peerId, "iceConnectionState:", pc.iceConnectionState);
    if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
      warn("Connection issues with", peerId, "- might need to restart connection");
    }
  };
  pc.onconnectionstatechange = () => log(peerId, "connectionState:", pc.connectionState);
  pc.onsignalingstatechange = () => log(peerId, "signalingState:", pc.signalingState);

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      log(peerId, "LOCAL CAND:", candidate.candidate);
      socket.emit("candidate", { to: peerId, candidate });
    } else {
      log(peerId, "ICE gathering complete");
    }
  };

  // --- Stable m-line order: audio then video transceivers ---
  const audioTr = pc.addTransceiver("audio", { direction: "sendrecv" });
  const videoTr = pc.addTransceiver("video", { direction: "sendrecv" });
  
  // --- Codec preferences ---
  try {
    const caps = RTCRtpReceiver.getCapabilities("video");
    if (videoTr.setCodecPreferences && caps?.codecs?.length) {
      const h264 = caps.codecs.filter(c => /video\/h264/i.test(c.mimeType));
      const vp8 = caps.codecs.filter(c => /video\/vp8/i.test(c.mimeType));
      const rest = caps.codecs.filter(c => !h264.includes(c) && !vp8.includes(c));
      videoTr.setCodecPreferences([...h264, ...vp8, ...rest]);
      log(peerId, "codec prefs set:", [...h264, ...vp8].map(c => c.mimeType));
    }
  } catch (e) {
    warn(peerId, "setCodecPreferences skipped:", e);
  }

  state.senders.audio = audioTr.sender;
  state.senders.video = videoTr.sender;

  // Bind local tracks if available
  if (localStream) {
    const audioTrack = localStream.getAudioTracks()[0] || null;
    const videoTrack = localStream.getVideoTracks()[0] || null;
    
    if (audioTrack) {
      audioTr.sender.replaceTrack(audioTrack);
      log(peerId, "Added local audio track");
    }
    if (videoTrack) {
      videoTr.sender.replaceTrack(videoTrack);
      log(peerId, "Added local video track");
    }
  }

  // --- FIXED: Remote track handling ---
  pc.ontrack = async (e) => {
    log(peerId, "ontrack received:", e.track.kind, "id:", e.track.id);

    let card = document.querySelector(`.video-card[data-id="${peerId}"]`);
    let stream;

    if (!card) {
      // Create new stream and card for this peer
      stream = new MediaStream();
      card = addVideoCard(peerId, stream, false);
      log("Created new video card for", peerId);
    } else {
      // Get existing stream from video element
      const video = card.querySelector("video");
      stream = video.srcObject;
      if (!stream) {
        stream = new MediaStream();
        video.srcObject = stream;
      }
    }

    // Add track to stream if not already present
    if (!stream.getTracks().some(t => t.id === e.track.id)) {
      stream.addTrack(e.track);
      log("Added", e.track.kind, "track to stream for", peerId);
    }

    // Ensure video element properties
    const video = card.querySelector("video");
    video.autoplay = true;
    video.playsInline = true;

    // Handle track events
    e.track.onended = () => {
      log("Track ended for", peerId, e.track.kind);
      stream.removeTrack(e.track);
    };

    e.track.onmute = () => log("Track muted for", peerId, e.track.kind);
    e.track.onunmute = () => {
      log("Track unmuted for", peerId, e.track.kind);
      // Try to play when track becomes active
      video.play().catch(err => warn("Auto-play blocked:", err));
    };
  };

  // --- FIXED: Negotiation handling ---
  pc.onnegotiationneeded = async () => {
    // Check if peer state still exists (might have been removed)
    if (!peers.has(peerId)) {
      log("Peer", peerId, "no longer exists, skipping negotiation");
      return;
    }

    const currentState = peers.get(peerId);
    if (currentState.makingOffer) {
      log("Already making offer to", peerId);
      return;
    }
    if (pc.signalingState !== "stable") {
      log("Signaling state not stable for", peerId, ":", pc.signalingState);
      return;
    }

    currentState.makingOffer = true;
    try {
      const offer = await pc.createOffer();
      if (pc.signalingState === "stable") { // Double-check state hasn't changed
        await pc.setLocalDescription(offer);
        socket.emit("offer", { to: peerId, sdp: pc.localDescription });
        log("offer→", peerId);
      }
    } catch (e) {
      err("onnegotiationneeded error:", e);
    } finally {
      if (peers.has(peerId)) {
        peers.get(peerId).makingOffer = false;
      }
    }
  };

  return state;
}

/* ====================== Local media & join ====================== */
async function init(room) {
  roomId = room;
  
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { 
        facingMode: "user",
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 },
        frameRate: { ideal: 30, max: 60 }
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 44100
      }
    });
    
    log("Local media acquired successfully");
  } catch (e) {
    err("Camera/mic permission error:", e);
    alert("Camera/mic permission error: " + e.message);
    return;
  }

  addVideoCard("local", localStream, true);

  const url = new URL(location.href);
  url.searchParams.set("room", roomId);
  $share.innerHTML = `Share: <a href="${url.href}" target="_blank">${url.href}</a>`;

  socket.emit("join", { roomId });
  log("Joined room:", roomId);
}

/* ====================== FIXED: Signaling Event Handlers ====================== */

socket.on("existing-users", (ids) => {
  log("existing-users", ids);
  for (const id of ids) {
    const st = getOrCreatePeerState(id);
    st.polite = true; // You're the polite peer (callee)
    log("Set up polite peer state for existing user:", id);
  }
});

socket.on("user-joined", ({ userId }) => {
  log("user-joined", userId);
  const st = getOrCreatePeerState(userId);
  st.polite = false; // You're the impolite peer (caller)
  log("Set up impolite peer state for new user:", userId);
});

socket.on("offer", async ({ from, sdp }) => {
  log("Received offer from", from);
  
  const st = getOrCreatePeerState(from);
  if (!st || !st.pc) {
    err("No peer state for offer from", from);
    return;
  }
  
  const { pc } = st;
  const desc = new RTCSessionDescription(sdp);

  const readyForOffer = (pc.signalingState === "stable") || st.isSettingRemoteAnswerPending;
  const offerCollision = (desc.type === "offer") && !readyForOffer;

  try {
    if (offerCollision) {
      if (!st.polite) {
        warn("Ignoring offer (impolite & collision) from", from);
        return;
      }
      log("Handling offer collision with rollback for", from);
      await Promise.allSettled([
        pc.setLocalDescription({ type: "rollback" }),
        pc.setRemoteDescription(desc),
      ]);
    } else {
      await pc.setRemoteDescription(desc);
    }

    log("setRemote(offer) ✓", from);

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("answer", { to: from, sdp: pc.localDescription });

    log("answer→", from);

    // Flush buffered candidates
    const candidates = candidateBuffer.get(from) || [];
    for (const candidate of candidates) {
      try { 
        await pc.addIceCandidate(new RTCIceCandidate(candidate)); 
        log("Applied buffered candidate from", from);
      } catch (e) { 
        warn("Failed to apply buffered candidate:", e); 
      }
    }
    candidateBuffer.delete(from);
  } catch (e) {
    err("offer handling error from", from, ":", e);
  }
});

socket.on("answer", async ({ from, sdp }) => {
  log("Received answer from", from);
  
  const st = peers.get(from);
  if (!st || !st.pc) {
    err("No peer state for answer from", from);
    return;
  }
  
  const { pc } = st;
  
  try {
    st.isSettingRemoteAnswerPending = true;
    
    if (pc.signalingState === "have-local-offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      log("setRemote(answer) ✓", from);

      // Flush buffered candidates
      const candidates = candidateBuffer.get(from) || [];
      for (const candidate of candidates) {
        try { 
          await pc.addIceCandidate(new RTCIceCandidate(candidate)); 
          log("Applied buffered candidate from", from);
        } catch (e) { 
          warn("Failed to apply buffered candidate:", e); 
        }
      }
      candidateBuffer.delete(from);
    } else {
      warn("Late/mismatched answer ignored from", from, "in state:", pc.signalingState);
    }
  } catch (e) {
    err("answer handling error from", from, ":", e);
  } finally {
    st.isSettingRemoteAnswerPending = false;
  }
});

socket.on("candidate", async ({ from, candidate }) => {
  log("Received ICE candidate from", from);
  
  const st = getOrCreatePeerState(from);
  if (!st || !st.pc) {
    err("No peer state for candidate from", from);
    return;
  }
  
  const { pc } = st;
  
  try {
    if (pc.remoteDescription) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
      log("Applied ICE candidate from", from);
    } else {
      // Buffer candidate until we have remote description
      const candidates = candidateBuffer.get(from) || [];
      candidates.push(candidate);
      candidateBuffer.set(from, candidates);
      log("Buffered ICE candidate from", from);
    }
  } catch (e) {
    warn("addIceCandidate error from", from, ":", e);
  }
});

socket.on("user-left", ({ userId }) => {
  log("user-left", userId);
  removePeer(userId);
});

// Add connection error handling
socket.on("connect", () => {
  log("Socket connected");
});

socket.on("disconnect", () => {
  log("Socket disconnected");
});

socket.on("error", (error) => {
  err("Socket error:", error);
});

/* ====================== UI: Join & Auto-join ====================== */
$join.onclick = async () => {
  const input = $room.value.trim() || new URLSearchParams(location.search).get("room") || "demo";
  await init(input);
};

// Auto-join from URL
(async function autoJoinFromURL(){
  const fromURL = new URLSearchParams(location.search).get("room");
  if (fromURL) { 
    $room.value = fromURL; 
    await init(fromURL); 
  }
})();

/* ====================== Optional: Device switching ====================== */
async function switchCamera(deviceId) {
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({ 
      video: { deviceId }, 
      audio: true 
    });
    
    const audioTrack = newStream.getAudioTracks()[0] || null;
    const videoTrack = newStream.getVideoTracks()[0] || null;
    
    // Update local video display
    const localCard = document.querySelector('.video-card[data-id="local"]');
    if (localCard) { 
      localCard.querySelector("video").srcObject = newStream; 
    }
    
    // Close old stream
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
    }
    localStream = newStream;
    
    // Update all peer connections
    for (const [peerId, state] of peers) {
      if (state.senders.audio && audioTrack) {
        await state.senders.audio.replaceTrack(audioTrack);
      }
      if (state.senders.video && videoTrack) {
        await state.senders.video.replaceTrack(videoTrack);
      }
    }
    
    log("Switched camera successfully");
  } catch (e) {
    err("Camera switch error:", e);
  }
}
// Add this diagnostic function to your app.js for troubleshooting
// Call it from browser console: diagnoseConnections()

function diagnoseConnections() {
  console.log("=== FACECALL DIAGNOSTICS ===");
  
  // Check local stream
  console.log("Local stream:", localStream);
  if (localStream) {
    console.log("Local tracks:", localStream.getTracks().map(t => ({
      kind: t.kind,
      enabled: t.enabled,
      readyState: t.readyState,
      muted: t.muted
    })));
  }
  
  // Check all peers
  console.log("Active peers:", peers.size);
  for (const [peerId, state] of peers) {
    console.log(`\n--- Peer: ${peerId} ---`);
    console.log("Connection state:", state.pc.connectionState);
    console.log("ICE connection state:", state.pc.iceConnectionState);
    console.log("Signaling state:", state.pc.signalingState);
    console.log("Polite:", state.polite);
    
    // Check transceivers
    const transceivers = state.pc.getTransceivers();
    console.log("Transceivers:", transceivers.map(t => ({
      mid: t.mid,
      direction: t.direction,
      currentDirection: t.currentDirection,
      sender: {
        track: t.sender.track ? {
          kind: t.sender.track.kind,
          enabled: t.sender.track.enabled,
          readyState: t.sender.track.readyState
        } : null
      },
      receiver: {
        track: t.receiver.track ? {
          kind: t.receiver.track.kind,
          enabled: t.receiver.track.enabled,
          readyState: t.receiver.track.readyState,
          muted: t.receiver.track.muted
        } : null
      }
    })));
  }
  
  // Check video elements
  console.log("\n=== VIDEO ELEMENTS ===");
  const videos = document.querySelectorAll('.video-card');
  videos.forEach((card, index) => {
    const video = card.querySelector('video');
    const peerId = card.dataset.id;
    console.log(`Video ${index} (${peerId}):`);
    console.log("- Video dimensions:", video.videoWidth, "x", video.videoHeight);
    console.log("- Ready state:", video.readyState);
    console.log("- Paused:", video.paused);
    console.log("- Muted:", video.muted);
    console.log("- Current time:", video.currentTime);
    console.log("- Duration:", video.duration);
    console.log("- Source:", video.srcObject ? "has MediaStream" : "no source");
    
    if (video.srcObject) {
      const tracks = video.srcObject.getTracks();
      console.log("- Stream tracks:", tracks.map(t => ({
        kind: t.kind,
        enabled: t.enabled,
        readyState: t.readyState,
        muted: t.muted
      })));
    }
  });
  
  console.log("=== END DIAGNOSTICS ===");
}

// Auto-diagnose every 10 seconds (remove in production)
// setInterval(diagnoseConnections, 10000);

// Also add this function to force video play
function forcePlayAllVideos() {
  const videos = document.querySelectorAll('.video-card video');
  videos.forEach(async (video, index) => {
    try {
      video.muted = true; // Ensure muted for autoplay
      await video.play();
      console.log(`Video ${index} playing successfully`);
    } catch (e) {
      console.warn(`Video ${index} play failed:`, e);
    }
  });
}

// Quick fix function for black video
function fixBlackVideo(peerId) {
  const card = document.querySelector(`.video-card[data-id="${peerId}"]`);
  if (!card) {
    console.log("No card found for", peerId);
    return;
  }
  
  const video = card.querySelector('video');
  const stream = video.srcObject;
  
  console.log("Fixing video for", peerId);
  console.log("Current stream:", stream);
  
  if (stream) {
    const tracks = stream.getTracks();
    console.log("Stream tracks:", tracks);
    
    // Try to refresh the video element
    video.load();
    video.play().catch(e => console.warn("Play failed:", e));
    
    // Check if tracks are active
    tracks.forEach(track => {
      console.log(`Track ${track.kind}:`, {
        enabled: track.enabled,
        readyState: track.readyState,
        muted: track.muted
      });
      
      if (track.readyState === 'ended') {
        console.warn(`Track ${track.kind} has ended!`);
      }
    });
  }
}
// ADD THIS CODE to the very end of your app.js file
// This creates a simple "Fix Video" button you can click

// Create a Fix Video button
function createFixButton() {
  // Remove existing button if it exists
  const existingBtn = document.getElementById('fix-video-btn');
  if (existingBtn) existingBtn.remove();

  // Create new button
  const fixBtn = document.createElement('button');
  fixBtn.id = 'fix-video-btn';
  fixBtn.textContent = '🔧 Fix Black Videos';
  fixBtn.style.cssText = `
    position: fixed;
    top: 10px;
    right: 10px;
    z-index: 1000;
    background: #ff4444;
    color: white;
    border: none;
    padding: 10px 15px;
    border-radius: 5px;
    cursor: pointer;
    font-weight: bold;
  `;

  // Add click handler
  fixBtn.onclick = function() {
    console.log('=== FIXING BLACK VIDEOS ===');
    
    // Show what we're doing
    fixBtn.textContent = '🔄 Fixing...';
    fixBtn.style.background = '#orange';
    
    // Get all video cards
    const videoCards = document.querySelectorAll('.video-card');
    console.log('Found', videoCards.length, 'video cards');
    
    videoCards.forEach((card, index) => {
      const video = card.querySelector('video');
      const peerId = card.dataset.id;
      const isLocal = peerId === 'local';
      
      console.log(`Checking video ${index} (${peerId}):`, {
        dimensions: `${video.videoWidth}x${video.videoHeight}`,
        readyState: video.readyState,
        paused: video.paused,
        muted: video.muted,
        hasSource: !!video.srcObject
      });
      
      // Try to fix the video
      if (video.srcObject) {
        const tracks = video.srcObject.getTracks();
        console.log(`Video ${index} tracks:`, tracks.map(t => ({
          kind: t.kind,
          enabled: t.enabled,
          readyState: t.readyState,
          muted: t.muted
        })));
        
        // Force video properties
        video.autoplay = true;
        video.playsInline = true;
        video.muted = isLocal; // Local muted, remote unmuted
        
        // Try to play
        video.play().then(() => {
          console.log(`✅ Video ${index} (${peerId}) is now playing`);
        }).catch(error => {
          console.log(`❌ Video ${index} (${peerId}) play failed:`, error.message);
          
          // Try with muted
          video.muted = true;
          return video.play();
        }).then(() => {
          if (video.muted && !isLocal) {
            console.log(`⚠️ Video ${index} (${peerId}) playing but muted - click unmute button`);
          }
        }).catch(error => {
          console.log(`💥 Video ${index} (${peerId}) completely failed:`, error.message);
        });
      } else {
        console.log(`❌ Video ${index} (${peerId}) has no source stream`);
      }
    });
    
    // Check peers
    console.log('\n=== PEER CONNECTIONS ===');
    console.log('Active peers:', peers.size);
    
    for (const [peerId, state] of peers) {
      console.log(`Peer ${peerId}:`, {
        connectionState: state.pc.connectionState,
        iceConnectionState: state.pc.iceConnectionState,
        signalingState: state.pc.signalingState
      });
      
      // Check transceivers
      const transceivers = state.pc.getTransceivers();
      transceivers.forEach((t, i) => {
        console.log(`  Transceiver ${i}:`, {
          mid: t.mid,
          direction: t.direction,
          currentDirection: t.currentDirection,
          senderTrack: t.sender.track ? `${t.sender.track.kind} (${t.sender.track.readyState})` : 'none',
          receiverTrack: t.receiver.track ? `${t.receiver.track.kind} (${t.receiver.track.readyState})` : 'none'
        });
      });
    }
    
    // Reset button
    setTimeout(() => {
      fixBtn.textContent = '🔧 Fix Black Videos';
      fixBtn.style.background = '#ff4444';
    }, 3000);
    
    console.log('=== FIX COMPLETE - Check console above for details ===');
  };

  // Add to page
  document.body.appendChild(fixBtn);
  console.log('Fix Video button added to page');
}

// Create the button when page loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', createFixButton);
} else {
  createFixButton();
}

// Also create button when joining room
const originalInit = init;
init = async function(room) {
  await originalInit(room);
  setTimeout(createFixButton, 1000); // Add button after room join
};