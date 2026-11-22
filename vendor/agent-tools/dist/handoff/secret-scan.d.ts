export interface Finding {
    file: string;
    rule: string;
}
export declare function scanDirectory(root: string): Promise<Finding[]>;
/** The review that runs before a package is published: secrets and personal paths are refused (docs/07 section 6a). */
export declare function secretReview(context: {
    packageDir: string;
}): Promise<{
    approved: boolean;
    reason: string;
}>;
