import type { ScheduledTaskWeekday } from "./ScheduledTaskWeekday";
export type ScheduledTaskSchedule = {
    "type": "hourly";
    intervalHours: number;
    days: Array<ScheduledTaskWeekday> | null;
} | {
    "type": "daily";
    time: string;
} | {
    "type": "weekdays";
    time: string;
} | {
    "type": "weekly";
    days: Array<ScheduledTaskWeekday>;
    time: string;
};
//# sourceMappingURL=ScheduledTaskSchedule.d.ts.map