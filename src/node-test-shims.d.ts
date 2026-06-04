declare module "node:child_process" {
  export function spawnSync(
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: Record<string, string | undefined>;
      encoding: "utf8";
    },
  ): { status: number | null; stdout: string; stderr: string };
}

declare module "node:process" {
  const process: {
    execPath: string;
    cwd: () => string;
    env: Record<string, string | undefined>;
  };
  export default process;
}

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function mkdtempSync(prefix: string): string;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function rmSync(path: string, options: { recursive?: boolean; force?: boolean }): void;
  export function writeFileSync(path: string, data: string, encoding: "utf8"): void;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}
