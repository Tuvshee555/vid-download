import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PREFIX = 'vd-job-';

export interface Workspace {
  dir: string;
  path(name: string): string;
  dispose(): Promise<void>;
}

/** Private (0700) scratch directory for one job. Always `dispose()` in a `finally`. */
export async function createWorkspace(): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), PREFIX));
  return {
    dir,
    path: (name) => join(dir, name),
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

/** Remove workspaces orphaned by a crash or kill -9 (anything older than `maxAgeMs`). Returns how many were removed. */
export async function sweepStaleWorkspaces(maxAgeMs = 2 * 3600_000, now = Date.now()): Promise<number> {
  let removed = 0;
  const base = tmpdir();
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.startsWith(PREFIX)) continue;
    const full = join(base, entry);
    try {
      const info = await stat(full);
      if (info.isDirectory() && now - info.mtimeMs > maxAgeMs) {
        await rm(full, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // raced with another sweep or the job itself — ignore
    }
  }
  return removed;
}
