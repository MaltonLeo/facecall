
// app.js — FaceCall (mesh ≤4 users) - IMPROVED VERSION
// Fixes: proper peer state management, face detection optimization, better video track handling, iOS compatibility

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

// iOS/Safari detection
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
const isSafari = /Safari/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent);

/* ====================== Video Card (IMPROVED) ====================== */
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

  // IMPROVED: Better video loading handling with iOS/Safari support
  video.addEventListener("loadedmetadata", async () => {
    log("Video metadata loaded for", id, "dimensions:", video.videoWidth, "x", video.videoHeight);
    
    // iPhone/Safari fallback dimensions with better detection
    const width = video.videoWidth || 320;
    const height = video.videoHeight || 240;
    
    canvas.width = width;
    canvas.height = height;
    
    try { 
      await video.play(); 
      log("Video playing for", id);
      
      // IMPROVED: Face detection with better timing and validation
      setTimeout(() => {
        const hasValidVideo = video.videoWidth > 0 && video.videoHeight > 0 && 
                             video.readyState >= 2 && !video.paused;
        
        if (hasValidVideo && !faceDetectors.has(id)) {
          startFaceDetectorFor(id);
        } else if (!hasValidVideo) {
          log("Delaying face detection for", id, "- video not ready");
          // Retry face detection after more time for iOS devices
          setTimeout(() => {
            if (video.videoWidth > 0 && !faceDetectors.has(id)) {
              startFaceDetectorFor(id);
            }
          }, isIOS ? 5000 : 3000);
        }
      }, isIOS ? 2000 : 1000); // Longer delay for iOS
      
    } catch (e) {
      warn("Video play failed for", id, e);
    }
  });

  // Additional event listeners for debugging
  video.addEventListener("canplay", () => log("Video can play:", id));
  video.addEventListener("playing", () => log("Video started playing:", id));
  video.addEventListener("error", (e) => err("Video error for", id, e));

  // iOS-specific event listeners
  if (isIOS) {
    video.addEventListener("suspend", () => log("Video suspended:", id));
    video.addEventListener("waiting", () => log("Video waiting:", id));
  }

  return card;
}

function removePeer(id) {
  log("Removing peer:", id);
  
  // Stop face detection
  if (faceDetectors.has(id)) {
    clearInterval(faceDetectors.get(id));
    faceDetectors.delete(id);
    log("Stopped face detection for", id);
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

/* ====================== Face Detection (ROBUST) ====================== */
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

  // Enhanced video content validation
  const validateVideoContent = () => {
    return video.readyState >= 2 && 
           video.videoWidth > 0 && 
           video.videoHeight > 0 && 
           !video.paused &&
           video.currentTime > 0;
  };

  // Wait for video to be truly ready
  if (!validateVideoContent()) {
    log("Video not ready for face detection:", id, {
      readyState: video.readyState,
      dimensions: `${video.videoWidth}x${video.videoHeight}`,
      paused: video.paused,
      currentTime: video.currentTime
    });
    
    // Retry with exponential backoff
    setTimeout(() => startFaceDetectorFor(id), 3000);
    return;
  }

  try {
    log("Loading BlazeFace model for", id);
    const model = await blazeface.load();
    let isDetecting = false;
    let consecutiveErrors = 0;
    let detectionCount = 0;

    const detectLoop = async () => {
      if (isDetecting) return; // Prevent overlapping detections
      
      // Re-validate video content on each loop
      if (!validateVideoContent()) {
        consecutiveErrors++;
        if (consecutiveErrors > 10) {
          log("Too many validation failures, stopping face detection for", id);
          if (faceDetectors.has(id)) {
            clearInterval(faceDetectors.get(id));
            faceDetectors.delete(id);
          }
        }
        return;
      }

      consecutiveErrors = 0; // Reset error counter
      isDetecting = true;
      
      try {
        // Ensure canvas matches video dimensions
        if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          log("Updated canvas dimensions for", id, `${canvas.width}x${canvas.height}`);
        }
        
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        // Face detection with timeout protection
        const detectionPromise = model.estimateFaces(video, false);
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Detection timeout')), 1000)
        );
        
        const predictions = await Promise.race([detectionPromise, timeoutPromise]);
        
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
        
        detectionCount++;
        
        // Log progress every 5 seconds
        if (detectionCount % 25 === 0) {
          log(`Face detection active for ${id} (${detectionCount} frames processed)`);
        }
        
      } catch (e) {
        consecutiveErrors++;
        warn("Face detection error for", id, e.message);
        
        // Stop if too many consecutive errors
        if (consecutiveErrors > 5) {
          err("Too many face detection errors, stopping for", id);
          if (faceDetectors.has(id)) {
            clearInterval(faceDetectors.get(id));
            faceDetectors.delete(id);
          }
        }
      } finally {
        isDetecting = false;
      }
    };

    // Adjust detection frequency based on device capabilities
    const detectionInterval = isIOS ? 300 : 200; // Slower on iOS to reduce CPU load
    const intervalId = setInterval(detectLoop, detectionInterval);
    faceDetectors.set(id, intervalId);
    
    log("Face detection started for", id, `at ${1000/detectionInterval}fps`);
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

  // Enhanced Diagnostics
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

  // Stable m-line order: audio then video transceivers
  const audioTr = pc.addTransceiver("audio", { direction: "sendrecv" });
  const videoTr = pc.addTransceiver("video", { direction: "sendrecv" });
  
  // Enhanced codec preferences with Safari/iOS support
  try {
    const caps = RTCRtpReceiver.getCapabilities("video");
    if (videoTr.setCodecPreferences && caps?.codecs?.length) {
      const h264 = caps.codecs.filter(c => /video\/h264/i.test(c.mimeType));
      const vp8 = caps.codecs.filter(c => /video\/vp8/i.test(c.mimeType));
      const rest = caps.codecs.filter(c => !h264.includes(c) && !vp8.includes(c));
      
      // Prioritize H.264 for Safari/iOS compatibility
      const codecOrder = isSafari || isIOS ? [...h264, ...vp8, ...rest] : [...h264, ...vp8, ...rest];
      videoTr.setCodecPreferences(codecOrder);
      log(peerId, "codec prefs set:", codecOrder.slice(0, 3).map(c => c.mimeType));
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

  // ENHANCED: Remote track handling with better iOS support
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

    // Enhanced track event handling
    e.track.onended = () => {
      log("Track ended for", peerId, e.track.kind);
      stream.removeTrack(e.track);
    };

    e.track.onmute = () => log("Track muted for", peerId, e.track.kind);
    e.track.onunmute = () => {
      log("Track unmuted for", peerId, e.track.kind);
      // Enhanced autoplay handling for iOS
      if (isIOS) {
        setTimeout(() => {
          video.play().catch(err => warn("Auto-play blocked:", err));
        }, 100);
      } else {
        video.play().catch(err => warn("Auto-play blocked:", err));
      }
    };
  };

  // FIXED: Negotiation handling
  pc.onnegotiationneeded = async () => {
    // Check if peer state still exists
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
      if (pc.signalingState === "stable") {
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

/* ====================== Local media & join (ENHANCED) ====================== */
async function init(room) {
  roomId = room;
  
  try {
    // iOS-optimized media constraints
    const videoConstraints = isIOS ? {
      facingMode: "user",
      width: { ideal: 640, max: 1280 },
      height: { ideal: 480, max: 720 },
      frameRate: { ideal: 15, max: 30 }
    } : {
      facingMode: "user",
      width: { ideal: 1280, max: 1920 },
      height: { ideal: 720, max: 1080 },
      frameRate: { ideal: 30, max: 60 }
    };

    const audioConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    };

    // Don't include sampleRate for iOS compatibility
    if (!isIOS) {
      audioConstraints.sampleRate = 44100;
    }

    localStream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: audioConstraints
    });
    
    log("Local media acquired successfully", isIOS ? "(iOS optimized)" : "");
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

/* ====================== Enhanced Diagnostic Functions ====================== */
function diagnoseConnections() {
  console.log("=== FACECALL DIAGNOSTICS ===");
  console.log("Device info:", { isIOS, isSafari });
  
  // Check local stream
  console.log("Local stream:", localStream);
  if (localStream) {
    console.log("Local tracks:", localStream.getTracks().map(t => ({
      kind: t.kind,
      enabled: t.enabled,
      readyState: t.readyState,
      muted: t.muted,
      label: t.label
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
  
  // Check face detection
  console.log("\n=== FACE DETECTION ===");
  console.log("Active detectors:", Array.from(faceDetectors.keys()));
  console.log("BlazeFace loaded:", typeof blazeface !== "undefined");
  
  console.log("=== END DIAGNOSTICS ===");
}

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

// Enhanced face detection status checker
function checkFaceDetectionStatus() {
  console.log("=== FACE DETECTION STATUS ===");
  
  document.querySelectorAll('.video-card').forEach((card, i) => {
    const video = card.querySelector('video');
    const canvas = card.querySelector('canvas');
    const peerId = card.dataset.id;
    
    console.log(`Video ${i} (${peerId}):`);
    console.log("- Video dimensions:", video.videoWidth, "x", video.videoHeight);
    console.log("- Canvas dimensions:", canvas.width, "x", canvas.height);
    console.log("- Face detection active:", faceDetectors.has(peerId));
    console.log("- Video ready:", video.readyState >= 2);
    console.log("- Video playing:", !video.paused);
    console.log("- Current time:", video.currentTime);
  });
  
  console.log("Active detectors:", Array.from(faceDetectors.keys()));
  console.log("BlazeFace available:", typeof blazeface !== "undefined");
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
    
    // Restart face detection if video becomes valid
    setTimeout(() => {
      if (video.videoWidth > 0 && !faceDetectors.has(peerId)) {
        startFaceDetectorFor(peerId);
      }
    }, 2000);
  }
}

/* ====================== Enhanced Fix Video Button ====================== */
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

  // Enhanced click handler
  fixBtn.onclick = function() {
    console.log('=== ENHANCED FIXING BLACK VIDEOS ===');
    console.log('Device:', { isIOS, isSafari });
    
    // Show what we're doing
    fixBtn.textContent = '🔄 Fixing...';
    fixBtn.style.background = 'orange';
    
    // Get all video cards
    const videoCards = document.querySelectorAll('.video-card');
    console.log('Found', videoCards.length, 'video cards');
    
    videoCards.forEach((card, index) => {
      const video = card.querySelector('video');
      const canvas = card.querySelector('canvas');
      const peerId = card.dataset.id;
      const isLocal = peerId === 'local';
      
      console.log(`Checking video ${index} (${peerId}):`, {
        dimensions: `${video.videoWidth}x${video.videoHeight}`,
        readyState: video.readyState,
        paused: video.paused,
        muted: video.muted,
        hasSource: !!video.srcObject,
        currentTime: video.currentTime
      });
      
      // Try to fix the video
      if (video.srcObject) {
        const tracks = video.srcObject.getTracks();
        console.log(`Video ${index} tracks:`, tracks.map(t => ({
          kind: t.kind,
          enabled: t.enabled,
          readyState: t.readyState,
          muted: t.muted,
          label: t.label
        })));
        
        // Force video properties
        video.autoplay = true;
        video.playsInline = true;
        video.muted = isLocal; // Local muted, remote unmuted initially
        
        // Enhanced canvas setup
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
        } else {
          canvas.width = 320;
          canvas.height = 240;
        }
        
        // Try to play with enhanced error handling
        video.play().then(() => {
          console.log(`✅ Video ${index} (${peerId}) is now playing`);
          
          // Restart face detection if needed
          if (video.videoWidth > 0 && !faceDetectors.has(peerId)) {
            setTimeout(() => startFaceDetectorFor(peerId), 1000);
          }
          
        }).catch(error => {
          console.log(`❌ Video ${index} (${peerId}) play failed:`, error.message);
          
          // Try with muted for autoplay policy
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
    
    // Enhanced peer connection diagnostics
    console.log('\n=== PEER CONNECTIONS ===');
    console.log('Active peers:', peers.size);
    
    for (const [peerId, state] of peers) {
      console.log(`Peer ${peerId}:`, {
        connectionState: state.pc.connectionState,
        iceConnectionState: state.pc.iceConnectionState,
        signalingState: state.pc.signalingState,
        polite: state.polite
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
    
    // Face detection status
    setTimeout(() => {
      checkFaceDetectionStatus();
    }, 2000);
    
    // Reset button
    setTimeout(() => {
      fixBtn.textContent = '🔧 Fix Black Videos';
      fixBtn.style.background = '#ff4444';
    }, 3000);
    
    console.log('=== ENHANCED FIX COMPLETE - Check console above for details ===');
  };

  // Add to page
  document.body.appendChild(fixBtn);
  console.log('Enhanced Fix Video button added to page');
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