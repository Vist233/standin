/**
 * The only thing the tool knows about the handoff library: this port. One adapter file (`adapter.ts`) implements it, so a
 * change in the library (its README says the interface may change) is a change in that one file.
 */
export interface SearchHit {
    id: string;
    version: string;
    description: string;
    tags: string[];
    verifiable: boolean;
}
export interface HandoffPort {
    search(query: string, limit?: number): Promise<{
        total: number;
        shown: number;
        results: SearchHit[];
        note?: string;
        refine?: unknown;
    }>;
    /** `path` "." describes the package; a file name returns that file. */
    peek(id: string, path: string): Promise<Record<string, unknown>>;
    pull(id: string, verify: boolean): Promise<Record<string, unknown>>;
    /** A directory (absolute) or file names mapped to contents. */
    publish(source: string | Record<string, string | object>): Promise<{
        status: "accepted" | "rejected";
        id: string;
        version: string;
        reason: string;
        digest?: string;
    }>;
}
