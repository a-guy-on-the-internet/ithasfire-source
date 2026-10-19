import { proc } from "../init";
export const healthRouter = {
  health: proc.query(() => ({ ok: true })),
};
