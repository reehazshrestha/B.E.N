import React, { useEffect, useState } from 'react';
import { Cpu, HardDrive, BatteryCharging, Battery, Clock, Activity, ShieldCheck } from 'lucide-react';
import { SystemTelemetry as TelemetryData } from '../types';

export const SystemTelemetry: React.FC = () => {
  const [telemetry, setTelemetry] = useState<TelemetryData>({
    cpuLoad: 12,
    memoryPercent: 42,
    memoryTotalGb: '16.0',
    memoryUsedGb: '6.7',
    batteryPercent: 85,
    batteryIsCharging: true,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  });

  const [currentTime, setCurrentTime] = useState<string>('');

  useEffect(() => {
    // Clock ticker
    const updateTime = () => {
      const d = new Date();
      setCurrentTime(
        d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
      );
    };
    updateTime();
    const timeInterval = setInterval(updateTime, 1000);

    // Telemetry fetcher
    const fetchTelemetry = async () => {
      if (window.electronAPI?.getSystemInfo) {
        try {
          const data = await window.electronAPI.getSystemInfo();
          if (data && typeof data.cpuLoad === 'number') {
            setTelemetry(data);
          }
        } catch (e) {
          console.warn('Telemetry error:', e);
        }
      }
    };

    fetchTelemetry();
    const telemetryInterval = setInterval(fetchTelemetry, 3000);

    return () => {
      clearInterval(timeInterval);
      clearInterval(telemetryInterval);
    };
  }, []);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 bg-[#06101c]/70 border-y border-cyan-950/60 font-mono text-xs text-cyan-400/90 backdrop-blur-sm">
      {/* Time & Timezone */}
      <div className="flex items-center gap-2">
        <Clock className="w-3.5 h-3.5 text-cyan-400" />
        <span className="font-semibold tracking-wider text-cyan-200">{currentTime}</span>
        <span className="text-[10px] text-cyan-600 uppercase">{telemetry.timezone?.split('/').pop()}</span>
      </div>

      {/* CPU Telemetry */}
      <div className="flex items-center gap-2">
        <Cpu className="w-3.5 h-3.5 text-cyan-400" />
        <span className="text-cyan-500 text-[10px]">CPU:</span>
        <div className="w-16 h-1.5 bg-cyan-950 rounded-full overflow-hidden border border-cyan-800/40">
          <div
            className="h-full bg-gradient-to-r from-cyan-500 to-sky-300 transition-all duration-500"
            style={{ width: `${Math.min(100, telemetry.cpuLoad)}%` }}
          />
        </div>
        <span className="text-[11px] font-bold text-cyan-200">{telemetry.cpuLoad}%</span>
      </div>

      {/* Memory Telemetry */}
      <div className="flex items-center gap-2">
        <HardDrive className="w-3.5 h-3.5 text-cyan-400" />
        <span className="text-cyan-500 text-[10px]">RAM:</span>
        <div className="w-16 h-1.5 bg-cyan-950 rounded-full overflow-hidden border border-cyan-800/40">
          <div
            className="h-full bg-gradient-to-r from-sky-400 to-blue-400 transition-all duration-500"
            style={{ width: `${Math.min(100, telemetry.memoryPercent)}%` }}
          />
        </div>
        <span className="text-[11px] font-bold text-cyan-200">{telemetry.memoryPercent}%</span>
      </div>

      {/* Battery Telemetry if available */}
      {telemetry.batteryPercent !== null && telemetry.batteryPercent !== undefined && (
        <div className="flex items-center gap-1.5">
          {telemetry.batteryIsCharging ? (
            <BatteryCharging className="w-3.5 h-3.5 text-amber-400" />
          ) : (
            <Battery className="w-3.5 h-3.5 text-cyan-400" />
          )}
          <span className="text-[10px] text-cyan-500">PWR:</span>
          <span className="text-[11px] font-bold text-cyan-200">{telemetry.batteryPercent}%</span>
        </div>
      )}

      {/* Security Protocol */}
      <div className="hidden lg:flex items-center gap-1 text-[10px] text-emerald-400 border border-emerald-900/40 bg-emerald-950/20 px-2 py-0.5 rounded">
        <ShieldCheck className="w-3 h-3 text-emerald-400" />
        <span>STARK_SEC_ONLINE</span>
      </div>
    </div>
  );
};
