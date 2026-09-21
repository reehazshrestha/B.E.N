import React, { useEffect, useRef, useState } from 'react';
import { Send, Trash2, Bot, Radio } from 'lucide-react';
import { ChatMessage, JarvisState } from '../types';

interface RightColumnProps {
  messages: ChatMessage[];
  currentStreamingText: string;
  streamingUserText: string;
  state: JarvisState;
  onSendText: (text: string) => void;
  onClear: () => void;
  onQuickCommand: (command: string) => void;
}

const COMMAND_BUTTONS = [
  { label: 'OPENCODE DEV', command: 'Use opencode to inspect my Development directory and check project build status' },
  { label: 'ACTIVE TASKS', command: 'List all my active and uncompleted directives from system memory' },
  { label: 'SYSTEM CHECK', command: 'Run a system check and tell me CPU, memory and battery metrics' },
  { label: 'INSPECT SCREEN', command: 'Inspect my screen and tell me what you see' }
];

export const RightColumn: React.FC<RightColumnProps> = ({
  messages,
  currentStreamingText,
  streamingUserText,
  state,
  onSendText,
  onClear,
  onQuickCommand
}) => {
  const [inputText, setInputText] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, currentStreamingText, streamingUserText]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    onSendText(inputText.trim());
    setInputText('');
  };

  return (
    <aside className="w-full lg:w-[320px] xl:w-[360px] flex flex-col gap-5 h-full overflow-hidden select-none">
      {/* 1. Command Deck 2x2 Action Buttons */}
      <div className="rounded-xl border border-[#241C3A] bg-[#0E0C15] p-5 flex flex-col gap-3 shadow-sm">
        <div className="flex items-center justify-between pb-2 border-b border-[#241C3A]/80 font-mono text-[10px]">
          <span className="font-bold tracking-widest text-[#E8E3F5] uppercase">
            COMMAND DECK
          </span>
          <span className="text-[#8A82A6] tracking-wider uppercase">
            CLICK OR SPEAK
          </span>
        </div>

        <div className="grid grid-cols-2 gap-1.5 font-mono text-[10px]">
          {COMMAND_BUTTONS.map((btn) => (
            <button
              key={btn.label}
              disabled={state === 'disconnected'}
              onClick={() => onQuickCommand(btn.command)}
              className="py-2 px-2.5 rounded bg-[#151221] hover:bg-[#A855F7]/20 border border-[#241C3A] hover:border-[#A855F7]/50 text-[#E8E3F5] hover:text-[#A855F7] font-semibold tracking-wider transition-all disabled:opacity-40 text-center truncate"
            >
              {btn.label}
            </button>
          ))}
        </div>
      </div>

      {/* 2. Radio I/O / Neural Stream Panel */}
      <div className="flex-1 rounded-xl border border-[#241C3A] bg-[#0E0C15] p-5 flex flex-col min-h-[220px] shadow-sm overflow-hidden">
        <div className="flex items-center justify-between pb-2.5 border-b border-[#241C3A]/80 font-mono text-[10px]">
          <div className="flex items-center gap-1.5">
            <Radio className="w-3 h-3 text-[#A855F7] animate-pulse" />
            <span className="font-bold tracking-widest text-[#E8E3F5] uppercase">
              RADIO I/O TRANSCRIPT
            </span>
          </div>
          <button
            onClick={onClear}
            disabled={messages.length === 0}
            className="text-[#8A82A6] hover:text-red-400 transition-colors text-[9px] uppercase disabled:opacity-30 disabled:hover:text-[#8A82A6]"
            title="Clear Stream"
          >
            PURGE
          </button>
        </div>

        {/* Message Log */}
        <div
          ref={scrollRef}
          className="flex-1 py-3 pr-1 space-y-3 overflow-y-auto font-mono text-xs custom-scrollbar"
        >
          {messages.length === 0 && !currentStreamingText && !streamingUserText && (
            <div className="h-full flex flex-col items-center justify-center text-center p-4 text-[#8A82A6]/60 space-y-1">
              <Bot className="w-6 h-6 opacity-30" />
              <p className="text-[10px] tracking-widest uppercase">
                AWAITING TRANSMISSION...
              </p>
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex flex-col gap-1 p-2 rounded-lg border text-xs leading-relaxed ${
                msg.sender === 'user'
                  ? 'bg-[#151221] border-[#241C3A] text-[#E8E3F5] ml-3'
                  : 'bg-[#1C162E]/60 border-[#A855F7]/30 text-[#E8E3F5] mr-3 shadow-[0_0_10px_rgba(168,85,247,0.05)]'
              }`}
            >
              <div className="flex items-center justify-between text-[9px] text-[#8A82A6] uppercase tracking-wider font-bold">
                <span className={msg.sender === 'user' ? 'text-[#22D3EE]' : 'text-[#A855F7]'}>
                  {msg.sender === 'user' ? '› USER' : '› B.E.N.'}
                </span>
                <span className="text-[#8A82A6]/60">{msg.timestamp}</span>
              </div>
              <p className="font-sans text-[11px] text-[#E8E3F5]">{msg.text}</p>
            </div>
          ))}

          {streamingUserText && (
            <div className="flex flex-col gap-1 p-2 rounded-lg border bg-[#151221] border-[#22D3EE]/40 text-[#E8E3F5] ml-3">
              <div className="text-[9px] text-[#22D3EE] uppercase tracking-wider font-bold">
                › USER (SPEAKING)
              </div>
              <p className="font-sans text-[11px] text-[#E8E3F5]/80 italic">{streamingUserText}</p>
            </div>
          )}

          {currentStreamingText && (
            <div className="flex flex-col gap-1 p-2 rounded-lg border bg-[#1C162E]/80 border-[#A855F7]/60 text-[#E8E3F5] mr-3 animate-pulse">
              <div className="text-[9px] text-[#A855F7] uppercase tracking-wider font-bold">
                › B.E.N. (SPEAKING)
              </div>
              <p className="font-sans text-[11px] text-[#E8E3F5] flex items-center">
                <span>{currentStreamingText}</span>
                <span className="w-1.5 h-3 bg-[#A855F7] ml-1 animate-ping" />
              </p>
            </div>
          )}
        </div>

        {/* Input Form */}
        <form onSubmit={handleSubmit} className="mt-3 pt-3 border-t border-[#241C3A] flex items-center gap-2">
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder={state === 'disconnected' ? 'Engage B.E.N. to prompt...' : 'Transmit command to neural wire...'}
            disabled={state === 'disconnected'}
            className="flex-1 bg-[#07060B] border border-[#241C3A] rounded-lg px-3 py-2 text-xs text-[#E8E3F5] placeholder-[#8A82A6]/60 focus:outline-none focus:border-[#A855F7] font-mono"
          />
          <button
            type="submit"
            disabled={state === 'disconnected' || !inputText.trim()}
            className="p-2 bg-[#A855F7] hover:bg-[#9333EA] disabled:opacity-30 text-white rounded-lg transition-colors"
          >
            <Send className="w-3.5 h-3.5" />
          </button>
        </form>
      </div>
    </aside>
  );
};
