/** Parse bounded literal command lists, never evaluate or expand shell input. */
function literalCommands(command: string): string[][] | null {
  const commands: string[][] = [];
  let args: string[] = [];
  let word = '';
  let quote = '';
  let started = false;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i]!;
    if (quote === "'") {
      if (c === "'") quote = ''; else word += c;
      continue;
    }
    if (c === '$' || c === '`' || c === '\n' || c === '\r') return null;
    if (c === '\\') {
      const next = command[++i];
      if (!next || next === '\n' || next === '\r') return null;
      if (quote === '"' && !['\\', '"', '$', '`'].includes(next)) return null;
      word += next; started = true; continue;
    }
    if (quote === '"') {
      if (c === '"') quote = ''; else word += c;
      continue;
    }
    if (c === ';' || c === '&') {
      if (c === '&' && command[++i] !== '&') return null;
      if (started) { args.push(word); word = ''; started = false; }
      if (!args.length || commands.length >= 16) return null;
      commands.push(args); args = []; continue;
    }
    if ('|<>()*?[]{}#'.includes(c)) return null;
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (/\s/.test(c)) {
      if (started) { args.push(word); word = ''; started = false; }
    } else { word += c; started = true; }
  }
  if (quote) return null;
  if (started) args.push(word);
  if (!args.length) return null;
  commands.push(args);
  return commands;
}

/** One final cat determines successful reading only after the tool has settled.
 * Literal pwd/ls/echo prefixes cannot alter its target or hide its exit status.
 * Compound output is mixed evidence, so it never proves full body coverage.
 */
export function skillShellRead(command: unknown): { path: string; compound: boolean } | undefined {
  if (typeof command !== 'string' || command.length > 16_384) return undefined;
  let commands = literalCommands(command);
  if (!commands) return undefined;
  let args = commands[0]!;
  if (/^(?:\/bin\/|\/usr\/bin\/)?(?:zsh|bash|sh)$/.test(args[0] ?? '')) {
    if (commands.length !== 1 || args.length !== 3 || !['-lc', '-c'].includes(args[1]!)) return undefined;
    commands = literalCommands(args[2]!);
    if (!commands) return undefined;
  }
  if (!commands.slice(0, -1).every(([name]) => /^(?:\/bin\/|\/usr\/bin\/)?(?:pwd|ls|echo)$/.test(name ?? ''))) return undefined;
  args = commands.at(-1)!;
  if (!['cat', '/bin/cat', '/usr/bin/cat'].includes(args[0] ?? '')) return undefined;
  const paths = args[1] === '--' ? args.slice(2) : args.slice(1);
  return paths.length === 1 && paths[0]!.startsWith('/')
    ? { path: paths[0]!, compound: commands.length > 1 } : undefined;
}

/** Return the one literal file read by a supported shell command. */
export function singleSkillShellRead(command: unknown): string | undefined {
  return skillShellRead(command)?.path;
}
