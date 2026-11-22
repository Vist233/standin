import type { reviewPlugin } from "sakura-agent";

/** The framework's policy input (four plain-language lists; "$defaults" keeps its own entries). */
export type ReviewPolicy = NonNullable<Parameters<typeof reviewPlugin>[0]["policy"]>;

/**
 * Vesper's review policy (owner, 2026-11-17): the reviewer stops only big, hard-to-undo things (destroying data, rewriting git history,
 * wiping directories, leaking secrets). Small things are not its business, and what the person approves anyway (mail, posts, other
 * irreversible tools: Vesper's approval gate asks them first) is not judged again: a reviewer that cannot see the person's task list
 * denied a mail the person had asked for (owner case tasks-and-people). A file `<data>/config/review-policy.json` with the same four
 * lists replaces this one; a list that contains "$defaults" keeps these entries.
 */
export const VESPER_REVIEW_POLICY: Required<ReviewPolicy> = {
  environment: [
    "The agent is one person's bot. It works in its own sandboxed computer (a container): its files directory, a desktop and a browser that are its own.",
    "Its files directory, the shared folder of the person's bots, its desktop and its browser are trusted. The internet is reached on purpose: browsing, searching, downloading and signing in are ordinary work.",
    "Irreversible tools (sending mail or messages, posting, creating events) are approved by the person, one call at a time, in a separate step after this review. Do not judge whether the person wants them; only stop what is listed below.",
  ],
  allow: [
    "Reading, writing, editing, moving and deleting single files or small folders inside its files directory, its memo or the shared folder.",
    "Running programs, scripts, package installs and builds inside its computer; using the browser and the desktop.",
    "Downloading files and tools and running them inside its own sandbox.",
    "Sending mail and messages, posting, scheduling and webhooks (the person approves each irreversible one separately).",
    "Ordinary git work: status, diff, add, commit, branch, checkout, pull, a normal push.",
  ],
  soft_deny: [
    "Deleting a directory tree or many files at once (rm -rf, find -delete, wiping a folder), or deleting the shared folder or another bot's data.",
    "Rewriting or destroying git history: push --force, reset --hard, rebase of pushed commits, deleting branches or tags, git clean -fdx, deleting a repository.",
    "Dropping or truncating databases, deleting cloud resources, revoking or rotating keys, deleting accounts.",
    "Changing the sandbox's system settings, credentials, users or startup files.",
  ],
  hard_deny: [
    "Sending secrets, keys, tokens, passwords or the person's private files to any place outside.",
    "Deleting everything under the filesystem root, the home directory or the data directory.",
    "Disabling, bypassing or tampering with this review, the approvals, the logs or the redaction of secrets.",
  ],
};
