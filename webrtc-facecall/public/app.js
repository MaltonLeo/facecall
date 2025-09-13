// const socket = io();

// // === Global state ===
// const peers = new Map();
// const streams = new Map();
// const makingOffer = new Map();
// const pending = new Map(); // ICE candidate queue

// let localStream = null;
// let roomId = null;

// // === RTC Config (STUN + TURN) ===
// const rtcConfig = {
//   iceServers: [
//     { urls: 'stun:stun.l.google.com:19302' },
//     {
//       urls: 'turn:global.relay.metered.ca:80',
//       username: 'openai',
//       credential: 'openai123'
//     }
//   ]
// };

// // === Local video ===
// async function init() {
//   localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
//   addVideo('me', localStream, true);

//   // room id from URL (?room=demo)
//   const params = new URLSearchParams(window.location.search);
//   roomId = params.get('room') || 'demo';
//   socket.emit('join', roomId);
// }
// init();

// // === PeerConnection yaratish ===
// async function createPeerConnection(peerId, initiator = false) {
//   if (peers.has(peerId)) return peers.get(peerId);

//   const pc = new RTCPeerConnection(rtcConfig);
//   peers.set(peerId, pc);

//   makingOffer.set(peerId, false);
//   pending.set(peerId, []);

//   // Faqat initiator offer yaratadi
//   if (initiator) {
//     pc.onnegotiationneeded = async () => {
//       try {
//         if (pc.signalingState !== 'stable') return;
//         makingOffer.set(peerId, true);
//         await pc.setLocalDescription(await pc.createOffer());
//         socket.emit("offer", { to: peerId, sdp: pc.localDescription });
//       } catch (err) {
//         console.error("negotiation error", err);
//       } finally {
//         makingOffer.set(peerId, false);
//       }
//     };
//   }

//   // Local treklari
//   localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

//   pc.onicecandidate = (e) => {
//     if (e.candidate) {
//       socket.emit("candidate", { to: peerId, candidate: e.candidate });
//     }
//   };

//   pc.ontrack = (e) => {
//     let stream = streams.get(peerId);
//     if (!stream) {
//       stream = new MediaStream();
//       streams.set(peerId, stream);
//       addVideo(peerId, stream, false);
//     }
//     stream.addTrack(e.track);
//   };

//   return pc;
// }

// // === Video qo‘shish/olib tashlash ===
// function addVideo(id, stream, muted) {
//   let video = document.getElementById(id);
//   if (!video) {
//     video = document.createElement('video');
//     video.id = id;
//     video.autoplay = true;
//     video.playsInline = true;
//     video.muted = muted;
//     document.body.appendChild(video);
//   }
//   video.srcObject = stream;
// }

// function removePeer(id) {
//   const video = document.getElementById(id);
//   if (video) video.remove();
//   peers.delete(id);
//   streams.delete(id);
// }

// // === Socket.io handlers ===
// socket.on('existing-users', async (clients) => {
//   console.log('existing-users', clients);
//   for (const peerId of clients) {
//     await createPeerConnection(peerId, true);   // initiator = true
//   }
// });

// socket.on('user-joined', async ({ userId }) => {
//   console.log('user-joined', userId);
//   await createPeerConnection(userId, false);    // initiator = false
// });

// socket.on('offer', async ({ from, sdp }) => {
//   console.log('offer from', from);
//   const pc = await createPeerConnection(from, false);
//   const offer = new RTCSessionDescription(sdp);

//   const isStable = pc.signalingState === 'stable';
//   const isColliding = !isStable || makingOffer.get(from);

//   if (isColliding) {
//     try { await pc.setLocalDescription({ type: 'rollback' }); } catch(e){ console.warn(e); }
//   }

//   await pc.setRemoteDescription(offer);
//   const answer = await pc.createAnswer();
//   await pc.setLocalDescription(answer);
//   socket.emit('answer', { to: from, sdp: pc.localDescription });

//   // navbatdagi kandidatlarni flush
//   const q = pending.get(from) || [];
//   for (const c of q) {
//     try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch(e){ console.warn(e); }
//   }
//   pending.set(from, []);
// });

// socket.on('answer', async ({ from, sdp }) => {
//   console.log('answer from', from, 'state=', peers.get(from)?.signalingState);
//   const pc = peers.get(from);
//   if (!pc) return;
//   if (pc.signalingState === 'have-local-offer') {
//     await pc.setRemoteDescription(new RTCSessionDescription(sdp));
//     const q = pending.get(from) || [];
//     for (const c of q) {
//       try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch(e){ console.warn(e); }
//     }
//     pending.set(from, []);
//   } else {
//     console.log('ignore late answer in state', pc.signalingState);
//   }
// });

// socket.on('candidate', async ({ from, candidate }) => {
//   const pc = peers.get(from) || await createPeerConnection(from, false);
//   if (!pc) return;
//   try {
//     if (pc.remoteDescription) {
//       await pc.addIceCandidate(new RTCIceCandidate(candidate));
//     } else {
//       const q = pending.get(from) || [];
//       q.push(candidate);
//       pending.set(from, q);
//     }
//   } catch(e){ console.warn(e); }
// });

// socket.on('user-left', ({ userId }) => {
//   console.log('user-left', userId);
//   removePeer(userId);
// });



const socket = io();

// ICE servers (use public Google STUN)
const rtcConfig = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }]
};

const peers = new Map(); // peerId -> RTCPeerConnection
const streams = new Map(); // peerId -> MediaStream
let localStream = null;
let roomId = null;

const videosEl = document.getElementById('videos');
const roomInput = document.getElementById('room-input');
const joinBtn = document.getElementById('join-btn');
const shareLink = document.getElementById('share-link');

joinBtn.onclick = async () => {
  const input = roomInput.value.trim() || new URLSearchParams(location.search).get('room') || 'demo';
  await init(input);
};

(async function autoJoinFromURL(){
  const fromURL = new URLSearchParams(location.search).get('room');
  if (fromURL) {
    roomInput.value = fromURL;
    await init(fromURL);
  }
})();

async function init(room) {
  roomId = room;
  // get user media
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (e) {
    alert('Camera/mic permission denied or unavailable: ' + e.message);
    return;
  }

  // add local video
  addVideo('local', localStream, true);
  // load detector
  await loadFaceDetector('local');

  // join signaling room
  socket.emit('join', { roomId, userId: 'local' });

  const url = new URL(location.href);
  url.searchParams.set('room', roomId);
  shareLink.innerHTML = `Share: <a href="${url.href}" target="_blank">${url.href}</a>`;

  // handle existing users (create offers)
  socket.on('existing-users', async (clients) => {
    for (const peerId of clients) {
      await createPeerConnection(peerId, true); // initiator
    }
  });

  socket.on('user-joined', async ({ userId }) => {
    await createPeerConnection(userId, true);
  });

  socket.on('offer', async ({ from, sdp }) => {
    const pc = await createPeerConnection(from, false);
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { to: from, sdp: answer });
  });

  socket.on('answer', async ({ from, sdp }) => {
    const pc = peers.get(from);
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  });

  socket.on('candidate', async ({ from, candidate }) => {
    const pc = peers.get(from);
    if (!pc) return;
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(e){ console.warn(e); }
  });

  socket.on('user-left', ({ userId }) => removePeer(userId));
}

async function createPeerConnection(peerId, initiator=false) {
  if (peers.has(peerId)) return peers.get(peerId);

  const pc = new RTCPeerConnection(rtcConfig);
  peers.set(peerId, pc);

  // add local tracks
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('candidate', { to: peerId, candidate: e.candidate });
    }
  };

  pc.ontrack = (e) => {
    let stream = streams.get(peerId);
    if (!stream) {
      stream = new MediaStream();
      streams.set(peerId, stream);
      addVideo(peerId, stream, false);
      // load detector for remote stream as well
      loadFaceDetector(peerId);
    }
    stream.addTrack(e.track);
  };

  if (initiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { to: peerId, sdp: offer });
  }

  return pc;
}

function removePeer(peerId) {
  const pc = peers.get(peerId);
  if (pc) pc.close();
  peers.delete(peerId);
  streams.delete(peerId);
  const card = document.querySelector(`.video-card[data-id="${peerId}"]`);
  card?.remove();
}

function addVideo(id, stream, isLocal=false) {
  let card = document.querySelector(`.video-card[data-id="${id}"]`);
  if (card) card.remove();

  card = document.createElement('div');
  card.className = 'video-card';
  card.dataset.id = id;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = isLocal;
  video.srcObject = stream;

  const canvas = document.createElement('canvas');
  canvas.className = 'overlay';

  const badge = document.createElement('div');
  badge.className = 'badge';
  badge.textContent = isLocal ? 'You' : id.slice(0,6);

  card.appendChild(video);
  card.appendChild(canvas);
  card.appendChild(badge);
  videosEl.appendChild(card);

  // Resize canvas to match video whenever metadata is loaded
  video.addEventListener('loadedmetadata', () => {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  });
}

async function loadFaceDetector(peerId) {
  const card = document.querySelector(`.video-card[data-id="${peerId}"]`);
  if (!card) return;
  const video = card.querySelector('video');
  const canvas = card.querySelector('canvas.overlay');
  const ctx = canvas.getContext('2d');

  const model = await blazeface.load();
  async function loop() {
    if (video.readyState >= 2) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.clearRect(0,0,canvas.width,canvas.height);

      const predictions = await model.estimateFaces(video, false);
      for (const p of predictions) {
        const [x, y] = p.topLeft;
        const [x2, y2] = p.bottomRight;
        const w = x2 - x;
        const h = y2 - y;
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#00FFAA';
        ctx.strokeRect(x, y, w, h);
      }
    }
    requestAnimationFrame(loop);
  }
  loop();
}
