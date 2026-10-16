import { z } from 'zod';
import { AddNodeRequest, NodeAccessLevel } from './api.ts';
import { SpendPolicy } from './spend.ts';

export const ManageNodeRequest = AddNodeRequest.extend({
  viewRune: z.string().min(1).max(4096).optional(),
  accessLevel: NodeAccessLevel.optional(),
  adminAcknowledged: z.boolean().default(false),
  credentialBlock: z.string().max(12000).optional(),
  limits: SpendPolicy.optional(),
}).meta({ id: 'ManageNodeRequest' });
export type ManageNodeRequest = z.input<typeof ManageNodeRequest>;
export const ReplaceNodeRequest = ManageNodeRequest;
