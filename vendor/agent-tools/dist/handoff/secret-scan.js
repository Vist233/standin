import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
/** Patterns for things that must never be in a package other agents will read. Findings name the file and the rule, never the text. */
const RULES = [
    { name: "private key", pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
    { name: "API key", pattern: /\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9]{30,}|xox[abp]-[A-Za-z0-9-]{20,})\b/ },
    { name: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/ },
    { name: "assigned secret", pattern: /\b(?:api[_-]?key|secret|password|token)\b["']?\s*[:=]\s*["'][A-Za-z0-9._~+/=-]{20,}["']/i },
    { name: "personal path", pattern: /\/(?:Users|home)\/(?!user\b|me\b|example\b)[A-Za-z0-9._-]+\// },
];
export async function scanDirectory(root) {
    const findings = [];
    const walk = async (dir) => {
        for (const name of await readdir(dir)) {
            const path = join(dir, name);
            const info = await lstat(path);
            if (info.isDirectory())
                await walk(path);
            else if (info.isFile() && info.size <= 2_000_000) {
                const text = await readFile(path, "utf8").catch(() => "");
                for (const rule of RULES)
                    if (rule.pattern.test(text))
                        findings.push({ file: relative(root, path), rule: rule.name });
            }
        }
    };
    await walk(root);
    return findings;
}
/** The review that runs before a package is published: secrets and personal paths are refused (docs/07 section 6a). */
export async function secretReview(context) {
    const findings = await scanDirectory(context.packageDir);
    if (findings.length === 0)
        return { approved: true, reason: "no secrets or personal paths found" };
    const list = findings.map((f) => `${f.file} (${f.rule})`).join(", ");
    return { approved: false, reason: `Refused: remove secrets and personal paths before publishing. Found in: ${list}` };
}
