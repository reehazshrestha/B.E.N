// Skill library: third-party SKILL.md collections that B.E.N. can consult when
// planning or writing code.
//
// Only the markdown is ever read. These repositories also ship hooks, scripts
// and MCP servers; none of that is executed by this app.

import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';

export interface SkillSummary {
  id: string; // "<source>/<skill-name>"
  name: string;
  description: string;
  source: string;
  file: string;
}

export const DEFAULT_SKILL_SOURCES = [
  'https://github.com/obra/superpowers.git',
  'https://github.com/DietrichGebert/ponytail.git',
  'https://github.com/multica-ai/andrej-karpathy-skills.git'
];

// Enough for the model to follow a skill; long appendices are trimmed.
const MAX_SKILL_CHARS = 12000;
const MAX_CATALOGUE_DESCRIPTION = 200;

function repoName(url: string): string {
  return path.basename(url.replace(/\.git$/, ''));
}

// Minimal YAML front matter reader. Handles `key: value`, quoted values, and
// the `>` / `|` block scalars these repositories use for long descriptions.
function parseFrontMatter(text: string): Record<string, string> {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};

  const lines = text.slice(4, end).split('\n');
  const out: Record<string, string> = {};
  let key = '';
  let folding = false;

  for (const line of lines) {
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (match && !/^\s/.test(line)) {
      key = match[1];
      const value = match[2].trim();
      if (value === '>' || value === '|' || value === '>-' || value === '|-') {
        folding = true;
        out[key] = '';
      } else {
        folding = false;
        out[key] = value.replace(/^["']|["']$/g, '');
      }
      continue;
    }
    if (folding && key && /^\s+/.test(line)) {
      out[key] = `${out[key]} ${line.trim()}`.trim();
    }
  }
  return out;
}

function walkForSkills(dir: string, depth = 0): string[] {
  if (depth > 5) return [];
  let found: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found = found.concat(walkForSkills(full, depth + 1));
    } else if (entry.name === 'SKILL.md') {
      found.push(full);
    }
  }
  return found;
}

function summarise(file: string, source: string): SkillSummary | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const meta = parseFrontMatter(raw);
    const name = meta.name || path.basename(path.dirname(file));
    const description = (meta.description || '').replace(/\s+/g, ' ').trim();
    return {
      id: `${source}/${name}`,
      name,
      description:
        description.length > MAX_CATALOGUE_DESCRIPTION
          ? `${description.slice(0, MAX_CATALOGUE_DESCRIPTION).trimEnd()}...`
          : description,
      source,
      file
    };
  } catch {
    // A single unreadable skill must not break the catalogue.
    return null;
  }
}

// `label` marks a directory whose skills all belong to one source, such as the
// set that ships with the app. Without it, each subdirectory is its own source.
export function listSkills(skillsDir: string, label?: string): SkillSummary[] {
  if (!fs.existsSync(skillsDir)) return [];
  const results: SkillSummary[] = [];

  if (label) {
    for (const file of walkForSkills(skillsDir)) {
      const summary = summarise(file, label);
      if (summary) results.push(summary);
    }
    return results.sort((a, b) => a.id.localeCompare(b.id));
  }

  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const source = entry.name;

    for (const file of walkForSkills(path.join(skillsDir, source))) {
      const summary = summarise(file, source);
      if (summary) results.push(summary);
    }
  }

  return results.sort((a, b) => a.id.localeCompare(b.id));
}

export function readSkillFrom(
  skills: SkillSummary[],
  id: string
): { found: boolean; id?: string; content?: string } {
  const wanted = (id || '').trim().toLowerCase();
  if (!wanted) return { found: false };

  const match =
    skills.find((s) => s.id.toLowerCase() === wanted) ||
    skills.find((s) => s.name.toLowerCase() === wanted) ||
    skills.find((s) => s.name.toLowerCase().includes(wanted)) ||
    skills.find((s) => wanted.includes(s.name.toLowerCase()));
  if (!match) return { found: false };

  try {
    const raw = fs.readFileSync(match.file, 'utf8');
    // Strip the front matter; the catalogue already carries it.
    const body = raw.startsWith('---')
      ? raw.slice(raw.indexOf('\n---', 3) + 4).trimStart()
      : raw;
    return { found: true, id: match.id, content: body.slice(0, MAX_SKILL_CHARS) };
  } catch {
    return { found: false };
  }
}

// Clone each source, or fast-forward it if already present.
export async function syncSkills(
  skillsDir: string,
  sources: string[],
  onLog?: (line: string) => void
): Promise<{ source: string; action: string; error?: string }[]> {
  fs.mkdirSync(skillsDir, { recursive: true });
  const results: { source: string; action: string; error?: string }[] = [];

  for (const url of sources) {
    const name = repoName(url);
    const dest = path.join(skillsDir, name);
    const exists = fs.existsSync(path.join(dest, '.git'));
    const command = exists
      ? `git -C ${JSON.stringify(dest)} pull --ff-only --depth 1`
      : `git clone --depth 1 ${JSON.stringify(url)} ${JSON.stringify(dest)}`;

    onLog?.(`${exists ? 'Updating' : 'Installing'} ${name}...`);
    const outcome = await new Promise<{ source: string; action: string; error?: string }>((resolve) => {
      exec(command, { timeout: 120000 }, (err, _stdout, stderr) => {
        if (err) {
          resolve({ source: name, action: 'failed', error: (stderr || err.message).slice(0, 300) });
        } else {
          resolve({ source: name, action: exists ? 'updated' : 'installed' });
        }
      });
    });

    onLog?.(
      outcome.action === 'failed' ? `${name}: ${outcome.error}` : `${name}: ${outcome.action}`
    );
    results.push(outcome);
  }

  return results;
}
