import React, { useEffect, useRef } from 'react';

interface VitalSparklineProps {
  label: string;
  value: string | number;
  unit?: string;
  percentage?: number;
  note?: string;
  accent?: string;
}

export const VitalSparkline: React.FC<VitalSparklineProps> = ({
  label,
  value,
  unit = '',
  percentage = 20,
  note = '',
  accent = '#A855F7'
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const historyRef = useRef<number[]>([]);

  useEffect(() => {
    const history = historyRef.current;
    history.push(percentage);
    if (history.length > 40) {
      history.shift();
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    if (history.length < 2) return;

    // Draw sparkline curve
    const step = width / (40 - 1);
    ctx.beginPath();

    const startX = (40 - history.length) * step;

    for (let i = 0; i < history.length; i++) {
      const x = startX + i * step;
      const val = Math.max(0, Math.min(100, history[i]));
      const y = height - (val / 100) * (height - 4) - 2;

      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = accent;
    ctx.shadowBlur = 4;
    ctx.stroke();

    // Area fill under curve
    ctx.lineTo(startX + (history.length - 1) * step, height);
    ctx.lineTo(startX, height);
    ctx.closePath();

    const fillGrad = ctx.createLinearGradient(0, 0, 0, height);
    fillGrad.addColorStop(0, `${accent}44`);
    fillGrad.addColorStop(1, `${accent}00`);
    ctx.fillStyle = fillGrad;
    ctx.fill();
  }, [percentage, accent]);

  return (
    <div className="flex flex-col py-2 border-b border-[#241C3A]/60 font-mono">
      <div className="flex items-center justify-between text-[10px] text-[#8A82A6] tracking-wider uppercase">
        <span>▪ {label}</span>
        {note && <span className="text-[9px] text-[#8A82A6]/80">{note}</span>}
      </div>

      <div className="flex items-baseline justify-between mt-1">
        <div className="flex items-baseline gap-1">
          <span className="text-lg font-bold text-[#E8E3F5] font-sans tracking-tight">
            {value}
          </span>
          {unit && <span className="text-xs text-[#8A82A6]">{unit}</span>}
        </div>

        {/* Sparkline canvas */}
        <canvas
          ref={canvasRef}
          width={90}
          height={24}
          className="w-[90px] h-[24px] rounded overflow-hidden"
        />
      </div>
    </div>
  );
};
