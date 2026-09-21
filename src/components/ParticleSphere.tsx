import React, { useEffect, useRef } from 'react';
import { JarvisState } from '../types';

interface ParticleSphereProps {
  state: JarvisState;
  micAnalyser: AnalyserNode | null;
  speakerAnalyser: AnalyserNode | null;
  onClick?: () => void;
}

// State color definitions matching B.E.N. / V.A.U.L.T. palette
export const STATE_COLORS: Record<string, { r: number; g: number; b: number; hex: string }> = {
  idle: { r: 91, g: 75, b: 138, hex: '#5B4B8A' },
  listening: { r: 34, g: 211, b: 238, hex: '#22D3EE' },
  thinking: { r: 168, g: 85, b: 247, hex: '#A855F7' },
  building: { r: 245, g: 158, b: 11, hex: '#F59E0B' }, // Vibrant Sci-Fi Orange
  tool_executing: { r: 251, g: 146, b: 60, hex: '#FB923C' }, // Amber Orange
  working: { r: 74, g: 222, b: 128, hex: '#4ADE80' },
  speaking: { r: 168, g: 85, b: 247, hex: '#A855F7' },
  alert: { r: 248, g: 113, b: 113, hex: '#F87171' },
  error: { r: 248, g: 113, b: 113, hex: '#F87171' },
  connecting: { r: 251, g: 191, b: 36, hex: '#FBBF24' }
};

interface Point3D {
  x: number;
  y: number;
  z: number;
  baseRadius: number;
}

interface Edge {
  p1: number;
  p2: number;
}

export const ParticleSphere: React.FC<ParticleSphereProps> = ({
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
    const POINT_COUNT = 900;
    const NEIGHBOUR_RADIUS = 0.28;
    const MAX_EDGES_PER_POINT = 2;
    const SPIRAL_SKIP = 12;

    // 1. Generate Fibonacci spiral shell points
    const points: Point3D[] = [];
    const goldenRatio = Math.PI * (1.0 + Math.sqrt(5.0));

    for (let i = 0; i < POINT_COUNT; i++) {
      const idx = i + 0.5;
      const phi = Math.acos(1.0 - (2.0 * idx) / POINT_COUNT);
      const theta = goldenRatio * idx;
      const jitter = (Math.random() - 0.5) * 0.12;
      const r = 1.0 + jitter;

      points.push({
        x: Math.cos(theta) * Math.sin(phi) * r,
        y: Math.sin(theta) * Math.sin(phi) * r,
        z: Math.cos(phi) * r,
        baseRadius: r
      });
    }

    // 2. Precompute sparse neighbour edges
    const edges: Edge[] = [];
    const perPointCount = new Array(POINT_COUNT).fill(0);
    const radiusSq = NEIGHBOUR_RADIUS * NEIGHBOUR_RADIUS;

    for (let i = 0; i < POINT_COUNT; i++) {
      if (perPointCount[i] >= MAX_EDGES_PER_POINT) continue;
      for (let j = i + SPIRAL_SKIP; j < POINT_COUNT; j++) {
        if (perPointCount[i] >= MAX_EDGES_PER_POINT) break;
        if (perPointCount[j] >= MAX_EDGES_PER_POINT) continue;

        const dx = points[j].x - points[i].x;
        const dy = points[j].y - points[i].y;
        const dz = points[j].z - points[i].z;
        const distSq = dx * dx + dy * dy + dz * dz;

        if (distSq < radiusSq) {
          edges.push({ p1: i, p2: j });
          perPointCount[i]++;
          perPointCount[j]++;
        }
      }
    }

    // Rotation angles and dynamics
    let rotX = 0.3;
    let rotY = 0.0;
    let breathPhase = 0;

    // Audio frequency buffers
    const micData = new Uint8Array(micAnalyser?.frequencyBinCount || 128);
    const speakerData = new Uint8Array(speakerAnalyser?.frequencyBinCount || 128);

    // Color transition interpolation
    let currentR = STATE_COLORS.idle.r;
    let currentG = STATE_COLORS.idle.g;
    let currentB = STATE_COLORS.idle.b;

    const render = () => {
      const width = canvas.width;
      const height = canvas.height;
      const centerX = width / 2;
      const centerY = height / 2;
      const baseScale = Math.min(centerX, centerY) * 0.72;

      ctx.clearRect(0, 0, width, height);

      // Get audio volume
      let audioVolume = 0;
      if (micAnalyser && state === 'listening') {
        micAnalyser.getByteFrequencyData(micData);
        const sum = micData.reduce((a, b) => a + b, 0);
        audioVolume = sum / (micData.length * 255);
      } else if (speakerAnalyser && state === 'speaking') {
        speakerAnalyser.getByteFrequencyData(speakerData);
        const sum = speakerData.reduce((a, b) => a + b, 0);
        audioVolume = sum / (speakerData.length * 255);
      }

      // Smooth color transition
      const targetColor = STATE_COLORS[state] || STATE_COLORS.idle;
      currentR += (targetColor.r - currentR) * 0.08;
      currentG += (targetColor.g - currentG) * 0.08;
      currentB += (targetColor.b - currentB) * 0.08;

      const colStr = `${Math.round(currentR)}, ${Math.round(currentG)}, ${Math.round(currentB)}`;

      // Speeds based on state
      let rotSpeed = 0.006;
      if (state === 'building' || state === 'tool_executing') rotSpeed = 0.032;
      else if (state === 'thinking') rotSpeed = 0.024;
      else if (state === 'speaking') rotSpeed = 0.014;
      else if (state === 'listening') rotSpeed = 0.01;
      else if (state === 'disconnected') rotSpeed = 0.002;

      rotY += rotSpeed;
      rotX += rotSpeed * 0.35;
      breathPhase += 0.04;

      const breath = Math.sin(breathPhase) * 0.04 + audioVolume * 0.22;
      const currentScale = baseScale * (1.0 + breath);

      // Trigonometry for 3D rotation matrix
      const cosY = Math.cos(rotY);
      const sinY = Math.sin(rotY);
      const cosX = Math.cos(rotX);
      const sinX = Math.sin(rotX);

      // Project points to 2D screen
      const projected = new Array(POINT_COUNT);

      for (let i = 0; i < POINT_COUNT; i++) {
        const p = points[i];
        // Rotate Y
        const x1 = p.x * cosY + p.z * sinY;
        const z1 = -p.x * sinY + p.z * cosY;
        // Rotate X
        const y2 = p.y * cosX - z1 * sinX;
        const z2 = p.y * sinX + z1 * cosX;

        // Depth perspective
        const depth = (z2 + 2.4) / 3.4;
        const alpha = Math.max(0.08, Math.min(1.0, (z2 + 1.2) / 2.4));

        projected[i] = {
          sx: centerX + x1 * currentScale,
          sy: centerY + y2 * currentScale,
          sz: z2,
          alpha: alpha,
          depth: depth
        };
      }

      // Draw with Additive Blending (Composite 'lighter')
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      // 1. Draw connecting mesh lines
      ctx.lineWidth = 0.85;
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        const p1 = projected[e.p1];
        const p2 = projected[e.p2];

        // Average depth alpha
        const lineAlpha = (p1.alpha + p2.alpha) * 0.18;
        if (lineAlpha > 0.02) {
          ctx.strokeStyle = `rgba(${colStr}, ${lineAlpha})`;
          ctx.beginPath();
          ctx.moveTo(p1.sx, p1.sy);
          ctx.lineTo(p2.sx, p2.sy);
          ctx.stroke();
        }
      }

      // 2. Draw glowing constellation points
      for (let i = 0; i < POINT_COUNT; i++) {
        const p = projected[i];
        const ptAlpha = p.alpha * (state === 'disconnected' ? 0.35 : 0.85);
        const radius = Math.max(0.6, (p.sz + 1.4) * 1.2 * (1 + audioVolume * 0.8));

        ctx.fillStyle = `rgba(${colStr}, ${ptAlpha})`;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, radius, 0, Math.PI * 2);
        ctx.fill();
      }

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
      className="relative flex items-center justify-center cursor-pointer group select-none"
      title={state === 'disconnected' ? 'Click to Engage B.E.N.' : 'Click to Stand Down'}
    >
      <canvas
        ref={canvasRef}
        width={440}
        height={440}
        className="w-[280px] h-[280px] sm:w-[340px] sm:h-[340px] md:w-[400px] md:h-[400px] drop-shadow-[0_0_40px_rgba(168,85,247,0.25)] transition-transform duration-300 group-hover:scale-105"
      />
    </div>
  );
};
