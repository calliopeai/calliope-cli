import { readFileSync } from 'node:fs';
import { constants } from 'node:os';

/**
 * Whether a process the test SIGKILLed has stopped running (calliopeai/calliope-cli#481).
 *
 * `kill(pid, 0)` keeps succeeding on a zombie. A process whose parent dies
 * first, such as a shell's child in the same group kill, is adopted by PID 1
 * (or the nearest subreaper). A PID 1 that never waits for adopted children,
 * such as a Python runner blocked in subprocess.call, keeps that zombie for as
 * long as it runs. On Linux a zombie whose recorded wait status is SIGKILL
 * therefore counts; a running process, or a zombie that ended any other way,
 * does not. Without /proc only ESRCH counts.
 */
export function reapedOrSigkilled(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    throw error;
  }
  let stat: string;
  try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return false; }
  // Fields after the parenthesised command name start at field 3 (state);
  // field 52 (exit_code, Linux 3.5+) is the waitpid status a zombie holds.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(' ');
  return fields[0] === 'Z' && Number(fields[49]) === constants.signals.SIGKILL;
}
