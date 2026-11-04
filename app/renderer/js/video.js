'use strict';
/* Connect All — Connect Video: WebRTC call, 1:4 watch split, synced local music. */

(function () {
  const { h, icon, toast } = UI;

  const V = {
    pc: null,
    dc: null,
    localStream: null,
    remoteCamStream: null,
    remoteScreenStream: null,
    screenStream: null,
    senders: {},
    remote: { cam: null, screen: null, mic: null, sys: null },
    callId: '',
    role: '',
    state: 'idle', // idle | ringing | connecting | active
    signals: [],
    incoming: null,
    pendingOffer: null,
    pendingCandidates: [],
    pendingMode: null,
    polite: false,
    mode: 'call',
    muted: false,
    cameraOn: true,
    sharing: false,
    remoteScreenActive: false,
    sourceId: '',
    quality: 'auto',
    stats: { rtt: 0, kbps: 0, loss: 0, fps: 0, w: 0, h: 0 },
    statsTimer: null,
    statsPrev: null,
    durationTimer: null,
    startedAt: 0,
    music: {
      audio: null,
      ctx: null,
      analyser: null,
      source: null,
      playlist: [],
      index: -1,
      playing: false,
      duration: 0,
      name: '',
      path: '',
      applying: false,
      raf: null,
      remoteName: '',
    },
    els: null,
    lastTick: 0,
    ringTimer: null,
  };

  const QC = { auto: 1200, saver: 350, hd: 3000 };
  const REMOTE_LABELS = ['cam', 'screen', 'mic', 'sys'];

  function peerName() {
    return CA.snap && CA.snap.app.pairing.peer ? CA.snap.app.pairing.peer.name : T('chat.partner');
  }

  function myName() {
    return CA.snap && CA.snap.app.device ? CA.snap.app.device.name : 'Me';
  }

  function callId() {
    return 'call-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }

  /* ------------------------------------------------------------------ */
  /* Media                                                               */
  /* ------------------------------------------------------------------ */

  async function ensureLocalMedia() {
    if (V.localStream) return V.localStream;
    const cfg = CA.snap.settings.video;
    const video = cfg.cameraId ? { deviceId: { exact: cfg.cameraId } } : { width: 1280, height: 720, frameRate: 24 };
    const audio = cfg.micId
      ? { deviceId: { exact: cfg.micId } }
      : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    try {
      await window.ca.video.mediaAccess();
    } catch (_) {}
    try {
      V.localStream = await navigator.mediaDevices.getUserMedia({ video, audio });
    } catch (err) {
      console.warn('camera/mic unavailable', err);
      try {
        V.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        toast(T('video.permission_denied'), 'err');
      } catch (err2) {
        try {
          V.localStream = await navigator.mediaDevices.getUserMedia({ video: true });
        } catch (err3) {
          throw new Error(T('video.permission_denied'));
        }
      }
    }
    return V.localStream;
  }

  function replaceTracks() {
    if (!V.pc || !V.localStream) return;
    const v = V.localStream.getVideoTracks()[0] || null;
    const a = V.localStream.getAudioTracks()[0] || null;
    if (V.senders.cam) V.senders.cam.replaceTrack(v).catch(() => {});
    if (V.senders.mic) V.senders.mic.replaceTrack(a).catch(() => {});
    if (v) v.enabled = V.cameraOn;
    if (a) a.enabled = !V.muted;
    if (V.els) {
      for (const el of [V.els.localCall, V.els.localSide]) {
        el.srcObject = V.localStream;
        el.muted = true;
        el.play().catch(() => {});
      }
    }
  }

  function attachRemote(transceiver, track) {
    if (!V.pc || !track) return;
    const idx = V.pc.getTransceivers().indexOf(transceiver);
    const key = REMOTE_LABELS[idx];
    if (!key) return;
    V.remote[key] = track;
    if (key === 'cam') {
      V.remoteCamStream = new MediaStream([track]);
      for (const el of [V.els.remoteCall, V.els.remoteSide]) {
        el.srcObject = V.remoteCamStream;
        el.play().catch(() => {});
      }
    } else if (key === 'screen') {
      V.remoteScreenStream = new MediaStream([track]);
      if (V.els.screen) {
        V.els.screen.srcObject = V.remoteScreenStream;
        V.els.screen.play().catch(() => {});
      }
      renderMain();
    } else if (key === 'mic' && V.els.remoteAudio) {
      V.els.remoteAudio.srcObject = new MediaStream([track]);
      V.els.remoteAudio.play().catch(() => {});
    } else if (key === 'sys' && V.els.remoteSysAudio) {
      V.els.remoteSysAudio.srcObject = new MediaStream([track]);
      V.els.remoteSysAudio.play().catch(() => {});
    }
    track.addEventListener('ended', () => {
      if (V.remote[key] === track) V.remote[key] = null;
      if (key === 'screen') V.remoteScreenActive = false;
      renderMain();
      renderTiles();
    });
  }

  function bindTransceivers() {
    if (!V.pc) return;
    const tx = V.pc.getTransceivers();
    V.senders.cam = tx[0] ? tx[0].sender : null;
    V.senders.screen = tx[1] ? tx[1].sender : null;
    V.senders.mic = tx[2] ? tx[2].sender : null;
    V.senders.sys = tx[3] ? tx[3].sender : null;
    // Transceivers created by a remote offer default to recvonly. replaceTrack()
    // does not change direction, so an answerer must opt into sending explicitly.
    for (const t of tx.slice(0, 4)) {
      try {
        t.direction = 'sendrecv';
      } catch (_) {}
    }
  }

  function syncRemoteTracks() {
    if (!V.pc) return;
    for (const t of V.pc.getTransceivers()) {
      if (t.receiver && t.receiver.track) attachRemote(t, t.receiver.track);
    }
  }

  /* ------------------------------------------------------------------ */
  /* WebRTC                                                              */
  /* ------------------------------------------------------------------ */

  function makePc({ polite = false } = {}) {
    const cfg = CA.snap.settings.transport;
    const iceServers = (cfg.iceServers || []).map((s) => ({ urls: s.urls }));
    if (cfg.turn && cfg.turn.url) {
      iceServers.push({ urls: cfg.turn.url, username: cfg.turn.username || '', credential: cfg.turn.password || '' });
    }
    if (!iceServers.length) iceServers.push({ urls: 'stun:stun.l.google.com:19302' });
    const pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 2 });
    V.pc = pc;
    V.senders = {};
    V.remote = { cam: null, screen: null, mic: null, sys: null };
    // The caller creates the four m-lines in a fixed order; the callee reuses
    // the transceivers that the remote offer creates. Pre-creating them on both
    // sides would make the answerer negotiate eight m-lines and send nothing.
    if (V.role === 'caller') {
      pc.addTransceiver('video', { direction: 'sendrecv' });
      pc.addTransceiver('video', { direction: 'sendrecv' });
      pc.addTransceiver('audio', { direction: 'sendrecv' });
      pc.addTransceiver('audio', { direction: 'sendrecv' });
      bindTransceivers();
    }
    pc.ontrack = (ev) => attachRemote(ev.transceiver, ev.track);
    pc.onicecandidate = (ev) => {
      if (ev.candidate) sendSignal('ice', ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate);
    };
    pc.onconnectionstatechange = () => {
      if (!V.pc) return;
      if (pc.connectionState === 'connected') {
        V.state = 'active';
        V.startedAt = V.startedAt || Date.now();
        clearRingTimer();
        syncRemoteTracks();
        renderAll();
      } else if (pc.connectionState === 'failed') {
        toast(T('video.error', { err: 'ICE failed' }), 'err');
        hangup(true);
      } else if (pc.connectionState === 'disconnected') {
        renderAll();
      }
    };
    if (V.role === 'caller') {
      try {
        const dc = pc.createDataChannel('ca-ctl', { ordered: true });
        setupDataChannel(dc);
      } catch (_) {}
    } else {
      pc.ondatachannel = (ev) => setupDataChannel(ev.channel);
    }
    return pc;
  }

  function setupDataChannel(dc) {
    V.dc = dc;
    dc.onopen = () => {
      sendCtl({ t: 'mode', mode: V.mode });
      if (V.pendingMode) {
        setMode(V.pendingMode, { remote: true });
        V.pendingMode = null;
      }
    };
    dc.onmessage = (ev) => {
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      handleCtl(data, true);
    };
  }

  function sendCtl(obj) {
    if (V.dc && V.dc.readyState === 'open') {
      try {
        V.dc.send(JSON.stringify(obj));
        return true;
      } catch (_) {}
    }
    window.ca.video.mediaSync({ type: obj.t, data: obj }).catch(() => {});
    return false;
  }

  function handleCtl(data, viaDc) {
    if (!data || !data.t) return;
    if (data.t === 'mode' && data.mode) setMode(data.mode, { remote: true });
    else if (data.t === 'music') handleRemoteMusic(data);
    else if (data.t === 'screen') {
      V.remoteScreenActive = Boolean(data.active);
      if (!data.active) {
        V.remote.screen = null;
        V.remoteScreenStream = null;
        if (V.els.screen) V.els.screen.srcObject = null;
      }
      renderMain();
    }
  }

  function sendSignal(type, data) {
    if (!V.callId) return;
    window.ca.video.signal({ callId: V.callId, type, data }).catch((err) => console.warn('signal failed', err));
  }

  function onCallButton() {
    if (V.state === 'ringing') return acceptCall();
    if (V.state === 'active' || V.state === 'connecting') return hangup();
    return startCall();
  }

  async function startCall() {
    if (!CA.snap.app.pairing.paired) {
      toast(T('video.need_pair'), 'err');
      return;
    }
    if (V.state === 'active' || V.state === 'connecting') {
      hangup();
      return;
    }
    V.role = 'caller';
    V.callId = callId();
    V.state = 'connecting';
    V.mode = 'call';
    V.pendingCandidates = [];
    V.polite = false;
    V.startedAt = 0;
    clearRingTimer();
    V.ringTimer = setTimeout(() => {
      if (V.state !== 'active' && V.state !== 'idle') {
        toast(T('video.no_answer'));
        hangup(true);
      }
    }, 45000);
    sendSignal('call-request', { from: myName(), mode: 'call' });
    try {
      makePc({ polite: false });
      startTimers();
      await ensureLocalMedia();
      replaceTracks();
      const offer = await V.pc.createOffer();
      await V.pc.setLocalDescription(offer);
      sendSignal('offer', { type: 'offer', sdp: V.pc.localDescription.sdp });
      applyQuality();
    } catch (err) {
      toast(T('video.error', { err: err.message }), 'err');
      hangup(true);
      return;
    }
    updateActivity();
    renderAll();
  }

  function clearRingTimer() {
    if (V.ringTimer) clearTimeout(V.ringTimer);
    V.ringTimer = null;
  }

  function showIncoming(payload) {
    if (V.state === 'ringing' && payload.callId && payload.callId === V.callId) return; // duplicate replay
    if (V.state === 'active' || V.state === 'connecting' || V.state === 'ringing') {
      if (payload.callId) {
        window.ca.video.signal({ callId: payload.callId, type: 'hangup', data: { reason: 'busy' } }).catch(() => {});
        toast(T('video.busy'));
      }
      return;
    }
    V.incoming = { callId: payload.callId, from: (payload.data && payload.data.from) || peerName() };
    V.callId = payload.callId;
    V.state = 'ringing';
    renderAll();
  }

  async function acceptCall() {
    if (!V.incoming) return;
    const { callId: id } = V.incoming;
    V.callId = id;
    V.role = 'callee';
    V.state = 'connecting';
    V.incoming = null;
    V.pendingCandidates = [];
    try {
      makePc({ polite: true });
      startTimers();
      await ensureLocalMedia();
      if (V.pendingOffer) {
        await V.pc.setRemoteDescription(V.pendingOffer);
        V.pendingOffer = null;
        bindTransceivers();
        replaceTracks();
        await drainCandidates();
        const answer = await V.pc.createAnswer();
        await V.pc.setLocalDescription(answer);
        sendSignal('answer', { type: 'answer', sdp: V.pc.localDescription.sdp });
      }
      applyQuality();
      updateActivity();
      renderAll();
      if (V.pendingMode) {
        setMode(V.pendingMode, { remote: true });
        V.pendingMode = null;
      }
    } catch (err) {
      toast(T('video.error', { err: err.message }), 'err');
      hangup(true);
    }
  }

  function declineCall() {
    if (V.incoming) {
      V.callId = V.incoming.callId;
      sendSignal('hangup', { reason: 'declined' });
    }
    V.incoming = null;
    V.state = 'idle';
    V.callId = '';
    renderAll();
  }

  function hangup(quiet) {
    clearRingTimer();
    if (V.callId && !quiet) sendSignal('hangup', { reason: 'bye' });
    stopScreenShare({ silent: true });
    if (V.music.audio && !V.music.audio.paused) {
      V.music.audio.pause();
      V.music.playing = false;
    }
    if (V.pc) {
      try {
        V.pc.close();
      } catch (_) {}
      V.pc = null;
    }
    V.dc = null;
    if (V.localStream) {
      for (const t of V.localStream.getTracks()) t.stop();
      V.localStream = null;
    }
    V.remoteCamStream = null;
    V.remoteScreenStream = null;
    V.remoteScreenActive = false;
    V.remote = { cam: null, screen: null, mic: null, sys: null };
    V.callId = '';
    V.role = '';
    V.state = 'idle';
    V.incoming = null;
    V.pendingOffer = null;
    V.pendingCandidates = [];
    V.mode = 'call';
    V.startedAt = 0;
    if (V.statsTimer) clearInterval(V.statsTimer);
    if (V.durationTimer) clearInterval(V.durationTimer);
    V.statsTimer = null;
    V.durationTimer = null;
    if (V.els) {
      for (const el of [V.els.remoteCall, V.els.remoteSide, V.els.localCall, V.els.localSide, V.els.screen]) el.srcObject = null;
      if (V.els.remoteAudio) V.els.remoteAudio.srcObject = null;
      if (V.els.remoteSysAudio) V.els.remoteSysAudio.srcObject = null;
    }
    updateActivity();
    renderAll();
  }

  async function drainCandidates() {
    if (!V.pc) return;
    for (const c of V.pendingCandidates.splice(0)) {
      try {
        await V.pc.addIceCandidate(c);
      } catch (_) {}
    }
  }

  async function handleSignal(payload) {
    if (!payload || !payload.type) return;
    V.signals.push({ at: Date.now(), type: payload.type, callId: payload.callId });
    if (V.signals.length > 100) V.signals.shift();
    if (payload.type === 'call-request') {
      showIncoming(payload);
      return;
    }
    if (!V.callId || payload.callId !== V.callId) {
      if (payload.type === 'offer') {
        V.pendingMode = (payload.data && payload.data.mode) || V.pendingMode;
      }
      return;
    }
    const { type, data } = payload;
    try {
      if (type === 'offer') {
        if (!V.pc) {
          V.pendingOffer = data;
          return;
        }
        if (V.pc.signalingState !== 'stable') {
          if (V.polite) {
            try {
              await V.pc.setLocalDescription({ type: 'rollback' });
            } catch (_) {}
          } else {
            return;
          }
        }
        await V.pc.setRemoteDescription(data);
        bindTransceivers();
        replaceTracks();
        await drainCandidates();
        const answer = await V.pc.createAnswer();
        await V.pc.setLocalDescription(answer);
        sendSignal('answer', { type: 'answer', sdp: V.pc.localDescription.sdp });
      } else if (type === 'answer') {
        if (V.pc && V.pc.signalingState === 'have-local-offer') {
          await V.pc.setRemoteDescription(data);
          await drainCandidates();
          syncRemoteTracks();
        }
      } else if (type === 'ice') {
        if (V.pc && V.pc.remoteDescription) {
          try {
            await V.pc.addIceCandidate(data);
          } catch (_) {}
        } else {
          V.pendingCandidates.push(data);
        }
      } else if (type === 'hangup') {
        toast((data && data.reason === 'busy' ? T('video.in_call') : T('video.hangup')), '');
        hangup(true);
      }
    } catch (err) {
      console.warn('signal handling failed', err);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Screen share                                                        */
  /* ------------------------------------------------------------------ */

  async function pickSource() {
    const sources = await window.ca.video.sources();
    if (!sources.length) {
      toast(T('video.no_signal_desc'), 'err');
      return;
    }
    const grid = h('div', { class: 'source-grid' });
    const body = h('div', {}, h('div', { class: 'hint', text: T('video.screen_picker_title') }), grid);
    const dlg = UI.showDialog({
      title: T('video.choose_screen'),
      body,
      width: 700,
      actions: [{ label: T('common.cancel'), primary: true }],
    });
    for (const src of sources) {
      const card = h(
        'button',
        {
          class: 'source-card',
          on: {
            click: async () => {
              V.sourceId = src.id;
              await window.ca.video.setSource(src.id);
              UI.closeTopDialog(null);
              startScreenShare();
            },
          },
        },
        src.thumbnail ? h('img', { src: src.thumbnail, alt: src.name }) : h('div', { class: 'source-empty', text: 'NO PREVIEW' }),
        h('div', { class: 'source-name', text: src.name, title: src.name })
      );
      grid.appendChild(card);
    }
  }

  async function startScreenShare() {
    if (V.sharing) return stopScreenShare();
    if (!V.pc || V.state !== 'active') {
      toast(T('video.watch_need_screen'), 'err');
      return;
    }
    try {
      let stream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
      } catch (firstErr) {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
      }
      V.screenStream = stream;
      const vt = stream.getVideoTracks()[0];
      const at = stream.getAudioTracks()[0] || null;
      if (V.senders.screen) await V.senders.screen.replaceTrack(vt).catch(() => {});
      if (at && V.senders.sys) await V.senders.sys.replaceTrack(at).catch(() => {});
      V.sharing = true;
      if (V.els.screenLocal) {
        V.els.screenLocal.srcObject = new MediaStream([vt]);
        V.els.screenLocal.play().catch(() => {});
      }
      vt.addEventListener('ended', () => stopScreenShare());
      setMode('watch', { remote: false });
      sendCtl({ t: 'mode', mode: 'watch' });
      sendCtl({ t: 'screen', active: true });
      toast(at ? T('video.watch') + ' · system audio' : T('video.watch'), 'ok');
      renderAll();
    } catch (err) {
      toast(T('video.error', { err: err.message }), 'err');
    }
  }

  function stopScreenShare({ silent } = {}) {
    if (V.screenStream) {
      for (const t of V.screenStream.getTracks()) t.stop();
      V.screenStream = null;
    }
    if (V.senders.screen) V.senders.screen.replaceTrack(null).catch(() => {});
    if (V.senders.sys) V.senders.sys.replaceTrack(null).catch(() => {});
    V.sharing = false;
    if (V.els && V.els.screenLocal) V.els.screenLocal.srcObject = null;
    if (!silent) {
      sendCtl({ t: 'screen', active: false });
      setMode(V.music.playing ? 'music' : 'call', { remote: false });
      sendCtl({ t: 'mode', mode: V.music.playing ? 'music' : 'call' });
      renderAll();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Music                                                               */
  /* ------------------------------------------------------------------ */

  function fileUrl(p) {
    let path = String(p || '').replace(/\\/g, '/');
    if (!path.startsWith('/')) path = '/' + path;
    return 'file://' + encodeURI(path);
  }

  function ensureAudioGraph() {
    if (!V.music.audio) {
      const audio = new Audio();
      audio.preload = 'metadata';
      audio.addEventListener('loadedmetadata', () => {
        V.music.duration = Number.isFinite(audio.duration) ? audio.duration : 0;
        renderMain();
      });
      audio.addEventListener('timeupdate', () => {
        if (V.els && V.els.seek && !V.music.applying) {
          V.els.seek.max = String(V.music.duration || 0);
          V.els.seek.value = String(audio.currentTime || 0);
          if (V.els.musicTime) V.els.musicTime.textContent = UI.fmtDuration(audio.currentTime * 1000);
        }
      });
      audio.addEventListener('play', () => {
        V.music.playing = true;
        updateActivity();
        renderMusicControls();
        if (!V.music.applying) sendMusic('play');
        startViz();
      });
      audio.addEventListener('pause', () => {
        V.music.playing = false;
        updateActivity();
        renderMusicControls();
        if (!V.music.applying) sendMusic('pause');
        stopViz();
      });
      audio.addEventListener('ended', () => {
        V.music.playing = false;
        renderMusicControls();
        nextTrack();
      });
      audio.addEventListener('error', () => {
        toast(T('video.music_no_file'), 'err');
      });
      V.music.audio = audio;
    }
    if (!V.music.ctx) {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 64;
        const source = ctx.createMediaElementSource(V.music.audio);
        source.connect(analyser);
        analyser.connect(ctx.destination);
        V.music.ctx = ctx;
        V.music.analyser = analyser;
        V.music.source = source;
      } catch (err) {
        console.warn('audio graph failed', err);
      }
    }
  }

  async function openAudio() {
    try {
      const res = await window.ca.video.pickAudio();
      if (!res || !res.ok) return;
      ensureAudioGraph();
      const exists = V.music.playlist.findIndex((t) => t.path === res.path);
      if (exists >= 0) V.music.index = exists;
      else {
        V.music.playlist.push({ path: res.path, name: res.name });
        V.music.index = V.music.playlist.length - 1;
      }
      loadTrack(V.music.index, { autoplay: false });
      if (V.state === 'active') {
        setMode('music', { remote: false });
        sendCtl({ t: 'mode', mode: 'music' });
      }
      renderAll();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function loadTrack(index, { autoplay = false } = {}) {
    const track = V.music.playlist[index];
    if (!track) return;
    V.music.index = index;
    V.music.name = track.name;
    V.music.path = track.path;
    V.music.duration = 0;
    const audio = V.music.audio;
    audio.src = fileUrl(track.path);
    audio.load();
    if (autoplay) audio.play().catch(() => {});
    V.music.playing = autoplay;
    renderControlLabels();
    renderMusicControls();
    renderMain();
  }

  function togglePlay() {
    ensureAudioGraph();
    if (!V.music.audio || !V.music.name) {
      toast(T('video.music_no_file'));
      return;
    }
    if (V.music.audio.paused) V.music.audio.play().catch((e) => toast(e.message, 'err'));
    else V.music.audio.pause();
  }

  function nextTrack() {
    if (!V.music.playlist.length) return;
    loadTrack((V.music.index + 1) % V.music.playlist.length, { autoplay: true });
    sendMusic('track');
  }
  function prevTrack() {
    if (!V.music.playlist.length) return;
    loadTrack((V.music.index - 1 + V.music.playlist.length) % V.music.playlist.length, { autoplay: true });
    sendMusic('track');
  }

  function sendMusic(action) {
    if (V.state !== 'active' && V.state !== 'connecting') return;
    sendCtl({
      t: 'music',
      action,
      name: V.music.name,
      position: V.music.audio ? V.music.audio.currentTime : 0,
      playing: V.music.playing,
      at: Date.now(),
    });
  }

  function handleRemoteMusic(data) {
    if (!data || !data.action) return;
    V.music.remoteName = data.name || V.music.remoteName;
    if (!V.music.name && data.name) {
      toast(T('video.music') + ': ' + data.name);
      return;
    }
    if (data.name && V.music.name && data.name !== V.music.name) {
      toast(T('video.music_mismatch'), 'err');
      renderMusicHint(T('video.music_mismatch'));
      return;
    }
    if (!V.music.audio) return;
    V.music.applying = true;
    try {
      if (data.action === 'play') {
        if (Number.isFinite(data.position)) V.music.audio.currentTime = data.position;
        V.music.audio.play().catch(() => {});
      } else if (data.action === 'pause') {
        V.music.audio.pause();
      } else if (data.action === 'seek') {
        if (Number.isFinite(data.position)) V.music.audio.currentTime = data.position;
      } else if (data.action === 'track') {
        if (data.name && V.music.name === data.name) V.music.audio.currentTime = 0;
      }
    } finally {
      setTimeout(() => (V.music.applying = false), 300);
    }
    if (V.state === 'active') setMode('music', { remote: true });
  }

  function seekTo(value) {
    if (!V.music.audio) return;
    V.music.audio.currentTime = Number(value) || 0;
    if (V.state === 'active') sendMusic('seek');
  }

  function startViz() {
    if (V.music.raf || !V.music.analyser) return;
    const canvas = V.els && V.els.viz;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const data = new Uint8Array(V.music.analyser.frequencyBinCount);
    V.music.raf = requestAnimationFrame(function draw() {
      V.music.raf = requestAnimationFrame(draw);
      if (!V.els || !V.els.viz) return;
      const w = canvas.width;
      const h = canvas.height;
      V.music.analyser.getByteFrequencyData(data);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = '#000';
      const bars = Math.min(48, data.length);
      const bw = Math.max(2, Math.floor(w / bars) - 2);
      for (let i = 0; i < bars; i++) {
        const v = data[i] / 255;
        const bh = Math.max(2, Math.round(v * (h - 6)));
        ctx.fillRect(i * (bw + 2) + 1, h - bh, bw, bh);
      }
    });
  }

  function stopViz() {
    if (V.music.raf) cancelAnimationFrame(V.music.raf);
    V.music.raf = null;
  }

  /* ------------------------------------------------------------------ */
  /* Mode / quality / stats                                              */
  /* ------------------------------------------------------------------ */

  function setMode(mode, { remote } = {}) {
    if (!['call', 'watch', 'music'].includes(mode)) return;
    if (V.state !== 'active' && V.state !== 'connecting') {
      V.pendingMode = mode;
      if (!remote) toast(T('video.call'), '');
      return;
    }
    V.mode = mode;
    renderStage();
    renderControls();
    updateActivity();
    if (!remote) sendCtl({ t: 'mode', mode });
    if (mode === 'music') {
      stopScreenShare({ silent: true });
      renderMain();
    }
    if (mode === 'watch' && !V.sharing && !V.remote.screen) {
      // wait for a screen
    }
  }

  function applyQuality() {
    const kbps = QC[V.quality] || QC.auto;
    for (const key of ['cam', 'screen']) {
      const sender = V.senders[key];
      if (!sender) continue;
      try {
        const params = sender.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = kbps * 1000;
        sender.setParameters(params).catch(() => {});
      } catch (_) {}
    }
  }

  function startStats() {
    if (V.statsTimer) clearInterval(V.statsTimer);
    V.statsTimer = setInterval(async () => {
      if (!V.pc) return;
      try {
        const report = await V.pc.getStats();
        let outBytes = 0;
        let inBytes = 0;
        let loss = 0;
        let fps = 0;
        let w = 0;
        let h0 = 0;
        let rtt = 0;
        const now = Date.now();
        report.forEach((r) => {
          if (r.type === 'outbound-rtp' && (r.kind || r.mediaType) === 'video') outBytes += r.bytesSent || 0;
          if (r.type === 'inbound-rtp' && (r.kind || r.mediaType) === 'video') {
            inBytes += r.bytesReceived || 0;
            loss += r.packetsLost || 0;
            fps = r.framesPerSecond || fps;
            w = r.frameWidth || w;
            h0 = r.frameHeight || h0;
          }
          if (r.type === 'candidate-pair' && (r.state === 'succeeded' || r.nominated) && r.currentRoundTripTime != null) {
            rtt = r.currentRoundTripTime * 1000;
          }
        });
        const prev = V.statsPrev;
        const kbps = prev ? Math.max(0, Math.round(((outBytes - prev.outBytes) * 8) / Math.max(1, now - prev.at))) : 0;
        V.statsPrev = { outBytes, at: now };
        V.stats = { rtt: Math.round(rtt), kbps, loss, fps, w, h: h0 };
        renderTelemetry();
        renderStatsOverlay();
        if (V.quality === 'auto' && (rtt > 350 || loss > 20)) {
          toast(T('video.poor_network'));
        }
      } catch (_) {}
    }, 2500);
  }

  function startTimers() {
    if (V.durationTimer) clearInterval(V.durationTimer);
    V.durationTimer = setInterval(() => updateFooter(), 1000);
    startStats();
  }

  function updateActivity() {
    const videoMode = V.state === 'active' ? (V.mode === 'watch' ? 'watch' : 'call') : '';
    window.ca.settings.setActivity({ videoMode, musicPlaying: Boolean(V.music.playing) }).catch(() => {});
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                           */
  /* ------------------------------------------------------------------ */

  function videoEl(id, extra = {}) {
    const el = h('video', Object.assign({ id, autoplay: '', playsinline: '', muted: extra.muted ? '' : undefined }, extra.attrs || {}));
    el.autoplay = true;
    el.playsInline = true;
    if (extra.muted) el.muted = true;
    return el;
  }

  function tile(id, label, { muted = true, mirror = false } = {}) {
    const v = videoEl(id, { muted });
    const labelNode = h('span', { class: 'label', text: label });
    const off = h('span', { class: 'muted-badge hidden', text: T('video.camera_off') });
    const empty = h('div', { class: 'tile-empty', text: 'NO SIGNAL' });
    const node = h('div', { class: 'video-tile' + (mirror ? ' mirror' : ''), dataset: { video: id } }, v, labelNode, off, empty);
    return { node, video: v, label: labelNode, off, empty };
  }

  function buildStage() {
    const remoteCall = tile('remote-call', peerName(), { muted: false });
    const localCall = tile('local-call', T('video.self'), { muted: true, mirror: true });
    const remoteSide = tile('remote-side', peerName(), { muted: false });
    const localSide = tile('local-side', T('video.self'), { muted: true, mirror: true });
    const grid = h('div', { class: 'video-grid' }, remoteCall.node, localCall.node);

    const screen = videoEl('screen-video');
    screen.muted = true;
    const screenPlaceholder = h(
      'div',
      { class: 'video-pane-placeholder' },
      h('div', { class: 'big', text: T('video.no_signal') }),
      h('div', { class: 'small', text: T('video.watch_need_screen') }),
      h(
        'div',
        { class: 'smpte' },
        Array.from({ length: 7 }, (_, i) => h('i', { style: { opacity: 0.2 + i * 0.1 } }))
      ),
      h('button', { class: 'btn small', text: T('video.share_screen') || T('video.screen'), on: { click: pickSource } })
    );
    const mainPane = h('div', { class: 'video-main' }, screen, screenPlaceholder);
    const side = h('div', { class: 'video-side' }, remoteSide.node, localSide.node);
    const handle = h('div', { class: 'side-handle' });
    side.appendChild(handle);
    const split = h('div', { class: 'split-wrap', style: { display: 'contents' } }, side, mainPane);

    const statsOverlay = h('div', { class: 'stats-overlay hidden' });
    const badge = h('div', { class: 'video-badge hidden' }, h('span', { class: 'rec-dot' }), h('span', { text: T('video.in_call') }));

    const incomingName = h('div', { class: 'bold', text: '' });
    const incoming = h(
      'div',
      { class: 'incoming-call hidden' },
      h(
        'div',
        { class: 'box' },
        h('div', { class: 'titlebar' }, h('span', { class: 'title', text: T('video.ringing', { name: '' }) })),
        h(
          'div',
          { class: 'body' },
          h('div', { class: 'hint', text: T('video.incoming_hint') }),
          h(
            'div',
            { class: 'row center', style: { marginTop: '12px', justifyContent: 'center' } },
            h('button', { class: 'btn primary', text: T('video.accept'), on: { click: acceptCall } }),
            h('button', { class: 'btn', text: T('video.decline'), on: { click: declineCall } })
          )
        )
      )
    );

    const stage = h('div', { class: 'video-stage mode-call' }, grid, side, mainPane, statsOverlay, badge, incoming);
    // side/main are inside stage; grid shown in call mode via CSS classes.
    return {
      stage,
      remoteCall: remoteCall.video,
      localCall: localCall.video,
      remoteSide: remoteSide.video,
      localSide: localSide.video,
      remoteAudio: h('audio', { autoplay: '', style: { display: 'none' } }),
      remoteSysAudio: h('audio', { autoplay: '', style: { display: 'none' } }),
      screen,
      screenPlaceholder,
      screenLocal: null,
      mainPane,
      side,
      handle,
      statsOverlay,
      badge,
      incoming,
      incomingName,
      musicPane: null,
      tiles: { remoteCall, localCall, remoteSide, localSide },
    };
  }

  function musicCanvas() {
    const canvas = h('canvas', { class: 'music-viz', width: '600', height: '90' });
    return canvas;
  }

  function buildMusicPane() {
    const cover = h('div', { class: 'music-cover', text: 'CA' });
    const title = h('div', { class: 'music-title', text: T('video.no_track') });
    const sub = h('div', { class: 'music-sub', text: 'LOCAL AUDIO · SYNCED' });
    const viz = musicCanvas();
    const time = h('span', { class: 'small', text: '00:00' });
    const seek = h('input', { type: 'range', min: '0', max: '0', value: '0', step: '0.1', on: { change: (e) => seekTo(e.target.value) } });
    const playBtn = h('button', { class: 'btn primary', on: { click: togglePlay } }, h('span', { text: T('video.play') }));
    const prevBtn = h('button', { class: 'btn', title: T('video.prev'), on: { click: prevTrack } }, UI.icon('prev', 12));
    const nextBtn = h('button', { class: 'btn', title: T('video.next'), on: { click: nextTrack } }, UI.icon('next', 12));
    const openBtn = h('button', { class: 'btn', text: T('video.open_audio'), on: { click: openAudio } });
    const syncBtn = h('button', { class: 'btn', text: T('video.sync'), on: { click: () => { sendMusic(V.music.playing ? 'play' : 'pause'); toast(T('common.done'), 'ok'); } } });
    const hint = h('div', { class: 'music-hint', text: T('video.music_hint') });
    const pane = h(
      'div',
      { class: 'music-pane' },
      h('div', { class: 'cover-row' }, cover, h('div', { class: 'grow' }, title, sub, h('div', { class: 'row', style: { marginTop: '8px' } }, openBtn, syncBtn))),
      viz,
      h('div', { class: 'music-seek' }, time, seek, h('span', { id: 'music-duration', class: 'small', text: '00:00' })),
      h('div', { class: 'music-transport' }, prevBtn, playBtn, nextBtn, h('span', { class: 'music-hint', text: T('ci.local_only') })),
      hint
    );
    return { pane, title, sub, viz, seek, time, playBtn, hint };
  }

  function renderHead() {
    if (!V.els) return;
    const head = V.els.head;
    UI.clear(head);
    const modeSeg = h(
      'div',
      { class: 'seg' },
      ['call', 'watch', 'music'].map((m) =>
        h('button', {
          class: 'seg-btn ' + (V.mode === m ? 'active' : ''),
          text: T('video.' + (m === 'call' ? 'call_mode' : m === 'watch' ? 'watch_mode' : 'music_mode')),
          disabled: V.state !== 'active' ? true : undefined,
          on: { click: () => setMode(m) },
        })
      )
    );
    const qualitySeg = h(
      'div',
      { class: 'seg' },
      ['auto', 'saver', 'hd'].map((q) =>
        h('button', {
          class: 'seg-btn ' + (V.quality === q ? 'active' : ''),
          text: T('video.quality_' + q),
          on: {
            click: () => {
              V.quality = q;
              applyQuality();
              window.ca.settings.setVideo({ quality: q }).catch(() => {});
              renderHead();
            },
          },
        })
      )
    );
    head.append(
      h('span', { class: 'title-line' }, UI.icon('video', 14), h('span', { text: T('video.title') })),
      h('span', { class: 'tag ' + (V.state === 'active' ? 'green' : ''), text: V.state === 'active' ? T('video.in_call') : V.state === 'connecting' ? T('common.connecting') : V.state === 'ringing' ? T('video.incoming_tag') : T('common.offline') }),
      h('span', { class: 'grow' }),
      h('span', { class: 'mono tiny', id: 'vid-telemetry', text: V.state === 'active' ? telemetryText() : '—' }),
      modeSeg,
      qualitySeg,
      h('button', { class: 'btn small', title: T('video.stats'), on: { click: () => { if (V.els.statsOverlay) V.els.statsOverlay.classList.toggle('hidden'); } } }, UI.icon('eye', 12))
    );
  }

  function telemetryText() {
    const s = V.stats;
    return 'RTT ' + (s.rtt ? s.rtt + 'ms' : '—') + ' · ' + (s.kbps ? s.kbps + 'kbps' : '—') + ' · FPS ' + (s.fps || 0);
  }

  function renderTelemetry() {
    const el = document.getElementById('vid-telemetry');
    if (el) el.textContent = V.state === 'active' ? telemetryText() : '—';
  }

  function renderStatsOverlay() {
    if (!V.els || !V.els.statsOverlay) return;
    const s = V.stats;
    V.els.statsOverlay.textContent =
      'STATE   ' + V.state + '\n' +
      'MODE    ' + V.mode + '\n' +
      'RTT     ' + s.rtt + ' ms\n' +
      'UP      ' + s.kbps + ' kbps\n' +
      'LOST    ' + s.loss + '\n' +
      'VIDEO   ' + (s.w || 0) + 'x' + (s.h || 0) + '\n' +
      'FPS     ' + (s.fps || 0) + '\n' +
      'DC      ' + (V.dc ? V.dc.readyState : '—');
  }

  function renderTiles() {
    if (!V.els) return;
    for (const key of ['remoteCall', 'remoteSide']) {
      const t = V.els.tiles[key];
      t.label.textContent = peerName();
      t.node.classList.toggle('mirror', false);
    }
    for (const key of ['localCall', 'localSide']) {
      const t = V.els.tiles[key];
      t.label.textContent = T('video.self');
      t.node.classList.toggle('mirror', CA.snap.settings.video.mirrorSelf !== false);
      t.off.classList.toggle('hidden', V.cameraOn);
    }
    const active = V.state === 'active';
    const remoteOff = active && !V.remote.cam;
    if (V.els.tiles.remoteCall) V.els.tiles.remoteCall.off.classList.toggle('hidden', !remoteOff);
    if (V.els.tiles.remoteSide) V.els.tiles.remoteSide.off.classList.toggle('hidden', !remoteOff);
    for (const key of ['remoteCall', 'remoteSide']) {
      const t = V.els.tiles[key];
      if (t && t.empty) t.empty.classList.toggle('hidden', !active || Boolean(V.remote.cam));
    }
    for (const key of ['localCall', 'localSide']) {
      const t = V.els.tiles[key];
      if (t && t.empty) t.empty.classList.toggle('hidden', !active || Boolean(V.localStream));
      if (t) t.off.classList.toggle('hidden', !(active && !V.cameraOn));
    }
    if (V.els.badge) {
      V.els.badge.classList.toggle('hidden', V.state !== 'active');
      if (V.els.badge.lastElementChild) V.els.badge.lastElementChild.textContent = V.state === 'active' ? T('video.in_call') : '';
    }
  }

  function renderStage() {
    if (!V.els) return;
    const split = V.mode !== 'call';
    V.els.stage.classList.toggle('mode-call', !split);
    V.els.stage.classList.toggle('mode-split', split);
    V.els.stage.classList.toggle('music-mode', V.mode === 'music');
    // side + main visibility is CSS-driven by mode classes
    const cfg = CA.snap.settings.video;
    V.els.side.style.flexBasis = Math.round((cfg.splitRatio || 0.2) * 100) + '%';
    V.els.stage.classList.toggle('rev', cfg.stripSide === 'right');
    renderMain();
    renderTiles();
    if (V.els.idle) {
      const showIdle = V.state === 'idle' || V.state === 'connecting';
      V.els.idle.classList.toggle('hidden', !showIdle);
      const big = V.els.idle.querySelector('.big');
      if (big) big.textContent = V.state === 'connecting' ? 'CONNECTING…' : 'NO SIGNAL';
      const btn = V.els.idle.querySelector('.btn');
      if (btn) btn.classList.toggle('hidden', V.state !== 'idle');
    }
    const incoming = V.state === 'ringing' && V.incoming;
    if (V.els.incoming) {
      V.els.incoming.classList.toggle('hidden', !incoming);
      if (incoming) {
        V.els.incomingName.textContent = T('video.ringing', { name: V.incoming.from || peerName() });
        const title = V.els.incoming.querySelector('.title');
        if (title) title.textContent = T('video.ringing', { name: V.incoming.from || peerName() });
      }
    }
  }

  function renderMain() {
    if (!V.els) return;
    const main = V.els.mainPane;
    const showMusic = V.mode === 'music';
    const hasScreen = Boolean((V.remoteScreenActive && V.remote.screen) || V.sharing);
    if (V.els.screen) V.els.screen.classList.toggle('hidden', showMusic || !hasScreen);
    if (V.els.screenLocal) V.els.screenLocal.classList.toggle('hidden', !V.sharing || Boolean(V.remote.screen));
    if (V.els.screenPlaceholder) V.els.screenPlaceholder.classList.toggle('hidden', showMusic || hasScreen || V.state !== 'active');
    if (V.els.musicPane) V.els.musicPane.classList.toggle('hidden', !showMusic);
    if (!hasScreen && !showMusic && V.state !== 'active' && V.els.screenPlaceholder) {
      V.els.screenPlaceholder.classList.remove('hidden');
    }
    if (V.els.shareLabel) {
      const label = V.sharing ? 'LIVE · ' + T('video.self') : V.remoteScreenActive && V.remote.screen ? T('video.movie_pane') : '';
      V.els.shareLabel.textContent = label;
      V.els.shareLabel.classList.toggle('hidden', !label);
    }
    if (V.els.musicHint) V.els.musicHint.textContent = T('video.music_hint');
    if (V.state !== 'active' && V.els.screenPlaceholder) {
      const small = V.els.screenPlaceholder.querySelector('.small');
      if (small) small.textContent = T('video.no_signal_desc');
    }
  }

  function renderControlLabels() {
    if (!V.els) return;
    if (V.els.callBtn) {
      V.els.callBtn.textContent =
        V.state === 'ringing' ? T('video.accept') : V.state === 'active' || V.state === 'connecting' ? T('video.hangup') : T('video.call');
      V.els.callBtn.classList.toggle('danger', V.state === 'active' || V.state === 'connecting');
    }
    if (V.els.muteBtn) V.els.muteBtn.textContent = V.muted ? T('video.unmute') : T('video.mute');
    if (V.els.cameraBtn) V.els.cameraBtn.textContent = V.cameraOn ? T('video.camera') : T('video.camera_off');
    if (V.els.screenBtn) V.els.screenBtn.textContent = V.sharing ? T('video.stop_screen') : T('video.screen');
    if (V.els.shareLabel) V.els.shareLabel.textContent = V.sharing ? 'LIVE' : '';
  }

  function renderMusicControls() {
    if (!V.els || !V.els.musicPlay) return;
    V.els.musicPlay.textContent = V.music.playing ? T('video.pause') : T('video.play');
    if (V.els.musicTitle) V.els.musicTitle.textContent = V.music.name || T('video.no_track');
    if (V.els.musicSub) V.els.musicSub.textContent = V.music.path ? 'LOCAL FILE · SYNCED · E2E' : 'NO TRACK';
    if (V.els.seek) {
      V.els.seek.max = String(V.music.duration || 0);
    }
    if (V.els.musicDuration) V.els.musicDuration.textContent = UI.fmtDuration((V.music.duration || 0) * 1000);
  }

  function renderMusicHint(text) {
    if (V.els && V.els.musicHint) V.els.musicHint.textContent = text;
  }

  function renderControls() {
    if (!V.els) return;
    renderControlLabels();
    const active = V.state === 'active' || V.state === 'connecting';
    for (const btn of [V.els.muteBtn, V.els.cameraBtn, V.els.musicBtn]) {
      if (btn) btn.disabled = !active;
    }
    if (V.els.screenBtn) V.els.screenBtn.disabled = V.state !== 'active';
    if (V.els.flipBtn) V.els.flipBtn.disabled = !active;
  }

  function renderAll() {
    if (!refs) return;
    renderHead();
    renderStage();
    renderControls();
    renderMusicControls();
    updateFooter();
  }

  function updateFooter() {
    if (!refs) return;
    const active = V.state === 'active';
    const dur = active && V.startedAt ? UI.fmtDuration(Date.now() - V.startedAt) : '00:00';
    const link = CA.snap.link || {};
    CA_UI.setFooter('video', [
      h('span', { text: 'WEBRTC · DTLS-SRTP' }),
      h('span', { text: '·' }),
      h('span', { text: T('video.elapsed') + ' ' + dur }),
      h('span', { text: '·' }),
      h('span', { text: link.online ? (link.via === 'lan' ? 'LAN' : 'RELAY') : T('common.offline') }),
      h('span', { class: 'grow' }),
      h('span', { text: V.state === 'active' ? telemetryText() : T('video.no_signal_desc') }),
    ]);
  }

  /* ------------------------------------------------------------------ */
  /* Mount                                                               */
  /* ------------------------------------------------------------------ */

  let refs = null;

  function buildStage2() {
    // Final layout: grid (call) or side+main (split) inside one stage.
    const remoteCall = tile('remote-call', peerName(), { muted: false });
    const localCall = tile('local-call', T('video.self'), { muted: true, mirror: true });
    const remoteSide = tile('remote-side', peerName(), { muted: false });
    const localSide = tile('local-side', T('video.self'), { muted: true, mirror: true });
    const grid = h('div', { class: 'video-grid' }, remoteCall.node, localCall.node);

    const screen = videoEl('screen-video');
    screen.muted = true;
    const screenLocal = videoEl('screen-local');
    screenLocal.muted = true;
    const shareLabel = h('div', { class: 'video-badge hidden' }, h('span', { class: 'rec-dot' }), h('span', { text: '' }));
    const screenPlaceholder = h(
      'div',
      { class: 'video-pane-placeholder' },
      h('div', { class: 'big', text: T('video.no_signal') }),
      h('div', { class: 'small', text: V.state === 'active' ? T('video.watch_need_screen') : T('video.no_signal_desc') }),
      h('div', { class: 'smpte' }, Array.from({ length: 7 }, (_, i) => h('i', { style: { opacity: 0.2 + i * 0.1 } }))),
      h('button', { class: 'btn small', text: T('video.screen'), on: { click: pickSource } })
    );
    const mainPane = h('div', { class: 'video-main' }, screen, screenLocal, shareLabel, screenPlaceholder);

    const music = buildMusicPane();
    mainPane.appendChild(music.pane);

    const side = h('div', { class: 'video-side' }, remoteSide.node, localSide.node);
    const stage = h('div', { class: 'video-stage mode-call' }, grid, side, mainPane);
    const statsOverlay = h('div', { class: 'stats-overlay hidden' });
    stage.appendChild(statsOverlay);
    const idle = h(
      'div',
      { class: 'video-idle' },
      h('div', { class: 'idle-bars' }, Array.from({ length: 7 }, (_, i) => h('i', { style: { opacity: 0.18 + i * 0.1 } }))),
      h('div', { class: 'big', text: 'NO SIGNAL' }),
      h('div', { class: 'small', text: T('video.no_signal_desc') }),
      h('button', { class: 'btn primary', text: T('video.call'), on: { click: startCall } }),
      h('div', { class: 'hint', text: T('video.start_hint') })
    );
    stage.appendChild(idle);
    const incomingName = h('div', { class: 'bold', text: '' });
    const incoming = h(
      'div',
      { class: 'incoming-call hidden' },
      h(
        'div',
        { class: 'box' },
        h('div', { class: 'titlebar' }, h('span', { class: 'title', text: T('video.ringing', { name: '' }) })),
        h(
          'div',
          { class: 'body' },
          h('div', { class: 'hint', text: T('video.incoming_hint') }),
          h(
            'div',
            { class: 'row', style: { marginTop: '12px', justifyContent: 'center' } },
            h('button', { class: 'btn primary', text: T('video.accept'), on: { click: acceptCall } }),
            h('button', { class: 'btn', text: T('video.decline'), on: { click: declineCall } })
          )
        )
      )
    );
    stage.appendChild(incoming);

    return {
      stage,
      remoteCall: remoteCall.video,
      localCall: localCall.video,
      remoteSide: remoteSide.video,
      localSide: localSide.video,
      remoteAudio: h('audio', { autoplay: '', style: { display: 'none' } }),
      remoteSysAudio: h('audio', { autoplay: '', style: { display: 'none' } }),
      screen,
      screenLocal,
      screenPlaceholder,
      shareLabel,
      mainPane,
      side,
      statsOverlay,
      incoming,
      incomingName,
      musicPane: music.pane,
      musicTitle: music.title,
      musicSub: music.sub,
      viz: music.viz,
      seek: music.seek,
      musicTime: music.time,
      musicPlay: music.playBtn,
      musicHint: music.hint,
      idle,
      tiles: { remoteCall, localCall, remoteSide, localSide },
    };
  }

  function mount({ body }) {
    const head = h('div', { class: 'video-head' });
    const els = buildStage2();
    const callBtn = h('button', { class: 'btn primary', text: T('video.call'), on: { click: onCallButton } });
    const muteBtn = h('button', {
      class: 'btn',
      text: T('video.mute'),
      on: {
        click: () => {
          V.muted = !V.muted;
          if (V.localStream) for (const t of V.localStream.getAudioTracks()) t.enabled = !V.muted;
          renderControlLabels();
        },
      },
    });
    const cameraBtn = h('button', {
      class: 'btn',
      text: T('video.camera'),
      on: {
        click: () => {
          V.cameraOn = !V.cameraOn;
          if (V.localStream) for (const t of V.localStream.getVideoTracks()) t.enabled = V.cameraOn;
          renderTiles();
          renderControlLabels();
        },
      },
    });
    const screenBtn = h('button', { class: 'btn', text: T('video.screen'), on: { click: () => (V.sharing ? stopScreenShare() : (V.sourceId ? startScreenShare() : pickSource())) } });
    const musicBtn = h('button', { class: 'btn', text: T('video.listen'), on: { click: () => (V.music.name ? setMode('music') : openAudio()) } });
    const flipBtn = h('button', {
      class: 'btn',
      text: T('video.swap'),
      on: {
        click: async () => {
          const cfg = CA.snap.settings.video;
          const next = cfg.stripSide === 'right' ? 'left' : 'right';
          await window.ca.settings.setVideo({ stripSide: next });
          await CA_UI.refreshSnapshot();
          renderStage();
        },
      },
    });
    const fullBtn = h('button', {
      class: 'btn icon',
      title: T('video.fullscreen'),
      on: {
        click: () => {
          if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
          else document.exitFullscreen().catch(() => {});
        },
      },
    }, UI.icon('monitor', 12));
    const controls = h(
      'div',
      { class: 'video-controls' },
      h('div', { class: 'group' }, callBtn, muteBtn, cameraBtn, screenBtn, musicBtn, flipBtn),
      h('span', { class: 'grow' }),
      h('span', { class: 'mono tiny', text: 'E2E · AES-GCM · DTLS' }),
      fullBtn
    );
    const app = h('div', { class: 'video-app' }, head, els.stage, controls, els.remoteAudio, els.remoteSysAudio);
    els.head = head;
    els.callBtn = callBtn;
    els.muteBtn = muteBtn;
    els.cameraBtn = cameraBtn;
    els.screenBtn = screenBtn;
    els.musicBtn = musicBtn;
    els.flipBtn = flipBtn;
    body.appendChild(app);
    refs = { head, els };
    V.els = els;
    V.quality = CA.snap.settings.video.quality || 'auto';
    if (V.state === 'active' && V.localStream) replaceTracks();
    if (V.localStream) {
      for (const el of [V.els.localCall, V.els.localSide]) {
        el.srcObject = V.localStream;
        el.muted = true;
        el.play().catch(() => {});
      }
    }
    if (V.remoteCamStream) {
      for (const el of [V.els.remoteCall, V.els.remoteSide]) {
        el.srcObject = V.remoteCamStream;
        el.play().catch(() => {});
      }
    }
    if (V.remoteScreenStream && V.els.screen) {
      V.els.screen.srcObject = V.remoteScreenStream;
      V.els.screen.play().catch(() => {});
    }
    if (V.music.audio) {
      V.els.seek.max = String(V.music.duration || 0);
      V.els.seek.value = String(V.music.audio.currentTime || 0);
    }
    renderAll();
    renderMusicControls();
    if (V.state === 'active') startTimers();

    // Resize the 1:4 strip by dragging the divider.
    const handle = h('div', { class: 'side-handle' });
    els.side.appendChild(handle);
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const stageRect = els.stage.getBoundingClientRect();
      const startPct = els.side.getBoundingClientRect().width / stageRect.width;
      const move = (ev) => {
        const pct = UI.clamp(startPct + (ev.clientX - startX) / stageRect.width, 0.15, 0.35);
        els.side.style.flexBasis = Math.round(pct * 100) + '%';
      };
      const up = async () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        const pct = els.side.getBoundingClientRect().width / els.stage.getBoundingClientRect().width;
        await window.ca.settings.setVideo({ splitRatio: pct });
        await CA_UI.refreshSnapshot();
        renderAll();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    els.side.style.flexBasis = Math.round((CA.snap.settings.video.splitRatio || 0.2) * 100) + '%';
    els.stage.classList.toggle('rev', CA.snap.settings.video.stripSide === 'right');

    // Local screen mirror (sharer sees what is being shared).
    if (V.screenStream) {
      els.screenLocal.srcObject = new MediaStream([V.screenStream.getVideoTracks()[0]]);
      els.screenLocal.play().catch(() => {});
    }
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                              */
  /* ------------------------------------------------------------------ */

  function event(evt) {
    if (!refs) return;
    switch (evt.type) {
      case 'signal':
        handleSignal(evt.payload);
        break;
      case 'signal-replay':
        if (V.state === 'idle') handleSignal(evt.payload);
        break;
      case 'media-sync':
        if (evt.payload && evt.payload.data) handleCtl(evt.payload.data, false);
        break;
      case 'presence':
        renderTiles();
        break;
      case 'link':
        updateFooter();
        break;
      case 'video-mode':
        break;
      case 'snapshot':
        V.quality = CA.snap.settings.video.quality || 'auto';
        renderAll();
        break;
      default:
        break;
    }
  }

  function destroy() {
    if (V.state !== 'idle') hangup(true);
    stopViz();
    if (V.music.audio) {
      V.music.audio.pause();
      V.music.audio.src = '';
    }
    if (V.statsTimer) clearInterval(V.statsTimer);
    if (V.durationTimer) clearInterval(V.durationTimer);
    V.statsTimer = null;
    V.durationTimer = null;
    refs = null;
    V.els = null;
  }

  window.CA_VIDEO_STATE = V;

  window.CA_APPS.video = {
    titleKey: 'video.title',
    layout: { x: 120, y: 34, w: 720, h: 566, minW: 520, minH: 430 },
    mount,
    event,
    destroy,
  };
})();
