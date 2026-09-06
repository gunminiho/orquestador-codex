import type { ProjectRoot } from "./ProjectRoot";
export type Project = {
    id: string;
    name: string;
    roots: Array<ProjectRoot>;
    metadata: {
        [key in string]?: string;
    };
    position: number;
    createdAt: number;
    updatedAt: number;
    /**
     * Newest non-archived member thread's recency, in Unix seconds; null when none exist.
     */
    recencyAt: number | null;
};
//# sourceMappingURL=Project.d.ts.map