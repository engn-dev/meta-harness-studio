import pc from 'picocolors';

let quiet = false;

export function setQuiet(v: boolean): void {
  quiet = v;
}

export const log = {
  info(msg: string): void {
    if (!quiet) console.log(msg);
  },
  step(msg: string): void {
    if (!quiet) console.log(`${pc.cyan('›')} ${msg}`);
  },
  success(msg: string): void {
    if (!quiet) console.log(`${pc.green('✔')} ${msg}`);
  },
  warn(msg: string): void {
    console.warn(`${pc.yellow('!')} ${msg}`);
  },
  error(msg: string): void {
    console.error(`${pc.red('✘')} ${msg}`);
  },
  heading(msg: string): void {
    if (!quiet) console.log(`\n${pc.bold(msg)}`);
  },
  dim(msg: string): void {
    if (!quiet) console.log(pc.dim(msg));
  },
};

export { pc };
