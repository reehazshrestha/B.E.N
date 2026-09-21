import React, { useEffect, useRef } from 'react';
import { JarvisState } from '../types';

interface ArcReactorProps {
  state: JarvisState;
  micAnalyser: AnalyserNode | null;
  speakerAnalyser: AnalyserNode | null;
  onClick?: () => void;
}

export const ArcReactor: React.FC<ArcReactorProps> = ({
  state,
  micAnalyser,
  speakerAnalyser,
  onClick
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrameId: number;
    let rotationAngle1 = 0;
    let rotationAngle2 = 0;
    let rotationAngle3 = 0;
    let pulsePhase = 0;

    const micDataArray = new Uint8Array(micAnalyser?.frequencyBinCount || 128);
    const speakerDataArray = new Uint8Array(speakerAnalyser?.frequencyBinCount || 128);

    const render = () => {
      // Handle high-DPI displays
      const width = canvas.width;
      const height = canvas.height;
      const centerX = width / 2;
      const centerY = height / 2;
      const maxRadius = Math.min(centerX, centerY) - 20;

      ctx.clearRect(0, 0, width, height);

      // Get audio data
      let micVolume = 0;
      if (micAnalyser && state === 'listening') {
        micAnalyser.getByteFrequencyData(micDataArray);
        const sum = micDataArray.reduce((a, b) => a + b, 0);
        micVolume = sum / (micDataArray.length * 255);
      }

      let speakerVolume = 0;
      if (speakerAnalyser && state === 'speaking') {
        speakerAnalyser.getByteFrequencyData(speakerDataArray);
        const sum = speakerDataArray.reduce((a, b) => a + b, 0);
        speakerVolume = sum / (speakerDataArray.length * 255);
      }

      const activeVolume = Math.max(micVolume, speakerVolume);

      // Color scheme based on state
      let primaryColor = '0, 229, 255'; // Cyan
      let coreColor = '220, 248, 255';
      let speedMultiplier = 1.0;

      if (state === 'disconnected') {
        primaryColor = '70, 100, 120';
        coreColor = '100, 140, 160';
        speedMultiplier = 0.2;
      } else if (state === 'connecting' || state === 'thinking') {
        primaryColor = '255, 170, 0'; // Amber/Gold
        coreColor = '255, 230, 180';
        speedMultiplier = 2.5;
      } else if (state === 'speaking') {
        primaryColor = '0, 190, 255'; // Electric blue
        coreColor = '255, 255, 255';
        speedMultiplier = 1.6;
      } else if (state === 'error') {
        primaryColor = '255, 50, 80';
        coreColor = '255, 180, 190';
        speedMultiplier = 0.5;
      }

      // Update angles
      rotationAngle1 += 0.008 * speedMultiplier;
      rotationAngle2 -= 0.012 * speedMultiplier;
      rotationAngle3 += 0.018 * speedMultiplier;
      pulsePhase += 0.04;

      const dynamicRadius = maxRadius * (0.95 + activeVolume * 0.15);

      // 1. Ambient Background Glow
      const bgGlow = ctx.createRadialGradient(
        centerX,
        centerY,
        maxRadius * 0.1,
        centerX,
        centerY,
        maxRadius * 1.2
      );
      bgGlow.addColorStop(0, `rgba(${primaryColor}, ${0.15 + activeVolume * 0.3})`);
      bgGlow.addColorStop(0.5, `rgba(${primaryColor}, ${0.05 + activeVolume * 0.1})`);
      bgGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = bgGlow;
      ctx.fillRect(0, 0, width, height);

      // 2. Outer Frequency Spectrum Ring
      ctx.save();
      ctx.translate(centerX, centerY);
      const bars = 48;
      const angleStep = (Math.PI * 2) / bars;

      for (let i = 0; i < bars; i++) {
        const barAngle = i * angleStep + rotationAngle1;
        const dataIdx = i % (speakerDataArray.length / 2);
        const dataVal = state === 'speaking'
          ? speakerDataArray[dataIdx] / 255
          : state === 'listening'
          ? micDataArray[dataIdx] / 255
          : 0.15 + Math.sin(pulsePhase + i * 0.3) * 0.1;

        const barHeight = 8 + dataVal * 32 * (state === 'disconnected' ? 0.3 : 1);
        const r1 = dynamicRadius * 0.96;
        const r2 = r1 + barHeight;

        const x1 = Math.cos(barAngle) * r1;
        const y1 = Math.sin(barAngle) * r1;
        const x2 = Math.cos(barAngle) * r2;
        const y2 = Math.sin(barAngle) * r2;

        ctx.strokeStyle = `rgba(${primaryColor}, ${0.4 + dataVal * 0.6})`;
        ctx.lineWidth = 2.5;
        ctx.shadowColor = `rgba(${primaryColor}, 0.8)`;
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      ctx.restore();

      // 3. Concentric Technical Circles
      ctx.save();
      ctx.translate(centerX, centerY);

      // Outer solid ring
      ctx.strokeStyle = `rgba(${primaryColor}, 0.6)`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, dynamicRadius * 0.92, 0, Math.PI * 2);
      ctx.stroke();

      // Segmented telemetry ring (Clockwise)
      ctx.rotate(rotationAngle1);
      ctx.strokeStyle = `rgba(${primaryColor}, 0.85)`;
      ctx.lineWidth = 3.5;
      ctx.setLineDash([14, 10, 30, 8, 4, 12]);
      ctx.beginPath();
      ctx.arc(0, 0, dynamicRadius * 0.82, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // Middle counter-rotating ring with tick marks
      ctx.save();
      ctx.translate(centerX, centerY);
      ctx.rotate(rotationAngle2);

      ctx.strokeStyle = `rgba(${primaryColor}, 0.5)`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, dynamicRadius * 0.68, 0, Math.PI * 2);
      ctx.stroke();

      // Ticks around middle ring
      const numTicks = 24;
      for (let i = 0; i < numTicks; i++) {
        const a = (i * Math.PI * 2) / numTicks;
        const len = i % 4 === 0 ? 8 : 4;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * (dynamicRadius * 0.68 - len), Math.sin(a) * (dynamicRadius * 0.68 - len));
        ctx.lineTo(Math.cos(a) * dynamicRadius * 0.68, Math.sin(a) * dynamicRadius * 0.68);
        ctx.stroke();
      }
      ctx.restore();

      // 4. Arc Reactor Inner Segments / Coils (10 coils like Mark 1 / Mark 3)
      ctx.save();
      ctx.translate(centerX, centerY);
      ctx.rotate(rotationAngle3);

      const coils = 10;
      for (let i = 0; i < coils; i++) {
        const coilAngle = (i * Math.PI * 2) / coils;
        ctx.save();
        ctx.rotate(coilAngle);

        const coilGrad = ctx.createLinearGradient(0, dynamicRadius * 0.35, 0, dynamicRadius * 0.55);
        coilGrad.addColorStop(0, `rgba(${primaryColor}, 0.8)`);
        coilGrad.addColorStop(1, `rgba(${coreColor}, 0.2)`);

        ctx.fillStyle = coilGrad;
        ctx.strokeStyle = `rgba(${primaryColor}, 0.9)`;
        ctx.lineWidth = 1.5;

        // Coil trapezoid
        const innerW = 8;
        const outerW = 16;
        const innerR = dynamicRadius * 0.36;
        const outerR = dynamicRadius * 0.54;

        ctx.beginPath();
        ctx.moveTo(-innerW / 2, innerR);
        ctx.lineTo(innerW / 2, innerR);
        ctx.lineTo(outerW / 2, outerR);
        ctx.lineTo(-outerW / 2, outerR);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        ctx.restore();
      }
      ctx.restore();

      // 5. Central Glowing Core
      ctx.save();
      ctx.translate(centerX, centerY);

      const coreRadius = dynamicRadius * (0.28 + activeVolume * 0.1 + Math.sin(pulsePhase) * 0.02);

      const coreGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, coreRadius);
      coreGrad.addColorStop(0, `rgba(${coreColor}, 1)`);
      coreGrad.addColorStop(0.4, `rgba(${primaryColor}, 0.9)`);
      coreGrad.addColorStop(0.8, `rgba(${primaryColor}, 0.3)`);
      coreGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');

      ctx.fillStyle = coreGrad;
      ctx.shadowColor = `rgba(${primaryColor}, 1)`;
      ctx.shadowBlur = 20 + activeVolume * 30;
      ctx.beginPath();
      ctx.arc(0, 0, coreRadius, 0, Math.PI * 2);
      ctx.fill();

      // Central triangle icon (Stark Arc insignia)
      ctx.strokeStyle = `rgba(${coreColor}, 0.9)`;
      ctx.lineWidth = 2.5;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      const triR = coreRadius * 0.55;
      for (let i = 0; i < 3; i++) {
        const a = (i * Math.PI * 2) / 3 - Math.PI / 2 + (state === 'thinking' ? rotationAngle3 * 2 : 0);
        const tx = Math.cos(a) * triR;
        const ty = Math.sin(a) * triR;
        if (i === 0) ctx.moveTo(tx, ty);
        else ctx.lineTo(tx, ty);
      }
      ctx.closePath();
      ctx.stroke();

      ctx.restore();

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [state, micAnalyser, speakerAnalyser]);

  return (
    <div
      onClick={onClick}
      className="relative flex items-center justify-center cursor-pointer group"
      title={state === 'disconnected' ? 'Click to Activate J.A.R.V.I.S.' : 'Click to Toggle Standby'}
    >
      <canvas
        ref={canvasRef}
        width={420}
        height={420}
        className="w-[300px] h-[300px] sm:w-[360px] sm:h-[360px] md:w-[400px] md:h-[400px] drop-shadow-[0_0_35px_rgba(0,229,255,0.3)] transition-transform duration-300 group-hover:scale-105"
      />
      {/* State label badge */}
      <div className="absolute -bottom-2 px-4 py-1 rounded-full text-xs font-mono tracking-widest uppercase border bg-black/80 backdrop-blur-md transition-all duration-300">
        {state === 'disconnected' && (
          <span className="text-gray-400 border-gray-700/50">SYSTEM OFFLINE • CLICK TO ENGAGE</span>
        )}
        {state === 'connecting' && (
          <span className="text-amber-400 border-amber-500/50 animate-pulse">ESTABLISHING QUANTUM LINK...</span>
        )}
        {state === 'listening' && (
          <span className="text-cyan-400 border-cyan-500/50 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping"></span>
            LISTENING • SPEAK FREELY
          </span>
        )}
        {state === 'thinking' && (
          <span className="text-amber-400 border-amber-500/50 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-spin"></span>
            PROCESSING TELEMETRY...
          </span>
        )}
        {state === 'speaking' && (
          <span className="text-blue-400 border-blue-500/50 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse"></span>
            J.A.R.V.I.S. TRANSMITTING
          </span>
        )}
        {state === 'error' && (
          <span className="text-red-400 border-red-500/50">SYSTEM ANOMALY • CHECK CONFIG</span>
        )}
      </div>
    </div>
  );
};
