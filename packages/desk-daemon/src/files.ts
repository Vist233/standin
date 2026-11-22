import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkFileBytes, type FileEntry, MAX_FILE_BYTES, numberedName, OgbError, type PluginLogger, sanitizeFileName } from "@standin/contracts";

const MAX_SUFFIX = 1000;

/**
 * The files directory of one workspace as the person sees it: put a file in, list what is there, read one out. Only
 * regular files directly in the directory exist here (no sub-directories, no symlinks, no dot-files), a name that is
 * taken gets a number and nothing is overwritten, and file content never reaches a log: names and sizes only.
 */
export class WorkspaceFiles {
  private readonly dir: string;
  private readonly log: PluginLogger;

  constructor(dir: string, log: PluginLogger) {
    this.dir = dir;
    this.log = log;
  }

  async put(rawName: string, bytes: Uint8Array): Promise<FileEntry> {
    const name = sanitizeFileName(rawName);
    checkFileBytes(bytes);
    await this.ensureDirectory();
    // Written under a hidden temporary name, then linked to its final name: `link` fails if the name exists, so a
    // file is never replaced, and a half-written file never shows in the list.
    const temporary = join(this.dir, `.upload-${randomBytes(8).toString("hex")}`);
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o644 });
    try {
      for (let n = 1; n <= MAX_SUFFIX; n += 1) {
        const stored = numberedName(name, n);
        try {
          await link(temporary, join(this.dir, stored));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
          throw new OgbError("unavailable", "the file could not be stored", { cause: error });
        }
        const written = await lstat(join(this.dir, stored));
        this.log.info("file stored", { name: stored, size: written.size });
        return { name: stored, size: written.size, modifiedAt: Math.round(written.mtimeMs), path: join(this.dir, stored) };
      }
      throw new OgbError("conflict", "too many files with this name");
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  /** Newest first. */
  async list(): Promise<FileEntry[]> {
    let names: string[];
    try {
      names = (await readdir(this.dir, { withFileTypes: true })).filter((e) => e.isFile() && !e.name.startsWith(".")).map((e) => e.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new OgbError("unavailable", "the files directory cannot be read", { cause: error });
    }
    const entries: FileEntry[] = [];
    for (const name of names) {
      try {
        const info = await lstat(join(this.dir, name));
        if (info.isFile()) entries.push({ name, size: info.size, modifiedAt: Math.round(info.mtimeMs), path: join(this.dir, name) });
      } catch {
        // gone between readdir and lstat
      }
    }
    return entries.sort((a, b) => b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name));
  }

  async get(rawName: string): Promise<Uint8Array> {
    const name = sanitizeFileName(rawName);
    if (name.startsWith(".")) throw new OgbError("not_found", "no such file");
    const path = join(this.dir, name);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); // a symlink fails here with ELOOP
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") throw new OgbError("not_found", "no such file");
      if (code === "ELOOP") throw new OgbError("denied", "only regular files can be read");
      throw new OgbError("unavailable", "the file cannot be read", { cause: error });
    }
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new OgbError("denied", "only regular files can be read");
      if (info.size > MAX_FILE_BYTES) throw new OgbError("denied", `the file is larger than ${MAX_FILE_BYTES} bytes and cannot be transferred`);
      const content = await handle.readFile();
      this.log.info("file read", { name, size: content.length });
      return new Uint8Array(content.buffer, content.byteOffset, content.length);
    } finally {
      await handle.close();
    }
  }

  /** The directory must be a real directory: an agent that replaced it with a link would redirect every transfer. */
  private async ensureDirectory(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    if (!(await lstat(this.dir)).isDirectory()) throw new OgbError("unavailable", "the files directory is not a directory");
  }
}
