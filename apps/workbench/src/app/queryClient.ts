// The one query cache of the workbench; App drops a project's part when the reader leaves it and all of it on logout.
import { createQueryClient } from "../shared/query";

export const queryClient = createQueryClient();
