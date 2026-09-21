import React, { useEffect, useState } from 'react';
import { Monitor, RefreshCw, X, Eye, AppWindow } from 'lucide-react';

interface CaptureSource {
  id: string;
  name: string;
  isScreen: boolean;
}

interface VisionPreviewProps {
  onCaptureFrame: (target?: string) => Promise<string | null>;
  onClose: () => void;
}

export const VisionPreview: React.FC<VisionPreviewProps> = ({ onCaptureFrame, onClose }) => {
  const [previewImg, setPreviewImg] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSentAt, setLastSentAt] = useState<string | null>(null);
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const [target, setTarget] = useState<string>('');

  // Re-read on open and on every capture: windows come and go, and a list from
  // five minutes ago offers apps that have since been closed.
  const refreshSources = async () => {
    const res = await window.electronAPI?.listCaptureSources?.();
    setSources(res?.sources || []);
  };

  useEffect(() => {
    void refreshSources();
  }, []);

  const handleCaptureNow = async () => {
    setIsCapturing(true);
    setError(null);
    try {
      void refreshSources();
      const base64 = await onCaptureFrame(target || undefined);
      if (base64) {
        setPreviewImg(`data:image/jpeg;base64,${base64}`);
        setLastSentAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      } else {
        setError('Screen capture unavailable. Engage B.E.N. and grant screen recording permission.');
      }
    } catch (e: any) {
      setError(e?.message || 'Screen capture failed.');
    } finally {
      setIsCapturing(false);
    }
  };

  return (
    <div className="absolute top-16 right-4 w-72 sm:w-80 bg-[#0E0C15]/95 border border-[#241C3A] rounded-xl p-3 shadow-[0_0_30px_rgba(168,85,247,0.18)] backdrop-blur-xl z-40 flex flex-col gap-2.5 font-mono text-xs">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[#241C3A] pb-2">
        <div className="flex items-center gap-1.5 text-[#A855F7] font-bold tracking-wider">
          <Eye className="w-4 h-4" />
          <span>OPTICAL SENSOR</span>
        </div>
        <button onClick={onClose} className="text-[#8A82A6] hover:text-red-400 transition-colors" title="Close">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Preview Screen Container */}
      <div className="relative aspect-video bg-[#07060B] rounded border border-[#241C3A] overflow-hidden flex items-center justify-center">
        {previewImg ? (
          <img src={previewImg} alt="Screen capture preview" className="w-full h-full object-cover" />
        ) : (
          <div className="flex flex-col items-center text-center p-4 text-[#8A82A6] gap-1">
            <Monitor className="w-8 h-8 opacity-40" />
            <span className="text-[10px]">No frame captured yet</span>
          </div>
        )}

        {/* Reticle overlay */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute top-2 left-2 w-3 h-3 border-t-2 border-l-2 border-[#A855F7]/70" />
          <div className="absolute top-2 right-2 w-3 h-3 border-t-2 border-r-2 border-[#A855F7]/70" />
          <div className="absolute bottom-2 left-2 w-3 h-3 border-b-2 border-l-2 border-[#A855F7]/70" />
          <div className="absolute bottom-2 right-2 w-3 h-3 border-b-2 border-r-2 border-[#A855F7]/70" />
        </div>
      </div>

      {/* What to capture. A list rather than a single "share screen" button:
          the whole desktop is rarely the thing you meant. */}
      <div className="flex items-center gap-1.5">
        <AppWindow className="w-3.5 h-3.5 text-[#8A82A6] flex-shrink-0" />
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          onFocus={() => void refreshSources()}
          className="flex-1 bg-[#151221] border border-[#241C3A] rounded px-2 py-1.5 text-[11px] text-[#E8E3F5] outline-none focus:border-[#A855F7]/60"
        >
          <option value="">Entire screen</option>
          {sources
            .filter((src) => !src.isScreen)
            .map((src) => (
              <option key={src.id} value={src.id}>
                {src.name.length > 42 ? `${src.name.slice(0, 41)}…` : src.name}
              </option>
            ))}
        </select>
        <button
          type="button"
          onClick={() => void refreshSources()}
          title="Refresh the list of open windows"
          className="text-[#8A82A6] hover:text-[#C084FC] transition-colors flex-shrink-0"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Trigger Button */}
      <button
        onClick={handleCaptureNow}
        disabled={isCapturing}
        className="w-full flex items-center justify-center gap-2 py-2 px-3 bg-[#A855F7]/15 hover:bg-[#A855F7]/25 border border-[#A855F7]/60 text-[#E8E3F5] rounded font-semibold text-xs tracking-wider transition-all disabled:opacity-50"
      >
        <RefreshCw className={`w-3.5 h-3.5 ${isCapturing ? 'animate-spin' : ''}`} />
        <span>
          {isCapturing
            ? 'CAPTURING...'
            : target
            ? 'SEND THIS WINDOW'
            : 'SEND WHOLE SCREEN'}
        </span>
      </button>

      {error ? (
        <p className="text-[10px] text-red-300 leading-tight">{error}</p>
      ) : (
        <p className="text-[10px] text-[#8A82A6] leading-tight">
          {lastSentAt
            ? `Frame sent at ${lastSentAt}. Ask B.E.N. what is on screen.`
            : 'Sends one screenshot to the live session, then ask about what is on screen.'}
        </p>
      )}
    </div>
  );
};
