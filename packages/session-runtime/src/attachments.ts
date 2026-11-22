import { join } from "node:path";
import { type MessageAttachment, OgbError, sanitizeFileName } from "@standin/contracts";

/**
 * The files a message names, checked and given the path the agent's own tools see. The gateway has already checked them
 * against the files directory; names are checked again here because a path built from a name must not leave the directory.
 */
export function attachmentRefs(filesDir: string, given: readonly { name: string; size: number }[] | undefined): MessageAttachment[] {
  return (given ?? []).map(({ name, size }) => {
    if (typeof name !== "string" || sanitizeFileName(name) !== name)
      throw new OgbError("invalid_input", "an attachment has a name that is not a plain file name");
    if (!Number.isSafeInteger(size) || size < 0) throw new OgbError("invalid_input", "an attachment has no valid size");
    return { name, size, path: join(filesDir, name) };
  });
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What the agent reads: the person's words, then one line naming the files and where they are. */
export function withAttachmentLine(text: string, attachments: readonly MessageAttachment[]): string {
  if (attachments.length === 0) return text;
  const list = attachments.map((a) => `${a.name} (${sizeText(a.size)}) at ${a.path}`).join("; ");
  const line = `The person attached ${attachments.length} ${attachments.length === 1 ? "file" : "files"}: ${list}`;
  return text.trim() === "" ? line : `${text}\n\n${line}`;
}
