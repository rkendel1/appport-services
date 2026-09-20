import type { JobSchedule, ScheduleRecurringInput } from '../jobs/models.js';

export type Schedule = JobSchedule;
export interface CreateScheduleInput extends ScheduleRecurringInput {}
