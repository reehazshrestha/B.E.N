// Desktop Tool definitions and execution engine for Gemini Live Function Calling
import { memoryStore } from './memory-store';
import { backgroundTasks } from './background-tasks';
import { proposalIsApplicable, reflectNow, selfEditEnabled } from './hermes';
import { OpencodeCompletion } from '../types';

// The workspace root lives in the Electron main process. It is cached here so
// tool descriptions and results can name the real directory instead of a path
// hardcoded to one machine.
let workspaceDir = '~/Development';

export async function initToolWorkspace(): Promise<string> {
  try {
    const info = await window.electronAPI?.getWorkspaceInfo?.();
    if (info?.directory) workspaceDir = info.directory;
  } catch (e) {
    // Keep the placeholder; tools still work, the model just sees a generic path.
  }
  return workspaceDir;
}

export function getWorkspaceDir(): string {
  return workspaceDir;
}

// Catalogue of installed skills, cached so it can go into the system prompt
// without a round trip mid-conversation.
let skillCatalogue: Array<{ id: string; name: string; description: string }> = [];

export async function initSkillCatalogue(): Promise<number> {
  try {
    const res = await window.electronAPI?.listSkills?.();
    skillCatalogue = (res?.skills || []).map((sk) => ({
      id: sk.id,
      name: sk.name,
      description: sk.description
    }));
  } catch (e) {
    skillCatalogue = [];
  }
  return skillCatalogue.length;
}

// A compact index. The full text of a skill is fetched on demand via use_skill,
// so the prompt carries only enough to choose one.
export function getSkillCatalogueText(): string {
  if (!skillCatalogue.length) return '';
  const lines = skillCatalogue.map((sk) => `- ${sk.name}: ${sk.description}`);
  return `\nInstalled skill playbooks (load with use_skill):\n${lines.join('\n')}\n`;
}

export interface ToolDeclaration {
  functionDeclarations: Array<{
    name: string;
    description: string;
    parameters: {
      type: 'OBJECT';
      properties: Record<string, {
        type: 'STRING' | 'NUMBER' | 'BOOLEAN' | 'INTEGER' | 'ARRAY' | 'OBJECT';
        description: string;
        enum?: string[];
        // Required by the schema whenever type is ARRAY.
        items?: { type: 'STRING' | 'NUMBER' | 'BOOLEAN' | 'INTEGER' | 'OBJECT' };
      }>;
      required?: string[];
    };
  }>;
}

// Registered only when self-editing is switched on
// (`localStorage.setItem('ben_hermes_self_edit', '1')`). B.E.N.'s own source
// sits inside the workspace sandbox and opencode runs with `--auto`, so a tool
// that can approve a change to it is a tool that can rewrite the running app.
// Off by default, and even on, nothing applies without the user saying so.
const SELF_EDIT_TOOLS: ToolDeclaration['functionDeclarations'] = [
  {
    name: 'list_self_improvements',
    description:
      'List the changes to your own code that you have proposed after reviewing your ' +
      'mistakes, so the user can decide about them. Read them out as a short numbered list ' +
      'with the reason for each. Nothing has been changed and nothing will be until they say ' +
      'so explicitly.',
    parameters: { type: 'OBJECT', properties: {} }
  },
  {
    name: 'apply_self_improvement',
    description:
      'Start a build that changes your own source code, using one of the proposals from ' +
      'list_self_improvements. Call this ONLY after the user has heard what the proposal is ' +
      'and has clearly agreed to that specific one - never on your own initiative, never to ' +
      '"tidy up", and never because a proposal looks sensible to you. It edits the ' +
      'application the user is currently talking to, which will need restarting afterwards. ' +
      'If they have not been told what it does, describe it and ask first.',
    parameters: {
      type: 'OBJECT',
      properties: {
        id: {
          type: 'STRING',
          description: 'The id of the proposal the user agreed to, from list_self_improvements.'
        }
      },
      required: ['id']
    }
  }
];

// Lessons are appended to the description of the tool they are about.
//
// Descriptions here are load-bearing - one sentence in run_project_command once
// turned "write a plan in the dev folder" into a dev server - so text a model
// wrote about them is capped, marked as learned rather than as a rule from the
// author, and listable and deletable by voice.
function applyLessons(declaration: ToolDeclaration): ToolDeclaration {
  return {
    functionDeclarations: declaration.functionDeclarations.map((fn) => {
      const lessons = memoryStore.lessonsForTool(fn.name);
      if (!lessons.length) return fn;
      const note = lessons.map((lesson) => lesson.lesson.replace(/\s+/g, ' ').trim()).join(' ');
      return { ...fn, description: `${fn.description} Learned from experience: ${note}` };
    })
  };
}

export function buildJarvisTools(): ToolDeclaration {
  const declaration: ToolDeclaration = {
  functionDeclarations: [
    {
      name: 'run_opencode_task',
      description: `Execute the opencode autonomous development agent in the user's Development workspace (${workspaceDir}) to build a project, write code, install packages, or fix bugs. The build runs in the background and can take several minutes; this returns as soon as it has started and you will be told separately when it finishes, so do not call it again for the same project while it is running.`,
      parameters: {
        type: 'OBJECT',
        properties: {
          prompt: {
            type: 'STRING',
            description:
              'The full specification the coding agent works from - not the sentence the user said. ' +
              'It cannot ask them anything, so anything you leave out it invents: state the purpose, ' +
              'the pages or features, the real content, the look and the stack. For work on an ' +
              'existing project, say what to change and where.'
          },
          briefConfirmed: {
            type: 'BOOLEAN',
            description:
              'Set true only once the user has answered your questions about what to build, or has ' +
              'told you to go ahead without them. Never set it on a first call for something that ' +
              'does not exist yet.'
          },
          projectName: {
            type: 'STRING',
            description: `Optional subfolder project directory inside ${workspaceDir} (e.g., "BEN", "my-app", "portfolio").`
          },
          skills: {
            type: 'ARRAY',
            description:
              'Skill names whose instructions should be handed to the coding agent, e.g. ["ponytail", "karpathy-guidelines"]. Use list_skills to see what is available.',
            items: { type: 'STRING' }
          }
        },
        required: ['prompt']
      }
    },
    {
      name: 'research_in_background',
      description:
        'Look something up without making the user wait. Use this when a question needs real ' +
        'research rather than a quick answer, or when you catch yourself about to say "let me ' +
        'check and get back to you" - this is what makes that promise real. Returns immediately; ' +
        'the answer is delivered to you later and you tell the user then. Do NOT use it for ' +
        'something you already know, and do NOT answer the question yourself after calling it.',
      parameters: {
        type: 'OBJECT',
        properties: {
          question: {
            type: 'STRING',
            description:
              'The question to research, written out in full as a standalone question - it is ' +
              'answered without any of this conversation for context.'
          }
        },
        required: ['question']
      }
    },
    {
      name: 'list_development_projects',
      description: `List all project folders in the ${workspaceDir} directory.`,
      parameters: {
        type: 'OBJECT',
        properties: {}
      }
    },
    {
      name: 'create_task',
      description: 'Add a new pending directive or task to the uncompleted task list and system memory.',
      parameters: {
        type: 'OBJECT',
        properties: {
          title: {
            type: 'STRING',
            description: 'The task description or directive to track.'
          },
          project: {
            type: 'STRING',
            description: 'Optional project name associated with the task.'
          }
        },
        required: ['title']
      }
    },
    {
      name: 'complete_task',
      description: 'Mark a task in the directives list as completed.',
      parameters: {
        type: 'OBJECT',
        properties: {
          taskTitleOrId: {
            type: 'STRING',
            description: 'The task ID or keywords from the task title to mark complete.'
          }
        },
        required: ['taskTitleOrId']
      }
    },
    {
      name: 'list_uncompleted_tasks',
      description: 'Retrieve the list of current active and uncompleted directives/tasks.',
      parameters: {
        type: 'OBJECT',
        properties: {}
      }
    },
    {
      name: 'save_memory_note',
      description: 'Save important context, user preferences, or knowledge into long-term memory.',
      parameters: {
        type: 'OBJECT',
        properties: {
          content: {
            type: 'STRING',
            description: 'The information or preference to remember.'
          },
          category: {
            type: 'STRING',
            description: 'Category of note: "preference", "project", "directive", or "general".',
            enum: ['preference', 'project', 'directive', 'general']
          }
        },
        required: ['content']
      }
    },
    {
      name: 'remember_about_user',
      description:
        "Save a durable fact about the user to long-term memory: their name, role, what they are building, tools they prefer, how they like to be spoken to. Call this whenever the user tells you something about themselves that should still be true next week. Do not use it for one-off requests.",
      parameters: {
        type: 'OBJECT',
        properties: {
          fact: {
            type: 'STRING',
            description: 'One self-contained fact, e.g. "Prefers TypeScript over Python for new services".'
          },
          name: {
            type: 'STRING',
            description: "Optionally set or correct the user's name."
          }
        },
        required: ['fact']
      }
    },
    {
      name: 'remember_project',
      description:
        'Record or update what you know about one of the user\'s projects: what it is, its stack, its current state. Call this after working on or discussing a project so you can recall it in a later conversation.',
      parameters: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING', description: 'Project name, matching the folder name where possible.' },
          summary: {
            type: 'STRING',
            description: 'What the project is and where it currently stands, in one or two sentences.'
          }
        },
        required: ['name', 'summary']
      }
    },
    {
      name: 'recall_memory',
      description:
        'Read back everything you have stored about the user, their projects, notes and earlier conversations. Call this when asked what you remember, who the user is, or what you worked on previously.',
      parameters: { type: 'OBJECT', properties: {} }
    },
    {
      name: 'forget_memory',
      description:
        'Remove something from long-term memory when the user says it is wrong or asks you to forget it.',
      parameters: {
        type: 'OBJECT',
        properties: {
          match: { type: 'STRING', description: 'Text identifying the fact, note or project to drop.' }
        },
        required: ['match']
      }
    },
    {
      name: 'get_system_metrics',
      description: 'Retrieve live system performance metrics including CPU usage, memory consumption, battery level, and uptime.',
      parameters: {
        type: 'OBJECT',
        properties: {}
      }
    },
    {
      name: 'open_application',
      description: 'Launch or switch to a desktop application by name (e.g., Google Chrome, Spotify, Antigravity, Terminal, Notes, Calculator, Finder). The name is matched against what is actually installed on this Mac; if it is not installed the result says so, and you must tell the user it did not open rather than claiming it did.',
      parameters: {
        type: 'OBJECT',
        properties: {
          appName: {
            type: 'STRING',
            description: 'The name of the application to launch (e.g. "Google Chrome", "Spotify", "Terminal", "Visual Studio Code", "Notes", "Calculator").'
          }
        },
        required: ['appName']
      }
    },
    {
      name: 'open_web_url',
      description:
        'Open a website in the user\'s default browser. Only call this when the user explicitly asks to ' +
        'open, show, visit or pull up a site ("open YouTube", "pull up the Electron docs"). This is NOT a ' +
        'search tool and NOT a way to answer a question: you can search the web yourself and should say ' +
        'the answer out loud instead. Launching a browser takes over the user\'s screen, so never call it ' +
        'uninvited, and never to show them search results.',
      parameters: {
        type: 'OBJECT',
        properties: {
          url: {
            type: 'STRING',
            description:
              'The full URL of the site the user asked to open (e.g. "https://news.ycombinator.com").'
          }
        },
        required: ['url']
      }
    },
    {
      name: 'get_current_time_date',
      description: 'Get the exact current local time, date, day of the week, and timezone.',
      parameters: {
        type: 'OBJECT',
        properties: {}
      }
    },
    {
      name: 'list_skills',
      description:
        'List the installed skill playbooks for planning and coding. Each one is a written method for a specific kind of work (brainstorming a design, writing a plan, keeping a solution minimal, reviewing code, avoiding common LLM coding mistakes). Call this when you are unsure which skill fits the task.',
      parameters: { type: 'OBJECT', properties: {} }
    },
    {
      name: 'use_skill',
      description:
        'Load the full text of a skill playbook and follow it. Call this BEFORE planning a feature, designing something, or writing code, so you work to the method rather than improvising. You may load more than one.',
      parameters: {
        type: 'OBJECT',
        properties: {
          name: {
            type: 'STRING',
            description: 'Skill name or id, e.g. "brainstorming", "writing-plans", "ponytail", "karpathy-guidelines".'
          }
        },
        required: ['name']
      }
    },
    {
      name: 'write_file',
      description: `Write or overwrite a text file inside the workspace (${workspaceDir}). Use this for plans, notes, documents, READMEs, code snippets - anything the user asks you to "write down", "save", "put in a file", or "write in the dev folder". Writing a file never runs or starts anything.`,
      parameters: {
        type: 'OBJECT',
        properties: {
          path: {
            type: 'STRING',
            description: `Path relative to ${workspaceDir}, including the filename and extension, e.g. "plans/launch-plan.md" or "BEN/notes.md". Use a .md extension for plans, notes and documents, and the proper source extension for code - the extension decides which application it opens in later.`
          },
          content: { type: 'STRING', description: 'The full text to write into the file.' },
          append: {
            type: 'BOOLEAN',
            description: 'Set true to add to the end of an existing file instead of replacing it.'
          }
        },
        required: ['path', 'content']
      }
    },
    {
      name: 'read_file',
      description: `Read back a text file from the workspace (${workspaceDir}).`,
      parameters: {
        type: 'OBJECT',
        properties: {
          path: { type: 'STRING', description: `Path relative to ${workspaceDir}.` }
        },
        required: ['path']
      }
    },
    {
      name: 'list_folder',
      description: `List the files and folders at a path inside the workspace (${workspaceDir}). Use this to see what is in the Development folder or any project inside it.`,
      parameters: {
        type: 'OBJECT',
        properties: {
          path: {
            type: 'STRING',
            description: `Path relative to ${workspaceDir}. Omit or pass "" for the workspace root.`
          }
        }
      }
    },
    {
      name: 'create_folder',
      description: `Create a new folder inside the workspace (${workspaceDir}).`,
      parameters: {
        type: 'OBJECT',
        properties: {
          path: { type: 'STRING', description: `Folder path relative to ${workspaceDir}.` }
        },
        required: ['path']
      }
    },
    {
      name: 'open_path',
      description: `Open a file or folder from the workspace (${workspaceDir}) so the user can see it. Use this whenever the user says "open it", "show me", or "open that file" after something has been written. It opens the file itself and never runs or starts a project. Leave mode unset: notes, plans and other documents go to the notes app, code and project folders go to the code editor, automatically.`,
      parameters: {
        type: 'OBJECT',
        properties: {
          path: { type: 'STRING', description: `Path relative to ${workspaceDir}.` },
          app: {
            type: 'STRING',
            description:
              'The application the user named, exactly as they said it ("Antigravity", "Cursor", "VS Code", "Zed"). Set this whenever they name one. The result reports which application actually opened it, and says so if that one is not installed - never announce an application this tool did not name back to you.'
          },
          mode: {
            type: 'STRING',
            description:
              'Only set this if the user asks for a kind of app rather than naming one. "auto" (default) routes documents to the notes app and code to the code editor. "notes" forces the notes app, "editor" forces the machine\'s code editor, "finder" reveals it in Finder, "default" uses the system default app.',
            enum: ['auto', 'notes', 'editor', 'finder', 'default']
          }
        },
        required: ['path']
      }
    },
    {
      name: 'run_project_command',
      description: `Run a project inside ${workspaceDir}/<projectName>: its dev server, its script, or a specific shell command. Call it when the user asks to run, start, launch, serve, build, install or test something, and after you have built something for them and they ask to see it working. A web project's address is detected and opened in the browser for you; anything else runs in the console on screen, which the user can type into if the program asks a question. ONLY call this when the user explicitly asks to run, start, launch, serve, build, install or test something. "The dev folder", "the Development folder" and "write it in dev" refer to the ${workspaceDir} directory and are NOT requests to run anything - use write_file, list_folder or open_path for those. Never call this to create or open a file, and never restart a process the user has just cancelled unless they ask for it again in so many words.`,
      parameters: {
        type: 'OBJECT',
        properties: {
          projectName: {
            type: 'STRING',
            description: `The project folder name in ${workspaceDir} (e.g., "chat-interface", "BEN", "portfolio").`
          },
          command: {
            type: 'STRING',
            description: 'Optional specific shell command to run (e.g. "npm run dev", "npm start", "npm test", "npm install"). If omitted, B.E.N. auto-detects the startup script from package.json.'
          }
        },
        required: ['projectName']
      }
    },
    {
      name: 'open_project_in_editor',
      description: `Open a whole project folder from ${workspaceDir} in a code editor or in Finder. For a single file, use open_path instead. The editor is whichever one is installed on this Mac unless the user names one.`,
      parameters: {
        type: 'OBJECT',
        properties: {
          projectName: {
            type: 'STRING',
            description: `The project folder name in ${workspaceDir}.`
          },
          editor: {
            type: 'STRING',
            description:
              'Leave unset for the machine\'s code editor. Pass the application name the user said ("Antigravity", "Cursor", "Zed", "VS Code") when they name one, or "finder" to reveal it in Finder.'
          }
        },
        required: ['projectName']
      }
    },
    {
      name: 'close_application',
      description: 'Close, quit, or terminate a desktop application (e.g., "Calculator", "Visual Studio Code", "Google Chrome", "Spotify", "Terminal", "Finder"). Call this whenever the user says "close the app", "close Calculator", "close Chrome", "quit VS Code", or "close what you opened".',
      parameters: {
        type: 'OBJECT',
        properties: {
          appName: {
            type: 'STRING',
            description: 'The name of the desktop application to close (e.g., "Calculator", "Google Chrome", "Visual Studio Code", "Spotify", "Terminal", "Finder").'
          }
        },
        required: ['appName']
      }
    },
    {
      name: 'stop_running_process',
      description: 'Stop the active dev server, background project runtime, or opencode build session. Call this when the user says "stop", "cancel", "kill it", or "close what you started". Once stopped, leave it stopped: do not call run_project_command or run_opencode_task again afterwards unless the user explicitly asks you to start it up again.',
      parameters: {
        type: 'OBJECT',
        properties: {}
      }
    },
    {
      name: 'check_background_work',
      description:
        'Check what is actually running right now - an autonomous build, a dev server, a ' +
        'research question - and what finished recently. Call this BEFORE saying anything about ' +
        'the state of a build or a process: whether it is still going, whether it finished, ' +
        'whether it was stopped. Never answer those from memory or from what you said earlier; ' +
        'a build takes minutes and nothing tells you when it ends except this and the ' +
        'announcement you are given. If it says a build is running, it is running, however long ' +
        'ago it started.',
      parameters: { type: 'OBJECT', properties: {} }
    },
    {
      name: 'inspect_screen',
      description:
        'Look at what is on the user\'s screen right now. Call this ONLY when the user asks you ' +
        'to look, or asks a question that cannot be answered without seeing their screen ("what ' +
        'am I looking at", "what does this error say", "read this to me"). Never call it to check ' +
        'on the user, never out of curiosity, and never twice for one question - it captures ' +
        'whatever they happen to have open, including private things. Do call it again every ' +
        'time they ask again: an image from earlier in the conversation is a picture of the ' +
        'past, not of their screen now. If they named a particular app or window, ' +
        'pass it as target; if they said "my screen" or named nothing, leave target out and the ' +
        'whole desktop is captured. The image is attached to the conversation; describe what you ' +
        'actually see, briefly, and never guess at content you cannot make out.',
      parameters: {
        type: 'OBJECT',
        properties: {
          target: {
            type: 'STRING',
            description:
              'The app or window to look at, as the user named it ("Chrome", "the terminal", ' +
              '"VS Code"). Omit, or use "screen", for the whole desktop.'
          }
        }
      }
    },
    {
      name: 'list_lessons_learned',
      description:
        'Read back the lessons you have drawn from your own past mistakes. Call this when the ' +
        'user asks what you have learned, why you keep doing something, or what you know about ' +
        'your own behaviour. It reads a stored list; it does not think about anything new.',
      parameters: { type: 'OBJECT', properties: {} }
    },
    {
      name: 'forget_lesson',
      description:
        'Delete a lesson you had drawn about your own behaviour, because the user says it is ' +
        'wrong. These lessons were written automatically from what went wrong before, so some ' +
        'of them will be wrong. Call this whenever the user tells you a rule you are following ' +
        'is mistaken. Match on a few distinctive words of the lesson, or on the tool name.',
      parameters: {
        type: 'OBJECT',
        properties: {
          match: {
            type: 'STRING',
            description: 'Words from the lesson to delete, or the name of the tool it is about.'
          }
        },
        required: ['match']
      }
    },
    {
      name: 'review_own_performance',
      description:
        'Look back over your recent tool calls and work out what went wrong and what to do ' +
        'differently. Call this only when the user asks you to review yourself, to learn from ' +
        'something, or asks why a tool keeps failing. It takes a few seconds and it does not ' +
        'change anything on the machine - it only writes lessons for yourself. It happens on ' +
        'its own after a session and after repeated failures, so do not call it routinely.',
      parameters: { type: 'OBJECT', properties: {} }
    }
    ]
  };

  if (selfEditEnabled()) declaration.functionDeclarations.push(...SELF_EDIT_TOOLS);
  return applyLessons(declaration);
}

// Active build state & duplicate build tracker
let currentActiveBuildProject: string | null = null;
// Lets a bare "open it" resolve to the file that was just written.
let lastWrittenPath = '';
const recentlyCompletedBuilds = new Map<string, { timestamp: number; summary: string }>();

// The build runs in the background, so the lock is released by the completion
// broadcast rather than by the tool call returning. Without this the lock would
// stay set for the whole life of the app after the first build.
// Where a captured screenshot is delivered. Set by the live client, because
// only it holds the socket the image has to travel down.
let screenFrameSink: ((jpegBase64: string) => boolean) | null = null;

export function setScreenFrameSink(sink: ((jpegBase64: string) => boolean) | null) {
  screenFrameSink = sink;
}

// The background researcher runs outside the live session, so it needs its own
// copy of whichever key is currently active.
let backgroundApiKey = '';

export function setBackgroundApiKey(key: string) {
  backgroundApiKey = key || '';
}

let buildCompletionListener: ((result: OpencodeCompletion) => void) | null = null;
let buildCompletionUnsub: (() => void) | null = null;

export function setBuildCompletionListener(cb: ((result: OpencodeCompletion) => void) | null) {
  buildCompletionListener = cb;
  if (!cb || buildCompletionUnsub || !window.electronAPI?.onOpencodeComplete) return;
  buildCompletionUnsub = window.electronAPI.onOpencodeComplete((result) => {
    if (!currentActiveBuildProject || currentActiveBuildProject === result.projectName) {
      currentActiveBuildProject = null;
    }
    if (result.success) {
      recentlyCompletedBuilds.set(result.projectName, {
        timestamp: Date.now(),
        summary: `Completed build for ${result.projectName}`
      });
    }
    console.log(
      `[Opencode] build finished: ${result.projectName} ` +
        `(${result.cancelled ? 'cancelled' : result.success ? 'success' : 'failed'})`
    );
    buildCompletionListener?.(result);
  });
}

function extractProjectName(prompt: string, explicitName?: string): string {
  if (explicitName && explicitName.trim()) {
    return explicitName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  }
  // Match "in <folder> folder", "in <folder> directory", "inside <folder>", "build <folder>"
  const folderMatch = prompt.match(/(?:in|inside|into)\s+(?:the\s+)?([a-zA-Z0-9_-]+)(?:\s+(?:folder|directory|project|repo|dir))?/i);
  if (folderMatch && folderMatch[1] && folderMatch[1].toLowerCase() !== 'development' && folderMatch[1].toLowerCase() !== 'ben') {
    return folderMatch[1].toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  }
  const projectMatch = prompt.match(/(?:project|app|for|called|named)\s+([a-zA-Z0-9_-]{3,25})/i);
  if (projectMatch && projectMatch[1] && projectMatch[1].toLowerCase() !== 'development' && projectMatch[1].toLowerCase() !== 'ben') {
    return projectMatch[1].toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  }
  return 'project-' + Math.random().toString(36).substring(2, 7);
}

// --- The build brief ---------------------------------------------------------
// "Build me a portfolio" used to reach opencode verbatim, which then invented
// the stack, the sections, the content and the look, and the user found out
// what they were getting when it finished. A category name is not a
// specification: the gate below stops the build once, hands back the questions
// worth asking and a default worth agreeing to, and lets it through as soon as
// the brief actually says what to build.
const BUILD_VERBS = /\b(build|create|make|scaffold|set ?up|start|generate|design|write) (me )?(a|an|the|my)\b/i;

// Signals that the prompt describes the thing rather than naming its category.
function briefSignals(prompt: string): string[] {
  const p = prompt.toLowerCase();
  const found: string[] = [];
  if (/\b(react|next\.?js|vite|vue|svelte|astro|remix|html|tailwind|css|node|express|fastapi|flask|django|rails|typescript|javascript|python|static site)\b/.test(p)) {
    found.push('stack');
  }
  if (/\b(page|pages|section|sections|hero|about|contact|projects|gallery|blog|resume|cv|nav|navbar|footer|form|dashboard|login|checkout|cards?|posts?|endpoints?|routes?|levels?)\b/.test(p)) {
    found.push('content');
  }
  if (/\b(dark|light|minimal|brutalist|colou?rs?|palette|theme|fonts?|typography|animated|animations?|styled?|modern|retro|glass|gradient|serif)\b/.test(p)) {
    found.push('style');
  }
  if (/\b(responsive|mobile|accessible|a11y|seo|deploy|hosting|cms|database|auth|api key|tests?)\b/.test(p)) {
    found.push('requirements');
  }
  return found;
}

// What B.E.N. already knows these things normally contain, so he proposes a
// build rather than making the user design one out loud.
const BRIEF_PLAYBOOK: Array<{
  match: RegExp;
  kind: string;
  questions: string[];
  proposal: string;
}> = [
  {
    match: /\b(portfolio|personal site|personal website|my site)\b/i,
    kind: 'portfolio',
    questions: [
      'What do you want it to say you do - the role and the one-line pitch?',
      'Which projects go on it, and do you have links, repos or screenshots for them?',
      'Anything else it needs: an about section, a CV to download, contact links?',
      'How should it look, and is there a stack you want it built in?'
    ],
    proposal:
      'a single-page Vite + React + Tailwind site: a hero with your name, role and one-line pitch, ' +
      'a projects grid, a short about, and a contact section with email and GitHub. Dark, minimal, ' +
      'responsive, with your real content rather than lorem ipsum.'
  },
  {
    match: /\b(landing page|marketing site|product page|waitlist)\b/i,
    kind: 'landing page',
    questions: [
      'What is the product, and who is it for?',
      'What is the one action the page should get - a signup, a purchase, a demo booking?',
      'What proof goes on it: features, pricing, testimonials, screenshots?',
      'Do you have brand colours, a logo and copy, or should I draft them?'
    ],
    proposal:
      'a Vite + React + Tailwind landing page: hero with the pitch and a call to action, a features ' +
      'row, a pricing or proof section, an FAQ and a footer, responsive, with the signup wired to a ' +
      'form you can point at a service later.'
  },
  {
    match: /\b(dashboard|admin panel|analytics|crm)\b/i,
    kind: 'dashboard',
    questions: [
      'What data is it showing, and where does it come from?',
      'Which views does it need, and who logs into it?',
      'Does it need live updates, or is a refresh enough?',
      'Any stack or component library you want it built on?'
    ],
    proposal:
      'a React + Tailwind dashboard with a sidebar, an overview page of stat tiles and a chart, a ' +
      'table view with filtering, and a mocked data layer behind one module so a real API drops in later.'
  },
  {
    match: /\b(blog|newsletter site|docs site|documentation site)\b/i,
    kind: 'blog',
    questions: [
      'What are you writing about, and how often?',
      'Do posts come from markdown files in the repo, or a CMS?',
      'Does it need tags, search, an RSS feed, comments?',
      'Any look or stack you have in mind?'
    ],
    proposal:
      'an Astro site reading markdown posts from the repo: index with excerpts, a post page with ' +
      'typography styles, tags, an RSS feed, and a sample post so you can see the shape.'
  },
  {
    match: /\b(api|backend|server|microservice|endpoints?)\b/i,
    kind: 'API',
    questions: [
      'What does it serve, and what calls it?',
      'Which endpoints does it need, and what does the data look like?',
      'Where is the data stored, and does it need authentication?',
      'Language and framework preference?'
    ],
    proposal:
      'a TypeScript Express service with typed routes, request validation, an in-memory store behind ' +
      'a repository interface, error handling and a README of the endpoints.'
  },
  {
    match: /\b(game|arcade|puzzle)\b/i,
    kind: 'game',
    questions: [
      'What is the game, in one sentence of how it plays?',
      'What does the player control, and how do they win or lose?',
      'Browser or desktop, and what should it look like?'
    ],
    proposal:
      'a browser game on an HTML canvas in TypeScript: game loop, keyboard controls, score and a ' +
      'restart screen, no build step beyond Vite.'
  },
  {
    match: /\b(app|tool|website|site|clone|extension|script)\b/i,
    kind: 'app',
    questions: [
      'What should it do, and who uses it?',
      'What are the two or three screens or commands it needs?',
      'Does it store anything, and where?',
      'Any stack you want it built in?'
    ],
    proposal: ''
  }
];

function briefPlaybookFor(prompt: string) {
  return BRIEF_PLAYBOOK.find((entry) => entry.match.test(prompt));
}

export async function executeJarvisTool(name: string, args: Record<string, any>): Promise<any> {
  console.log(`[B.E.N. Tool] Executing: ${name}`, args);

  switch (name) {
    case 'run_opencode_task': {
      const userPrompt = args.prompt || '';
      const targetProject = extractProjectName(userPrompt, args.projectName);
      const targetDir = `${workspaceDir}/${targetProject}`;

      // 0. Brief check. Only for something that does not exist yet: work on a
      //    project already on disk has the code itself as its specification,
      //    and stopping to ask about it would be an interrogation.
      const playbook = briefPlaybookFor(userPrompt);
      const looksLikeNewBuild = BUILD_VERBS.test(userPrompt) && !!playbook;
      if (looksLikeNewBuild && !args.briefConfirmed) {
        const specified = userPrompt.trim().length >= 160 && briefSignals(userPrompt).length >= 2;
        let existsAlready = false;
        if (window.electronAPI?.listDevelopmentProjects) {
          try {
            const projects = await window.electronAPI.listDevelopmentProjects();
            existsAlready = projects.some((p) => p.toLowerCase() === targetProject.toLowerCase());
          } catch {
            // Not being able to list projects is no reason to skip the brief.
          }
        }
        if (!specified && !existsAlready) {
          return {
            status: 'needs_brief',
            kind: playbook.kind,
            summary: 'Nothing has been built. The brief does not yet say what to build.',
            askFirst: playbook.questions,
            proposedDefault: playbook.proposal || undefined,
            instruction:
              'Do not start the build and do not say you have started one. Ask the user about this, ' +
              'two short questions at a time, out loud - and if there is a proposedDefault, offer it ' +
              'first as the thing they can simply agree to, since you already know what one of these ' +
              'normally contains. When they have answered, say back in one sentence what you are ' +
              'about to build, then call run_opencode_task again with briefConfirmed true and their ' +
              'answers written into prompt as a full specification. The coding agent cannot ask them ' +
              'anything, so whatever is missing from that prompt it will invent.'
          };
        }
      }

      // 1. Concurrency Check: If already building a project right now, tell user and halt!
      if (currentActiveBuildProject) {
        console.warn(`[Opencode Lock] Build already in progress for: ${currentActiveBuildProject}`);
        return {
          status: 'already_running',
          summary: `Sir, an autonomous build is currently in progress for project '${currentActiveBuildProject}'. Please wait until it completes.`,
          directory: `${workspaceDir}/${currentActiveBuildProject}`
        };
      }

      // 2. Duplicate Check: If this project was built in the last 3 minutes, prevent redundant build!
      const recent = recentlyCompletedBuilds.get(targetProject);
      if (recent && Date.now() - recent.timestamp < 180000) {
        console.warn(`[Opencode Duplicate] Project ${targetProject} was already built recently.`);
        return {
          status: 'already_completed',
          summary: `Sir, project '${targetProject}' has already been built and is complete in ${targetDir}. No rebuild is necessary.`,
          directory: targetDir
        };
      }

      // Set active lock
      currentActiveBuildProject = targetProject;

      // Skill playbooks travel with the task, so the coding agent works to the
      // same method B.E.N. planned with.
      let skillBriefing = '';
      const requestedSkills: string[] = Array.isArray(args.skills) ? args.skills : [];
      if (requestedSkills.length && window.electronAPI?.readSkill) {
        const loaded: string[] = [];
        for (const skillName of requestedSkills.slice(0, 3)) {
          const skill = await window.electronAPI.readSkill({ id: skillName });
          if (skill.found && skill.content) {
            loaded.push(`--- SKILL: ${skill.id} ---\n${skill.content}`);
          }
        }
        if (loaded.length) {
          skillBriefing = `\n\nApply the following engineering playbooks throughout this task:\n\n${loaded.join('\n\n')}\n`;
        }
      }

      // Professional developer-level prompt expansion for robust building
      const professionalPrompt = `You are a Principal Full-Stack Software Engineer.
Target Project Directory: ${targetDir}
Task: Build a clean, complete, production-ready implementation of: ${userPrompt}.

Strict Execution Rules:
1. Isolated Workspace: You must create and modify files ONLY within ${targetDir}. Do NOT touch or modify parent directories.
2. File Structure: Create all required source files, components, configurations (package.json, tsconfig, etc.), and assets in ${targetDir}.
3. Production Quality: Implement fully working components, clean architecture, responsive layout, and modern styling. Do NOT leave TODOs or stub functions.
4. Error-Free: Ensure all code is syntax-valid and ready to run.
5. Dependencies: Install or declare any necessary packages.${skillBriefing}`;

      // The register is keyed by project: the completion broadcast names the
      // project and nothing else, so that is what has to match.
      const buildTaskId = `build:${targetProject}`;
      // Repairing something that exists is not building something new, and the
      // readout on the deck is what the user reads to know which is happening.
      const isRepair = /\b(fix|fixes|fixing|repair|debug|resolve|patch|broken|error|bug)\b/i.test(
        userPrompt
      );
      backgroundTasks.start({
        id: buildTaskId,
        kind: isRepair ? 'fix' : 'build',
        label: targetProject
      });

      try {
        if (!window.electronAPI?.runOpencode) {
          currentActiveBuildProject = null;
          backgroundTasks.finish(buildTaskId, {
            status: 'failed',
            result: 'The desktop bridge is not available.'
          });
          return {
            status: 'unavailable',
            doNotRetry: true,
            error: 'The desktop bridge is not available, so opencode cannot be started from here.'
          };
        }

        const res = await window.electronAPI.runOpencode({
          prompt: professionalPrompt,
          projectName: targetProject
        });


        if (!res.success) {
          currentActiveBuildProject = null;
          backgroundTasks.finish(buildTaskId, { status: 'failed', result: res.error });
          return {
            status: 'failed',
            doNotRetry: true,
            directory: res.directory || targetDir,
            summary: `The autonomous build could not be started: ${res.error}`
          };
        }

        // Returning here rather than awaiting the whole build is deliberate: a
        // build runs for minutes, and blocking the tool call blocked every
        // incoming server message with it, so B.E.N. went deaf until it ended.
        // The outcome arrives on the completion broadcast and is announced then.
        return {
          status: 'started',
          directory: res.directory || targetDir,
          projectName: targetProject,
          summary: `The autonomous build for '${targetProject}' is now running in the background in ${res.directory || targetDir}.`,
          instruction:
            'Tell the user the build has started, in one short sentence, and then stop. You will be told ' +
            'when it finishes. Do not call this tool again for this project, do not start a server, and ' +
            'do not run any command while it is running.'
        };
      } catch (err: any) {
        currentActiveBuildProject = null;
        backgroundTasks.finish(buildTaskId, { status: 'failed', result: err?.message });
        throw err;
      }
    }

    case 'research_in_background': {
      const question = (args.question || '').trim();
      if (!question) {
        return { status: 'failed', doNotRetry: true, error: 'No question was supplied.' };
      }
      if (!window.electronAPI?.startBackgroundTask) {
        return { status: 'unavailable', doNotRetry: true, error: 'The desktop bridge is not available.' };
      }

      const id = 'bg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      backgroundTasks.start({ id, kind: 'research', label: question });

      const res = await window.electronAPI.startBackgroundTask({
        id,
        question,
        apiKey: backgroundApiKey
      });

      if (!res.success) {
        backgroundTasks.finish(id, { status: 'failed', result: res.error });
        return { status: 'failed', doNotRetry: true, error: res.error };
      }

      return {
        status: 'started',
        id,
        summary: `Researching "${question}" in the background.`,
        instruction:
          'Tell the user you are looking into it, in one short sentence, and then stop. Do not ' +
          'guess at the answer and do not call this again for the same question: you will be ' +
          'given the answer when it is ready and you will tell them then.'
      };
    }

    case 'list_lessons_learned': {
      const lessons = memoryStore.getLessons();
      return {
        count: lessons.length,
        lessons: lessons.map((lesson) => ({
          id: lesson.id,
          about: lesson.tool || 'general',
          lesson: lesson.lesson,
          learnedFrom: lesson.evidence
        })),
        instruction: lessons.length
          ? 'Say these back in your own words, briefly. If the user says one of them is wrong, ' +
            'call forget_lesson with a few words of it.'
          : 'Say that you have not had to learn anything from a mistake yet.'
      };
    }

    case 'forget_lesson': {
      const match = (args.match || '').trim();
      if (!match) {
        return { status: 'failed', doNotRetry: true, error: 'Nothing was named to forget.' };
      }
      const { removed } = memoryStore.forgetLesson(match);
      return removed
        ? { status: 'ok', removed, summary: `Forgot ${removed} lesson(s) matching "${match}".` }
        : {
            status: 'not_found',
            doNotRetry: true,
            summary: `Nothing matching "${match}" was in the lessons.`,
            instruction: 'Tell the user you are not following any rule like that.'
          };
    }

    case 'review_own_performance': {
      const outcome = await reflectNow('the user asked for a review');
      if (!outcome.lessons && !outcome.proposals) {
        return {
          status: 'ok',
          learned: 0,
          summary: 'Nothing new came out of the review.',
          instruction:
            'Say plainly that you looked back over what you have done and found nothing worth ' +
            'changing. Do not invent a lesson to have something to report.'
        };
      }
      return {
        status: 'ok',
        learned: outcome.lessons,
        proposed: outcome.proposals,
        lessons: memoryStore.getLessons().slice(0, outcome.lessons).map((lesson) => lesson.lesson),
        instruction:
          'Tell the user what you have taken from it, in one or two sentences, using only the ' +
          'lessons listed here.'
      };
    }

    case 'list_self_improvements': {
      if (!selfEditEnabled()) {
        return {
          status: 'unavailable',
          doNotRetry: true,
          summary: 'Changing your own code is switched off.'
        };
      }
      const pending = memoryStore.getProposals('pending');
      return {
        count: pending.length,
        proposals: pending.map((proposal) => ({
          id: proposal.id,
          title: proposal.title,
          why: proposal.evidence,
          files: proposal.files,
          brief: proposal.brief.slice(0, 400)
        })),
        instruction: pending.length
          ? 'Read these out as a short numbered list - the title and the reason, not the brief. ' +
            'Nothing has been changed. Only call apply_self_improvement if the user names one ' +
            'and clearly agrees to it.'
          : 'Say you have not got any changes to your own code to suggest.'
      };
    }

    case 'apply_self_improvement': {
      if (!selfEditEnabled()) {
        return {
          status: 'unavailable',
          doNotRetry: true,
          summary: 'Changing your own code is switched off.'
        };
      }
      const proposal = memoryStore.getProposals().find((entry) => entry.id === (args.id || '').trim());
      if (!proposal) {
        return {
          status: 'not_found',
          doNotRetry: true,
          error: 'No proposal with that id. Call list_self_improvements first.'
        };
      }

      // Checked here as well as at the point it was written: the proposal has
      // been sitting in a file since, and a build may have started in between.
      const verdict = proposalIsApplicable(proposal);
      if (!verdict.ok) {
        return {
          status: 'refused',
          doNotRetry: true,
          summary: `That change cannot be applied: ${verdict.reason}`,
          instruction: 'Tell the user that, plainly, and do not try another way round it.'
        };
      }

      if (!window.electronAPI?.runOpencode) {
        return { status: 'unavailable', doNotRetry: true, error: 'The desktop bridge is not available.' };
      }
      if (currentActiveBuildProject) {
        return {
          status: 'already_running',
          summary: `A build is already running for '${currentActiveBuildProject}'.`
        };
      }

      const selfProject = 'BEN';
      const selfDir = `${workspaceDir}/${selfProject}`;
      const brief = `You are a Principal Engineer working on an existing Electron + React + TypeScript
application in ${selfDir}. It is a voice assistant and it is running right now.

Change to make: ${proposal.title}
${proposal.brief}

Strict rules:
1. Work only inside ${selfDir}, and change as little as possible to achieve the above.
2. Do NOT touch the audio pipeline: audio-recorder.ts, audio-player.ts, speech-detector.ts or
   tunables.ts. Every constant in those was measured on a real microphone.
3. Do NOT change any API key, any file under mobile/android, or package.json's name field.
4. Read CLAUDE.md in the project root first and follow the conventions in it.
5. The project has no tests. Verify with: npx tsc --noEmit. It must pass before you finish.`;

      currentActiveBuildProject = selfProject;
      const buildTaskId = `build:${selfProject}`;
      backgroundTasks.start({ id: buildTaskId, kind: 'fix', label: selfProject });

      try {
        const res = await window.electronAPI.runOpencode({ prompt: brief, projectName: selfProject });
        if (!res.success) {
          currentActiveBuildProject = null;
          backgroundTasks.finish(buildTaskId, { status: 'failed', result: res.error });
          return { status: 'failed', doNotRetry: true, error: res.error };
        }
        memoryStore.setProposalStatus(proposal.id, 'applied');
        return {
          status: 'started',
          directory: res.directory || selfDir,
          summary: `Applying '${proposal.title}' to your own code in ${res.directory || selfDir}.`,
          instruction:
            'Tell the user you have started it and that you will need restarting once it lands, ' +
            'in one sentence, then stop. You will be told when it finishes.'
        };
      } catch (err: any) {
        currentActiveBuildProject = null;
        backgroundTasks.finish(buildTaskId, { status: 'failed', result: err?.message });
        throw err;
      }
    }

    case 'list_development_projects': {
      if (window.electronAPI?.listDevelopmentProjects) {
        const projects = await window.electronAPI.listDevelopmentProjects();
        return { workspace: workspaceDir, projects };
      }
      return {
        workspace: workspaceDir,
        projects: [],
        error: 'The desktop bridge is not available, so the workspace cannot be listed.'
      };
    }

    case 'create_task': {
      const task = memoryStore.addTask(args.title, args.project);
      return {
        status: 'created',
        task
      };
    }

    case 'complete_task': {
      const query = (args.taskTitleOrId || '').toLowerCase();
      const all = memoryStore.getData().tasks;
      const matched = all.find(
        (t) => t.id === query || t.title.toLowerCase().includes(query)
      );
      if (matched) {
        memoryStore.toggleTask(matched.id);
        return {
          status: 'success',
          message: `Directive completed: "${matched.title}"`
        };
      }
      return { status: 'not_found', message: `No matching directive found for "${args.taskTitleOrId}".` };
    }

    case 'list_uncompleted_tasks': {
      const tasks = memoryStore.getUncompletedTasks();
      return {
        count: tasks.length,
        uncompletedTasks: tasks
      };
    }

    case 'save_memory_note': {
      const note = memoryStore.addNote(args.content, args.category || 'general');
      return {
        status: 'saved',
        note
      };
    }

    case 'remember_about_user': {
      if (args.name) memoryStore.setUserName(args.name);
      const facts = memoryStore.addUserFact(args.fact || '');
      return { status: 'saved', knownFacts: facts.length };
    }

    case 'remember_project': {
      const project = memoryStore.rememberProject(args.name || '', args.summary || '');
      return { status: 'saved', project: project.name };
    }

    case 'recall_memory': {
      return memoryStore.getMemorySnapshot();
    }

    case 'forget_memory': {
      const match = (args.match || '').trim();
      if (!match) return { status: 'nothing_specified' };
      const removedFact = memoryStore.removeUserFact(match);
      const removedProject = memoryStore.removeProject(match);
      const note = memoryStore
        .getData()
        .notes.find((n) => n.content.toLowerCase().includes(match.toLowerCase()));
      if (note) memoryStore.deleteNote(note.id);
      const removed = removedFact || removedProject || !!note;
      return { status: removed ? 'forgotten' : 'not_found' };
    }

    case 'get_system_metrics': {
      if (window.electronAPI?.getSystemInfo) {
        const info = await window.electronAPI.getSystemInfo();
        return {
          status: 'success',
          data: info
        };
      }
      return {
        status: 'simulated',
        data: {
          cpuLoad: 24,
          memoryPercent: 48,
          memoryTotalGb: '16.0',
          memoryUsedGb: '7.6',
          batteryPercent: 88,
          batteryIsCharging: true
        }
      };
    }

    case 'open_application': {
      const appName = args.appName || 'Calculator';
      if (window.electronAPI?.openApp) {
        const res = await window.electronAPI.openApp(appName);
        return res;
      }
      return { status: 'mock_opened', message: `Application ${appName} would be launched.` };
    }

    case 'close_application': {
      const appName = args.appName || 'Calculator';
      if (window.electronAPI?.closeApp) {
        const res = await window.electronAPI.closeApp(appName);
        return res;
      }
      return { status: 'mock_closed', message: `Closed application ${appName}.` };
    }

    case 'stop_running_process': {
      if (!window.electronAPI?.cancelOpencode) {
        return { status: 'unavailable', error: 'The desktop bridge is not available.' };
      }

      // The result is read back from the process table. This used to be
      // discarded entirely and 'stopped' returned unconditionally, so "I have
      // stopped the build" was said when nothing had been running, and again
      // when the build ignored the signal and carried on writing files.
      const outcome = await window.electronAPI.cancelOpencode();

      if (!outcome.wasRunning) {
        return {
          status: 'nothing_running',
          doNotRestart: true,
          summary: 'Nothing was running, so nothing was stopped.',
          instruction:
            'Tell the user plainly that there was nothing running to stop. Do not say you ' +
            'stopped anything, and do not start anything.'
        };
      }

      if (outcome.stillRunning) {
        return {
          status: 'still_running',
          doNotRestart: true,
          project: outcome.project,
          summary: `The stop signal was sent but ${outcome.project || 'the process'} is still running.`,
          instruction:
            'Tell the user it has not stopped and that they may need to stop it from a terminal. ' +
            'Do not claim it is stopped.'
        };
      }

      currentActiveBuildProject = null;
      return {
        status: 'stopped',
        doNotRestart: true,
        project: outcome.project,
        stoppedBuild: outcome.stoppedBuild,
        stoppedProcess: outcome.stoppedProcess,
        message:
          'It has stopped, confirmed by the process no longer existing. Confirm this to the user ' +
          'and stop there. Do not start it again, and do not call run_project_command or ' +
          'run_opencode_task, unless the user explicitly asks you to.'
      };
    }

    case 'check_background_work': {
      // Two sources, because they answer different halves of the question: the
      // register knows what was promised and whether the user has been told,
      // the process table knows what is alive this second.
      const status = await window.electronAPI?.opencodeStatus?.();
      const running = backgroundTasks.running().map((task) => ({
        kind: task.kind,
        label: task.label,
        runningForSeconds: Math.round((Date.now() - task.startedAt) / 1000)
      }));
      const finished = backgroundTasks
        .list()
        .filter((task) => task.status !== 'running')
        .slice(0, 5)
        .map((task) => ({
          kind: task.kind,
          label: task.label,
          outcome: task.status,
          toldTheUser: task.announced,
          result: task.result ? task.result.slice(0, 200) : undefined
        }));

      const buildAlive = !!status?.build?.alive;

      return {
        buildRunning: buildAlive,
        buildProject: status?.build?.project || null,
        processRunning: !!status?.process?.alive,
        processProject: status?.process?.project || null,
        running,
        recentlyFinished: finished,
        instruction: buildAlive
          ? 'The build is still running. Say so. Do not say it is finished, do not describe what ' +
            'it produced, and do not start anything else.'
          : running.length
          ? 'Nothing is being built, but the work listed in running is still going. Report only that.'
          : 'Nothing is running. If you said earlier that something was building, that is no longer ' +
            'true - say what actually happened, using recentlyFinished, or say nothing is running.'
      };
    }

    case 'open_web_url': {
      let url = args.url || '';
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        url = `https://www.google.com/search?q=${encodeURIComponent(url)}`;
      }
      if (window.electronAPI?.openUrl) {
        const res: any = await window.electronAPI.openUrl(url);
        if (!res?.success) {
          return {
            status: 'failed',
            doNotRetry: true,
            url,
            error: res?.error || 'The browser did not open.',
            instruction: 'Tell the user it did not open. Do not say that it did.'
          };
        }
        return {
          status: 'opened',
          url,
          openedIn: res.openedIn,
          instruction:
            'Say the page is open, naming the site, and stop. Say only what this result reports.'
        };
      }
      window.open(url, '_blank');
      return { status: 'opened', url };
    }

    case 'get_current_time_date': {
      const now = new Date();
      return {
        time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        date: now.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        iso: now.toISOString()
      };
    }

    case 'list_skills': {
      if (!window.electronAPI?.listSkills) {
        return { status: 'unavailable', error: 'The desktop bridge is not available.' };
      }
      const res = await window.electronAPI.listSkills();
      return {
        status: 'ok',
        count: res.skills.length,
        skills: res.skills.map((sk) => ({ id: sk.id, name: sk.name, description: sk.description }))
      };
    }

    case 'use_skill': {
      if (!window.electronAPI?.readSkill) {
        return { status: 'unavailable', error: 'The desktop bridge is not available.' };
      }
      const res = await window.electronAPI.readSkill({ id: args.name || '' });
      if (!res.found) {
        return { status: 'not_found', error: `No skill matching '${args.name}'. Call list_skills to see what exists.` };
      }
      return {
        status: 'loaded',
        skill: res.id,
        instructions: res.content,
        note: 'Follow these instructions for this task.'
      };
    }

    case 'write_file': {
      if (!window.electronAPI?.writeWorkspaceFile) {
        return { status: 'unavailable', error: 'The desktop bridge is not available, so files cannot be written.' };
      }
      const res = await window.electronAPI.writeWorkspaceFile({
        relativePath: args.path || '',
        content: args.content ?? '',
        append: !!args.append
      });
      if (!res.success) return { status: 'failed', error: res.error };
      lastWrittenPath = args.path || '';
      return {
        status: 'written',
        path: res.displayPath,
        bytes: res.bytes,
        note: 'The file is saved. Nothing has been run or started.'
      };
    }

    case 'read_file': {
      if (!window.electronAPI?.readWorkspaceFile) {
        return { status: 'unavailable', error: 'The desktop bridge is not available.' };
      }
      const res = await window.electronAPI.readWorkspaceFile({ relativePath: args.path || '' });
      return res.success ? { status: 'read', content: res.content } : { status: 'failed', error: res.error };
    }

    case 'list_folder': {
      if (!window.electronAPI?.listWorkspaceFolder) {
        return { status: 'unavailable', error: 'The desktop bridge is not available.' };
      }
      const res = await window.electronAPI.listWorkspaceFolder({ relativePath: args.path || '' });
      return res.success
        ? { status: 'listed', path: res.displayPath, entries: res.entries }
        : { status: 'failed', error: res.error };
    }

    case 'create_folder': {
      if (!window.electronAPI?.createWorkspaceFolder) {
        return { status: 'unavailable', error: 'The desktop bridge is not available.' };
      }
      const res = await window.electronAPI.createWorkspaceFolder({ relativePath: args.path || '' });
      return res.success ? { status: 'created', path: res.displayPath } : { status: 'failed', error: res.error };
    }

    case 'open_path': {
      if (!window.electronAPI?.openWorkspacePath) {
        return { status: 'unavailable', error: 'The desktop bridge is not available.' };
      }
      // "open it" right after a write refers to what was just written.
      const target = args.path || lastWrittenPath;
      const res = await window.electronAPI.openWorkspacePath({
        relativePath: target,
        mode: args.mode || 'auto',
        app: (args.app || '').trim() || undefined
      });
      // openedIn is the application that actually opened it, read back from the
      // system. Announcing anything else - the app that was asked for, an
      // editor that is not installed - is the bug this reports around.
      return res.success
        ? {
            status: 'opened',
            path: res.displayPath,
            openedIn: res.openedIn,
            kind: res.kind,
            note: res.note,
            availableEditors: res.availableEditors
          }
        : {
            status: 'failed',
            doNotRetry: true,
            error: res.error,
            requestedApp: res.requestedApp,
            availableEditors: res.availableEditors
          };
    }

    case 'run_project_command': {
      // The folder name is passed straight through: extractProjectName is for
      // parsing free-text prompts and mangled real names (and invented random
      // ones when given nothing), which sent this at directories that never
      // existed and made the model retry.
      const projectName = (args.projectName || '').trim();
      if (!projectName) {
        return { status: 'failed', error: 'No project name given. Ask the user which project to run.' };
      }
      if (!window.electronAPI?.runProjectCommand) {
        return { status: 'unavailable', error: 'The desktop bridge is not available.' };
      }
      const res = await window.electronAPI.runProjectCommand({
        projectName,
        command: args.command || 'dev'
      });
      if (res.success) {
        // What happened next decides what to say: a web project has already
        // been opened in the browser, a script that prints and exits has
        // finished, and one that is still up may be waiting to be typed into.
        return {
          status: 'started',
          summary: `Executed '${res.commandExecuted}' for project '${projectName}' in ${res.directory}.`,
          url: res.url || undefined,
          alreadyOpenedInBrowser: !!res.url,
          stillRunning: res.stillRunning,
          consoleTakesInput: !!res.stillRunning && !!res.acceptsInput,
          instruction: res.url
            ? 'It is a web project and its address is already open in the browser. Say the address, ' +
              'and do not open it again.'
            : res.stillRunning
            ? 'It is running in the console on screen. If it asks for something, tell the user they ' +
              'can type their answer into the console, and read out what it asked.'
            : 'It has already finished. Describe what it printed, in a sentence.',
          preview: res.preview
        };
      }
      if (res.cancelledRecently) {
        return { status: 'blocked_after_cancel', doNotRetry: true, error: res.error };
      }
      return { status: 'failed', doNotRetry: true, error: res.error };
    }

    case 'open_project_in_editor': {
      const projectName = (args.projectName || '').trim();
      if (!window.electronAPI?.openWorkspacePath) {
        return { status: 'unavailable', error: 'The desktop bridge is not available.' };
      }
      // "vscode" is still accepted because it was the old enum value, but it no
      // longer means Visual Studio Code specifically - it means the editor this
      // machine has.
      const requested = (args.editor || '').trim();
      const wantsFinder = /^finder$/i.test(requested);
      const named = !wantsFinder && requested && !/^(vscode|vs code|editor|code)$/i.test(requested);
      const res = await window.electronAPI.openWorkspacePath({
        relativePath: projectName,
        mode: wantsFinder ? 'finder' : 'editor',
        app: named ? requested : undefined
      });
      return res.success
        ? {
            status: 'opened',
            path: res.displayPath,
            openedIn: res.openedIn,
            note: res.note,
            availableEditors: res.availableEditors
          }
        : {
            status: 'failed',
            doNotRetry: true,
            error: res.error,
            requestedApp: res.requestedApp,
            availableEditors: res.availableEditors
          };
    }

    case 'inspect_screen': {
      if (!window.electronAPI?.captureScreen) {
        return {
          status: 'unavailable',
          doNotRetry: true,
          error: 'Screen capture is not available here.'
        };
      }

      const target = (args.target || '').trim();
      const capture = await window.electronAPI.captureScreen(target ? { target } : undefined);
      if (!capture.success || !capture.imageBase64) {
        return {
          status: 'failed',
          doNotRetry: true,
          error: capture.error || 'The screen could not be captured.',
          // So the model can name what is actually open rather than guessing at
          // a window title a second time.
          openWindows: capture.available
        };
      }

      // This used to stop here and report success, having sent the image
      // nowhere: the model was told "captured and ready for analysis" and then
      // described a screen it had never seen. The frame has to actually go down
      // the socket, and the result has to say whether it did.
      const delivered = screenFrameSink?.(capture.imageBase64) ?? false;
      if (!delivered) {
        return {
          status: 'failed',
          doNotRetry: true,
          error: 'The screenshot was taken but could not be sent. Tell the user you cannot see it.'
        };
      }

      return {
        status: 'screen_attached',
        captured: capture.capturedName,
        summary: capture.wasWholeScreen
          ? 'A screenshot of the whole desktop is now attached to this conversation.'
          : `A screenshot of the "${capture.capturedName}" window is now attached.`,
        instruction:
          'The image just attached is the current screen; ignore any earlier screenshot in ' +
          'this conversation. Describe what is actually visible in it, in one or two ' +
          'sentences. If you cannot make something out, say so rather than guessing at it.'
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}
