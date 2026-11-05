   console.log('webrtc.js loaded');
   alert('webrtc.js is running');
   (function () {
  const TOKEN_KEY = 'scopedesk_token'; // <-- change this (Step D)
  const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  let rtcSocket, rtcPc, rtcRole;

  function rtcSend(msg) { rtcSocket.emit('webrtc-signal', msg); }

  function rtcSetup(room) {
    rtcPc = new RTCPeerConnection(rtcConfig);

    rtcPc.onicecandidate = (e) => {
      if (e.candidate) rtcSend({ type: 'candidate', candidate: e.candidate });
    };
    rtcPc.onconnectionstatechange = () => console.log('Connection state:', rtcPc.connectionState);
    rtcPc.ontrack = (e) => {
      console.log('Video received!');
        document.getElementById('rtcShareBtn').onclick = async () => {
     try {
       rtcRole = 'client';
       const room = document.getElementById('rtcRoom').value;
       if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
         alert('Screen sharing is not available on this address. Open http://localhost:3000');
         return;
       }
       const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
       console.log('Screen picked');
       rtcSetup(room);
       stream.getTracks().forEach((t) => rtcPc.addTrack(t, stream));
     } catch (err) {
       alert('Share failed: ' + err.name + ' - ' + err.message);
       console.error(err);
     }
   }; 
    };

    rtcSocket = io({ auth: { token: localStorage.getItem(TOKEN_KEY) } });
    rtcSocket.on('connect', () => console.log('Signaling connected'));
    rtcSocket.on('connect_error', (err) => console.log('Signaling error:', err.message));

    rtcSocket.on('webrtc-peer-joined', async () => {
      if (rtcRole !== 'client') return;
      const offer = await rtcPc.createOffer();
      await rtcPc.setLocalDescription(offer);
      rtcSend({ type: 'offer', offer });
    });

    rtcSocket.on('webrtc-signal', async (msg) => {
      if (msg.type === 'offer') {
        await rtcPc.setRemoteDescription(msg.offer);
        const answer = await rtcPc.createAnswer();
        await rtcPc.setLocalDescription(answer);
        rtcSend({ type: 'answer', answer });
      }
      if (msg.type === 'answer') await rtcPc.setRemoteDescription(msg.answer);
      if (msg.type === 'candidate') await rtcPc.addIceCandidate(msg.candidate);
    });

    rtcSocket.emit('webrtc-join', room);
  }

  document.getElementById('rtcShareBtn').onclick = async () => {
    rtcRole = 'client';
    const room = document.getElementById('rtcRoom').value;
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    rtcSetup(room);
    stream.getTracks().forEach((t) => rtcPc.addTrack(t, stream));
  };

  document.getElementById('rtcViewBtn').onclick = () => {
    rtcRole = 'vendor';
    rtcSetup(document.getElementById('rtcRoom').value);
  };
})();