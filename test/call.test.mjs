import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DoorbellCall, retryWhile, isQuickReplyBusy } from '../ha-doorbell-talk-card.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeTrack {
  constructor(kind = 'audio') { this.kind = kind; this.stopped = false; }
  stop() { this.stopped = true; }
}

class FakeStream {
  constructor(tracks = []) { this.tracks = tracks; }
  getTracks() { return [...this.tracks]; }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
  addTrack(track) { this.tracks.push(track); }
  removeTrack(track) { this.tracks = this.tracks.filter((t) => t !== track); }
}

function makeEnv({ secure = true, micDelay = null } = {}) {
  const env = { peers: [], micTracks: [], calls: [], silences: [] };

  class FakePeer {
    constructor(config) {
      this.config = config;
      this.transceivers = [];
      this.connectionState = 'new';
      this.closed = false;
      env.peers.push(this);
    }
    createDataChannel() {}
    addTransceiver(kindOrTrack, init) {
      const sender = { track: typeof kindOrTrack === 'string' ? null : kindOrTrack, replaced: [], async replaceTrack(track) { this.track = track; this.replaced.push(track); } };
      this.transceivers.push({ kind: typeof kindOrTrack === 'string' ? kindOrTrack : kindOrTrack.kind, direction: init.direction, sender });
      return { sender };
    }
    async createOffer() { return { type: 'offer', sdp: `offer-${env.peers.indexOf(this)}` }; }
    async setLocalDescription(description) {
      this.localDescription = description;
      setTimeout(() => this.onicecandidate && this.onicecandidate({ candidate: { toJSON: () => ({ candidate: 'candidate:1' }) } }), 0);
    }
    async setRemoteDescription() {
      this.connectionState = 'connected';
      if (this.onconnectionstatechange) this.onconnectionstatechange();
    }
    async addIceCandidate() {}
    close() { this.closed = true; }
  }

  class FakeAudioContext {
    constructor() { this.state = 'running'; }
    createMediaStreamDestination() { const track = new FakeTrack('audio'); env.silences.push(track); return { stream: new FakeStream([track]) }; }
    createGain() { return { gain: { value: 1 }, connect() {} }; }
    createOscillator() { return { connect() {}, start() {} }; }
    resume() {}
    close() {}
  }

  env.connection = {
    messages: [],
    candidates: [],
    async sendMessagePromise(message) {
      this.messages.push(message);
      if (message.type === 'camera/webrtc/get_client_config') return { configuration: { iceServers: [] } };
      if (message.type === 'camera/webrtc/candidate') this.candidates.push(message);
      return {};
    },
    async subscribeMessage(callback, message) {
      this.messages.push(message);
      setTimeout(async () => { await callback({ type: 'session', session_id: 's1' }); await callback({ type: 'answer', answer: 'answer' }); }, 5);
      return () => { this.unsubscribed = (this.unsubscribed || 0) + 1; };
    },
  };

  env.deps = {
    RTCPeerConnection: FakePeer,
    MediaStream: FakeStream,
    AudioContext: FakeAudioContext,
    secure,
    settleMs: 1,
    retryWaitMs: 1,
    getUserMedia: async () => {
      if (micDelay) await micDelay;
      const track = new FakeTrack('audio');
      env.micTracks.push(track);
      return new FakeStream([track]);
    },
  };
  return env;
}

test('start opens a listen-only offer for the camera entity', async () => {
  const env = makeEnv();
  const call = new DoorbellCall(env.connection, 'camera.front', () => {}, env.deps);
  await call.start();
  assert.equal(call.state, 'live');
  assert.equal(call.voiceReturn, false);
  const offer = env.connection.messages.find((m) => m.type === 'camera/webrtc/offer');
  assert.equal(offer.entity_id, 'camera.front');
  assert.equal(offer.offer, 'offer-0');
  assert.deepEqual(env.peers[0].transceivers.map((t) => [t.kind, t.direction]), [['video', 'recvonly'], ['audio', 'recvonly']]);
});

test('ice candidates found before the session id are sent once it arrives', async () => {
  const env = makeEnv();
  const call = new DoorbellCall(env.connection, 'camera.front', () => {}, env.deps);
  await call.start();
  await tick();
  assert.equal(env.connection.candidates.length, 1);
  assert.equal(env.connection.candidates[0].session_id, 's1');
});

test('first press on talk reconnects with a sendrecv audio line and swaps the microphone in', async () => {
  const env = makeEnv();
  const call = new DoorbellCall(env.connection, 'camera.front', () => {}, env.deps);
  await call.start();
  await call.talk(true);
  assert.equal(env.peers.length, 2);
  assert.equal(env.peers[0].closed, true);
  assert.deepEqual(env.peers[1].transceivers.map((t) => [t.kind, t.direction]), [['video', 'recvonly'], ['audio', 'sendrecv']]);
  assert.equal(env.peers[1].transceivers[1].sender.track, env.micTracks[0]);
  assert.equal(call.talking, true);
  assert.equal(call.voiceReturn, true);
});

test('releasing talk puts the silent track back and stops the microphone', async () => {
  const env = makeEnv();
  const call = new DoorbellCall(env.connection, 'camera.front', () => {}, env.deps);
  await call.start();
  await call.talk(true);
  await call.talk(false);
  assert.equal(call.talking, false);
  assert.equal(env.micTracks[0].stopped, true);
  assert.equal(env.peers[1].transceivers[1].sender.track, env.silences[0]);
});

test('later presses reuse the open return channel without reconnecting', async () => {
  const env = makeEnv();
  const call = new DoorbellCall(env.connection, 'camera.front', () => {}, env.deps);
  await call.start();
  await call.talk(true);
  await call.talk(false);
  await call.talk(true);
  assert.equal(env.peers.length, 2);
  assert.equal(env.peers[1].transceivers[1].sender.track, env.micTracks[1]);
});

test('releasing before the return channel is ready never sends the microphone', async () => {
  let release;
  const env = makeEnv({ micDelay: new Promise((resolve) => { release = resolve; }) });
  const call = new DoorbellCall(env.connection, 'camera.front', () => {}, env.deps);
  await call.start();
  const pressed = call.talk(true);
  await call.talk(false);
  release();
  await pressed;
  assert.equal(call.talking, false);
  assert.equal(env.micTracks[0].stopped, true);
  assert.ok(!env.peers[1] || env.peers[1].transceivers[1].sender.replaced.length === 0);
});

test('talk refuses without a secure context', async () => {
  const env = makeEnv({ secure: false });
  const call = new DoorbellCall(env.connection, 'camera.front', () => {}, env.deps);
  await call.start();
  await assert.rejects(call.talk(true), /secure context/);
  assert.equal(call.state, 'live');
});

test('a quick reply while talking leaves talk mode, retries while busy, then resumes listen-only', async () => {
  const env = makeEnv();
  const call = new DoorbellCall(env.connection, 'camera.front', () => {}, env.deps);
  await call.start();
  await call.talk(true);
  let attempts = 0;
  await call.whileListenOnly(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error('QuickReplyPlay failed with -17');
  });
  assert.equal(attempts, 3);
  assert.equal(call.voiceReturn, false);
  assert.equal(call.state, 'live');
  assert.equal(env.peers[1].closed, true);
  assert.deepEqual(env.peers[2].transceivers.map((t) => t.direction), ['recvonly', 'recvonly']);
});

test('a quick reply without an open return channel runs straight away', async () => {
  const env = makeEnv();
  const call = new DoorbellCall(env.connection, 'camera.front', () => {}, env.deps);
  await call.start();
  let ran = 0;
  await call.whileListenOnly(async () => { ran += 1; });
  assert.equal(ran, 1);
  assert.equal(env.peers.length, 1);
});

test('retryWhile stops at once on an error that is not busy', async () => {
  let attempts = 0;
  await assert.rejects(retryWhile(isQuickReplyBusy, async () => { attempts += 1; throw new Error('boom'); }, { wait: 1 }), /boom/);
  assert.equal(attempts, 1);
});

test('retryWhile gives up after the allowed attempts', async () => {
  let attempts = 0;
  await assert.rejects(retryWhile(isQuickReplyBusy, async () => { attempts += 1; throw new Error('-17'); }, { tries: 3, wait: 1 }), /-17/);
  assert.equal(attempts, 3);
});

test('isQuickReplyBusy recognises the Reolink busy error', () => {
  assert.equal(isQuickReplyBusy(new Error('Failed to call QuickReplyPlay, error -17')), true);
  assert.equal(isQuickReplyBusy(new Error('network down')), false);
});
