import React, { useEffect, useState } from 'react';
import { VitalSparkline } from './VitalSparkline';
import { SystemTelemetry, BenTask, WorkspaceInfo, MemoryStoreData } from '../types';
import { memoryStore } from '../services/memory-store';
import { backgroundTasks, BackgroundTask } from '../services/background-tasks';
import {
  CheckCircle2,
  Circle,
  Plus,
  Trash2,
  Code2,
  Brain,
  Loader2,
  AlertTriangle,
  Radio,
  Volume2,
  Lightbulb,
  Wrench,
  X,
  FolderOpen,
  Globe
} from 'lucide-react';

// "1m 20s" rather than a timestamp: what matters about a task still running is
// how long it has been running.
function elapsedLabel(from: number, to: number): string {
  const seconds = Math.max(0, Math.round((to - from) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

interface LeftColumnProps {
  telemetry: SystemTelemetry;
  // False until the host has returned a real reading, so the panel can show
  // placeholders instead of numbers nobody measured.
  telemetryReady: boolean;
  // The address a running dev server printed, if one has. Only a real, live URL
  // ever appears here - there is no guessed localhost port.
  liveUrl?: string | null;
  liveUrlProject?: string | null;
}

export const LeftColumn: React.FC<LeftColumnProps> = ({
  telemetry,
  telemetryReady,
  liveUrl,
  liveUrlProject
}) => {
  const [tasks, setTasks] = useState<BenTask[]>([]);
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [isAddingTask, setIsAddingTask] = useState(false);
  const [projects, setProjects] = useState<string[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [memory, setMemory] = useState<MemoryStoreData | null>(null);
  const [background, setBackground] = useState<BackgroundTask[]>([]);
  // Which editors are actually installed, asked of the machine. The list was
  // never shown anywhere, so a workspace full of projects had no way to open
  // any of them - the panel listed names and nothing else.
  const [editors, setEditors] = useState<string[]>([]);
  const [editor, setEditor] = useState<string>('');
  const [opening, setOpening] = useState<string>('');
  const [openNote, setOpenNote] = useState<string>('');
  const lessons = memory?.lessons || [];
  const proposals = (memory?.proposals || []).filter((proposal) => proposal.status === 'pending');
  // Ticks only while something is running, so an idle deck is not re-rendering
  // once a second for a panel that says the same thing.
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    return backgroundTasks.subscribe(setBackground);
  }, []);

  useEffect(() => {
    let cancelled = false;
    window.electronAPI?.getEditorInfo?.().then((info) => {
      if (cancelled) return;
      setEditors(info.editors || []);
      setEditor(info.editor || info.editors?.[0] || '');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Reports what actually opened, never what was requested. `openedIn` is read
  // back from the process table by the handler.
  const openProject = async (project: string, mode: 'editor' | 'finder') => {
    setOpening(project);
    setOpenNote('');
    try {
      const res = await window.electronAPI?.openWorkspacePath?.({
        relativePath: project,
        mode,
        app: mode === 'editor' && editor ? editor : undefined
      });
      setOpenNote(
        res?.success
          ? `${project} → ${res.openedIn}`
          : res?.error || `${project} did not open.`
      );
    } catch (err: any) {
      setOpenNote(err?.message || 'Could not open it.');
    } finally {
      setOpening('');
      setTimeout(() => setOpenNote(''), 6000);
    }
  };

  useEffect(() => {
    if (!background.some((task) => task.status === 'running')) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [background]);

  useEffect(() => {
    const unsub = memoryStore.subscribe((data) => {
      setTasks(data.tasks);
      setMemory(data);
    });
    return unsub;
  }, []);

  useEffect(() => {
    window.electronAPI?.listDevelopmentProjects?.().then((list) => {
      if (Array.isArray(list)) setProjects(list);
    });

    const readWorkspace = () => {
      window.electronAPI?.getWorkspaceInfo?.().then((info) => {
        if (info) setWorkspace(info);
      });
    };
    readWorkspace();
    const interval = setInterval(readWorkspace, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleAddTask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTaskTitle.trim()) return;
    memoryStore.addTask(newTaskTitle.trim());
    setNewTaskTitle('');
    setIsAddingTask(false);
  };

  const uncompletedCount = tasks.filter((t) => !t.completed).length;
  const runningCount = background.filter((task) => task.status === 'running').length;
  const memoryCount = memory
    ? memory.profile.facts.length + memory.projects.length + memory.notes.length
    : 0;

  return (
    <aside className="w-full lg:w-[270px] xl:w-[300px] flex flex-col gap-5 overflow-y-auto custom-scrollbar select-none pr-1">
      {/* 1. System Vitals Panel */}
      <div className="rounded-xl border border-[#241C3A] bg-[#0E0C15] p-5 flex flex-col gap-3 shadow-sm">
        {/* Section Heading */}
        <div className="flex items-center justify-between pb-2 border-b border-[#241C3A]/80 font-mono text-[10px]">
          <span className="font-bold tracking-widest text-[#E8E3F5] uppercase">
            SYSTEM VITALS
          </span>
          <span className="text-[#8A82A6] tracking-wider uppercase">
            {telemetryReady ? 'CADENCE 3S' : 'NO HOST LINK'}
          </span>
        </div>

        {/* Vital Rows with Sparklines */}
        <VitalSparkline
          label="MEMORY"
          value={telemetryReady && telemetry.memoryUsedGb ? `${telemetry.memoryUsedGb} GB` : '--'}
          unit={telemetryReady && telemetry.memoryTotalGb ? `/ ${telemetry.memoryTotalGb} GB` : ''}
          percentage={telemetryReady ? telemetry.memoryPercent : 0}
          note={telemetryReady ? `${telemetry.memoryPercent}%` : 'AWAITING HOST'}
          accent="#A855F7"
        />

        <VitalSparkline
          label="CPU LOAD"
          value={telemetryReady ? `${telemetry.cpuLoad}%` : '--'}
          percentage={telemetryReady ? telemetry.cpuLoad : 0}
          note={telemetryReady && telemetry.cpuCores ? `${telemetry.cpuCores} CORES` : ''}
          accent="#22D3EE"
        />

        {telemetryReady && telemetry.batteryPercent !== null && telemetry.batteryPercent !== undefined && (
          <VitalSparkline
            label="BATTERY"
            value={`${telemetry.batteryPercent}%`}
            percentage={telemetry.batteryPercent}
            note={telemetry.batteryIsCharging ? 'CHARGING' : 'DISCHARGING'}
            accent={telemetry.batteryIsCharging ? '#FBBF24' : '#4ADE80'}
          />
        )}
      </div>

      {/* 2. Uncompleted Directives & Memory Task List */}
      <div className="rounded-xl border border-[#241C3A] bg-[#0E0C15] p-5 flex flex-col gap-3 shadow-sm">
        <div className="flex items-center justify-between pb-2 border-b border-[#241C3A]/80 font-mono text-[10px]">
          <div className="flex items-center gap-1.5">
            <span className="font-bold tracking-widest text-[#E8E3F5] uppercase">
              ACTIVE DIRECTIVES
            </span>
            <span className="px-1.5 py-0.2 rounded bg-[#A855F7]/20 text-[#A855F7] font-bold text-[9px]">
              {uncompletedCount} PENDING
            </span>
          </div>
          <button
            onClick={() => setIsAddingTask(!isAddingTask)}
            className="text-[#A855F7] hover:text-white p-0.5"
            title="Add Directive"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Quick Add Directive Form */}
        {isAddingTask && (
          <form onSubmit={handleAddTask} className="flex gap-1.5">
            <input
              type="text"
              value={newTaskTitle}
              onChange={(e) => setNewTaskTitle(e.target.value)}
              placeholder="New task / directive..."
              autoFocus
              className="flex-1 bg-[#07060B] border border-[#241C3A] rounded px-2 py-1 text-xs text-[#E8E3F5] focus:outline-none focus:border-[#A855F7] font-mono"
            />
            <button
              type="submit"
              className="px-2 py-1 bg-[#A855F7] hover:bg-[#9333EA] text-black font-bold rounded text-xs"
            >
              ADD
            </button>
          </form>
        )}

        {/* Task List items */}
        <div className="space-y-1.5 max-h-[160px] overflow-y-auto custom-scrollbar pr-1">
          {tasks.length === 0 ? (
            <p className="text-[10px] text-[#8A82A6] font-mono italic">No pending directives.</p>
          ) : (
            tasks.map((task) => (
              <div
                key={task.id}
                className="group flex items-start justify-between gap-1.5 p-1.5 rounded bg-[#07060B]/60 hover:bg-[#07060B] border border-[#241C3A]/40 transition-colors"
              >
                <div
                  onClick={() => memoryStore.toggleTask(task.id)}
                  className="flex items-start gap-2 flex-1 cursor-pointer"
                >
                  {task.completed ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0 mt-0.5" />
                  ) : (
                    <Circle className="w-3.5 h-3.5 text-[#A855F7] flex-shrink-0 mt-0.5" />
                  )}
                  <span
                    className={`text-[11px] font-mono leading-tight ${
                      task.completed ? 'line-through text-[#8A82A6]' : 'text-[#E8E3F5]'
                    }`}
                  >
                    {task.title}
                  </span>
                </div>
                <button
                  onClick={() => memoryStore.deleteTask(task.id)}
                  className="opacity-0 group-hover:opacity-100 text-[#8A82A6] hover:text-red-400 p-0.5 transition-opacity"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 3. Work running in the background, and whether it has been reported.
          A finished task the user has not been told about is the failure this
          panel exists to make visible. */}
      <div className="rounded-xl border border-[#241C3A] bg-[#0E0C15] p-5 flex flex-col gap-3 shadow-sm">
        <div className="flex items-center justify-between pb-2 border-b border-[#241C3A]/80 font-mono text-[10px]">
          <div className="flex items-center gap-1.5">
            <Radio className="w-3.5 h-3.5 text-[#F59E0B]" />
            <span className="font-bold tracking-widest text-[#E8E3F5] uppercase">BACKGROUND</span>
          </div>
          {runningCount > 0 ? (
            <span className="text-[#F59E0B] tracking-wider uppercase">{runningCount} RUNNING</span>
          ) : background.length > 0 ? (
            <button
              onClick={() => backgroundTasks.clearFinished()}
              className="text-[#8A82A6] hover:text-[#E8E3F5] tracking-wider uppercase transition-colors"
            >
              CLEAR
            </button>
          ) : (
            <span className="text-[#8A82A6] tracking-wider uppercase">IDLE</span>
          )}
        </div>

        {background.length === 0 ? (
          <p className="text-[10px] text-[#8A82A6] font-mono italic leading-relaxed">
            Nothing running. Anything B.E.N. says he will look into or build appears here until it
            is done and he has told you.
          </p>
        ) : (
          <div className="space-y-1.5 max-h-[190px] overflow-y-auto custom-scrollbar pr-1">
            {background.map((task) => {
              const isRunning = task.status === 'running';
              const failed = task.status === 'failed';
              return (
                <div
                  key={task.id}
                  className="p-1.5 rounded bg-[#07060B]/60 border border-[#241C3A]/40 space-y-1"
                >
                  <div className="flex items-start gap-2">
                    {isRunning ? (
                      <Loader2 className="w-3.5 h-3.5 text-[#F59E0B] flex-shrink-0 mt-0.5 animate-spin" />
                    ) : failed ? (
                      <AlertTriangle className="w-3.5 h-3.5 text-red-400 flex-shrink-0 mt-0.5" />
                    ) : task.status === 'cancelled' ? (
                      <Circle className="w-3.5 h-3.5 text-[#8A82A6] flex-shrink-0 mt-0.5" />
                    ) : (
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0 mt-0.5" />
                    )}
                    <span className="flex-1 text-[11px] font-mono leading-tight text-[#E8E3F5] line-clamp-2">
                      {task.kind === 'build' ? `Building ${task.label}` : task.label}
                    </span>
                    <span className="text-[9px] font-mono text-[#8A82A6] flex-shrink-0 mt-0.5">
                      {elapsedLabel(task.startedAt, isRunning ? now : task.finishedAt || task.startedAt)}
                    </span>
                  </div>

                  {!isRunning && task.result && (
                    <p
                      className={`text-[10px] font-mono leading-snug pl-5 line-clamp-3 ${
                        failed ? 'text-red-300' : 'text-[#8A82A6]'
                      }`}
                    >
                      {task.result}
                    </p>
                  )}

                  {!isRunning && !task.announced && (
                    <div className="flex items-center gap-1 pl-5 text-[9px] font-mono text-[#F59E0B] uppercase tracking-wider">
                      <Volume2 className="w-3 h-3" />
                      <span>Waiting to be read out</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 3b. What he has learned from his own mistakes, and what he wants to
          change about himself. Both are on screen for one reason: this is text
          a model wrote about how it should behave, and a wrong one would
          otherwise be permanent and invisible. */}
      {(lessons.length > 0 || proposals.length > 0) && (
        <div className="rounded-xl border border-[#241C3A] bg-[#0E0C15] p-5 flex flex-col gap-3 shadow-sm">
          <div className="flex items-center justify-between pb-2 border-b border-[#241C3A]/80 font-mono text-[10px]">
            <div className="flex items-center gap-1.5">
              <Lightbulb className="w-3.5 h-3.5 text-[#22D3EE]" />
              <span className="font-bold tracking-widest text-[#E8E3F5] uppercase">LEARNED</span>
            </div>
            <span className="text-[#8A82A6] tracking-wider uppercase">{lessons.length} LESSON{lessons.length === 1 ? '' : 'S'}</span>
          </div>

          <div className="space-y-1.5 max-h-[170px] overflow-y-auto custom-scrollbar pr-1">
            {lessons.map((lesson) => (
              <div
                key={lesson.id}
                className="p-1.5 rounded bg-[#07060B]/60 border border-[#241C3A]/40 flex items-start gap-2 group"
              >
                <span className="flex-1 text-[11px] font-mono leading-tight text-[#E8E3F5]">
                  {lesson.tool && (
                    <span className="text-[#22D3EE]">[{lesson.tool}] </span>
                  )}
                  {lesson.lesson}
                </span>
                <button
                  onClick={() => memoryStore.forgetLesson(lesson.id)}
                  title="Forget this - it is wrong"
                  className="opacity-0 group-hover:opacity-100 text-[#8A82A6] hover:text-red-400 transition-all flex-shrink-0"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>

          {proposals.length > 0 && (
            <div className="space-y-1.5 pt-2 border-t border-[#241C3A]/80">
              <div className="flex items-center gap-1.5 font-mono text-[10px]">
                <Wrench className="w-3.5 h-3.5 text-[#F59E0B]" />
                <span className="font-bold tracking-widest text-[#E8E3F5] uppercase">
                  WANTS TO CHANGE HIMSELF
                </span>
              </div>
              <p className="text-[10px] text-[#8A82A6] font-mono italic leading-relaxed">
                Nothing is applied until you say so out loud.
              </p>
              {proposals.map((proposal) => (
                <div
                  key={proposal.id}
                  className="p-1.5 rounded bg-[#07060B]/60 border border-[#241C3A]/40 flex items-start gap-2 group"
                >
                  <div className="flex-1 space-y-0.5">
                    <span className="block text-[11px] font-mono leading-tight text-[#E8E3F5]">
                      {proposal.title}
                    </span>
                    {proposal.evidence && (
                      <span className="block text-[10px] font-mono leading-snug text-[#8A82A6] line-clamp-2">
                        {proposal.evidence}
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => memoryStore.setProposalStatus(proposal.id, 'rejected')}
                    title="Reject"
                    className="opacity-0 group-hover:opacity-100 text-[#8A82A6] hover:text-red-400 transition-all flex-shrink-0"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 4. What B.E.N. remembers between sessions */}
      <div className="rounded-xl border border-[#241C3A] bg-[#0E0C15] p-5 flex flex-col gap-3 shadow-sm">
        <div className="flex items-center justify-between pb-2 border-b border-[#241C3A]/80 font-mono text-[10px]">
          <div className="flex items-center gap-1.5">
            <Brain className="w-3.5 h-3.5 text-[#A855F7]" />
            <span className="font-bold tracking-widest text-[#E8E3F5] uppercase">MEMORY</span>
          </div>
          <span className="text-[#8A82A6] tracking-wider uppercase">
            {memory ? `${memoryCount} ${memoryCount === 1 ? 'ITEM' : 'ITEMS'}` : '...'}
          </span>
        </div>

        {memoryCount === 0 ? (
          <p className="text-[10px] text-[#8A82A6] font-mono italic leading-relaxed">
            Nothing learned yet. Tell B.E.N. about yourself or your projects and he will keep it.
          </p>
        ) : (
          <div className="space-y-2.5 max-h-[190px] overflow-y-auto custom-scrollbar pr-1 font-mono text-[10px]">
            {memory?.profile.name && (
              <div className="text-[#E8E3F5]">
                <span className="text-[#8A82A6]">NAME: </span>
                {memory.profile.name}
              </div>
            )}

            {!!memory?.profile.facts.length && (
              <div className="space-y-1">
                <div className="text-[#8A82A6] tracking-wider uppercase">About you</div>
                {memory.profile.facts.slice(0, 6).map((fact) => (
                  <div
                    key={fact}
                    className="group flex items-start justify-between gap-1.5 p-1.5 rounded bg-[#07060B]/60 border border-[#241C3A]/40"
                  >
                    <span className="text-[#E8E3F5] leading-snug">{fact}</span>
                    <button
                      onClick={() => memoryStore.removeUserFact(fact)}
                      className="opacity-0 group-hover:opacity-100 text-[#8A82A6] hover:text-red-400 p-0.5 transition-opacity flex-shrink-0"
                      title="Forget this"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {!!memory?.projects.length && (
              <div className="space-y-1">
                <div className="text-[#8A82A6] tracking-wider uppercase">Projects</div>
                {memory.projects.slice(0, 5).map((proj) => (
                  <div
                    key={proj.id}
                    className="group flex items-start justify-between gap-1.5 p-1.5 rounded bg-[#07060B]/60 border border-[#241C3A]/40"
                  >
                    <span className="leading-snug">
                      <span className="text-[#C084FC]">{proj.name}</span>
                      {proj.summary ? <span className="text-[#8A82A6]"> — {proj.summary}</span> : null}
                    </span>
                    <button
                      onClick={() => memoryStore.removeProject(proj.name)}
                      className="opacity-0 group-hover:opacity-100 text-[#8A82A6] hover:text-red-400 p-0.5 transition-opacity flex-shrink-0"
                      title="Forget this project"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {!!memory?.notes.length && (
              <div className="space-y-1">
                <div className="text-[#8A82A6] tracking-wider uppercase">Notes</div>
                {memory.notes.slice(0, 5).map((note) => (
                  <div
                    key={note.id}
                    className="group flex items-start justify-between gap-1.5 p-1.5 rounded bg-[#07060B]/60 border border-[#241C3A]/40"
                  >
                    <span className="text-[#E8E3F5] leading-snug">{note.content}</span>
                    <button
                      onClick={() => memoryStore.deleteNote(note.id)}
                      className="opacity-0 group-hover:opacity-100 text-[#8A82A6] hover:text-red-400 p-0.5 transition-opacity flex-shrink-0"
                      title="Forget this note"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 5. Development Workspace (Opencode) */}
      <div className="rounded-xl border border-[#241C3A] bg-[#0E0C15] p-5 flex flex-col gap-3 font-mono text-[10px]">
        <div className="flex items-center justify-between pb-2 border-b border-[#241C3A]/80">
          <div className="flex items-center gap-1.5 text-[#A855F7]">
            <Code2 className="w-3.5 h-3.5" />
            <span className="font-bold tracking-wider uppercase">DEV WORKSPACE</span>
          </div>
          <span
            className={`font-bold ${
              !workspace
                ? 'text-[#8A82A6]'
                : workspace.busy
                ? 'text-[#F59E0B]'
                : workspace.opencodeAvailable
                ? 'text-emerald-400'
                : 'text-red-400'
            }`}
          >
            {!workspace
              ? 'OPENCODE: ...'
              : workspace.busy
              ? 'OPENCODE: BUSY'
              : workspace.opencodeAvailable
              ? 'OPENCODE: READY'
              : 'OPENCODE: NOT FOUND'}
          </span>
        </div>

        <div className="text-[#8A82A6] space-y-1">
          <div className="truncate">
            <span className="text-[#E8E3F5]">PATH: </span>
            <span className={workspace && !workspace.exists ? 'text-red-400' : 'text-[#C084FC]'}>
              {workspace ? workspace.displayPath : 'resolving...'}
              {workspace && !workspace.exists ? ' (missing)' : ''}
            </span>
          </div>
          {/* Which editor opens things. Populated from what is installed on
              this machine, so it says Visual Studio Code on a machine that has
              it and nothing at all on a machine that has no editor - rather
              than naming an application that is not there. */}
          {editors.length > 1 && (
            <div className="flex items-center gap-1.5 pt-1">
              <span className="text-[9px] text-[#8A82A6] uppercase tracking-wider">OPEN WITH</span>
              <select
                value={editor}
                onChange={(e) => setEditor(e.target.value)}
                className="flex-1 bg-[#07060B] border border-[#241C3A] rounded px-1.5 py-0.5 text-[9px] text-[#E8E3F5] focus:border-[#A855F7] focus:outline-none"
              >
                {editors.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="space-y-1 pt-1">
            {projects.length === 0 && (
              <span className="text-[9px] text-[#8A82A6] italic">No projects found.</span>
            )}
            {projects.slice(0, 6).map((p) => (
              <div
                key={p}
                className="group flex items-center gap-1 px-1.5 py-1 rounded bg-[#241C3A]/40 hover:bg-[#241C3A]/70 transition-colors"
              >
                <span className="flex-1 truncate text-[#E8E3F5] text-[9px]">{p}</span>
                {liveUrl && liveUrlProject === p && (
                  <button
                    onClick={() => window.electronAPI?.openUrl?.(liveUrl)}
                    title={`Open ${liveUrl}`}
                    className="p-1 rounded text-[#22D3EE] hover:bg-[#22D3EE]/15 transition-colors"
                  >
                    <Globe className="w-3 h-3" />
                  </button>
                )}
                <button
                  onClick={() => openProject(p, 'editor')}
                  disabled={opening === p}
                  title={editor ? `Open in ${editor}` : 'Open in the code editor'}
                  className="p-1 rounded text-[#8A82A6] hover:text-[#A855F7] hover:bg-[#A855F7]/10 transition-colors disabled:opacity-40"
                >
                  <Code2 className="w-3 h-3" />
                </button>
                <button
                  onClick={() => openProject(p, 'finder')}
                  disabled={opening === p}
                  title="Show the folder"
                  className="p-1 rounded text-[#8A82A6] hover:text-[#E8E3F5] hover:bg-[#241C3A] transition-colors disabled:opacity-40"
                >
                  <FolderOpen className="w-3 h-3" />
                </button>
              </div>
            ))}
            {projects.length > 6 && (
              <span className="text-[9px] text-[#8A82A6]">+{projects.length - 6} more</span>
            )}
          </div>

          {openNote && (
            <p className="text-[9px] text-[#8A82A6] pt-1 leading-snug">{openNote}</p>
          )}
        </div>
      </div>
    </aside>
  );
};
