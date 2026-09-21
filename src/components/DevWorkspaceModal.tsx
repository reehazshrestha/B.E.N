import React, { useEffect, useRef, useState } from 'react';
import { X, CheckCircle2, Loader2, Folder, Code2, AlertTriangle, Globe, CornerDownLeft } from 'lucide-react';
import { DevBuildSession } from '../types';

// Once the build is over the console has nothing left to show, so it stands
// down on its own rather than sitting over the deck until dismissed.
const AUTO_CLOSE_SECONDS = 6;

interface DevWorkspaceModalProps {
  session: DevBuildSession | null;
  onClose: () => void;
  // Stand-down after the build finished. Unlike onClose this is not the user
  // dismissing the console, so the next build is still allowed to open it.
  onAutoClose?: () => void;
}

export const DevWorkspaceModal: React.FC<DevWorkspaceModalProps> = ({ session, onClose, onAutoClose }) => {
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [inputValue, setInputValue] = useState('');
  // Which editor this Mac actually has. The button used to say VS Code on a
  // machine that has never had it installed.
  const [editorName, setEditorName] = useState<string | null>(null);
  const autoCloseRef = useRef(onAutoClose);
  autoCloseRef.current = onAutoClose;

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [session?.logs]);

  useEffect(() => {
    window.electronAPI?.getEditorInfo?.().then((info) => setEditorName(info.editor));
  }, []);

  // A program that has stopped to ask something is waiting on this box, so put
  // the cursor in it rather than making the user find it.
  useEffect(() => {
    if (session?.awaitingInput) inputRef.current?.focus();
  }, [session?.awaitingInput]);

  const status = session?.status;
  const sessionId = session?.id;

  useEffect(() => {
    if (!status || status === 'running') {
      setSecondsLeft(null);
      return;
    }

    let left = AUTO_CLOSE_SECONDS;
    setSecondsLeft(left);
    const timer = setInterval(() => {
      left -= 1;
      setSecondsLeft(left);
      if (left <= 0) {
        clearInterval(timer);
        autoCloseRef.current?.();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [status, sessionId]);

  if (!session) return null;

  const cancelAutoClose = () => setSecondsLeft(null);

  const handleOpenInEditor = () => {
    // The project folder, not just the application: launching an empty editor
    // is not what "open in the editor" means here.
    if (session?.projectName && window.electronAPI?.openWorkspacePath) {
      window.electronAPI.openWorkspacePath({ relativePath: session.projectName, mode: 'editor' });
    } else if (editorName && window.electronAPI?.openApp) {
      window.electronAPI.openApp(editorName);
    }
  };

  const handleSendInput = async () => {
    if (!window.electronAPI?.sendProcessInput) return;
    const text = inputValue;
    setInputValue('');
    const res = await window.electronAPI.sendProcessInput({ text });
    if (!res.success) setInputValue(text);
  };

  const handleOpenFolder = () => {
    if (window.electronAPI?.openApp) {
      window.electronAPI.openApp('Finder');
    }
  };

  const handleCancelBuild = async () => {
    if (window.electronAPI?.cancelOpencode) {
      await window.electronAPI.cancelOpencode();
    }
  };

  const isServerRunning = session.mode === 'server' || session.logs.some(l => l.includes('http://') || l.includes('localhost:') || l.includes('VITE v') || l.includes('Ready in') || l.includes('server running'));

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 z-50 animate-in fade-in duration-200">
      <div className={`w-full max-w-4xl bg-[#090810] border ${isServerRunning ? 'border-emerald-500/50 shadow-[0_0_40px_rgba(16,185,129,0.25)]' : 'border-[#F59E0B]/50 shadow-[0_0_40px_rgba(245,158,11,0.25)]'} rounded-2xl flex flex-col max-h-[85vh] overflow-hidden`}>
        {/* Header Strip */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#241C3A] bg-[#0E0C15]">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg border ${isServerRunning ? 'bg-emerald-950/60 border-emerald-500 text-emerald-400' : 'bg-[#F59E0B]/20 border-[#F59E0B]/50 text-[#F59E0B]'}`}>
              <Code2 className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-[#E8E3F5] tracking-wider font-mono uppercase">
                  {isServerRunning ? 'AUTONOMOUS RUNTIME CONSOLE' : 'AUTONOMOUS DEV WORKSPACE'}
                </h2>
                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold tracking-wider uppercase border flex items-center gap-1 ${
                    session.status === 'running'
                      ? isServerRunning
                        ? 'bg-emerald-950/60 border-emerald-500 text-emerald-300 animate-pulse'
                        : 'bg-[#F59E0B]/20 border-[#F59E0B] text-[#F59E0B] animate-pulse'
                      : session.status === 'completed'
                      ? 'bg-emerald-950/60 border-emerald-500 text-emerald-300'
                      : 'bg-red-950/60 border-red-500 text-red-300'
                  }`}
                >
                  {session.status === 'running' ? (
                    isServerRunning ? (
                      <>
                        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                        <span>PROCESS / SERVER ACTIVE</span>
                      </>
                    ) : (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin" />
                        <span>BUILDING ARCHITECTURE</span>
                      </>
                    )
                  ) : session.status === 'completed' ? (
                    <>
                      <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                      <span>PROCESS COMPLETE</span>
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="w-3 h-3 text-red-400" />
                      <span>PROCESS HALTED</span>
                    </>
                  )}
                </span>
              </div>
              <p className="text-[11px] font-mono text-[#8A82A6] mt-0.5 truncate max-w-xl">
                Target:{' '}
                <span className="text-[#F59E0B]">
                  {session.directory || 'resolving...'}
                </span>
                {session.projectName ? (
                  <>
                    {' · Project: '}
                    <span className="text-[#C084FC]">{session.projectName}</span>
                  </>
                ) : null}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#8A82A6] hover:text-[#E8E3F5] hover:bg-[#241C3A]/50 transition-colors"
            title="Minimize Workspace"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Prompt Card */}
        <div className="px-6 py-2.5 bg-[#141022] border-b border-[#241C3A] flex items-center justify-between text-xs font-mono">
          <div className="flex items-center gap-2 truncate text-[#E8E3F5]">
            <span className="text-[#F59E0B] font-bold">PROMPT:</span>
            <span className="text-gray-300 truncate">{session.prompt}</span>
          </div>
          <span className="text-[10px] text-[#8A82A6] flex-shrink-0 ml-4">{session.startTime}</span>
        </div>

        {/* Live Terminal Log Viewer */}
        <div
          ref={terminalRef}
          className="flex-1 p-5 overflow-y-auto font-mono text-xs text-[#E8E3F5] bg-[#050409] space-y-1 custom-scrollbar select-text leading-relaxed min-h-[300px]"
        >
          {session.logs.length === 0 ? (
            <div className="flex items-center gap-2 text-[#8A82A6] italic p-4">
              <Loader2 className="w-4 h-4 animate-spin text-[#F59E0B]" />
              <span>Initializing autonomous developer agent pipeline...</span>
            </div>
          ) : (
            session.logs.map((line, idx) => {
              const isError = line.toLowerCase().includes('error') || line.toLowerCase().includes('fail') || line.includes('❌');
              const isSuccess = line.toLowerCase().includes('wrote') || line.toLowerCase().includes('success') || line.toLowerCase().includes('complete') || line.includes('🏁');
              const isAction = line.startsWith('>') || line.startsWith('←') || line.startsWith('⚡');

              return (
                <div
                  key={idx}
                  className={`whitespace-pre-wrap ${
                    isError
                      ? 'text-red-400 font-semibold'
                      : isSuccess
                      ? 'text-emerald-300 font-medium'
                      : isAction
                      ? 'text-amber-300 font-semibold'
                      : 'text-gray-300'
                  }`}
                >
                  {line}
                </div>
              );
            })
          )}
        </div>

        {/* Standard input. A program that asks a question has nowhere to read
            the answer from otherwise - stdin is a pipe with this on the end. */}
        {session.status === 'running' && (
          <div
            className={`px-6 py-2.5 bg-[#0B0913] border-t flex items-center gap-2 ${
              session.awaitingInput ? 'border-[#F59E0B]/60' : 'border-[#241C3A]'
            }`}
          >
            <CornerDownLeft
              className={`w-3.5 h-3.5 flex-shrink-0 ${
                session.awaitingInput ? 'text-[#F59E0B]' : 'text-[#8A82A6]'
              }`}
            />
            <input
              ref={inputRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSendInput();
                }
              }}
              placeholder={
                session.awaitingInput
                  ? `Waiting for input: ${session.awaitingInput.trim().slice(-60)}`
                  : 'Type here to send input to the running process'
              }
              className="flex-1 bg-transparent outline-none text-xs font-mono text-[#E8E3F5] placeholder:text-[#8A82A6]/70"
            />
            <button
              onClick={handleSendInput}
              className="px-2.5 py-1 rounded-md bg-[#241C3A]/60 hover:bg-[#241C3A] border border-[#241C3A] text-[10px] font-mono text-[#E8E3F5] transition-colors"
            >
              SEND
            </button>
          </div>
        )}

        {/* Footer Actions */}
        <div className="px-6 py-3.5 bg-[#0E0C15] border-t border-[#241C3A] flex items-center justify-between">
          <div className="flex items-center gap-2">
            {editorName && (
              <button
                onClick={handleOpenInEditor}
                className="px-3.5 py-1.5 rounded-lg bg-[#241C3A]/60 hover:bg-[#241C3A] border border-[#241C3A] text-xs font-mono text-[#E8E3F5] flex items-center gap-1.5 transition-colors"
              >
                <Code2 className="w-3.5 h-3.5 text-[#C084FC]" />
                <span>Open in {editorName}</span>
              </button>
            )}
            {session.url && (
              <button
                onClick={() => window.electronAPI?.openUrl?.(session.url as string)}
                className="px-3.5 py-1.5 rounded-lg bg-[#241C3A]/60 hover:bg-[#241C3A] border border-emerald-500/40 text-xs font-mono text-emerald-300 flex items-center gap-1.5 transition-colors"
              >
                <Globe className="w-3.5 h-3.5" />
                <span>{session.url.replace(/^https?:\/\//, '')}</span>
              </button>
            )}
            <button
              onClick={handleOpenFolder}
              className="px-3.5 py-1.5 rounded-lg bg-[#241C3A]/60 hover:bg-[#241C3A] border border-[#241C3A] text-xs font-mono text-[#E8E3F5] flex items-center gap-1.5 transition-colors"
            >
              <Folder className="w-3.5 h-3.5 text-[#F59E0B]" />
              <span>Open in Finder</span>
            </button>
            {session.status === 'running' && (
              <button
                onClick={handleCancelBuild}
                className="px-3.5 py-1.5 rounded-lg bg-red-950/60 hover:bg-red-900 border border-red-500/50 text-xs font-mono text-red-300 flex items-center gap-1.5 transition-colors shadow-[0_0_10px_rgba(239,68,68,0.25)]"
              >
                <AlertTriangle className="w-3.5 h-3.5 text-red-400" />
                <span>{isServerRunning ? 'Stop Server' : 'Stop Build'}</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-3">
            {secondsLeft !== null && secondsLeft > 0 && (
              <button
                onClick={cancelAutoClose}
                className="text-[10px] font-mono text-[#8A82A6] hover:text-[#E8E3F5] transition-colors"
                title="Keep the console open"
              >
                CLOSING IN {secondsLeft}s · STAY OPEN
              </button>
            )}
            <button
              onClick={onClose}
              className="px-5 py-1.5 rounded-lg bg-[#F59E0B] hover:bg-[#D97706] text-black font-mono font-bold text-xs tracking-wider transition-colors shadow-[0_0_12px_rgba(245,158,11,0.3)]"
            >
              {session.status === 'running' ? 'MINIMIZE' : 'CLOSE CONSOLE'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
