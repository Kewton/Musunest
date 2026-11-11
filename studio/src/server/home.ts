import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// 走りの記録の置き場所。リポジトリの外に置き、`.gitignore` は触らない（studio-s1.md §3・§8）。
// 既定はホームの下の `.musunest-studio`。`STUDIO_HOME` で差し替えられる。
// 値がリポジトリの中を指したら、起動を断る（記録がコミットに混ざらないように）。
export const HOME_ENV = "STUDIO_HOME";
export const DEFAULT_HOME_NAME = ".musunest-studio";

export interface StudioHomeOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  repoRoot?: string;
}

export class StudioHomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudioHomeError";
  }
}

// src/server/home.ts からも dist/server/home.js からも 3 つ上がリポジトリの根。
const repositoryRoot = (): string => resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const isInside = (target: string, root: string): boolean => target === root || target.startsWith(`${root}${sep}`);

export function resolveStudioHome(options: StudioHomeOptions = {}): string {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const repoRoot = resolve(options.repoRoot ?? repositoryRoot());
  const configured = env[HOME_ENV];
  const dir = resolve(configured && configured.length > 0 ? configured : resolve(home, DEFAULT_HOME_NAME));

  if (isInside(dir, repoRoot)) {
    throw new StudioHomeError(`記録の置き場所がリポジトリの中を指している: ${dir}`);
  }
  return dir;
}
