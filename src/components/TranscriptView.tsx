import React, { useEffect, useRef, useState } from 'react';
import { Send, Trash2, Mic, Bot, User, Sparkles } from 'lucide-react';
import { ChatMessage, JarvisState } from '../types';

interface TranscriptViewProps {
  messages: ChatMessage[];
  currentStreamingText: string;
  state: JarvisState;
  onSendText: (text: string) => void;
  onClear: () => void;
}

export const TranscriptView: React.FC<TranscriptViewProps> = ({
  messages,
  currentStreamingText,
  state,
  onSendText,
  onClear
}) => {
  const [inputText, setInputText] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll when messages or streaming text changes
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, currentStreamingText]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    onSendText(inputText.trim());
    setInputText('');
  };

  return (
    <div className="flex flex-col h-full bg-[#040912]/80 border border-cyan-900/40 rounded-xl overflow-hidden backdrop-blur-md shadow-[0_0_20px_rgba(0,180,255,0.08)]">
      {/* Header */}
      <div className="flex items-center justify-between px-3.5 py-2 border-b border-cyan-900/40 bg-cyan-950/20 text-xs font-mono">
        <div className="flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
          <span className="text-cyan-300 font-semibold tracking-wider">NEURAL DIALOGUE STREAM</span>
        </div>
        <button
          onClick={onClear}
          className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-red-400 transition-colors"
          title="Clear Stream History"
        >
          <Trash2 className="w-3 h-3" />
          <span className="hidden sm:inline">PURGE</span>
        </button>
      </div>

      {/* Message List */}
      <div
        ref={scrollRef}
        className="flex-1 p-3.5 space-y-3 overflow-y-auto font-mono text-xs custom-scrollbar"
      >
        {messages.length === 0 && !currentStreamingText && (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-cyan-700 space-y-2">
            <Bot className="w-8 h-8 opacity-40 animate-pulse" />
            <p className="text-xs uppercase tracking-widest">
              Awaiting voice or telemetry input...
            </p>
            <p className="text-[11px] text-cyan-800">
              Speak naturally. Say &quot;JARVIS, open Spotify&quot; or &quot;What are my system specs?&quot;
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex flex-col gap-1 p-2.5 rounded-lg border transition-all ${
              msg.sender === 'user'
                ? 'bg-cyan-950/20 border-cyan-800/40 ml-4'
                : msg.sender === 'jarvis'
                ? 'bg-[#081726]/60 border-cyan-500/30 mr-4 shadow-[0_0_12px_rgba(0,229,255,0.05)]'
                : 'bg-amber-950/20 border-amber-800/40 text-amber-300'
            }`}
          >
            <div className="flex items-center justify-between text-[10px] text-cyan-500/80">
              <div className="flex items-center gap-1.5 font-bold uppercase tracking-wider">
                {msg.sender === 'user' ? (
                  <>
                    <User className="w-3 h-3 text-cyan-400" />
                    <span>USER</span>
                  </>
                ) : msg.sender === 'jarvis' ? (
                  <>
                    <Bot className="w-3 h-3 text-sky-400" />
                    <span className="text-sky-300">J.A.R.V.I.S.</span>
                  </>
                ) : (
                  <span>SYSTEM</span>
                )}
              </div>
              <span className="text-[9px] text-cyan-600 font-mono">{msg.timestamp}</span>
            </div>
            <div className="text-cyan-100 text-xs leading-relaxed break-words font-sans">
              {msg.text}
            </div>
          </div>
        ))}

        {/* Live streaming text buffer */}
        {currentStreamingText && (
          <div className="flex flex-col gap-1 p-2.5 rounded-lg border bg-[#081726]/80 border-cyan-400/50 mr-4 shadow-[0_0_15px_rgba(0,229,255,0.15)] animate-pulse">
            <div className="flex items-center gap-1.5 text-[10px] text-sky-300 font-bold uppercase tracking-wider">
              <Bot className="w-3 h-3 text-cyan-400 animate-spin" />
              <span>J.A.R.V.I.S. (TRANSMITTING)</span>
            </div>
            <div className="text-cyan-100 text-xs leading-relaxed break-words font-sans flex items-center">
              <span>{currentStreamingText}</span>
              <span className="w-1.5 h-3.5 bg-cyan-400 ml-1 animate-ping" />
            </div>
          </div>
        )}
      </div>

      {/* Quick Input Bar */}
      <form
        onSubmit={handleSubmit}
        className="p-2 border-t border-cyan-900/40 bg-[#030812]/90 flex items-center gap-2"
      >
        <input
          type="text"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          placeholder={
            state === 'disconnected'
              ? 'Activate JARVIS to send command...'
              : 'Enter command or text prompt...'
          }
          disabled={state === 'disconnected'}
          className="flex-1 bg-[#071322] border border-cyan-900/60 rounded px-3 py-1.5 text-xs text-cyan-200 placeholder-cyan-800 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400/40 font-mono"
        />
        <button
          type="submit"
          disabled={state === 'disconnected' || !inputText.trim()}
          className="p-1.5 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 disabled:hover:bg-cyan-600 text-black font-bold rounded transition-colors"
          title="Transmit text prompt"
        >
          <Send className="w-4 h-4" />
        </button>
      </form>
    </div>
  );
};
