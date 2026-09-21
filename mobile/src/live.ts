// Voice to voice, the same way the desktop does it.
//
// A raw WebSocket to the Gemini Live API: microphone audio goes up as 16 kHz
// PCM, the model's own voice comes back as 24 kHz PCM. There is no
// transcription step and no phone TTS in the path, which is the whole point -
// recording, sending to Whisper, asking a text model and reading the answer
// back through Android's synthesiser was four hops and sounded like four hops.
//
// Trimmed against the desktop client: no skills, no memory injection, and one
// tool only - looking at the screen when asked. A phone is for talking to.

import { AudioRecorder } from './audio-recorder';
import { AudioPlayer } from './audio-player';
import { MobileSettings } from './types';
import { captureScreen } from './overlay';

export type LiveState =
  | 'disconnected'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error';

export type LiveVoice = 'Fenrir' | 'Puck' | 'Aoede' | 'Charon' | 'Kore';

export const VOICES: Array<{ id: LiveVoice; description: string }> = [
  { id: 'Fenrir', description: 'Deep, crisp, confident' },
  { id: 'Charon', description: 'Authoritative, calm, resonant' },
  { id: 'Aoede', description: 'Sophisticated, calm, clear' },
  { id: 'Kore', description: 'Warm, natural, conversational' },
  { id: 'Puck', description: 'Energetic, quick, bright' }
];

const WS_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

// Same chain and same ordering rule as the desktop: first entry is the fast one,
// and only models advertising bidiGenerateContent work at all.
const LIVE_MODELS = [
  'models/gemini-3.1-flash-live-preview',
  'models/gemini-2.5-flash-native-audio-preview-09-2025',
  'models/gemini-2.5-flash-native-audio-latest'
];

// After a barge-in the server has already sent the next second of audio. Drop it
// until the server's own `interrupted` arrives, capped below the time a fresh
// reply takes or the cap swallows the new answer.
const BARGE_IN_MUTE_MS = 600;

const SYSTEM_PROMPT = `You are B.E.N., a calm, capable assistant, speaking to the user on their phone.

- Address the user as "Sir". Dry, brief, never chirpy.
- Lead with the answer. One or two sentences unless more is asked for.
- This is speech: no markdown, no lists, no reading out URLs or code.
- If you do not know something, say so rather than guessing.
- You are the same assistant they use on their desktop, so an earlier part of
  the conversation may have happened there.
- You can see their screen, but only by looking, and you look only when asked or
  when the question cannot be answered otherwise. Never to check on them.`;

export interface LiveCallbacks {
  onStateChange?: (state: LiveState) => void;
  onTranscript?: (sender: 'user' | 'ben', text: string, isFinal: boolean) => void;
  onError?: (message: string) => void;
  onKeyRotate?: (index: number) => void;
}

export class LiveClient {
  private ws: WebSocket | null = null;
  private recorder: AudioRecorder;
  private player: AudioPlayer;
  private callbacks: LiveCallbacks;
  private settings: MobileSettings;

  private state: LiveState = 'disconnected';
  private connected = false;
  private userClosed = false;
  private turnOpen = false;
  private modelIndex = 0;
  private keyIndex = 0;
  private suppressUntil = 0;
  private turnEpoch = 0;
  private messageChain: Promise<void> = Promise.resolve();
  private userText = '';
  private benText = '';

  constructor(settings: MobileSettings, recorder: AudioRecorder, player: AudioPlayer, callbacks: LiveCallbacks) {
    this.settings = settings;
    this.recorder = recorder;
    this.player = player;
    this.callbacks = callbacks;

    this.player.setSpeakingCallback((speaking) => {
      this.recorder.setIsModelSpeaking(speaking);
      if (!this.connected) return;
      if (speaking) this.setState('speaking');
      else if (this.state === 'speaking') this.setState('listening');
    });

    this.recorder.setVoiceCallbacks({
      onSpeechStart: (preroll) => this.handleSpeechStart(preroll),
      onFrame: (chunk) => {
        if (this.turnOpen) this.send({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: chunk } } });
      },
      onSpeechEnd: () => this.closeTurn()
    });
  }

  getState(): LiveState {
    return this.state;
  }

  private setState(state: LiveState) {
    if (this.state === state) return;
    this.state = state;
    this.callbacks.onStateChange?.(state);
  }

  private send(payload: unknown): boolean {
    if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  private keyPool(): string[] {
    return this.settings.geminiApiKeys.length
      ? this.settings.geminiApiKeys
      : [this.settings.geminiApiKey].filter(Boolean);
  }

  // --- turns -----------------------------------------------------------------

  private handleSpeechStart(preroll: string[]) {
    // Barge-in: stop talking the instant the user does. The suppression window
    // is set before the flush, or the next in-flight chunk restarts playback.
    if (this.player.getIsPlaying()) {
      this.suppressUntil = Date.now() + BARGE_IN_MUTE_MS;
      this.player.interrupt();
      this.turnEpoch = this.player.getEpoch();
      this.flushBen(' [interrupted]');
    }
    if (!this.connected) return;
    this.setState('listening');
    this.openTurn(preroll);
  }

  private openTurn(preroll: string[] = []) {
    if (this.turnOpen) return;
    if (!this.send({ realtimeInput: { activityStart: {} } })) return;
    this.turnOpen = true;
    for (const chunk of preroll) {
      this.send({ realtimeInput: { audio: { mimeType: 'audio/pcm;rate=16000', data: chunk } } });
    }
  }

  private closeTurn() {
    if (!this.turnOpen) return;
    this.turnOpen = false;
    this.send({ realtimeInput: { activityEnd: {} } });
    if (this.connected && !this.player.getIsPlaying()) this.setState('thinking');
  }

  // --- connection ------------------------------------------------------------

  async connect(): Promise<void> {
    const pool = this.keyPool();
    if (!pool.length) throw new Error('No Gemini API key set. Open Settings and add one.');

    this.userClosed = false;
    this.modelIndex = 0;
    this.keyIndex = this.settings.activeKeyIndex % pool.length;
    this.setState('connecting');

    this.player.prime();
    this.turnEpoch = this.player.getEpoch();
    await this.recorder.start();
    await this.open();
  }

  private open(): Promise<void> {
    const pool = this.keyPool();
    const key = pool[this.keyIndex];
    const model = LIVE_MODELS[this.modelIndex];

    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(`${WS_ENDPOINT}?key=${encodeURIComponent(key.trim())}`);
      this.ws = ws;
      // ArrayBuffer so frames decode synchronously; a Blob forces an async read
      // on every audio chunk and they arrive out of order.
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => ws.send(JSON.stringify(this.setupMessage(model)));

      ws.onmessage = (event) => {
        this.messageChain = this.messageChain
          .then(() => this.handleMessage(event.data))
          .then(() => {
            if (this.connected && !settled) {
              settled = true;
              resolve();
            }
          })
          .catch(() => {});
      };

      ws.onclose = (event) => {
        const hadSession = this.connected;
        this.connected = false;
        this.turnOpen = false;
        this.ws = null;

        if (this.userClosed) {
          this.setState('disconnected');
          return;
        }

        const reason = (event.reason || '').toLowerCase();
        const quota = /quota|exceeded|resource_exhausted|rate limit|billing/.test(reason);

        // Quota is granted per model, so every model is tried on this key before
        // the key itself is written off.
        if (!hadSession && this.modelIndex < LIVE_MODELS.length - 1) {
          this.modelIndex++;
          this.open().then(() => !settled && ((settled = true), resolve())).catch((e) => !settled && ((settled = true), reject(e)));
          return;
        }
        if (!hadSession && quota && this.keyIndex < pool.length - 1) {
          this.keyIndex++;
          this.modelIndex = 0;
          this.callbacks.onKeyRotate?.(this.keyIndex);
          this.open().then(() => !settled && ((settled = true), resolve())).catch((e) => !settled && ((settled = true), reject(e)));
          return;
        }

        const message = event.reason || `Connection closed (code ${event.code})`;
        this.setState('error');
        this.callbacks.onError?.(message);
        if (!settled) {
          settled = true;
          reject(new Error(message));
        }
      };

      ws.onerror = () => {
        /* onclose carries the detail. */
      };
    });
  }

  private setupMessage(model: string) {
    return {
      setup: {
        model,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            prebuiltVoiceConfig: undefined,
            voiceConfig: { prebuiltVoiceConfig: { voiceName: this.settings.voice || 'Fenrir' } }
          },
          thinkingConfig: { thinkingBudget: 0 }
        },
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        tools: [
          { googleSearch: {} },
          {
            functionDeclarations: [
              {
                name: 'inspect_screen',
                description:
                  "Look at what is on the user's screen right now. Call this ONLY when they ask " +
                  'you to look, or when their question cannot be answered without seeing it. ' +
                  'Never out of curiosity and never twice for the same question - it captures ' +
                  'whatever they happen to have open. Describe only what is actually visible.',
                parameters: { type: 'OBJECT', properties: {} }
              }
            ]
          }
        ],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        contextWindowCompression: { slidingWindow: {} },
        // This client decides when a turn ends. Server endpointing added about
        // half a second and its threshold could not be tuned.
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } }
      }
    };
  }

  private async handleMessage(data: any) {
    let raw = '';
    if (typeof data === 'string') raw = data;
    else if (data instanceof ArrayBuffer) raw = new TextDecoder().decode(data);
    else if (data instanceof Blob) raw = await data.text();
    if (!raw) return;

    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.setupComplete) {
      this.connected = true;
      this.turnEpoch = this.player.getEpoch();
      this.setState('listening');
      return;
    }

    if (msg.toolCall) {
      await this.handleToolCalls(msg.toolCall);
      return;
    }

    if (!msg.serverContent) return;
    const { modelTurn, interrupted, turnComplete, inputTranscription, outputTranscription } = msg.serverContent;

    if (interrupted) {
      this.player.interrupt();
      this.turnEpoch = this.player.getEpoch();
      this.suppressUntil = 0;
      this.flushBen();
      this.setState('listening');
      return;
    }

    if (inputTranscription?.text) {
      this.userText += inputTranscription.text;
      this.callbacks.onTranscript?.('user', this.userText, false);
    }

    if (outputTranscription?.text && Date.now() >= this.suppressUntil) {
      this.flushUser();
      this.benText += outputTranscription.text;
      this.callbacks.onTranscript?.('ben', this.benText, false);
    }

    for (const part of modelTurn?.parts || []) {
      if (part.inlineData?.data) {
        if (Date.now() < this.suppressUntil) continue;
        this.player.enqueueChunk(part.inlineData.data, this.turnEpoch);
      }
      if (part.text && !part.thought && Date.now() >= this.suppressUntil) {
        this.flushUser();
        this.benText += part.text;
        this.callbacks.onTranscript?.('ben', this.benText, false);
      }
    }

    if (turnComplete) {
      this.turnEpoch = this.player.getEpoch();
      this.flushUser();
      this.flushBen();
      if (this.connected && !this.player.getIsPlaying() && this.state === 'thinking') {
        this.setState('listening');
      }
    }
  }

  private async handleToolCalls(payload: { functionCalls: Array<{ id: string; name: string }> }) {
    const responses: any[] = [];

    for (const call of payload.functionCalls || []) {
      if (call.name !== 'inspect_screen') {
        responses.push({ id: call.id, response: { error: `Unknown tool ${call.name}` } });
        continue;
      }

      const shot = await captureScreen();
      if (!shot.success || !shot.imageBase64) {
        responses.push({
          id: call.id,
          response: {
            error:
              shot.error ||
              'Could not capture the screen. Tell the user you cannot see it rather than guessing.'
          }
        });
        continue;
      }

      // The image travels as a realtime video frame, not inside the tool
      // result - the result only says that it went, so the model is never told
      // it can see something that was never sent.
      const sent = this.send({
        realtimeInput: { video: { mimeType: 'image/jpeg', data: shot.imageBase64 } }
      });
      console.log(
        `[Live] screen frame ${sent ? 'sent' : 'NOT sent'} (${Math.round(shot.imageBase64.length / 1365)} KB)`
      );

      responses.push({
        id: call.id,
        response: sent
          ? {
              status: 'screen_attached',
              instruction:
                'A screenshot of the screen is attached. Describe what is actually visible in ' +
                'one or two sentences, and say so if you cannot make something out.'
            }
          : { error: 'The screenshot could not be sent. Tell the user you cannot see it.' }
      });
    }

    this.send({ toolResponse: { functionResponses: responses } });
  }

  private flushUser() {
    const text = this.userText.trim();
    this.userText = '';
    if (text) this.callbacks.onTranscript?.('user', text, true);
  }

  private flushBen(suffix = '') {
    const text = (this.benText + suffix).trim();
    this.benText = '';
    if (text) this.callbacks.onTranscript?.('ben', text, true);
  }

  disconnect() {
    this.userClosed = true;
    this.connected = false;
    this.turnOpen = false;
    try {
      this.ws?.close(1000, 'client disconnect');
    } catch {}
    this.ws = null;
    this.recorder.stop();
    this.player.interrupt(true);
    this.userText = '';
    this.benText = '';
    this.setState('disconnected');
  }
}
