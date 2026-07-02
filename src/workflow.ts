export type WorkflowStage = "READY" | "DOING" | "REVIEW" | "DONE";

export interface WorkflowColumnLike {
    name: string;
    stage?: WorkflowStage | null;
}

export function getWorkflowStageFromColumnName(columnName: string): WorkflowStage | null {
    const normalized = columnName
        .trim()
        .toLowerCase()
        .replace(/[_-]+/g, " ");

    if (!normalized) return null;

    const words = new Set(normalized.split(/\s+/).filter(Boolean));
    const has = (...candidates: string[]) => candidates.some((c) => words.has(c));

    if (has("done", "complete", "completed", "shipped")) return "DONE";
    if (has("review", "qa")) return "REVIEW";
    if (has("doing", "progress", "wip") || (words.has("in") && words.has("progress"))) return "DOING";
    if (has("ready", "todo", "backlog") || (words.has("to") && words.has("do"))) return "READY";

    return null;
}

export function getWorkflowStageFromColumn(column: WorkflowColumnLike): WorkflowStage | null {
    if (column.stage) {
        return column.stage;
    }

    return getWorkflowStageFromColumnName(column.name);
}

export const DEFAULT_WORKFLOW_COLUMNS: Array<{
    name: string;
    stage: WorkflowStage;
    order: number;
}> = [
    { name: "Ready", stage: "READY", order: 0 },
    { name: "Doing", stage: "DOING", order: 1 },
    { name: "Review", stage: "REVIEW", order: 2 },
    { name: "Done", stage: "DONE", order: 3 },
];
