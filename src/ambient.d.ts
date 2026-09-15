declare module 'node-pty' {
  export interface IPty {
    pid: number;
    onData(callback: (data: string) => void): void;
    onExit(callback: (event: { exitCode: number; signal?: number }) => void): void;
    write(data: string): void;
    resize(columns: number, rows: number): void;
    kill(): void;
  }
  export function spawn(file: string, args: string[], options: Record<string, unknown>): IPty;
}

declare module '@xterm/xterm' {
  export interface IDisposable { dispose(): void; }
  export interface ITheme { background?: string; foreground?: string; cursor?: string; }
  export class Terminal {
    cols: number;
    rows: number;
    constructor(options?: Record<string, unknown>);
    loadAddon(addon: unknown): void;
    open(element: HTMLElement): void;
    reset(): void;
    write(data: string): void;
    writeln(data: string): void;
    onData(callback: (data: string) => void): IDisposable;
  }
}
