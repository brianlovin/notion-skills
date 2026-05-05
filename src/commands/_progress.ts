import chalk from "chalk";

/**
 * One-line progress task. While in progress, animates a braille spinner
 * next to the label; on done, overwrites in place with "✓ label"; on
 * fail, overwrites with "✗ label (reason)". Sequential — each task
 * resolves before the next starts, so `\r` updates the current line
 * without ANSI cursor gymnastics.
 *
 * Falls back to plain newline-terminated lines for non-TTY output (CI,
 * piped) so the user still gets one line per completed task.
 */
export interface Task {
  done(note?: string): void;
  fail(reason?: string): void;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

export function startTask(label: string): Task {
  const tty = !!process.stdout.isTTY;
  let interval: NodeJS.Timeout | undefined;

  if (tty) {
    let frame = 0;
    process.stdout.write(`  ${chalk.cyan(SPINNER_FRAMES[0])} ${label}`);
    interval = setInterval(() => {
      frame = (frame + 1) % SPINNER_FRAMES.length;
      process.stdout.write(`\r  ${chalk.cyan(SPINNER_FRAMES[frame])} ${label}`);
    }, SPINNER_INTERVAL_MS);
    // Don't keep the event loop alive just for the spinner.
    interval.unref();
  }

  const stop = () => {
    if (interval) {
      clearInterval(interval);
      interval = undefined;
    }
  };

  return {
    done(note?: string) {
      stop();
      const tail = note ? ` ${chalk.dim(note)}` : "";
      const line = `  ${chalk.green("✓")} ${label}${tail}\n`;
      process.stdout.write(tty ? `\r\x1b[2K${line}` : line);
    },
    fail(reason?: string) {
      stop();
      const tail = reason ? ` ${chalk.dim(`(${reason})`)}` : "";
      const line = `  ${chalk.red("✗")} ${label}${tail}\n`;
      process.stdout.write(tty ? `\r\x1b[2K${line}` : line);
    },
  };
}
