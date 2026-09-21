export type JarvisState =
  | 'idle'
  | 'disconnected'
  | 'connecting'
  | 'activated'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'building'
  | 'tool_executing'
  | 'error';

export type VoiceName = 'Aoede' | 'Charon' | 'Fenrir' | 'Kore' | 'Puck';


export interface AppSettings {
  // The key currently in use. Always mirrors apiKeys[activeKeyIndex], so every
  // existing consumer keeps reading one field and knows nothing about the pool.
  apiKey: string;
  // Rotation pool. A free-tier key that hits its quota is skipped and the next
  // one takes over, which is the whole point of holding more than one.
  apiKeys: string[];
  activeKeyIndex: number;
  voice: VoiceName;
  inputDeviceId: string;
  systemInstruction: string;
  enableThinking: boolean;
  soundEffects: boolean;
  // Wake word. Groq hosts the Whisper transcription used to decide whether what
  // was said in the room was actually addressed to B.E.N.
  groqApiKey: string;
  wakeWordEnabled: boolean;
  // Phrases that wake B.E.N. when he is asleep.
  wakeWords: string[];
  // Phrases that cut him off while he is speaking. Anything else said over him
  // is ignored, so the room can be noisy without stopping him mid-sentence.
  interruptWords: string[];
  alwaysOnTop: boolean;
  // Which shipped directive this was last reconciled against.
  systemInstructionVersion?: number;
}

export interface ChatMessage {
  id: string;
  sender: 'user' | 'jarvis' | 'system';
  text: string;
  timestamp: string;
  isStreaming?: boolean;
}

export interface BenTask {
  id: string;
  title: string;
  completed: boolean;
  createdAt: string;
  project?: string;
}

export interface MemoryNote {
  id: string;
  content: string;
  category: 'preference' | 'project' | 'directive' | 'general';
  createdAt: string;
}

// Durable facts about the person B.E.N. works for: who they are, how they like
// to work, what they are building.
export interface UserProfile {
  name?: string;
  facts: string[];
  updatedAt?: string;
}

// What B.E.N. knows about a project, independent of what is on disk.
export interface ProjectMemory {
  id: string;
  name: string;
  summary: string;
  lastTouched: string;
}

// One line per past conversation, so continuity survives a restart without
// replaying every message.
export interface SessionSummary {
  id: string;
  text: string;
  at: string;
}

// One tool call and what came of it. The record exists so the assistant can be
// told later what it actually did, rather than what it said it did: the live
// model has no memory of a failed call by the next turn, and no memory at all
// of one from yesterday.
export interface ToolJournalEntry {
  id: string;
  at: number;
  tool: string;
  // Truncated JSON. Arguments are the difference between "it called the right
  // tool" and "it called the right tool with the wrong thing".
  args: string;
  // 'ok' is a result the model can use. 'refused' is a guard firing (a brief
  // wanted, a build already running) - working as designed, not a fault.
  // 'error' is a real failure, 'blocked' is the bridge being absent.
  verdict: 'ok' | 'error' | 'refused' | 'blocked';
  detail?: string;
  ms: number;
  // What was said just before the call, so a lesson can name the phrasing that
  // led to the wrong tool rather than only the tool.
  asked?: string;
}

// Something learned from the journal and replayed into the system prompt. Short
// and specific, or it is just more prompt to ignore.
export interface BenLesson {
  id: string;
  scope: 'tool' | 'general';
  tool?: string;
  lesson: string;
  evidence: string;
  confidence: number;
  at: string;
  source: 'hermes' | 'user';
}

// A change to B.E.N.'s own source that the reflector thinks is worth making.
// Never applied on its own: this is a thing to be read and agreed to.
export interface SelfProposal {
  id: string;
  title: string;
  brief: string;
  files: string[];
  evidence: string;
  status: 'pending' | 'applied' | 'rejected';
  at: string;
}

export interface MemoryStoreData {
  profile: UserProfile;
  projects: ProjectMemory[];
  tasks: BenTask[];
  history: ChatMessage[];
  notes: MemoryNote[];
  sessions: SessionSummary[];
  // Added after the fact; normalise() tolerates files written without them.
  lessons: BenLesson[];
  proposals: SelfProposal[];
}

export interface DevBuildSession {
  id: string;
  prompt: string;
  projectName: string;
  directory: string;
  status: 'running' | 'completed' | 'failed';
  mode?: 'build' | 'server' | 'task';
  logs: string[];
  startTime: string;
  endTime?: string;
  // The address a dev server printed, once it has printed one.
  url?: string;
  // The last thing the process asked before stopping to wait for an answer.
  awaitingInput?: string;
}

export interface SystemTelemetry {
  cpuModel?: string;
  cpuCores?: number;
  cpuLoad: number;
  memoryTotalGb?: string;
  memoryUsedGb?: string;
  memoryPercent: number;
  batteryPercent?: number | null;
  batteryIsCharging?: boolean | null;
  uptimeSeconds?: number;
  timezone?: string;
  // Present when the host failed to read the hardware counters.
  error?: string;
}

export interface ToolCallPayload {
  functionCalls: Array<{
    id: string;
    name: string;
    args: Record<string, any>;
  }>;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  source: string;
  file: string;
}

export interface WorkspaceInfo {
  directory: string;
  displayPath: string;
  exists: boolean;
  opencodeBin: string;
  opencodeAvailable: boolean;
  model: string;
  busy: boolean;
  activeProject: string | null;
}

// run-opencode resolves as soon as the agent has been spawned. The outcome of
// the build itself arrives later through onOpencodeComplete, so a build that
// takes minutes no longer blocks the live voice session.
export interface OpencodeStartResult {
  success: boolean;
  started?: boolean;
  alreadyRunning?: boolean;
  projectName?: string;
  directory?: string;
  error?: string;
}

// The LAN sync server the phone talks to.
export interface SyncStatus {
  running: boolean;
  port: number;
  pairingCode: string;
  addresses: string[];
  lastSyncAt: number | null;
  lastPeer: string | null;
  error?: string;
}

// A question B.E.N. promised to come back with an answer to.
export interface BackgroundTaskResult {
  id: string;
  question: string;
  success: boolean;
  answer?: string;
  error?: string;
  elapsedMs?: number;
}

// What a stop request actually achieved. `stopped` is read back from the
// process table, never inferred from the signal being sent: "everything has
// been stopped" was said for builds that carried on running.
export interface CancelResult {
  success: boolean;
  wasRunning: boolean;
  stopped: boolean;
  stillRunning: boolean;
  project: string | null;
  stoppedBuild?: boolean;
  stoppedProcess?: boolean;
  error?: string;
}

export interface OpencodeStatus {
  build: { project: string | null; pid?: number; alive: boolean } | null;
  process: { project: string | null; pid?: number; alive: boolean } | null;
  lastCancelledProject: string | null;
  lastCancelAgoMs: number | null;
}

export interface OpencodeCompletion {
  success: boolean;
  cancelled?: boolean;
  projectName: string;
  directory: string;
  exitCode?: number | null;
  output?: string;
  error?: string;
}

export interface ElectronAPI {
  minimizeWindow: () => Promise<void>;
  maximizeWindow: () => Promise<void>;
  closeWindow: () => Promise<void>;
  toggleAlwaysOnTop: () => Promise<boolean>;
  isAlwaysOnTop: () => Promise<boolean>;
  loadSettings: () => Promise<any>;
  saveSettings: (settings: any) => Promise<{ success: boolean; error?: string }>;
  openUrl: (url: string) => Promise<{ success: boolean; error?: string }>;
  openApp: (appName: string) => Promise<{ success: boolean; message?: string; error?: string }>;
  closeApp?: (appName: string) => Promise<{ success: boolean; message?: string; error?: string }>;
  getSystemInfo: () => Promise<SystemTelemetry>;
  groqTranscribe?: (args: { apiKey: string; wavBase64: string; prompt?: string }) => Promise<{ success: boolean; text?: string; error?: string; status?: number; fatal?: boolean; avgLogprob?: number | null; noSpeechProb?: number | null }>;
  isSystemAudioPlaying?: () => Promise<{ playing: boolean; sources: string[] }>;
  syncStatus?: () => Promise<SyncStatus>;
  syncStart?: () => Promise<SyncStatus>;
  syncStop?: () => Promise<SyncStatus>;
  syncNewCode?: () => Promise<SyncStatus>;
  onSyncLog?: (callback: (line: string) => void) => () => void;
  onSyncMessages?: (callback: (messages: ChatMessage[]) => void) => () => void;
  startBackgroundTask?: (args: { id: string; question: string; apiKey: string }) => Promise<{ success: boolean; started?: boolean; id?: string; error?: string }>;
  onBackgroundTaskComplete?: (callback: (result: BackgroundTaskResult) => void) => () => void;
  captureScreen: (options?: { target?: string }) => Promise<{ success: boolean; imageBase64?: string; mimeType?: string; error?: string; capturedName?: string; wasWholeScreen?: boolean; available?: string[] }>;
  listCaptureSources?: () => Promise<{ success: boolean; sources: Array<{ id: string; name: string; isScreen: boolean }> }>;
  runOpencode: (args: { prompt: string; projectName?: string }) => Promise<OpencodeStartResult>;
  runProjectCommand?: (args: { projectName: string; command?: string; force?: boolean }) => Promise<{ success: boolean; preview?: string; error?: string; directory?: string; commandExecuted?: string; cancelledRecently?: boolean; url?: string | null; stillRunning?: boolean; acceptsInput?: boolean }>;
  cancelOpencode?: () => Promise<CancelResult>;
  opencodeStatus?: () => Promise<OpencodeStatus>;
  onOpencodeLog?: (callback: (log: string) => void) => () => void;
  onOpencodeComplete?: (callback: (result: OpencodeCompletion) => void) => () => void;
  listDevelopmentProjects: () => Promise<string[]>;
  getWorkspaceInfo?: () => Promise<WorkspaceInfo>;
  listSkills?: () => Promise<{ directory: string; skills: SkillSummary[] }>;
  readSkill?: (args: { id: string }) => Promise<{ found: boolean; id?: string; content?: string }>;
  syncSkills?: (args?: { sources?: string[] }) => Promise<{ results: any[]; skills: SkillSummary[] }>;
  onSkillsLog?: (callback: (line: string) => void) => () => void;
  writeWorkspaceFile?: (args: { relativePath: string; content: string; append?: boolean }) => Promise<any>;
  readWorkspaceFile?: (args: { relativePath: string }) => Promise<any>;
  listWorkspaceFolder?: (args: { relativePath?: string }) => Promise<any>;
  createWorkspaceFolder?: (args: { relativePath: string }) => Promise<any>;
  openWorkspacePath?: (args: {
    relativePath: string;
    mode?: 'auto' | 'notes' | 'editor' | 'finder' | 'default';
    app?: string;
  }) => Promise<any>;
  getEditorInfo?: () => Promise<{ editor: string | null; editors: string[] }>;
  sendProcessInput?: (args: { text: string }) => Promise<{ success: boolean; error?: string }>;
  onProjectUrl?: (callback: (payload: { projectName: string; url: string }) => void) => () => void;
  onProjectAwaitingInput?: (
    callback: (payload: { projectName: string; prompt: string }) => void
  ) => () => void;
  readMemory: () => Promise<MemoryStoreData>;
  saveMemory: (memoryData: MemoryStoreData) => Promise<{ success: boolean; error?: string }>;
  // The tool journal lives in its own file. Memory is written whole by the
  // renderer and merged in the main process; a record that is appended to on
  // every tool call has no business sharing that path.
  platform?: string;
  readJournal?: () => Promise<{ entries: ToolJournalEntry[] }>;
  saveJournal?: (entries: ToolJournalEntry[]) => Promise<{ success: boolean; error?: string }>;
  // One reflection pass. Returns its answer rather than broadcasting it: nobody
  // is waiting to speak it, so there is no announcement to keep.
  runReflection?: (args: {
    prompt: string;
    apiKey: string;
  }) => Promise<{ success: boolean; text?: string; error?: string }>;
  syncNotchState?: (state: any) => void;
  onNotchStateUpdate?: (callback: (state: any) => void) => () => void;
  resizeNotch?: (dims: { width: number; height: number }) => Promise<void>;
  notchAction?: (action: string) => Promise<void>;
  onDeckEngagedChange?: (callback: (engaged: boolean) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
