import { contextBridge, ipcRenderer } from 'electron';

// What a stop request actually achieved, read back from the process table
// rather than inferred from the signal being sent.
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

// run-opencode resolves as soon as the agent has been spawned; the outcome of
// the build arrives later on the 'opencode-complete' channel.
export interface OpencodeStartResult {
  success: boolean;
  started?: boolean;
  alreadyRunning?: boolean;
  projectName?: string;
  directory?: string;
  error?: string;
}

export interface SyncStatus {
  running: boolean;
  port: number;
  pairingCode: string;
  addresses: string[];
  lastSyncAt: number | null;
  lastPeer: string | null;
  error?: string;
}

export interface BackgroundTaskResult {
  id: string;
  question: string;
  success: boolean;
  answer?: string;
  error?: string;
  elapsedMs?: number;
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
  getSystemInfo: () => Promise<any>;
  groqTranscribe?: (args: { apiKey: string; wavBase64: string; prompt?: string }) => Promise<{ success: boolean; text?: string; error?: string; status?: number; fatal?: boolean; avgLogprob?: number | null; noSpeechProb?: number | null }>;
  isSystemAudioPlaying?: () => Promise<{ playing: boolean; sources: string[] }>;
  syncStatus?: () => Promise<SyncStatus>;
  syncStart?: () => Promise<SyncStatus>;
  syncStop?: () => Promise<SyncStatus>;
  syncNewCode?: () => Promise<SyncStatus>;
  onSyncLog?: (callback: (line: string) => void) => () => void;
  onSyncMessages?: (callback: (messages: any[]) => void) => () => void;
  startBackgroundTask?: (args: { id: string; question: string; apiKey: string }) => Promise<{ success: boolean; started?: boolean; id?: string; error?: string }>;
  onBackgroundTaskComplete?: (callback: (result: BackgroundTaskResult) => void) => () => void;
  captureScreen: (options?: { target?: string }) => Promise<{ success: boolean; imageBase64?: string; mimeType?: string; error?: string; capturedName?: string; wasWholeScreen?: boolean; available?: string[] }>;
  listCaptureSources?: () => Promise<{ success: boolean; sources: Array<{ id: string; name: string; isScreen: boolean }> }>;
  runOpencode: (args: { prompt: string; projectName?: string }) => Promise<OpencodeStartResult>;
  runProjectCommand?: (args: { projectName: string; command?: string; force?: boolean }) => Promise<{ success: boolean; preview?: string; error?: string; directory?: string; commandExecuted?: string; url?: string | null; stillRunning?: boolean; acceptsInput?: boolean }>;
  cancelOpencode?: () => Promise<CancelResult>;
  // What is actually running, read from the process table rather than from
  // anything the model remembers saying.
  opencodeStatus: () => Promise<OpencodeStatus>;
  onOpencodeLog?: (callback: (log: string) => void) => () => void;
  onOpencodeComplete?: (callback: (result: OpencodeCompletion) => void) => () => void;
  listDevelopmentProjects: () => Promise<string[]>;
  getWorkspaceInfo: () => Promise<any>;
  listSkills: () => Promise<any>;
  readSkill: (args: { id: string }) => Promise<any>;
  syncSkills: (args?: { sources?: string[] }) => Promise<any>;
  onSkillsLog: (callback: (line: string) => void) => () => void;
  writeWorkspaceFile: (args: { relativePath: string; content: string; append?: boolean }) => Promise<any>;
  readWorkspaceFile: (args: { relativePath: string }) => Promise<any>;
  listWorkspaceFolder: (args: { relativePath?: string }) => Promise<any>;
  createWorkspaceFolder: (args: { relativePath: string }) => Promise<any>;
  openWorkspacePath: (args: {
    relativePath: string;
    mode?: 'auto' | 'notes' | 'editor' | 'finder' | 'default';
    // An application the user named, as they said it. Resolved against
    // what is installed rather than assumed to exist.
    app?: string;
  }) => Promise<any>;
  getEditorInfo: () => Promise<{ editor: string | null; editors: string[] }>;
  // Types a line into whatever is currently running, so a program that asks a
  // question can be answered from the console in the deck.
  sendProcessInput: (args: { text: string }) => Promise<{ success: boolean; error?: string }>;
  onProjectUrl: (callback: (payload: { projectName: string; url: string }) => void) => () => void;
  onProjectAwaitingInput: (callback: (payload: { projectName: string; prompt: string }) => void) => () => void;
  readMemory: () => Promise<{ tasks: any[]; history: any[]; notes: any[] }>;
  saveMemory: (memoryData: any) => Promise<{ success: boolean; error?: string }>;
  // The tool journal: its own file, because memory is written whole and merged
  // and this is appended to on every tool call.
  // Which machine this is. The renderer draws its own window controls where the
  // system does not provide them, and that is a per-platform fact.
  platform: NodeJS.Platform;
  readJournal: () => Promise<{ entries: any[] }>;
  saveJournal: (entries: any[]) => Promise<{ success: boolean; error?: string }>;
  // One reflection pass. Returns its answer instead of broadcasting it - there
  // is no announcement to keep, nobody is waiting to speak it.
  runReflection: (args: {
    prompt: string;
    apiKey: string;
  }) => Promise<{ success: boolean; text?: string; error?: string }>;
  syncNotchState?: (state: any) => void;
  onNotchStateUpdate?: (callback: (state: any) => void) => () => void;
  resizeNotch?: (dims: { width: number; height: number }) => Promise<void>;
  notchAction?: (action: string) => Promise<void>;
  onDeckEngagedChange?: (callback: (engaged: boolean) => void) => () => void;
}

const electronAPI: ElectronAPI = {
  minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window-maximize'),
  closeWindow: () => ipcRenderer.invoke('window-close'),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('toggle-always-on-top'),
  isAlwaysOnTop: () => ipcRenderer.invoke('is-always-on-top'),
  loadSettings: () => ipcRenderer.invoke('load-settings'),
  saveSettings: (settings: any) => ipcRenderer.invoke('save-settings', settings),
  openUrl: (url: string) => ipcRenderer.invoke('open-url', url),
  openApp: (appName: string) => ipcRenderer.invoke('open-app', appName),
  closeApp: (appName: string) => ipcRenderer.invoke('close-app', appName),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  groqTranscribe: (args) => ipcRenderer.invoke('groq-transcribe', args),
  isSystemAudioPlaying: () => ipcRenderer.invoke('is-system-audio-playing'),
  syncStatus: () => ipcRenderer.invoke('sync-status'),
  syncStart: () => ipcRenderer.invoke('sync-start'),
  syncStop: () => ipcRenderer.invoke('sync-stop'),
  syncNewCode: () => ipcRenderer.invoke('sync-new-code'),
  onSyncLog: (callback: (line: string) => void) => {
    const handler = (_event: any, line: string) => callback(line);
    ipcRenderer.on('sync-log', handler);
    return () => ipcRenderer.removeListener('sync-log', handler);
  },
  onSyncMessages: (callback: (messages: any[]) => void) => {
    const handler = (_event: any, messages: any[]) => callback(messages);
    ipcRenderer.on('sync-messages', handler);
    return () => ipcRenderer.removeListener('sync-messages', handler);
  },
  startBackgroundTask: (args) => ipcRenderer.invoke('start-background-task', args),
  onBackgroundTaskComplete: (callback: (result: BackgroundTaskResult) => void) => {
    const handler = (_event: any, result: BackgroundTaskResult) => callback(result);
    ipcRenderer.on('background-task-complete', handler);
    return () => ipcRenderer.removeListener('background-task-complete', handler);
  },
  captureScreen: (options) => ipcRenderer.invoke('capture-screen', options),
  listCaptureSources: () => ipcRenderer.invoke('list-capture-sources'),
  runOpencode: (args) => ipcRenderer.invoke('run-opencode', args),
  runProjectCommand: (args) => ipcRenderer.invoke('run-project-command', args),
  cancelOpencode: () => ipcRenderer.invoke('cancel-opencode'),
  opencodeStatus: () => ipcRenderer.invoke('opencode-status'),
  onOpencodeLog: (callback: (log: string) => void) => {
    const handler = (_event: any, log: string) => callback(log);
    ipcRenderer.on('opencode-log', handler);
    return () => ipcRenderer.removeListener('opencode-log', handler);
  },
  onOpencodeComplete: (callback: (result: OpencodeCompletion) => void) => {
    const handler = (_event: any, result: OpencodeCompletion) => callback(result);
    ipcRenderer.on('opencode-complete', handler);
    return () => ipcRenderer.removeListener('opencode-complete', handler);
  },
  listDevelopmentProjects: () => ipcRenderer.invoke('list-development-projects'),
  getWorkspaceInfo: () => ipcRenderer.invoke('get-workspace-info'),
  listSkills: () => ipcRenderer.invoke('list-skills'),
  readSkill: (args) => ipcRenderer.invoke('read-skill', args),
  syncSkills: (args) => ipcRenderer.invoke('sync-skills', args || {}),
  onSkillsLog: (callback: (line: string) => void) => {
    const handler = (_event: any, line: string) => callback(line);
    ipcRenderer.on('skills-log', handler);
    return () => ipcRenderer.removeListener('skills-log', handler);
  },
  writeWorkspaceFile: (args) => ipcRenderer.invoke('write-workspace-file', args),
  readWorkspaceFile: (args) => ipcRenderer.invoke('read-workspace-file', args),
  listWorkspaceFolder: (args) => ipcRenderer.invoke('list-workspace-folder', args),
  createWorkspaceFolder: (args) => ipcRenderer.invoke('create-workspace-folder', args),
  openWorkspacePath: (args) => ipcRenderer.invoke('open-workspace-path', args),
  getEditorInfo: () => ipcRenderer.invoke('get-editor-info'),
  sendProcessInput: (args) => ipcRenderer.invoke('send-process-input', args),
  onProjectUrl: (callback) => {
    const handler = (_e: any, payload: any) => callback(payload);
    ipcRenderer.on('project-url', handler);
    return () => ipcRenderer.removeListener('project-url', handler);
  },
  onProjectAwaitingInput: (callback) => {
    const handler = (_e: any, payload: any) => callback(payload);
    ipcRenderer.on('project-awaiting-input', handler);
    return () => ipcRenderer.removeListener('project-awaiting-input', handler);
  },
  readMemory: () => ipcRenderer.invoke('read-memory'),
  saveMemory: (memoryData) => ipcRenderer.invoke('save-memory', memoryData),
  platform: process.platform,
  readJournal: () => ipcRenderer.invoke('read-journal'),
  saveJournal: (entries) => ipcRenderer.invoke('save-journal', entries),
  runReflection: (args) => ipcRenderer.invoke('run-reflection', args),
  syncNotchState: (state: any) => ipcRenderer.send('sync-notch-state', state),
  onNotchStateUpdate: (callback: (state: any) => void) => {
    const handler = (_event: any, state: any) => callback(state);
    ipcRenderer.on('notch-state-update', handler);
    return () => ipcRenderer.removeListener('notch-state-update', handler);
  },
  resizeNotch: (dims) => ipcRenderer.invoke('resize-notch', dims),
  notchAction: (action) => ipcRenderer.invoke('notch-action', action),
  onDeckEngagedChange: (callback: (engaged: boolean) => void) => {
    const handler = (_event: any, engaged: boolean) => callback(engaged);
    ipcRenderer.on('deck-engaged-change', handler);
    return () => ipcRenderer.removeListener('deck-engaged-change', handler);
  }
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
