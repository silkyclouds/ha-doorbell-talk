/**
 * Live view and two-way audio for a doorbell camera, as a Home Assistant dashboard card.
 *
 * The card talks WebRTC to Home Assistant's own go2rtc through the websocket API
 * (camera/webrtc/get_client_config, camera/webrtc/offer, camera/webrtc/candidate).
 * Nothing runs outside the browser and nothing is added to the Home Assistant configuration.
 *
 *   type: custom:doorbell-talk-card
 *   entity: camera.front_fluent
 *   name: Front door                                        (optional)
 *   quick_replies: select.front_play_quick_reply_message    (optional, Reolink)
 */

const CONNECT_TIMEOUT_MS = 15000;
const QUICK_REPLY_TRIES = 4;
const QUICK_REPLY_WAIT_MS = 1500;
const RETURN_CHANNEL_SETTLE_MS = 1500;
const QUICK_REPLY_BUSY = /QuickReplyPlay|-17/;
const MIC_CONSTRAINTS = { audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `action`, and runs it again after `wait` ms while `shouldRetry(error)` holds, up to `tries` attempts. */
export async function retryWhile(shouldRetry, action, { tries = QUICK_REPLY_TRIES, wait = QUICK_REPLY_WAIT_MS } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= tries || !shouldRetry(error)) throw error;
      await sleep(wait);
    }
  }
}

/** True when the error is the doorbell refusing a quick reply because its return channel is open. */
export const isQuickReplyBusy = (error) => QUICK_REPLY_BUSY.test(String((error && error.message) || error));

const browserDeps = () => ({
  RTCPeerConnection: globalThis.RTCPeerConnection,
  MediaStream: globalThis.MediaStream,
  AudioContext: globalThis.AudioContext || globalThis.webkitAudioContext,
  getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  secure: !!(globalThis.isSecureContext && globalThis.navigator && navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
});

/**
 * One WebRTC session with a camera entity. The call starts listen-only (video and door sound), because opening the
 * return channel puts a Reolink doorbell in talk mode and its quick replies then fail. The first press on talk
 * reconnects with a silent sendrecv audio track; replaceTrack then swaps the microphone in and out without delay.
 */
export class DoorbellCall {
  constructor(connection, entityId, onChange = () => {}, deps = browserDeps()) {
    this.connection = connection;
    this.entityId = entityId;
    this.onChange = onChange;
    this.deps = deps;
    this.state = 'idle'; // idle | connecting | live | error | closed
    this.error = null;
    this.talking = false;
    this.voiceReturn = false;
    this.switching = false;
    this.stream = null;
    this._pc = null;
    this._sender = null;
    this._audioCtx = null;
    this._silence = null;
    this._mic = null;
    this._wantTalk = false;
    this._unsubscribe = null;
  }

  get micAvailable() { return !!this.deps.secure; }

  async start() {
    this._set('connecting');
    try {
      await this._link(false);
      this._set('live');
    } catch (error) {
      this._fail(error);
      throw error;
    }
  }

  stop() {
    this._stopMic();
    this._closeLink();
    if (this._audioCtx) { try { this._audioCtx.close(); } catch { /* already closed */ } }
    this._audioCtx = null;
    this._silence = null;
    this._set('closed');
  }

  /** Hold-to-talk: true opens the microphone toward the door, false closes it. */
  async talk(on) {
    if (this.state !== 'live') throw new Error('The call is not connected');
    if (!on) {
      this._wantTalk = false;
      return this._stopTalking();
    }
    if (this.talking || this._wantTalk) return;
    if (!this.micAvailable) throw new Error('The microphone needs a secure context (https)');
    this._wantTalk = true;
    this._prepareAudio();
    try {
      this._mic = await this.deps.getUserMedia(MIC_CONSTRAINTS);
      if (!this.voiceReturn) await this._switchLink(true);
      if (!this._wantTalk) { this._stopMic(); return; }
      await this._sender.replaceTrack(this._mic.getAudioTracks()[0]);
      this.talking = true;
      this._emit();
    } catch (error) {
      this._wantTalk = false;
      this._stopMic();
      this._fail(error);
      throw error;
    }
  }

  /**
   * Runs `action` (a quick-reply service call) after leaving talk mode: the return channel is closed, the doorbell gets
   * a moment to settle, the action is retried while the doorbell answers "busy", then the listen-only call resumes.
   */
  async whileListenOnly(action) {
    if (!this.voiceReturn || this.state !== 'live') return action();
    this._wantTalk = false;
    this._stopMic();
    this.switching = true;
    this._closeLink();
    this._emit();
    await sleep(this.deps.settleMs ?? RETURN_CHANNEL_SETTLE_MS);
    try {
      return await retryWhile(isQuickReplyBusy, action, { wait: this.deps.retryWaitMs ?? QUICK_REPLY_WAIT_MS });
    } finally {
      await this._link(false).catch((error) => this._fail(error));
      this.switching = false;
      this._emit();
    }
  }

  _set(state, error = null) {
    if (this.state === 'closed' && state !== 'closed') return;
    this.state = state;
    this.error = error;
    this._emit();
  }

  _fail(error) {
    this._stopMic();
    this._closeLink();
    this._set('error', (error && error.message) || String(error));
  }

  _emit() {
    try { this.onChange(this); } catch { /* a listener must not break the call */ }
  }

  _prepareAudio() {
    if (!this._audioCtx) this._audioCtx = new this.deps.AudioContext();
    try { if (this._audioCtx.state === 'suspended') this._audioCtx.resume(); } catch { /* resumed later */ }
  }

  _silentTrack() {
    const ctx = this._audioCtx;
    const destination = ctx.createMediaStreamDestination();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const oscillator = ctx.createOscillator();
    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start();
    this._silence = destination.stream.getAudioTracks()[0];
    return this._silence;
  }

  async _stopTalking() {
    this._stopMic();
    if (this._sender && this._silence) await this._sender.replaceTrack(this._silence).catch(() => {});
    this._emit();
  }

  _stopMic() {
    if (this._mic) { try { this._mic.getTracks().forEach((track) => track.stop()); } catch { /* already stopped */ } }
    this._mic = null;
    this.talking = false;
  }

  async _switchLink(withVoice) {
    this.switching = true;
    this._closeLink();
    this._emit();
    try {
      await this._link(withVoice);
    } finally {
      this.switching = false;
      this._emit();
    }
  }

  _closeLink() {
    if (this._unsubscribe) { try { this._unsubscribe(); } catch { /* already gone */ } }
    this._unsubscribe = null;
    const old = this._pc;
    this._pc = null;
    this._sender = null;
    this.voiceReturn = false;
    if (old) { try { old.close(); } catch { /* already closed */ } }
    if (this.stream) this.stream.getTracks().forEach((track) => { this.stream.removeTrack(track); track.stop(); });
  }

  /** Opens one peer connection and resolves once it is connected. */
  _link(withVoice) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        if (error) { this._closeLink(); reject(error); }
        return true;
      };
      const timer = setTimeout(() => finish(new Error('Timed out waiting for the camera')), CONNECT_TIMEOUT_MS);
      const hooks = {
        connected: () => { if (finish()) { this.voiceReturn = withVoice; resolve(); } },
        failed: (error) => { if (!finish(error)) this._fail(error); },
        closed: () => { if (settled && !this.switching && this.state === 'live') this._set('closed'); },
      };
      this._open(withVoice, hooks).catch((error) => finish(error));
    });
  }

  async _open(withVoice, hooks) {
    const cfg = await this.connection.sendMessagePromise({ type: 'camera/webrtc/get_client_config', entity_id: this.entityId }).catch(() => null);
    const pc = new this.deps.RTCPeerConnection((cfg && cfg.configuration) || {});
    this._pc = pc;
    if (!this.stream) this.stream = new this.deps.MediaStream();
    if (cfg && cfg.dataChannel) pc.createDataChannel(cfg.dataChannel);
    pc.addTransceiver('video', { direction: 'recvonly' });
    if (withVoice) this._sender = pc.addTransceiver(this._silentTrack(), { direction: 'sendrecv' }).sender;
    else pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.ontrack = (event) => { if (pc === this._pc) { this.stream.addTrack(event.track); this._emit(); } };
    pc.onconnectionstatechange = () => {
      if (pc !== this._pc) return;
      const state = pc.connectionState;
      if (state === 'connected') hooks.connected();
      else if (state === 'failed') hooks.failed(new Error('Connection failed (is the camera reachable from this device?)'));
      else if (state === 'disconnected' || state === 'closed') hooks.closed();
    };
    await this._negotiate(pc);
  }

  async _negotiate(pc) {
    let session = null;
    const queued = [];
    const sendCandidate = (candidate) => this.connection.sendMessagePromise({
      type: 'camera/webrtc/candidate', entity_id: this.entityId, session_id: session, candidate: candidate.toJSON(),
    }).catch(() => {});
    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      if (session) sendCandidate(event.candidate); else queued.push(event.candidate);
    };
    await pc.setLocalDescription(await pc.createOffer());
    this._unsubscribe = await this.connection.subscribeMessage(async (event) => {
      try {
        if (event.type === 'session') { session = event.session_id; queued.splice(0).forEach(sendCandidate); }
        else if (event.type === 'answer') await pc.setRemoteDescription({ type: 'answer', sdp: event.answer });
        else if (event.type === 'candidate') await pc.addIceCandidate(event.candidate && event.candidate.candidate !== undefined ? event.candidate : { candidate: event.candidate, sdpMid: '0' });
        else if (event.type === 'error') this._fail(new Error(`${event.code || ''} ${event.message || ''}`.trim()));
      } catch (error) {
        this._fail(error);
      }
    }, { type: 'camera/webrtc/offer', entity_id: this.entityId, offer: pc.localDescription.sdp });
  }
}

const STYLE = `
  :host { display: block; }
  ha-card { overflow: hidden; }
  .head { padding: 12px 16px 0; font-size: 1.1em; color: var(--primary-text-color); }
  .view { position: relative; background: #000; aspect-ratio: 16 / 9; margin-top: 8px; }
  video { width: 100%; height: 100%; object-fit: contain; display: block; }
  .status { position: absolute; left: 0; right: 0; bottom: 0; padding: 6px 12px; font-size: 0.85em; color: #fff; background: rgba(0, 0, 0, 0.55); }
  .status[hidden] { display: none; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 16px; }
  button { font: inherit; border: 1px solid var(--divider-color); border-radius: 18px; padding: 8px 14px; cursor: pointer;
    color: var(--primary-text-color); background: var(--card-background-color); display: inline-flex; align-items: center; gap: 6px; }
  button[disabled] { opacity: 0.45; cursor: default; }
  button.primary { background: var(--primary-color); border-color: var(--primary-color); color: var(--text-primary-color, #fff); }
  button.talk { flex: 1 1 140px; justify-content: center; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
  button.talk.active { background: var(--error-color, #db4437); border-color: var(--error-color, #db4437); color: #fff; }
  .replies { padding-top: 0; }
`;

const BaseElement = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};

class DoorbellTalkCard extends BaseElement {
  static getStubConfig() { return { entity: 'camera.front_fluent' }; }

  setConfig(config) {
    if (!config || !config.entity) throw new Error('doorbell-talk-card needs an "entity" (a camera)');
    this._config = config;
    if (this.shadowRoot) this._render();
  }

  getCardSize() { return 5; }

  set hass(hass) {
    this._hass = hass;
    if (!this.shadowRoot || !this._video) return;
    this._renderName();
    this._renderReplies();
  }

  connectedCallback() {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    if (this._config) this._render();
  }

  disconnectedCallback() {
    if (this._call) { this._call.stop(); this._call = null; }
  }

  _render() {
    this.shadowRoot.innerHTML = `<style>${STYLE}</style>
      <ha-card>
        <div class="head"></div>
        <div class="view"><video autoplay playsinline muted></video><div class="status" hidden></div></div>
        <div class="row">
          <button class="live primary"><ha-icon icon="mdi:video"></ha-icon><span>Live</span></button>
          <button class="sound" disabled><ha-icon icon="mdi:volume-off"></ha-icon><span>Sound</span></button>
          <button class="talk" disabled><ha-icon icon="mdi:microphone"></ha-icon><span>Hold to talk</span></button>
        </div>
        <div class="row replies" hidden></div>
      </ha-card>`;
    this._video = this.shadowRoot.querySelector('video');
    this._wire();
    this._renderName();
    this._renderReplies();
    this._refresh();
  }

  _renderName() {
    const state = this._hass && this._hass.states[this._config.entity];
    const name = this._config.name || (state && state.attributes.friendly_name) || 'Doorbell';
    const head = this.shadowRoot.querySelector('.head');
    if (head.textContent !== name) head.textContent = name;
  }

  _wire() {
    const $ = (selector) => this.shadowRoot.querySelector(selector);
    $('.live').addEventListener('click', () => (this._call && this._call.state !== 'closed' && this._call.state !== 'error' ? this._stopCall() : this._startCall()));
    $('.sound').addEventListener('click', () => { this._video.muted = !this._video.muted; this._refresh(); });
    const talk = $('.talk');
    const down = (event) => { event.preventDefault(); this._talk(true); };
    const up = () => this._talk(false);
    talk.addEventListener('pointerdown', down);
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) talk.addEventListener(type, up);
    talk.addEventListener('contextmenu', (event) => event.preventDefault());
    talk.addEventListener('keydown', (event) => { if (event.code === 'Space' && !event.repeat) { event.preventDefault(); down(event); } });
    talk.addEventListener('keyup', (event) => { if (event.code === 'Space') up(); });
  }

  _startCall() {
    if (!this._hass) return;
    if (this._call) this._call.stop();
    this._video.muted = false;
    this._call = new DoorbellCall(this._hass.connection, this._config.entity, () => this._refresh());
    this._call.start().catch(() => {});
    this._refresh();
  }

  _stopCall() {
    if (this._call) this._call.stop();
    this._video.srcObject = null;
    this._call = null;
    this._refresh();
  }

  _talk(on) {
    if (!this._call) return;
    this._call.talk(on).catch((error) => this._flash(error.message));
  }

  _flash(message) {
    this._message = message;
    this._messageUntil = Date.now() + 4000;
    setTimeout(() => this._refresh(), 4100);
    this._refresh();
  }

  _refresh() {
    if (!this.shadowRoot || !this._video) return;
    const $ = (selector) => this.shadowRoot.querySelector(selector);
    const call = this._call;
    const live = !!call && call.state === 'live';
    if (call && call.stream && this._video.srcObject !== call.stream) this._attachStream(call.stream);
    $('.live span').textContent = call && (call.state === 'live' || call.state === 'connecting') ? 'Stop' : 'Live';
    const sound = $('.sound');
    sound.disabled = !live;
    sound.querySelector('ha-icon').setAttribute('icon', this._video.muted ? 'mdi:volume-off' : 'mdi:volume-high');
    const talk = $('.talk');
    talk.disabled = !live || (call && call.switching);
    talk.classList.toggle('active', !!call && call.talking);
    talk.querySelector('span').textContent = call && call.switching ? 'Connecting voice...' : call && call.talking ? 'Talking' : 'Hold to talk';
    const status = $('.status');
    const text = this._statusText(call);
    status.hidden = !text;
    status.textContent = text;
    this.shadowRoot.querySelectorAll('.replies button').forEach((b) => { b.disabled = !live || (call && call.switching); });
  }

  /** Shows the stream; if the browser refuses to play it with sound, plays it muted so the picture still appears. */
  _attachStream(stream) {
    const video = this._video;
    video.srcObject = stream;
    video.play().catch(() => {
      video.muted = true;
      video.play().catch(() => {});
      this._refresh();
    });
  }

  _statusText(call) {
    if (this._message && Date.now() < this._messageUntil) return this._message;
    if (!call) return '';
    if (call.state === 'connecting') return 'Connecting...';
    if (call.state === 'error') return call.error || 'Connection error';
    if (call.state === 'live' && !call.micAvailable) return 'Live. The microphone needs https.';
    return '';
  }

  _renderReplies() {
    const entityId = this._config && this._config.quick_replies;
    const holder = this.shadowRoot && this.shadowRoot.querySelector('.replies');
    if (!holder) return;
    const state = entityId && this._hass && this._hass.states[entityId];
    const options = ((state && state.attributes.options) || []).filter((option) => String(option).toLowerCase() !== 'off');
    holder.hidden = !options.length;
    const signature = options.join('|');
    if (holder.dataset.signature === signature) return;
    holder.dataset.signature = signature;
    holder.replaceChildren(...options.map((option) => {
      const button = document.createElement('button');
      button.textContent = option;
      button.disabled = true;
      button.addEventListener('click', () => this._reply(entityId, option));
      return button;
    }));
    this._refresh();
  }

  _reply(entityId, option) {
    const play = () => this._hass.callService('select', 'select_option', { entity_id: entityId, option });
    const run = this._call ? this._call.whileListenOnly(play) : play();
    run.catch((error) => this._flash(error.message || 'The doorbell refused the reply'));
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('doorbell-talk-card')) {
  customElements.define('doorbell-talk-card', DoorbellTalkCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'doorbell-talk-card',
    name: 'Doorbell talk card',
    description: 'Live view and two-way audio for a doorbell camera (WebRTC through go2rtc).',
  });
}
