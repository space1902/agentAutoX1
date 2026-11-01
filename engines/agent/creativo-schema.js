// Every table that only the Agente creativo owns (its agent.db gets them on top of the common ones).
import { APPROVAL_SCHEMA } from './creativo-approvals.js';
import { CREATIVO_LEARNING_SCHEMA } from './creativo-learning.js';
import { ROADMAP_SCHEMA } from './creativo-roadmap.js';

export const CREATIVO_SCHEMA = `${APPROVAL_SCHEMA}\n${CREATIVO_LEARNING_SCHEMA}\n${ROADMAP_SCHEMA}`;
